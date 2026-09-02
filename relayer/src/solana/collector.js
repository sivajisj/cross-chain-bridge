const { signingDigest, signAndBuildIx } = require("./signer");

// Collects `threshold` distinct validator ed25519 signatures over one
// mint/unlock request and returns them as ready-to-use Ed25519Program
// instructions, in the exact order they'll be placed in the transaction
// (indices 0..threshold-1), immediately before the bridge instruction
// itself. Mirrors relayer/src/collector.js's collectMintSignatures /
// collectUnlockSignatures, just producing Solana instructions instead of
// EIP-712 signature bytes.
async function collectEd25519Signatures(validatorKeypairs, request, threshold) {
  const digest = signingDigest(request);
  const instructions = [];
  const signers = [];
  const errors = [];

  for (const keypair of validatorKeypairs) {
    if (instructions.length >= threshold) break;
    try {
      const { instruction, pubkey } = signAndBuildIx(keypair, digest, instructions.length);
      instructions.push(instruction);
      signers.push(pubkey.toBase58());
      console.log(`  Validator ${pubkey.toBase58().slice(0, 10)}... signed (${instructions.length}/${threshold})`);
    } catch (err) {
      errors.push(`Validator ${keypair.publicKey.toBase58()}: ${err.message}`);
    }
  }

  if (instructions.length < threshold) {
    throw new Error(`Could not collect Solana threshold. Got ${instructions.length}/${threshold}. ${errors.join("; ")}`);
  }
  return { instructions, signers, digest };
}

module.exports = { collectEd25519Signatures };
