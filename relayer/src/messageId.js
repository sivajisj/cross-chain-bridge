const { ethers } = require("ethers");

// A message ID must uniquely and deterministically identify one
// TokenLocked event, computable independently by anyone re-scanning
// the chain. Binding it to (source chain, destination chain, tx hash,
// log index) means:
//   - the same event always produces the same ID, even after a crash
//   - two different events can never collide, even in the same tx
//   - the same source tx replayed toward a different destination
//     chain would not accidentally reuse an ID
// This ID doubles as the on-chain nonce passed into BridgeDest.mint(),
// so it is also what gives us on-chain replay protection.
function computeMessageId({ sourceChainId, destinationChainId, sourceTxHash, sourceLogIndex }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "bytes32", "uint256"],
      [sourceChainId, destinationChainId, sourceTxHash, sourceLogIndex]
    )
  );
}

module.exports = { computeMessageId };