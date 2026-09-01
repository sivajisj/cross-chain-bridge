const { signMintRequest, verifySignature } = require("./signer");

// Collect signatures from multiple validators for one mint request.
//
// In production each validator runs on a separate machine and exposes
// an HTTP endpoint. For Phase 2 we pass in ethers Wallet instances
// directly — the collection logic is identical, only the transport
// changes in Phase 5 when we add the real validator network.
//
// Parameters:
//   validatorWallets — array of ethers.Wallet (the 5 validators)
//   bridgeDest       — contract instance on destination chain
//   mintRequest      — { messageId, recipient, amount, sourceChainId, destChainId }
//   threshold        — minimum signatures needed
//
// Returns { signatures, signers } once threshold is reached,
// or throws if not enough validators could sign successfully.
async function collectSignatures(validatorWallets, bridgeDest, mintRequest, threshold) {
  const signatures = [];
  const signers = [];
  const errors = [];

  for (const wallet of validatorWallets) {
    if (signatures.length >= threshold) break; // stop once we have enough

    try {
      const sig = await signMintRequest(wallet, bridgeDest, mintRequest);

      // Verify locally before counting it — a bad sig wastes gas on-chain
      const recovered = await verifySignature(bridgeDest, mintRequest, sig);
      if (recovered.toLowerCase() !== wallet.address.toLowerCase()) {
        errors.push(`Validator ${wallet.address}: signature verification failed`);
        continue;
      }

      signatures.push(sig);
      signers.push(wallet.address);
      console.log(`  Validator ${wallet.address.slice(0, 10)}... signed (${signatures.length}/${threshold})`);
    } catch (err) {
      errors.push(`Validator ${wallet.address}: ${err.message}`);
    }
  }

  if (signatures.length < threshold) {
    throw new Error(
      `Could not collect threshold signatures. Got ${signatures.length}/${threshold}. ` +
      `Errors: ${errors.join("; ")}`
    );
  }

  return { signatures, signers };
}

module.exports = { collectSignatures };
