const { ethers } = require("ethers");

// EIP-712 type definitions — must match MINT_TYPEHASH / UNLOCK_TYPEHASH in
// the contracts exactly (field names, types, and order).

const MINT_TYPES = {
  MintRequest: [
    { name: "messageId",        type: "bytes32" },
    { name: "sourceToken",      type: "address" },
    { name: "recipient",        type: "address" },
    { name: "normalizedAmount", type: "uint256" },
    { name: "sourceChainId",    type: "uint256" },
    { name: "destChainId",      type: "uint256" },
  ],
};

const UNLOCK_TYPES = {
  UnlockRequest: [
    { name: "messageId",        type: "bytes32" },
    { name: "token",            type: "address" },
    { name: "recipient",        type: "address" },
    { name: "normalizedAmount", type: "uint256" },
    { name: "sourceChainId",    type: "uint256" },
    { name: "destChainId",      type: "uint256" },
  ],
};

async function buildDomain(contract, domainName) {
  const network = await contract.runner.provider.getNetwork();
  return {
    name: domainName,
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: await contract.getAddress(),
  };
}

// Sign a MintRequest (Sepolia → Amoy direction). wallet's address must be
// registered as a validator on bridgeDest.
async function signMintRequest(wallet, bridgeDest, mintRequest) {
  const domain = await buildDomain(bridgeDest, "CrossChainBridge");
  return wallet.signTypedData(domain, MINT_TYPES, {
    messageId:        mintRequest.messageId,
    sourceToken:      mintRequest.sourceToken,
    recipient:        mintRequest.recipient,
    normalizedAmount: mintRequest.normalizedAmount,
    sourceChainId:    mintRequest.sourceChainId,
    destChainId:      mintRequest.destChainId,
  });
}

// Sign an UnlockRequest (Amoy → Sepolia direction).
async function signUnlockRequest(wallet, bridgeSource, unlockRequest) {
  const domain = await buildDomain(bridgeSource, "CrossChainBridgeSource");
  return wallet.signTypedData(domain, UNLOCK_TYPES, {
    messageId:        unlockRequest.messageId,
    token:            unlockRequest.token,
    recipient:        unlockRequest.recipient,
    normalizedAmount: unlockRequest.normalizedAmount,
    sourceChainId:    unlockRequest.sourceChainId,
    destChainId:      unlockRequest.destChainId,
  });
}

async function verifyMintSignature(bridgeDest, mintRequest, signature) {
  const domain = await buildDomain(bridgeDest, "CrossChainBridge");
  return ethers.verifyTypedData(domain, MINT_TYPES, mintRequest, signature);
}

async function verifyUnlockSignature(bridgeSource, unlockRequest, signature) {
  const domain = await buildDomain(bridgeSource, "CrossChainBridgeSource");
  return ethers.verifyTypedData(domain, UNLOCK_TYPES, unlockRequest, signature);
}

module.exports = {
  signMintRequest,
  signUnlockRequest,
  verifyMintSignature,
  verifyUnlockSignature,
  MINT_TYPES,
  UNLOCK_TYPES,
  buildDomain,
};
