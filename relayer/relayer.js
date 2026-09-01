require("dotenv").config();
const { ethers } = require("ethers");

const config = require("./src/config");
const db = require("./src/db");
const processor = require("./src/processor");
const logger = require("./src/logger");
const { startApiServer } = require("./src/api");
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
    logger.info("events_detected", { label, count: detected.length, fromBlock, toBlock });
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
      logger.info("message_status_changed", { messageId: message.message_id, status: message.status });
    }
  } catch (err) {
    logger.error("relayer_tick_failed", { error: err.message });
  }
}

async function start() {
  logger.info("relayer_starting", { phase: "5 — monitoring + explorer" });
  logger.info("validators_loaded", {
    count: destValidatorWallets.length,
    addresses: destValidatorWallets.map((w) => w.address),
    threshold: config.threshold,
  });

  await db.migrate(config.databaseUrl);
  logger.info("database_ready");

  const apiPort = parseInt(process.env.API_PORT || "3001", 10);
  startApiServer(config.databaseUrl, apiPort);
  logger.info("api_server_started", { port: apiPort });

  logger.info("recovering_unfinished_messages");
  const recovered = await processor.recoverUnfinishedMessages({
    databaseUrl: config.databaseUrl,
    sourceProvider,
    destProvider,
    bridgeSource,
    bridgeDest,
    config,
  });
  logger.info("recovery_complete", { touched: recovered.length });

  logger.info("polling_started", {
    intervalMs: config.pollIntervalMs,
    confirmationsRequired: config.confirmationsRequired,
  });

  while (!stopping) {
    await tick();
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }

  logger.info("relayer_stopped");
  await db.closePool();
}

process.on("SIGINT",  () => { logger.info("shutdown_signal", { signal: "SIGINT" }); stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

start().catch((err) => {
  logger.error("fatal_relayer_error", { error: err.message, stack: err.stack });
  process.exit(1);
});
