const crypto = require("crypto");
const nacl = require("tweetnacl");
const { Keypair, PublicKey, Ed25519Program } = require("@solana/web3.js");

// Solana's chain ID as used in bridge_messages/sync_cursor -- see
// solana-program/programs/bridge/src/state.rs SOLANA_CHAIN_ID.
const SOLANA_CHAIN_ID = 901;

// Deterministically derives an ed25519 keypair from the same secp256k1
// private key material already used for EVM signing (VALIDATOR_KEY_1..5).
// This lets one env var per validator drive both signature schemes for
// this demo/testnet setup. A production deployment would give each
// validator machine its own independently-generated ed25519 key instead
// of deriving one from the EVM key.
function deriveEd25519Keypair(evmPrivateKeyHex) {
  const raw = evmPrivateKeyHex.startsWith("0x") ? evmPrivateKeyHex.slice(2) : evmPrivateKeyHex;
  const seed = crypto.createHash("sha256").update(Buffer.from(raw, "hex")).update("solana-ed25519").digest();
  return Keypair.fromSeed(seed);
}

// Byte-for-byte match of solana-program/programs/bridge/src/message.rs's
// signing_digest(): fixed-width big-endian fields, sha256'd once. This is
// the ed25519 equivalent of the EIP-712 struct hash the EVM side signs.
function signingDigest({ messageId, recipient, normalizedAmount, sourceChainId, destChainId, programId }) {
  const messageIdBytes = Buffer.from(messageId.startsWith("0x") ? messageId.slice(2) : messageId, "hex");
  if (messageIdBytes.length !== 32) throw new Error("messageId must be 32 bytes");

  const recipientBytes = new PublicKey(recipient).toBytes();

  const amountBytes = Buffer.alloc(16);
  let amt = BigInt(normalizedAmount);
  for (let i = 15; i >= 0; i--) {
    amountBytes[i] = Number(amt & 0xffn);
    amt >>= 8n;
  }

  const sourceChainBytes = Buffer.alloc(8);
  sourceChainBytes.writeBigUInt64BE(BigInt(sourceChainId));

  const destChainBytes = Buffer.alloc(8);
  destChainBytes.writeBigUInt64BE(BigInt(destChainId));

  const programIdBytes = new PublicKey(programId).toBytes();

  const preimage = Buffer.concat([
    messageIdBytes,
    Buffer.from(recipientBytes),
    amountBytes,
    sourceChainBytes,
    destChainBytes,
    Buffer.from(programIdBytes),
  ]);

  return crypto.createHash("sha256").update(preimage).digest();
}

// Signs the digest and returns both the raw signature and a ready-to-use
// Ed25519Program instruction. `instructionIndex` must be the exact position
// this instruction will occupy in the final transaction -- the on-chain
// program requires each Ed25519Program instruction to be self-referential
// (see solana-program/programs/bridge/src/ed25519.rs).
function signAndBuildIx(keypair, digest, instructionIndex) {
  const signature = nacl.sign.detached(digest, keypair.secretKey);
  const instruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: keypair.publicKey.toBytes(),
    message: digest,
    signature,
    instructionIndex,
  });
  return { signature, instruction, pubkey: keypair.publicKey };
}

module.exports = {
  SOLANA_CHAIN_ID,
  deriveEd25519Keypair,
  signingDigest,
  signAndBuildIx,
};
