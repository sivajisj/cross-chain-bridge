const { ethers } = require("ethers");

// The EIP-712 domain definition must match exactly what BridgeDest
// was constructed with: name="CrossChainBridge", version="1".
// The contract's address and chainId are fetched at runtime so this
// works correctly against any deployment without hardcoding.
async function buildDomain(bridgeDest) {
  const network = await bridgeDest.runner.provider.getNetwork();
  return {
    name: "CrossChainBridge",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: await bridgeDest.getAddress(),
  };
}

// The typed data structure must match MINT_TYPEHASH in BridgeDest.sol
// field for field, name for name, type for type.
const MINT_TYPES = {
  MintRequest: [
    { name: "messageId",     type: "bytes32"  },
    { name: "recipient",     type: "address"  },
    { name: "amount",        type: "uint256"  },
    { name: "sourceChainId", type: "uint256"  },
    { name: "destChainId",   type: "uint256"  },
  ],
};

// Sign one MintRequest as a validator.
// wallet       — ethers Wallet instance for this validator
// bridgeDest   — contract instance (connected to destination provider)
// mintRequest  — { messageId, recipient, amount, sourceChainId, destChainId }
//
// Returns a 65-byte ECDSA signature (hex string).
// The contract recovers the signer from this signature and checks
// it against its validator set — so the wallet address here must
// have been added as a validator when BridgeDest was deployed.
async function signMintRequest(wallet, bridgeDest, mintRequest) {
  const domain = await buildDomain(bridgeDest);

  const value = {
    messageId:     mintRequest.messageId,
    recipient:     mintRequest.recipient,
    amount:        mintRequest.amount,
    sourceChainId: mintRequest.sourceChainId,
    destChainId:   mintRequest.destChainId,
  };

  // ethers v6 signTypedData handles EIP-712 encoding and signing
  const signature = await wallet.signTypedData(domain, MINT_TYPES, value);
  return signature;
}

// Verify a signature locally before submitting on-chain.
// Used by the relayer to filter out bad signatures before wasting gas.
async function verifySignature(bridgeDest, mintRequest, signature) {
  const domain = await buildDomain(bridgeDest);
  const value = {
    messageId:     mintRequest.messageId,
    recipient:     mintRequest.recipient,
    amount:        mintRequest.amount,
    sourceChainId: mintRequest.sourceChainId,
    destChainId:   mintRequest.destChainId,
  };

  const recovered = ethers.verifyTypedData(domain, MINT_TYPES, value, signature);
  return recovered;
}

module.exports = { signMintRequest, verifySignature, buildDomain, MINT_TYPES };
