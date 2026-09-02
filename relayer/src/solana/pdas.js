const { PublicKey } = require("@solana/web3.js");

// Mirrors the exact seeds used in solana-program/programs/bridge/src/instructions/*.rs.
// Centralized here so the relayer never hand-derives a PDA address that
// could silently drift from the on-chain program.

function leBytes8(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function configPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

function mintAuthorityPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from("mint_authority")], programId)[0];
}

function nativeTokenConfigPda(programId, mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_config"), new PublicKey(mint).toBuffer()],
    programId
  )[0];
}

function vaultAuthorityPda(programId, mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), new PublicKey(mint).toBuffer()],
    programId
  )[0];
}

function wrappedTokenConfigPda(programId, sourceChainId, sourceTokenBytes20) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wrapped"), leBytes8(sourceChainId), Buffer.from(sourceTokenBytes20)],
    programId
  )[0];
}

function noncePda(programId, messageIdBytes32) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nonce"), Buffer.from(messageIdBytes32)],
    programId
  )[0];
}

module.exports = {
  leBytes8,
  configPda,
  mintAuthorityPda,
  nativeTokenConfigPda,
  vaultAuthorityPda,
  wrappedTokenConfigPda,
  noncePda,
};
