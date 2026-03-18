require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const BRIDGE_DEST    = "0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b";
  const RELAYER_WALLET = "0x21abDd5D4e1cFe21E3885AC932eAF021ED744A62";

  const bridgeDest = await hre.ethers.getContractAt("BridgeDest", BRIDGE_DEST);
  const tx = await bridgeDest.transferOwnership(RELAYER_WALLET);
  await tx.wait();
  console.log("Ownership transferred to relayer:", RELAYER_WALLET);
}

main().catch(console.error);