require("dotenv").config();
const hre = require("hardhat");

async function main() {
  console.log("Deploying BridgeDest to Polygon Amoy (Phase 3 — multi-validator, multi-token)...");

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

  // ── Register the source token + deploy its wrapped counterpart ───────────
  // Requires knowing the BridgeSource-side token address (from
  // deployed-sepolia.json / deploy-source.js), passed via SOURCE_TOKEN_ADDRESS.
  // Optional here since deploy-source.js may run against a different chain
  // at a different time — run this step manually afterwards if omitted.
  let wrappedToken = null;
  if (process.env.SOURCE_TOKEN_ADDRESS) {
    const minAmount = hre.ethers.parseEther("1");
    const maxAmount = hre.ethers.parseEther("1000000");
    const registerTx = await bridge.registerTokenWithWrapped(
      process.env.SOURCE_TOKEN_ADDRESS, 18, minAmount, maxAmount,
      "Wrapped Bridge Token", "wBRT"
    );
    await registerTx.wait();
    wrappedToken = await bridge.wrappedTokens(process.env.SOURCE_TOKEN_ADDRESS);
    console.log("Registered source token, wrapped token deployed to:", wrappedToken);
  } else {
    console.log("SOURCE_TOKEN_ADDRESS not set — skipping token registration. " +
      "Call registerTokenWithWrapped() manually before bridging.");
  }

  // ── Save addresses ────────────────────────────────────────────────────────
  const fs = require("fs");
  const addresses = {
    network: "amoy",
    bridgeDest: bridge.target,
    deployer: deployer.address,
    validators: validatorAddresses,
    threshold,
    sourceToken: process.env.SOURCE_TOKEN_ADDRESS || null,
    wrappedToken,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync("deployed-amoy.json", JSON.stringify(addresses, null, 2));
  console.log("Addresses saved to deployed-amoy.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});