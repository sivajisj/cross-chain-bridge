require("dotenv").config();
const hre = require("hardhat");

async function main() {
  console.log("Deploying to Polygon Amoy...");
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "MATIC");

  // Deploy BridgeDest (the wrapped token contract)
  const BridgeDest = await hre.ethers.getContractFactory("BridgeDest");
  const bridge = await BridgeDest.deploy();
  await bridge.waitForDeployment();
  console.log("BridgeDest deployed to:", bridge.target);

  const fs = require("fs");
  const addresses = {
    network: "amoy",
    bridgeDest: bridge.target,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync("deployed-amoy.json", JSON.stringify(addresses, null, 2));
  console.log("Addresses saved to deployed-amoy.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});