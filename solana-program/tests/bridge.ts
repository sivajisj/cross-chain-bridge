import * as anchor from "@anchor-lang/core";
import BN from "bn.js";
const { web3 } = anchor;
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import * as crypto from "crypto";
import nacl from "tweetnacl";
import * as fs from "fs";

// Read relative to process.cwd() (anchor test / ts-mocha both run from the
// solana-program/ package root) rather than __dirname, which isn't
// available in this ESM execution context.
const idl = JSON.parse(fs.readFileSync("target/idl/bridge.json", "utf8"));

const SOLANA_CHAIN_ID = 901;
const SEPOLIA_CHAIN_ID = 11155111;
const SYSVAR_INSTRUCTIONS_ID = new web3.PublicKey("Sysvar1nstructions1111111111111111111111111");

// Mirrors solana-program/programs/bridge/src/message.rs::signing_digest()
// and relayer/src/solana/signer.js::signingDigest() byte-for-byte.
function signingDigest(opts: {
  messageId: Buffer;
  recipient: web3.PublicKey;
  normalizedAmount: bigint;
  sourceChainId: number;
  destChainId: number;
  programId: web3.PublicKey;
}): Buffer {
  const amountBytes = Buffer.alloc(16);
  let amt = opts.normalizedAmount;
  for (let i = 15; i >= 0; i--) {
    amountBytes[i] = Number(amt & BigInt(0xff));
    amt >>= BigInt(8);
  }
  const sourceChainBytes = Buffer.alloc(8);
  sourceChainBytes.writeBigUInt64BE(BigInt(opts.sourceChainId));
  const destChainBytes = Buffer.alloc(8);
  destChainBytes.writeBigUInt64BE(BigInt(opts.destChainId));

  const preimage = Buffer.concat([
    opts.messageId,
    opts.recipient.toBuffer(),
    amountBytes,
    sourceChainBytes,
    destChainBytes,
    opts.programId.toBuffer(),
  ]);
  return crypto.createHash("sha256").update(preimage).digest();
}

function buildThresholdEd25519Ixs(
  validators: web3.Keypair[],
  threshold: number,
  digest: Buffer
): web3.TransactionInstruction[] {
  const ixs: web3.TransactionInstruction[] = [];
  for (let i = 0; i < threshold; i++) {
    const kp = validators[i];
    const signature = nacl.sign.detached(digest, kp.secretKey);
    ixs.push(
      web3.Ed25519Program.createInstructionWithPublicKey({
        publicKey: kp.publicKey.toBytes(),
        message: digest,
        signature,
        instructionIndex: i,
      })
    );
  }
  return ixs;
}

function pda(seeds: (Buffer | Uint8Array)[], programId: web3.PublicKey): web3.PublicKey {
  return web3.PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function leBytes8(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

describe("bridge", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const admin = provider.wallet as anchor.Wallet;
  const validators = Array.from({ length: 5 }, () => web3.Keypair.generate());
  const threshold = 3;

  const configPda = pda([Buffer.from("config")], program.programId);
  const mintAuthorityPda = pda([Buffer.from("mint_authority")], program.programId);

  let nativeMint: web3.PublicKey;
  let userWallet: web3.Keypair;
  let userAta: web3.PublicKey;
  let nativeTokenConfigPda: web3.PublicKey;
  let vaultAuthorityPda: web3.PublicKey;
  let vaultAta: web3.PublicKey;

  const sourceTokenEvm = Buffer.from("111111111111111111111111111111111111abcd", "hex"); // 20 bytes
  let wrappedTokenConfigPda: web3.PublicKey;
  let wrappedMint: web3.PublicKey;

  before(async () => {
    userWallet = web3.Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(userWallet.publicKey, 2 * web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig, "confirmed");

    nativeMint = await createMint(provider.connection, (admin as any).payer, admin.publicKey, null, 9);
    userAta = await createAssociatedTokenAccount(provider.connection, userWallet, nativeMint, userWallet.publicKey);
    await mintTo(provider.connection, (admin as any).payer, nativeMint, userAta, admin.publicKey, 3_000_000_000);

    nativeTokenConfigPda = pda([Buffer.from("token_config"), nativeMint.toBuffer()], program.programId);
    vaultAuthorityPda = pda([Buffer.from("vault_authority"), nativeMint.toBuffer()], program.programId);
    vaultAta = getAssociatedTokenAddressSync(nativeMint, vaultAuthorityPda, true);

    wrappedTokenConfigPda = pda(
      [Buffer.from("wrapped"), leBytes8(SEPOLIA_CHAIN_ID), sourceTokenEvm],
      program.programId
    );
  });

  it("initializes the bridge config with 5 validators and threshold 3", async () => {
    await program.methods
      .initialize(
        validators.map((v) => v.publicKey),
        threshold
      )
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    expect(config.threshold).to.equal(threshold);
    expect(config.validators.map((v: web3.PublicKey) => v.toBase58())).to.deep.equal(
      validators.map((v) => v.publicKey.toBase58())
    );
    expect(config.paused).to.equal(false);
  });

  it("registers a native SPL token for locking", async () => {
    await program.methods
      .registerNativeToken(new BN(1), new BN("1000000000000"))
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        mint: nativeMint,
        tokenConfig: nativeTokenConfigPda,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.nativeTokenConfig.fetch(nativeTokenConfigPda);
    expect(cfg.enabled).to.equal(true);
    expect(cfg.decimals).to.equal(9);
  });

  it("registers a wrapped SPL mint representing a Sepolia-origin ERC-20", async () => {
    const wrappedMintKeypair = web3.Keypair.generate();
    wrappedMint = wrappedMintKeypair.publicKey;

    await program.methods
      .registerWrappedToken(Array.from(sourceTokenEvm), new BN(SEPOLIA_CHAIN_ID), 18)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        mintAuthority: mintAuthorityPda,
        wrappedMint: wrappedMint,
        wrappedTokenConfig: wrappedTokenConfigPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([wrappedMintKeypair])
      .rpc();

    const cfg = await program.account.wrappedTokenConfig.fetch(wrappedTokenConfigPda);
    expect(cfg.wrappedMint.toBase58()).to.equal(wrappedMint.toBase58());
    expect(cfg.decimals).to.equal(18);
  });

  it("locks native SPL tokens into the vault and emits LockEvent", async () => {
    const lockAmount = new BN(2_000_000_000); // leaves enough in the vault for the later unlock test

    const sig = await program.methods
      .lockTokens(lockAmount, new BN(SEPOLIA_CHAIN_ID))
      .accounts({
        user: userWallet.publicKey,
        config: configPda,
        mint: nativeMint,
        tokenConfig: nativeTokenConfigPda,
        userTokenAccount: userAta,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associated_tokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([userWallet])
      .rpc();

    await provider.connection.confirmTransaction(sig, "confirmed");
    const vaultAccount = await getAccount(provider.connection, vaultAta);
    expect(vaultAccount.amount.toString()).to.equal("2000000000");
  });

  it("mints wrapped tokens after verifying threshold ed25519 signatures", async () => {
    const messageId = crypto.randomBytes(32);
    const recipient = userWallet.publicKey;
    const normalizedAmount = BigInt("1000000000000000000"); // 1 token, 18 decimals canonical

    const digest = signingDigest({
      messageId,
      recipient,
      normalizedAmount,
      sourceChainId: SEPOLIA_CHAIN_ID,
      destChainId: SOLANA_CHAIN_ID,
      programId: program.programId,
    });
    const ed25519Ixs = buildThresholdEd25519Ixs(validators, threshold, digest);

    const noncePda = pda([Buffer.from("nonce"), messageId], program.programId);
    const recipientAta = getAssociatedTokenAddressSync(wrappedMint, recipient, true);

    const mintIx = await program.methods
      .mintWrapped(Array.from(messageId), new BN(normalizedAmount.toString()), new BN(SEPOLIA_CHAIN_ID), Array.from(sourceTokenEvm))
      .accounts({
        payer: admin.publicKey,
        config: configPda,
        wrappedTokenConfig: wrappedTokenConfigPda,
        wrappedMint: wrappedMint,
        mintAuthority: mintAuthorityPda,
        recipient,
        recipientTokenAccount: recipientAta,
        nonce: noncePda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associated_tokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();

    const tx = new web3.Transaction().add(...ed25519Ixs, mintIx);
    await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });

    const recipientAccount = await getAccount(provider.connection, recipientAta);
    // 1e18 normalized -> denormalized to 18 decimals is a no-op: 1e18 raw units.
    expect(recipientAccount.amount.toString()).to.equal(normalizedAmount.toString());
  });

  it("rejects a mint replay of the same message_id", async () => {
    // Re-use of a previously-processed message_id must fail because the
    // nonce PDA already exists -- replay protection, same idea as
    // BridgeDest.sol's processedNonces mapping.
    const messageId = crypto.randomBytes(32);
    const recipient = userWallet.publicKey;
    const normalizedAmount = BigInt("1000000000000000000");

    const digest = signingDigest({
      messageId,
      recipient,
      normalizedAmount,
      sourceChainId: SEPOLIA_CHAIN_ID,
      destChainId: SOLANA_CHAIN_ID,
      programId: program.programId,
    });
    const ed25519Ixs = buildThresholdEd25519Ixs(validators, threshold, digest);
    const noncePda = pda([Buffer.from("nonce"), messageId], program.programId);
    const recipientAta = getAssociatedTokenAddressSync(wrappedMint, recipient, true);

    const accounts = {
      payer: admin.publicKey,
      config: configPda,
      wrappedTokenConfig: wrappedTokenConfigPda,
      wrappedMint: wrappedMint,
      mintAuthority: mintAuthorityPda,
      recipient,
      recipientTokenAccount: recipientAta,
      nonce: noncePda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associated_tokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    };
    const args = [Array.from(messageId), new BN(normalizedAmount.toString()), new BN(SEPOLIA_CHAIN_ID), Array.from(sourceTokenEvm)] as const;

    const firstIx = await program.methods.mintWrapped(...args).accounts(accounts).instruction();
    await provider.sendAndConfirm(new web3.Transaction().add(...ed25519Ixs, firstIx), [], { commitment: "confirmed" });

    const secondIx = await program.methods.mintWrapped(...args).accounts(accounts).instruction();
    let threw = false;
    try {
      await provider.sendAndConfirm(new web3.Transaction().add(...ed25519Ixs, secondIx), [], { commitment: "confirmed" });
    } catch (err) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it("rejects a mint with fewer than threshold signatures", async () => {
    const messageId = crypto.randomBytes(32);
    const recipient = userWallet.publicKey;
    const normalizedAmount = BigInt("1000000000000000000");

    const digest = signingDigest({
      messageId,
      recipient,
      normalizedAmount,
      sourceChainId: SEPOLIA_CHAIN_ID,
      destChainId: SOLANA_CHAIN_ID,
      programId: program.programId,
    });
    // Only 2 signatures, below the threshold of 3.
    const ed25519Ixs = buildThresholdEd25519Ixs(validators, 2, digest);
    const noncePda = pda([Buffer.from("nonce"), messageId], program.programId);
    const recipientAta = getAssociatedTokenAddressSync(wrappedMint, recipient, true);

    const mintIx = await program.methods
      .mintWrapped(Array.from(messageId), new BN(normalizedAmount.toString()), new BN(SEPOLIA_CHAIN_ID), Array.from(sourceTokenEvm))
      .accounts({
        payer: admin.publicKey,
        config: configPda,
        wrappedTokenConfig: wrappedTokenConfigPda,
        wrappedMint: wrappedMint,
        mintAuthority: mintAuthorityPda,
        recipient,
        recipientTokenAccount: recipientAta,
        nonce: noncePda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associated_tokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();

    let threw = false;
    try {
      await provider.sendAndConfirm(new web3.Transaction().add(...ed25519Ixs, mintIx), [], { commitment: "confirmed" });
    } catch (err) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it("burns wrapped tokens and emits BurnEvent", async () => {
    const recipientAta = getAssociatedTokenAddressSync(wrappedMint, userWallet.publicKey, true);
    const recipientEvm = Buffer.from("222222222222222222222222222222222222dcba", "hex");

    const sig = await program.methods
      .burnWrapped(new BN("1000000000000000000"), new BN(SEPOLIA_CHAIN_ID), Array.from(recipientEvm))
      .accounts({
        user: userWallet.publicKey,
        config: configPda,
        wrappedTokenConfig: wrappedTokenConfigPda,
        wrappedMint: wrappedMint,
        userTokenAccount: recipientAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userWallet])
      .rpc();

    await provider.connection.confirmTransaction(sig, "confirmed");
    const account = await getAccount(provider.connection, recipientAta);
    expect(account.amount.toString()).to.equal("1000000000000000000"); // one mint (1e18) survives after burning the other
  });

  it("unlocks native SPL tokens back to the recipient after verifying threshold signatures", async () => {
    const messageId = crypto.randomBytes(32);
    const recipient = userWallet.publicKey;
    const normalizedAmount = BigInt("1000000000000000000"); // 1 token, normalized 18dp -> 1e9 raw at 9 decimals

    const digest = signingDigest({
      messageId,
      recipient,
      normalizedAmount,
      sourceChainId: SEPOLIA_CHAIN_ID,
      destChainId: SOLANA_CHAIN_ID,
      programId: program.programId,
    });
    const ed25519Ixs = buildThresholdEd25519Ixs(validators, threshold, digest);
    const noncePda = pda([Buffer.from("nonce"), messageId], program.programId);
    const recipientAta = userAta;

    const before = await getAccount(provider.connection, recipientAta);

    const unlockIx = await program.methods
      .unlockTokens(Array.from(messageId), new BN(normalizedAmount.toString()), new BN(SEPOLIA_CHAIN_ID))
      .accounts({
        payer: admin.publicKey,
        config: configPda,
        mint: nativeMint,
        tokenConfig: nativeTokenConfigPda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount: vaultAta,
        recipient,
        recipientTokenAccount: recipientAta,
        nonce: noncePda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associated_tokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();

    await provider.sendAndConfirm(new web3.Transaction().add(...ed25519Ixs, unlockIx), [], { commitment: "confirmed" });

    const after = await getAccount(provider.connection, recipientAta);
    expect((after.amount - before.amount).toString()).to.equal("1000000000"); // 1e18 normalized -> 1e9 raw at 9 decimals
  });
});
