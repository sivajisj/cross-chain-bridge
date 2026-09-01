require("dotenv").config();
const hre = require("hardhat");

async function main() {
  console.log("Deploying BridgeDest to Polygon Amoy (Phase 2 — multi-validator)...");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "MATIC");

  // ── Validator addresses ──────────────────────────────────────────────────
  // Read from env so this script works for any deployment without code changes.
  // VALIDATOR_ADDRESSES is a comma-separated list of 5 addresses generated
  // in Phase 2 Step 8 (the node -e "ethers.Wallet.createRandom()" output).
  if (!process.env.VALIDATOR_ADDRESSES) {
    throw new Error("VALIDATOR_ADDRESSES env var is required. Set it in .env as a comma-separated list.");
  }

  const validatorAddresses = process.env.VALIDATOR_ADDRESSES
    .split(",")
    .map(a => a.trim());

  const threshold = process.env.THRESHOLD
    ? parseInt(process.env.THRESHOLD)
    : 3; // default 3-of-5

  console.log(`Validators (${validatorAddresses.length}):`);
  validatorAddresses.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
  console.log(`Threshold: ${threshold}-of-${validatorAddresses.length}`);

  if (validatorAddresses.length < threshold) {
    throw new Error(`Not enough validators (${validatorAddresses.length}) for threshold (${threshold})`);
  }

  // ── Deploy ───────────────────────────────────────────────────────────────
  const BridgeDest = await hre.ethers.getContractFactory("BridgeDest");
  const bridge = await BridgeDest.deploy(validatorAddresses, threshold);
  await bridge.waitForDeployment();

  console.log("BridgeDest deployed to:", bridge.target);
  console.log("Threshold:", threshold, "of", validatorAddresses.length, "validators");

  // ── Save addresses ────────────────────────────────────────────────────────
  const fs = require("fs");
  const addresses = {
    network: "amoy",
    bridgeDest: bridge.target,
    deployer: deployer.address,
    validators: validatorAddresses,
    threshold,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync("deployed-amoy.json", JSON.stringify(addresses, null, 2));
  console.log("Addresses saved to deployed-amoy.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});