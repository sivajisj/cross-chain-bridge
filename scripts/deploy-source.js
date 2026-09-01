require("dotenv").config();
const hre = require("hardhat");

async function main() {
  console.log("Deploying to Sepolia (Phase 3 — multi-validator, multi-token)...");
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");

  // ── Validator addresses ──────────────────────────────────────────────────
  // Same validator set BridgeDest is deployed with — both sides must agree
  // on who can co-sign lock/unlock messages.
  if (!process.env.VALIDATOR_ADDRESSES) {
    throw new Error("VALIDATOR_ADDRESSES env var is required. Set it in .env as a comma-separated list.");
  }
  const validatorAddresses = process.env.VALIDATOR_ADDRESSES.split(",").map(a => a.trim());
  const threshold = process.env.THRESHOLD ? parseInt(process.env.THRESHOLD) : 3;

  if (validatorAddresses.length < threshold) {
    throw new Error(`Not enough validators (${validatorAddresses.length}) for threshold (${threshold})`);
  }

  // Deploy MockERC20 (the token we'll bridge)
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy();
  await token.waitForDeployment();
  console.log("MockERC20 deployed to:", token.target);

  // Deploy BridgeSource
  const BridgeSource = await hre.ethers.getContractFactory("BridgeSource");
  const bridge = await BridgeSource.deploy(validatorAddresses, threshold);
  await bridge.waitForDeployment();
  console.log("BridgeSource deployed to:", bridge.target);

  // Register the token — nothing can be locked until this runs.
  const minAmount = hre.ethers.parseEther("1");
  const maxAmount = hre.ethers.parseEther("1000000");
  const registerTx = await bridge.registerToken(token.target, 18, minAmount, maxAmount);
  await registerTx.wait();
  console.log("Registered MockERC20 on BridgeSource (18 decimals)");

  // Save addresses — we need these for the relayer and frontend
  const fs = require("fs");
  const addresses = {
    network: "sepolia",
    token: token.target,
    bridgeSource: bridge.target,
    deployer: deployer.address,
    validators: validatorAddresses,
    threshold,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync("deployed-sepolia.json", JSON.stringify(addresses, null, 2));
  console.log("Addresses saved to deployed-sepolia.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});