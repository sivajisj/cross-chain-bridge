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
// For Phase 2 we load all 5 keys from environment variables — the
// signature collection logic is identical, only the transport differs.
// At minimum VALIDATOR_KEY_1 through VALIDATOR_KEY_5 must be set.
// The relayer submits transactions using VALIDATOR_KEY_1's wallet.
function loadValidatorWallets() {
  const wallets = [];
  for (let i = 1; i <= 5; i++) {
    const key = process.env[`VALIDATOR_KEY_${i}`];
    if (!key) {
      if (i <= config.threshold) {
        throw new Error(`VALIDATOR_KEY_${i} is required (threshold is ${config.threshold})`);
      }
      break;
    }
    wallets.push(new ethers.Wallet(key, destProvider));
  }
  if (wallets.length < config.threshold) {
    throw new Error(`Need at least ${config.threshold} validator keys (VALIDATOR_KEY_1 ... VALIDATOR_KEY_${config.threshold})`);
  }
  return wallets;
}

const validatorWallets = loadValidatorWallets();

// The first validator wallet signs and submits the transaction.
// All validator wallets contribute signatures.
const submitterWallet = validatorWallets[0];

// ── Contracts ────────────────────────────────────────────────────────────────
const bridgeSource = new ethers.Contract(
  config.bridgeSourceAddress,
  BridgeSourceABI.abi,
  sourceProvider
);

const bridgeDest = new ethers.Contract(
  config.bridgeDestAddress,
  BridgeDestABI.abi,
  submitterWallet // needs a signer to call mint()
);

let stopping = false;

async function tick() {
  try {
    const latestBlock = await sourceProvider.getBlockNumber();
    const lastScanned = await db.getCursor(
      config.databaseUrl,
      config.sourceChainId,
      latestBlock - config.startBlockLookback
    );
    const fromBlock = lastScanned + 1;

    if (fromBlock <= latestBlock) {
      const toBlock = Math.min(latestBlock, fromBlock + config.eventScanBatchSize - 1);

      const detected = await processor.scanForNewMessages({
        databaseUrl: config.databaseUrl,
        bridgeSource,
        config,
        fromBlock,
        toBlock,
      });

      if (detected.length > 0) {
        console.log(`Detected ${detected.length} new lock event(s) in blocks ${fromBlock}-${toBlock}`);
      }

      await db.setCursor(config.databaseUrl, config.sourceChainId, toBlock);
    }

    await processor.checkFinality({
      databaseUrl: config.databaseUrl,
      sourceProvider,
      config,
    });

    const processed = await processor.processReadyMessages({
      databaseUrl: config.databaseUrl,
      bridgeDest,
      config,
      validatorWallets,
    });

    for (const message of processed) {
      console.log(`Message ${message.message_id} -> ${message.status}`);
    }
  } catch (err) {
    console.error("Relayer tick failed:", err.message);
  }
}

async function start() {
  console.log("Relayer starting (Phase 2 — multi-validator)...");
  console.log(`Validators loaded: ${validatorWallets.length}`);
  validatorWallets.forEach((w, i) => console.log(`  Validator ${i + 1}: ${w.address}`));
  console.log(`Threshold: ${config.threshold}-of-${validatorWallets.length}`);

  await db.migrate(config.databaseUrl);
  console.log("Database schema ready.");

  console.log("Recovering unfinished messages...");
  const recovered = await processor.recoverUnfinishedMessages({
    databaseUrl: config.databaseUrl,
    destProvider,
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
