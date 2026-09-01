require("dotenv").config();
const { ethers } = require("ethers");

const config = require("./src/config");
const db = require("./src/db");
const processor = require("./src/processor");
const BridgeSourceABI = require("./abis/BridgeSource.json");
const BridgeDestABI = require("./abis/BridgeDest.json");

// ── Providers ───────────────────────────────────────────────────────────────
const sourceProvider = new ethers.JsonRpcProvider(config.sepoliaRpcUrl);
const destProvider   = new ethers.JsonRpcProvider(config.amoyRpcUrl);

// ── Validator wallets ────────────────────────────────────────────────────────
// In production these are 5 separate machines each holding one key.
// We load all 5 keys from environment variables — the signature collection
// logic is identical, only the transport differs.
// At minimum VALIDATOR_KEY_1 through VALIDATOR_KEY_5 must be set.
// The relayer submits transactions using VALIDATOR_KEY_1's wallet, on
// whichever chain the transaction targets.
function loadValidatorKeys() {
  const keys = [];
  for (let i = 1; i <= 5; i++) {
    const key = process.env[`VALIDATOR_KEY_${i}`];
    if (!key) {
      if (i <= config.threshold) {
        throw new Error(`VALIDATOR_KEY_${i} is required (threshold is ${config.threshold})`);
      }
      break;
    }
    keys.push(key);
  }
  if (keys.length < config.threshold) {
    throw new Error(`Need at least ${config.threshold} validator keys (VALIDATOR_KEY_1 ... VALIDATOR_KEY_${config.threshold})`);
  }
  return keys;
}

const validatorKeys = loadValidatorKeys();

// Two sets of the same wallets, one bound to each provider — mint()
// submits on the destination chain, unlockTokens() submits on the source
// chain, and signing itself doesn't depend on a provider at all.
const destValidatorWallets   = validatorKeys.map((k) => new ethers.Wallet(k, destProvider));
const sourceValidatorWallets = validatorKeys.map((k) => new ethers.Wallet(k, sourceProvider));

// ── Contracts ────────────────────────────────────────────────────────────────
// Read-only instances for scanning; signer-bound instances (submitter =
// the first validator wallet) for submitting transactions.
const bridgeSourceRead = new ethers.Contract(config.bridgeSourceAddress, BridgeSourceABI.abi, sourceProvider);
const bridgeDestRead   = new ethers.Contract(config.bridgeDestAddress, BridgeDestABI.abi, destProvider);

const bridgeSource = bridgeSourceRead.connect(sourceValidatorWallets[0]); // needs a signer to call unlockTokens()
const bridgeDest   = bridgeDestRead.connect(destValidatorWallets[0]);     // needs a signer to call mint()

let stopping = false;

async function scanChain({ provider, chainId, scanFn, contractArgKey, contract, label }) {
  const latestBlock = await provider.getBlockNumber();
  const lastScanned = await db.getCursor(config.databaseUrl, chainId, latestBlock - config.startBlockLookback);
  const fromBlock = lastScanned + 1;
  if (fromBlock > latestBlock) return;

  const toBlock = Math.min(latestBlock, fromBlock + config.eventScanBatchSize - 1);
  const detected = await scanFn({
    databaseUrl: config.databaseUrl,
    [contractArgKey]: contract,
    config,
    fromBlock,
    toBlock,
  });

  if (detected.length > 0) {
    console.log(`Detected ${detected.length} new ${label} event(s) in blocks ${fromBlock}-${toBlock}`);
  }
  await db.setCursor(config.databaseUrl, chainId, toBlock);
}

async function tick() {
  try {
    // Scan both directions: locks on the source chain, burns on the
    // destination chain.
    await scanChain({
      provider: sourceProvider,
      chainId: config.sourceChainId,
      scanFn: processor.scanForNewMessages,
      contractArgKey: "bridgeSource",
      contract: bridgeSourceRead,
      label: "lock",
    });

    await scanChain({
      provider: destProvider,
      chainId: config.destinationChainId,
      scanFn: processor.scanForBurnMessages,
      contractArgKey: "bridgeDest",
      contract: bridgeDestRead,
      label: "burn",
    });

    await processor.checkFinality({
      databaseUrl: config.databaseUrl,
      sourceProvider,
      destProvider,
      config,
    });

    const processed = await processor.processReadyMessages({
      databaseUrl: config.databaseUrl,
      bridgeSource,
      bridgeDest,
      config,
      validatorWallets: destValidatorWallets, // signMintRequest/signUnlockRequest only need the private key, provider-agnostic
    });

    for (const message of processed) {
      console.log(`Message ${message.message_id} -> ${message.status}`);
    }
  } catch (err) {
    console.error("Relayer tick failed:", err.message);
  }
}

async function start() {
  console.log("Relayer starting (Phase 3 — bidirectional, multi-token)...");
  console.log(`Validators loaded: ${destValidatorWallets.length}`);
  destValidatorWallets.forEach((w, i) => console.log(`  Validator ${i + 1}: ${w.address}`));
  console.log(`Threshold: ${config.threshold}-of-${destValidatorWallets.length}`);

  await db.migrate(config.databaseUrl);
  console.log("Database schema ready.");

  console.log("Recovering unfinished messages...");
  const recovered = await processor.recoverUnfinishedMessages({
    databaseUrl: config.databaseUrl,
    sourceProvider,
    destProvider,
    bridgeSource,
    bridgeDest,
    config,
  });
  console.log(`Recovery pass touched ${recovered.length} message(s).`);

  console.log(`Polling every ${config.pollIntervalMs}ms, ${config.confirmationsRequired} confirmations required.`);

  while (!stopping) {
    await tick();
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }

  console.log("Relayer stopped.");
  await db.closePool();
}

process.on("SIGINT",  () => { console.log("\nShutting down..."); stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

start().catch((err) => {
  console.error("Fatal relayer error:", err);
  process.exit(1);
});
