const {
  signMintRequest,
  signUnlockRequest,
  verifyMintSignature,
  verifyUnlockSignature,
} = require("./signer");

// Collect signatures from multiple validators for one mint or unlock request.
// In production each validator runs on a separate machine and exposes an
// HTTP endpoint; here we pass in ethers Wallet instances directly since the
// collection logic itself is identical either way.
async function collectMintSignatures(validatorWallets, bridgeDest, mintRequest, threshold) {
  const signatures = [];
  const signers = [];
  const errors = [];

  for (const wallet of validatorWallets) {
    if (signatures.length >= threshold) break;
    try {
      const sig = await signMintRequest(wallet, bridgeDest, mintRequest);
      const recovered = await verifyMintSignature(bridgeDest, mintRequest, sig);
      if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
        errors.push(`Validator ${wallet.address}: local verify failed`);
        continue;
      }
      signatures.push(sig);
      signers.push(wallet.address);
      console.log(`  Validator ${wallet.address.slice(0, 10)}... signed mint (${signatures.length}/${threshold})`);
    } catch (err) {
      errors.push(`Validator ${wallet.address}: ${err.message}`);
    }
  }

  if (signatures.length < threshold) {
    throw new Error(`Could not collect mint threshold. Got ${signatures.length}/${threshold}. ${errors.join("; ")}`);
  }
  return { signatures, signers };
}

async function collectUnlockSignatures(validatorWallets, bridgeSource, unlockRequest, threshold) {
  const signatures = [];
  const signers = [];
  const errors = [];

  for (const wallet of validatorWallets) {
    if (signatures.length >= threshold) break;
    try {
      const sig = await signUnlockRequest(wallet, bridgeSource, unlockRequest);
      const recovered = await verifyUnlockSignature(bridgeSource, unlockRequest, sig);
      if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
        errors.push(`Validator ${wallet.address}: local verify failed`);
        continue;
      }
      signatures.push(sig);
      signers.push(wallet.address);
      console.log(`  Validator ${wallet.address.slice(0, 10)}... signed unlock (${signatures.length}/${threshold})`);
    } catch (err) {
      errors.push(`Validator ${wallet.address}: ${err.message}`);
    }
  }

  if (signatures.length < threshold) {
    throw new Error(`Could not collect unlock threshold. Got ${signatures.length}/${threshold}. ${errors.join("; ")}`);
  }
  return { signatures, signers };
}

module.exports = { collectMintSignatures, collectUnlockSignatures };
