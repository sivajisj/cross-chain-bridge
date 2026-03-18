require("dotenv").config();
const hre = require("hardhat");

async function main() {
  console.log("Deploying to Sepolia...");
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");

  // Deploy MockERC20 (the token we'll bridge)
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy();
  await token.waitForDeployment();
  console.log("MockERC20 deployed to:", token.target);

  // Deploy BridgeSource
  const BridgeSource = await hre.ethers.getContractFactory("BridgeSource");
  const bridge = await BridgeSource.deploy(token.target);
  await bridge.waitForDeployment();
  console.log("BridgeSource deployed to:", bridge.target);

  // Save addresses — we need these for the relayer and frontend
  const fs = require("fs");
  const addresses = {
    network: "sepolia",
    token: token.target,
    bridgeSource: bridge.target,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync("deployed-sepolia.json", JSON.stringify(addresses, null, 2));
  console.log("Addresses saved to deployed-sepolia.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});