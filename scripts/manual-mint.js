require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const BRIDGE_DEST = "0xe9a5b54EC0c7B8887471b2FE0890780d32351E5b";
  const USER        = "0x04C62e2f2C53D05103eE77Bb98aF8777C1DED3Df";
  const amount      = hre.ethers.parseEther("10");

  const [signer] = await hre.ethers.getSigners();
  console.log("Signer address:", signer.address);

  const bridgeDest = await hre.ethers.getContractAt("BridgeDest", BRIDGE_DEST);
  
  const owner = await bridgeDest.owner();
  console.log("Contract owner:", owner);
  console.log("Signer is owner:", signer.address.toLowerCase() === owner.toLowerCase());

  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log("Signer MATIC balance:", hre.ethers.formatEther(balance));

  console.log("Attempting mint...");
  const tx = await bridgeDest.mint(USER, amount);
  await tx.wait();
  console.log("Minted 10 wBRT to:", USER);
}

main().catch(console.error);