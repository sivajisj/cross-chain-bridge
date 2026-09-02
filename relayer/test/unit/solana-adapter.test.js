const { expect } = require("chai");
const crypto = require("crypto");
const nacl = require("tweetnacl");
const anchor = require("@anchor-lang/core");
const { Keypair, Connection } = require("@solana/web3.js");

const db = require("../../src/db");
const { STATES } = require("../../src/stateMachine");
const signer = require("../../src/solana/signer");
const { collectEd25519Signatures } = require("../../src/solana/collector");
const pdas = require("../../src/solana/pdas");
const adapter = require("../../src/solana/adapter");
const bridgeIdl = require("../../src/solana/idl.json");

const TEST_DB = process.env.TEST_DATABASE_URL ||
  "postgres://bridge:bridge@localhost:5432/bridge_relayer_test";

const baseDigestInput = {
  messageId: "0x" + "aa".repeat(32),
  recipient: Keypair.generate().publicKey.toBase58(),
  normalizedAmount: 1_000_000_000_000_000_000n,
  sourceChainId: 11155111,
  destChainId: 901,
  programId: Keypair.generate().publicKey.toBase58(),
};

describe("solana/signer: signingDigest", function () {
  it("is deterministic for identical inputs", function () {
    expect(signer.signingDigest(baseDigestInput)).to.deep.equal(signer.signingDigest({ ...baseDigestInput }));
  });

  it("changes when the normalized amount changes", function () {
    const other = signer.signingDigest({ ...baseDigestInput, normalizedAmount: baseDigestInput.normalizedAmount + 1n });
    expect(signer.signingDigest(baseDigestInput).equals(other)).to.equal(false);
  });

  it("changes when the recipient changes", function () {
    const other = signer.signingDigest({ ...baseDigestInput, recipient: Keypair.generate().publicKey.toBase58() });
    expect(signer.signingDigest(baseDigestInput).equals(other)).to.equal(false);
  });

  it("changes when source or dest chain id changes", function () {
    const otherSource = signer.signingDigest({ ...baseDigestInput, sourceChainId: 80002 });
    const otherDest = signer.signingDigest({ ...baseDigestInput, destChainId: 80002 });
    expect(signer.signingDigest(baseDigestInput).equals(otherSource)).to.equal(false);
    expect(signer.signingDigest(baseDigestInput).equals(otherDest)).to.equal(false);
  });

  it("produces a 32-byte digest", function () {
    expect(signer.signingDigest(baseDigestInput).length).to.equal(32);
  });
});

describe("solana/signer: deriveEd25519Keypair + signAndBuildIx", function () {
  it("deterministically derives the same ed25519 keypair from the same EVM key", function () {
    const evmKey = "0x" + "11".repeat(32);
    const a = signer.deriveEd25519Keypair(evmKey);
    const b = signer.deriveEd25519Keypair(evmKey);
    expect(a.publicKey.toBase58()).to.equal(b.publicKey.toBase58());
  });

  it("derives different keypairs for different EVM keys", function () {
    const a = signer.deriveEd25519Keypair("0x" + "11".repeat(32));
    const b = signer.deriveEd25519Keypair("0x" + "22".repeat(32));
    expect(a.publicKey.toBase58()).to.not.equal(b.publicKey.toBase58());
  });

  it("produces a signature that verifies against the digest and rejects a tampered digest", function () {
    const keypair = signer.deriveEd25519Keypair("0x" + "33".repeat(32));
    const digest = signer.signingDigest(baseDigestInput);
    const { signature } = signer.signAndBuildIx(keypair, digest, 0);

    expect(nacl.sign.detached.verify(digest, signature, keypair.publicKey.toBytes())).to.equal(true);

    const tampered = Buffer.from(digest);
    tampered[0] ^= 0xff;
    expect(nacl.sign.detached.verify(tampered, signature, keypair.publicKey.toBytes())).to.equal(false);
  });

  it("builds a self-referential Ed25519Program instruction at the given index", function () {
    const keypair = signer.deriveEd25519Keypair("0x" + "44".repeat(32));
    const digest = signer.signingDigest(baseDigestInput);
    const { instruction } = signer.signAndBuildIx(keypair, digest, 2);
    expect(instruction.programId.toBase58()).to.equal("Ed25519SigVerify111111111111111111111111111");
  });
});

describe("solana/collector: collectEd25519Signatures", function () {
  const validators = Array.from({ length: 5 }, () => Keypair.generate());

  it("collects exactly `threshold` signatures from the first available validators", async function () {
    const { instructions, signers } = await collectEd25519Signatures(validators, baseDigestInput, 3);
    expect(instructions.length).to.equal(3);
    expect(signers.length).to.equal(3);
    expect(new Set(signers).size).to.equal(3); // all distinct
    expect(signers).to.deep.equal(validators.slice(0, 3).map((v) => v.publicKey.toBase58()));
  });

  it("throws when fewer validators are available than the threshold", async function () {
    let threw = false;
    try {
      await collectEd25519Signatures(validators.slice(0, 2), baseDigestInput, 3);
    } catch (err) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});

describe("solana/pdas", function () {
  const programId = Keypair.generate().publicKey;
  const mintA = Keypair.generate().publicKey;
  const mintB = Keypair.generate().publicKey;

  it("configPda/mintAuthorityPda are deterministic and program-scoped", function () {
    expect(pdas.configPda(programId).toBase58()).to.equal(pdas.configPda(programId).toBase58());
    expect(pdas.configPda(programId).toBase58()).to.not.equal(pdas.mintAuthorityPda(programId).toBase58());
  });

  it("nativeTokenConfigPda/vaultAuthorityPda differ per mint", function () {
    expect(pdas.nativeTokenConfigPda(programId, mintA).toBase58()).to.not.equal(
      pdas.nativeTokenConfigPda(programId, mintB).toBase58()
    );
    expect(pdas.vaultAuthorityPda(programId, mintA).toBase58()).to.not.equal(
      pdas.vaultAuthorityPda(programId, mintB).toBase58()
    );
  });

  it("wrappedTokenConfigPda differs per (sourceChainId, sourceToken)", function () {
    const tokenA = Buffer.alloc(20, 1);
    const tokenB = Buffer.alloc(20, 2);
    const a = pdas.wrappedTokenConfigPda(programId, 11155111, tokenA).toBase58();
    const b = pdas.wrappedTokenConfigPda(programId, 11155111, tokenB).toBase58();
    const c = pdas.wrappedTokenConfigPda(programId, 80002, tokenA).toBase58();
    expect(a).to.not.equal(b);
    expect(a).to.not.equal(c);
  });

  it("noncePda differs per message id", function () {
    const id1 = crypto.randomBytes(32);
    const id2 = crypto.randomBytes(32);
    expect(pdas.noncePda(programId, id1).toBase58()).to.not.equal(pdas.noncePda(programId, id2).toBase58());
  });
});

// Builds a valid "Program data: <base64>" log line for a BurnEvent, using
// the real discriminator from the compiled IDL and the exact Borsh layout
// solana-program/programs/bridge/src/events.rs::BurnEvent serializes to.
// This lets the adapter's real EventParser/BorshCoder decode it, without
// needing a live validator.
function encodeBurnEventLog({ user, sourceToken, sourceChainId, amount, recipientEvm, destChainId }) {
  const discriminator = Buffer.from(bridgeIdl.events.find((e) => e.name === "BurnEvent").discriminator);
  const parts = [
    discriminator,
    user.toBuffer(),
    Keypair.generate().publicKey.toBuffer(), // wrapped_mint (unused by the adapter)
    Buffer.from(sourceToken),
    le64(sourceChainId),
    le64(amount),
    Buffer.from(recipientEvm),
    le64(destChainId),
    le64(Math.floor(Date.now() / 1000)), // timestamp
  ];
  return "Program data: " + Buffer.concat(parts).toString("base64");
}

function le64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

describe("solana/adapter: scanForSolanaBurnMessages (mocked RPC, real DB)", function () {
  let program;

  before(async function () {
    await db.migrate(TEST_DB);
    const pool = db.getPool(TEST_DB);
    await pool.query("TRUNCATE bridge_messages, sync_cursor");

    const provider = new anchor.AnchorProvider(new Connection("http://127.0.0.1:8899"), new anchor.Wallet(Keypair.generate()), {});
    program = new anchor.Program(bridgeIdl, provider);
  });

  after(async function () {
    await db.closePool();
  });

  it("returns [] and touches nothing when there are no new signatures", async function () {
    const connection = {
      getSignaturesForAddress: async () => [],
    };
    const result = await adapter.scanForSolanaBurnMessages({
      databaseUrl: TEST_DB,
      connection,
      program,
      config: { solanaScanBatchSize: 200 },
    });
    expect(result).to.deep.equal([]);
  });

  it("detects a BurnEvent and drives the row DETECTED -> CONFIRMING -> FINALIZED", async function () {
    const user = Keypair.generate().publicKey;
    const sourceToken = Buffer.alloc(20, 0xab);
    const recipientEvm = Buffer.alloc(20, 0xcd);
    const signature = "5" + crypto.randomBytes(32).toString("hex").slice(0, 87); // fake but unique base58-ish signature

    const logLine = encodeBurnEventLog({
      user,
      sourceToken,
      sourceChainId: 11155111,
      amount: 1_000_000_000n, // 9-decimal wrapped amount
      recipientEvm,
      destChainId: 11155111,
    });

    const connection = {
      getSignaturesForAddress: async () => [{ signature, slot: 12345, err: null }],
      getTransaction: async () => ({
        meta: {
          logMessages: [
            `Program ${program.programId.toBase58()} invoke [1]`,
            logLine,
            `Program ${program.programId.toBase58()} success`,
          ],
        },
      }),
    };

    // Stand in for the on-chain WrappedTokenConfig account this event's
    // PDA would resolve to -- we're mocking the RPC, not the program logic.
    const originalFetch = program.account.wrappedTokenConfig.fetch;
    program.account.wrappedTokenConfig.fetch = async () => ({ decimals: 9 });

    let detected;
    try {
      detected = await adapter.scanForSolanaBurnMessages({
        databaseUrl: TEST_DB,
        connection,
        program,
        config: { solanaScanBatchSize: 200 },
      });
    } finally {
      program.account.wrappedTokenConfig.fetch = originalFetch;
    }

    expect(detected.length).to.equal(1);
    expect(detected[0].status).to.equal(STATES.FINALIZED);
    expect(detected[0].direction).to.equal("BURN");
    expect(Number(detected[0].source_chain_id)).to.equal(901);
    expect(Number(detected[0].destination_chain_id)).to.equal(11155111);
    expect(detected[0].sender).to.equal(user.toBase58());

    // Re-scanning the same signature must not double-insert (sync_cursor
    // has already advanced past its slot).
    const second = await adapter.scanForSolanaBurnMessages({
      databaseUrl: TEST_DB,
      connection,
      program,
      config: { solanaScanBatchSize: 200 },
    });
    expect(second).to.deep.equal([]);
  });
});

describe("solana/adapter: pure helpers", function () {
  it("toSyntheticTxHash is deterministic and well-formed", function () {
    const a = adapter.toSyntheticTxHash("abc123");
    const b = adapter.toSyntheticTxHash("abc123");
    expect(a).to.equal(b);
    expect(a).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("bytesToHexAddress/hexAddressToBytes20 round-trip", function () {
    const addr = "0x" + "ab".repeat(20);
    const bytes = adapter.hexAddressToBytes20(addr);
    expect(bytes.length).to.equal(20);
    expect(adapter.bytesToHexAddress(bytes).toLowerCase()).to.equal(addr);
  });
});
