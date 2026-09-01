const db = require("./db");
const { computeMessageId } = require("./messageId");
const { STATES, assertTransition } = require("./stateMachine");
const { collectMintSignatures, collectUnlockSignatures } = require("./collector");
const { normalize } = require("./normalizer");

function backoffDelayMs(retryCount, baseDelayMs) {
  return baseDelayMs * Math.pow(2, retryCount);
}

// ── Sepolia → Amoy: scan for TokenLocked events ──────────────────────────────
async function scanForNewMessages({ databaseUrl, bridgeSource, config, fromBlock, toBlock }) {
  const events = await bridgeSource.queryFilter(bridgeSource.filters.TokenLocked(), fromBlock, toBlock);
  if (events.length === 0) return [];

  const newlyDetected = [];

  for (const event of events) {
    const { user, token, amount, decimals } = event.args;
    const normalizedAmount = normalize(amount, Number(decimals));

    const messageId = computeMessageId({
      sourceChainId:      config.sourceChainId,
      destinationChainId: config.destinationChainId,
      sourceTxHash:       event.transactionHash,
      sourceLogIndex:     event.index,
    });

    const { inserted } = await db.insertDetectedMessage(databaseUrl, {
      messageId,
      sourceChainId:      config.sourceChainId,
      destinationChainId: config.destinationChainId,
      sourceTxHash:       event.transactionHash,
      sourceLogIndex:     event.index,
      sourceBlockNumber:  event.blockNumber,
      sender:             user,
      recipient:          user,
      token,
      amount:             normalizedAmount,
      nonce:              messageId,
      direction:          "LOCK",
    });

    if (!inserted) continue;

    assertTransition(STATES.DETECTED, STATES.CONFIRMING);
    const confirming = await db.transitionStatus(databaseUrl, messageId, [STATES.DETECTED], STATES.CONFIRMING);
    if (confirming) newlyDetected.push(confirming);
  }
  return newlyDetected;
}

// ── Amoy → Sepolia: scan for TokensBurned events ─────────────────────────────
async function scanForBurnMessages({ databaseUrl, bridgeDest, config, fromBlock, toBlock }) {
  const events = await bridgeDest.queryFilter(bridgeDest.filters.TokensBurned(), fromBlock, toBlock);
  if (events.length === 0) return [];

  const newlyDetected = [];

  for (const event of events) {
    const { user, sourceToken, amount } = event.args;

    // burn() emits the amount in wrapped-token decimals, which always match
    // the registered source token's decimals — look those up to normalize.
    const cfg = await bridgeDest.tokenConfigs(sourceToken);
    const normalizedAmount = normalize(amount, Number(cfg.decimals));

    // Stored with source/destination swapped relative to the lock direction:
    // the burn happened on what is normally the "destination" chain, and
    // the eventual unlock happens on what is normally the "source" chain.
    const messageId = computeMessageId({
      sourceChainId:      config.destinationChainId,
      destinationChainId: config.sourceChainId,
      sourceTxHash:       event.transactionHash,
      sourceLogIndex:     event.index,
    });

    const { inserted } = await db.insertDetectedMessage(databaseUrl, {
      messageId,
      sourceChainId:      config.destinationChainId,
      destinationChainId: config.sourceChainId,
      sourceTxHash:       event.transactionHash,
      sourceLogIndex:     event.index,
      sourceBlockNumber:  event.blockNumber,
      sender:             user,
      recipient:          user,
      token:              sourceToken,
      amount:             normalizedAmount,
      nonce:              messageId,
      direction:          "BURN",
    });

    if (!inserted) continue;

    assertTransition(STATES.DETECTED, STATES.CONFIRMING);
    const confirming = await db.transitionStatus(databaseUrl, messageId, [STATES.DETECTED], STATES.CONFIRMING);
    if (confirming) newlyDetected.push(confirming);
  }
  return newlyDetected;
}

// ── Check finality for both directions ───────────────────────────────────────
async function checkFinality({ databaseUrl, sourceProvider, destProvider, config }) {
  const sourceBlock = await sourceProvider.getBlockNumber();
  const destBlock   = destProvider ? await destProvider.getBlockNumber() : sourceBlock;

  const allConfirming = [
    ...(await db.getMessagesByStatus(databaseUrl, STATES.CONFIRMING, config.sourceChainId)),
    ...(await db.getMessagesByStatus(databaseUrl, STATES.CONFIRMING, config.destinationChainId)),
  ];

  const finalized = [];
  for (const message of allConfirming) {
    const currentBlock = Number(message.source_chain_id) === config.sourceChainId
      ? sourceBlock
      : destBlock;

    const confirmations = currentBlock - Number(message.source_block_number);
    if (confirmations < config.confirmationsRequired) continue;

    assertTransition(STATES.CONFIRMING, STATES.FINALIZED);
    const updated = await db.transitionStatus(databaseUrl, message.message_id, [STATES.CONFIRMING], STATES.FINALIZED);
    if (updated) finalized.push(updated);
  }
  return finalized;
}

async function failOrRetry({ databaseUrl, config, message, error }) {
  const nextRetryCount = message.retry_count + 1;
  if (nextRetryCount > config.maxRetries) {
    return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.FAILED, {
      last_error: error, retry_count: nextRetryCount,
    });
  }
  const delay = backoffDelayMs(nextRetryCount, config.retryBaseDelayMs);
  return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.RETRYING, {
    last_error: error, retry_count: nextRetryCount,
    next_retry_at: new Date(Date.now() + delay),
  });
}

// ── Submit a mint (Sepolia → Amoy) ───────────────────────────────────────────
async function submitMintMessage({ databaseUrl, bridgeDest, config, message, validatorWallets }) {
  const fromStatus = message.status;
  if (![STATES.FINALIZED, STATES.RETRYING].includes(fromStatus)) return null;

  const alreadyDone = await bridgeDest.processedNonces(message.message_id);
  if (alreadyDone) {
    assertTransition(fromStatus, STATES.COMPLETED);
    return db.transitionStatus(databaseUrl, message.message_id, [fromStatus], STATES.COMPLETED);
  }

  assertTransition(fromStatus, STATES.SUBMITTED);
  const claimed = await db.transitionStatus(databaseUrl, message.message_id, [fromStatus], STATES.SUBMITTED);
  if (!claimed) return null;

  try {
    const mintRequest = {
      messageId:        message.message_id,
      sourceToken:      message.token,
      recipient:        message.recipient,
      normalizedAmount: BigInt(message.amount),
      sourceChainId:    BigInt(message.source_chain_id),
      destChainId:      BigInt(message.destination_chain_id),
    };

    console.log(`Collecting mint signatures for ${message.message_id.slice(0, 10)}...`);
    const { signatures } = await collectMintSignatures(
      validatorWallets, bridgeDest, mintRequest, config.threshold
    );

    const tx = await bridgeDest.mint(
      mintRequest.sourceToken,
      mintRequest.recipient,
      mintRequest.normalizedAmount,
      mintRequest.messageId,
      mintRequest.sourceChainId,
      signatures
    );

    await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.SUBMITTED, {
      destination_tx_hash: tx.hash,
    });

    const receipt = await tx.wait();
    if (receipt.status === 1) {
      assertTransition(STATES.SUBMITTED, STATES.COMPLETED);
      return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.COMPLETED);
    }
    return failOrRetry({ databaseUrl, config, message: claimed, error: "mint tx reverted" });
  } catch (err) {
    return failOrRetry({ databaseUrl, config, message: claimed, error: err.message });
  }
}

// ── Submit an unlock (Amoy → Sepolia) ────────────────────────────────────────
async function submitUnlockMessage({ databaseUrl, bridgeSource, config, message, validatorWallets }) {
  const fromStatus = message.status;
  if (![STATES.FINALIZED, STATES.RETRYING].includes(fromStatus)) return null;

  const alreadyDone = await bridgeSource.processedNonces(message.message_id);
  if (alreadyDone) {
    assertTransition(fromStatus, STATES.COMPLETED);
    return db.transitionStatus(databaseUrl, message.message_id, [fromStatus], STATES.COMPLETED);
  }

  assertTransition(fromStatus, STATES.SUBMITTED);
  const claimed = await db.transitionStatus(databaseUrl, message.message_id, [fromStatus], STATES.SUBMITTED);
  if (!claimed) return null;

  try {
    const unlockRequest = {
      messageId:        message.message_id,
      token:            message.token,
      recipient:        message.recipient,
      normalizedAmount: BigInt(message.amount),
      sourceChainId:    BigInt(message.source_chain_id),
      destChainId:      BigInt(message.destination_chain_id),
    };

    console.log(`Collecting unlock signatures for ${message.message_id.slice(0, 10)}...`);
    const { signatures } = await collectUnlockSignatures(
      validatorWallets, bridgeSource, unlockRequest, config.threshold
    );

    const tx = await bridgeSource.unlockTokens(
      unlockRequest.token,
      unlockRequest.recipient,
      unlockRequest.normalizedAmount,
      unlockRequest.messageId,
      unlockRequest.sourceChainId,
      signatures
    );

    await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.SUBMITTED, {
      destination_tx_hash: tx.hash,
    });

    const receipt = await tx.wait();
    if (receipt.status === 1) {
      assertTransition(STATES.SUBMITTED, STATES.COMPLETED);
      return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.COMPLETED);
    }
    return failOrRetry({ databaseUrl, config, message: claimed, error: "unlock tx reverted" });
  } catch (err) {
    return failOrRetry({ databaseUrl, config, message: claimed, error: err.message });
  }
}

// ── Process all ready messages (both directions) ─────────────────────────────
async function processReadyMessages({ databaseUrl, bridgeSource, bridgeDest, config, validatorWallets }) {
  const lockFinalized = await db.getMessagesByStatus(databaseUrl, STATES.FINALIZED, config.sourceChainId);
  const burnFinalized = await db.getMessagesByStatus(databaseUrl, STATES.FINALIZED, config.destinationChainId);
  const retrying       = await db.getRetryableMessages(databaseUrl);

  const results = [];

  if (bridgeDest) {
    for (const msg of lockFinalized) {
      const r = await submitMintMessage({ databaseUrl, bridgeDest, config, message: msg, validatorWallets });
      if (r) results.push(r);
    }
  }
  if (bridgeSource) {
    for (const msg of burnFinalized) {
      const r = await submitUnlockMessage({ databaseUrl, bridgeSource, config, message: msg, validatorWallets });
      if (r) results.push(r);
    }
  }
  for (const msg of retrying) {
    if (msg.direction === "BURN") {
      if (!bridgeSource) continue;
      const r = await submitUnlockMessage({ databaseUrl, bridgeSource, config, message: msg, validatorWallets });
      if (r) results.push(r);
    } else {
      if (!bridgeDest) continue;
      const r = await submitMintMessage({ databaseUrl, bridgeDest, config, message: msg, validatorWallets });
      if (r) results.push(r);
    }
  }

  return results;
}

async function recoverUnfinishedMessages({ databaseUrl, destProvider, sourceProvider, bridgeSource, bridgeDest, config }) {
  const unfinished = await db.getUnfinishedMessages(databaseUrl);
  const recovered = [];

  for (const message of unfinished) {
    if (message.status !== STATES.SUBMITTED) { recovered.push(message); continue; }

    const isBurn = message.direction === "BURN";
    const contract = isBurn ? bridgeSource : bridgeDest;
    const provider = isBurn ? sourceProvider : destProvider;

    const alreadyDone = await contract.processedNonces(message.message_id);
    if (alreadyDone) {
      recovered.push(await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.COMPLETED));
      continue;
    }

    if (message.destination_tx_hash) {
      const receipt = await provider.getTransactionReceipt(message.destination_tx_hash);
      if (receipt && receipt.status === 1) {
        recovered.push(await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.COMPLETED));
        continue;
      }
    }

    recovered.push(await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.RETRYING, {
      last_error: "recovered after relayer restart",
    }));
  }
  return recovered;
}

module.exports = {
  backoffDelayMs,
  scanForNewMessages,
  scanForBurnMessages,
  checkFinality,
  submitMintMessage,
  submitUnlockMessage,
  processReadyMessages,
  recoverUnfinishedMessages,
};
