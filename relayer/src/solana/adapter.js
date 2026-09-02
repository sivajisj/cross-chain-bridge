const { ethers } = require("ethers");
const anchor = require("@anchor-lang/core");
const { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require("@solana/spl-token");

const db = require("../db");
const { STATES, assertTransition } = require("../stateMachine");
const { normalize, denormalize } = require("../normalizer");
const { collectEd25519Signatures } = require("./collector");
const { SOLANA_CHAIN_ID } = require("./signer");
const pdas = require("./pdas");

// Solana has no block numbers; transaction signatures are the natural
// pagination unit. We still key sync_cursor by chain_id (BIGINT) like the
// EVM side does, just storing the highest *slot* seen instead of a block
// number -- both are simply "how far have we scanned," monotonically
// increasing, which is all sync_cursor / source_block_number ever needed.
function toSyntheticTxHash(signature) {
  return ethers.keccak256(ethers.toUtf8Bytes(signature));
}

function bytesToHexAddress(bytes) {
  return ethers.getAddress(ethers.hexlify(Uint8Array.from(bytes)));
}

function hexAddressToBytes20(hexAddress) {
  return ethers.getBytes(ethers.zeroPadValue(hexAddress, 20));
}

// ── Solana → Sepolia: scan for BurnEvent (wrapped-token burns) ──────────────
// 'finalized' commitment is Solana's strongest guarantee (the block cannot
// be rolled back), so a burn detected this way is already irreversible --
// unlike the EVM side, there's no separate confirmation-count wait. We
// still walk the row through CONFIRMING before FINALIZED to respect the
// existing state machine's transition graph.
async function scanForSolanaBurnMessages({ databaseUrl, connection, program, config }) {
  const lastSlot = await db.getCursor(databaseUrl, SOLANA_CHAIN_ID, 0);

  const signatures = await connection.getSignaturesForAddress(
    program.programId,
    { limit: config.solanaScanBatchSize || 200 },
    "finalized"
  );

  const toProcess = signatures
    .filter((s) => !s.err && (s.slot || 0) > lastSlot)
    .sort((a, b) => a.slot - b.slot);

  if (toProcess.length === 0) return [];

  const newlyDetected = [];
  let maxSlot = lastSlot;
  const eventParser = new anchor.EventParser(program.programId, program.coder);

  for (const sigInfo of toProcess) {
    maxSlot = Math.max(maxSlot, sigInfo.slot);

    const tx = await connection.getTransaction(sigInfo.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || !tx.meta || !tx.meta.logMessages) continue;

    const events = [...eventParser.parseLogs(tx.meta.logMessages)];
    const burnEvents = events.filter((e) => e.name === "BurnEvent" || e.name === "burnEvent");

    for (let i = 0; i < burnEvents.length; i++) {
      const data = burnEvents[i].data;
      const sourceTokenBytes = Buffer.from(data.sourceToken);
      const sourceToken = bytesToHexAddress(sourceTokenBytes);
      const destinationChainId = Number(data.sourceChainId); // send back to the chain the wrapped asset originated from

      const wrappedConfigPda = pdas.wrappedTokenConfigPda(program.programId, destinationChainId, sourceTokenBytes);
      const wrappedConfig = await program.account.wrappedTokenConfig.fetch(wrappedConfigPda);

      const normalizedAmount = normalize(BigInt(data.amount.toString()), wrappedConfig.decimals);

      const syntheticTxHash = toSyntheticTxHash(sigInfo.signature);
      const messageId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "bytes32", "uint256"],
          [SOLANA_CHAIN_ID, destinationChainId, syntheticTxHash, i]
        )
      );

      const { row, inserted } = await db.insertDetectedMessage(databaseUrl, {
        messageId,
        sourceChainId: SOLANA_CHAIN_ID,
        destinationChainId,
        sourceTxHash: sigInfo.signature,
        sourceLogIndex: i,
        sourceBlockNumber: sigInfo.slot,
        sender: data.user.toBase58(),
        recipient: bytesToHexAddress(Buffer.from(data.recipientEvm)),
        token: sourceToken,
        amount: normalizedAmount,
        nonce: messageId,
        direction: "BURN",
      });
      if (!inserted) continue;

      assertTransition(STATES.DETECTED, STATES.CONFIRMING);
      await db.transitionStatus(databaseUrl, messageId, [STATES.DETECTED], STATES.CONFIRMING);
      assertTransition(STATES.CONFIRMING, STATES.FINALIZED);
      const finalized = await db.transitionStatus(databaseUrl, messageId, [STATES.CONFIRMING], STATES.FINALIZED);
      if (finalized) newlyDetected.push(finalized);
      void row;
    }
  }

  await db.setCursor(databaseUrl, SOLANA_CHAIN_ID, maxSlot);
  return newlyDetected;
}

// ── Submit a Sepolia unlock for a Solana-origin burn ─────────────────────────
// Reuses the EXISTING EVM machinery end to end: EIP-712 signer/collector and
// bridgeSource.unlockTokens() on the already-deployed Sepolia contract.
// unlockTokens doesn't care whether the burn happened on Amoy or Solana, only
// that the message fields and signatures are valid -- so
// processor.submitUnlockMessage() is reused unmodified.
async function processSolanaBurnsReadyForUnlock({ databaseUrl, bridgeSource, config, validatorWallets, submitUnlockMessage }) {
  if (!bridgeSource) return [];
  const finalized = await db.getMessagesByStatus(databaseUrl, STATES.FINALIZED, SOLANA_CHAIN_ID);
  const results = [];
  for (const message of finalized) {
    const r = await submitUnlockMessage({ databaseUrl, bridgeSource, config, message, validatorWallets });
    if (r) results.push(r);
  }
  return results;
}

// ── Sepolia → Solana: scan for TokenLocked (NOT wired into the live relayer loop) ──
//
// The already-deployed BridgeSource.sol emits one TokenLocked event shape
// with no destination-chain field, and every existing lock is already
// claimed by the Sepolia<->Amoy leg (scanForNewMessages in
// relayer/src/processor.js). Reusing that same event stream here would
// double-mint the same locked funds on both Amoy and Solana. This function
// is implemented and unit-testable, but relayer.js does not call it --
// enabling it for real requires a dedicated Solana-bound lock source (a
// second BridgeSource-like contract deployment on Sepolia), tracked as
// follow-up work. See README.md "Known limitations".
async function scanForSepoliaLockMessagesForSolana({ databaseUrl, bridgeSource, config, fromBlock, toBlock }) {
  const events = await bridgeSource.queryFilter(bridgeSource.filters.TokenLocked(), fromBlock, toBlock);
  if (events.length === 0) return [];

  const newlyDetected = [];
  for (const event of events) {
    const { user, token, amount, decimals } = event.args;
    const normalizedAmount = normalize(amount, Number(decimals));

    const messageId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "bytes32", "uint256"],
        [config.sourceChainId, SOLANA_CHAIN_ID, event.transactionHash, event.index]
      )
    );

    const { inserted } = await db.insertDetectedMessage(databaseUrl, {
      messageId,
      sourceChainId: config.sourceChainId,
      destinationChainId: SOLANA_CHAIN_ID,
      sourceTxHash: event.transactionHash,
      sourceLogIndex: event.index,
      sourceBlockNumber: event.blockNumber,
      sender: user,
      recipient: user,
      token,
      amount: normalizedAmount,
      nonce: messageId,
      direction: "LOCK",
    });
    if (!inserted) continue;

    assertTransition(STATES.DETECTED, STATES.CONFIRMING);
    const confirming = await db.transitionStatus(databaseUrl, messageId, [STATES.DETECTED], STATES.CONFIRMING);
    if (confirming) newlyDetected.push(confirming);
  }
  return newlyDetected;
}

// ── Submit a Solana mint for a Sepolia-origin lock (NOT wired into the live loop) ──
// Collects threshold ed25519 signatures, then sends one Solana transaction
// containing `threshold` Ed25519Program instructions followed by the
// mint_wrapped instruction, exactly as solana-program/programs/bridge/src/
// ed25519.rs::verify_threshold_signatures expects.
async function submitSolanaMintMessage({ databaseUrl, connection, program, message, validatorKeypairs, config, payerKeypair }) {
  const fromStatus = message.status;
  if (![STATES.FINALIZED, STATES.RETRYING].includes(fromStatus)) return null;

  assertTransition(fromStatus, STATES.SUBMITTED);
  const claimed = await db.transitionStatus(databaseUrl, message.message_id, [fromStatus], STATES.SUBMITTED);
  if (!claimed) return null;

  try {
    const messageIdBytes = Buffer.from(message.message_id.slice(2), "hex");
    const recipient = new PublicKey(message.recipient);
    const sourceTokenBytes20 = hexAddressToBytes20(message.token);
    const normalizedAmount = BigInt(message.amount);

    const signingRequest = {
      messageId: message.message_id,
      recipient: recipient.toBase58(),
      normalizedAmount,
      sourceChainId: Number(message.source_chain_id),
      destChainId: SOLANA_CHAIN_ID,
      programId: program.programId.toBase58(),
    };

    console.log(`Collecting Solana mint signatures for ${message.message_id.slice(0, 10)}...`);
    const { instructions: ed25519Ixs } = await collectEd25519Signatures(validatorKeypairs, signingRequest, config.threshold);

    const wrappedConfigPda = pdas.wrappedTokenConfigPda(program.programId, Number(message.source_chain_id), sourceTokenBytes20);
    const wrappedConfig = await program.account.wrappedTokenConfig.fetch(wrappedConfigPda);
    const recipientAta = getAssociatedTokenAddressSync(wrappedConfig.wrappedMint, recipient, true);

    // The JS client camelCases IDL names (snake_case in Rust) internally --
    // program.methods/.accounts() expect the camelCase form.
    const mintIx = await program.methods
      .mintWrapped(
        Array.from(messageIdBytes),
        new anchor.BN(normalizedAmount.toString()),
        new anchor.BN(message.source_chain_id.toString()),
        Array.from(sourceTokenBytes20)
      )
      .accounts({
        payer: payerKeypair.publicKey,
        config: pdas.configPda(program.programId),
        wrappedTokenConfig: wrappedConfigPda,
        wrappedMint: wrappedConfig.wrappedMint,
        mintAuthority: pdas.mintAuthorityPda(program.programId),
        recipient,
        recipientTokenAccount: recipientAta,
        nonce: pdas.noncePda(program.programId, messageIdBytes),
        instructionsSysvar: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const { blockhash } = await connection.getLatestBlockhash("finalized");
    const txMessage = new TransactionMessage({
      payerKey: payerKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [...ed25519Ixs, mintIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(txMessage);
    tx.sign([payerKeypair]);

    const signature = await connection.sendTransaction(tx);
    await connection.confirmTransaction(signature, "finalized");

    await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.SUBMITTED, {
      destination_tx_hash: signature,
    });
    assertTransition(STATES.SUBMITTED, STATES.COMPLETED);
    return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.COMPLETED);
  } catch (err) {
    const nextRetryCount = claimed.retry_count + 1;
    if (nextRetryCount > config.maxRetries) {
      return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.FAILED, {
        last_error: err.message, retry_count: nextRetryCount,
      });
    }
    const delay = config.retryBaseDelayMs * Math.pow(2, nextRetryCount);
    return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.RETRYING, {
      last_error: err.message, retry_count: nextRetryCount,
      next_retry_at: new Date(Date.now() + delay),
    });
  }
}

module.exports = {
  scanForSolanaBurnMessages,
  processSolanaBurnsReadyForUnlock,
  scanForSepoliaLockMessagesForSolana,
  submitSolanaMintMessage,
  toSyntheticTxHash,
  bytesToHexAddress,
  hexAddressToBytes20,
};
