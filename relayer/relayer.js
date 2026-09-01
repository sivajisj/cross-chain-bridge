require("dotenv").config();
const { ethers } = require("ethers");

const config = require("./src/config");
const db = require("./src/db");
const processor = require("./src/processor");
const BridgeSourceABI = require("./abis/BridgeSource.json");
const BridgeDestABI = require("./abis/BridgeDest.json");

// ── providers (one per chain) ──────────────────────────────────
const sourceProvider = new ethers.JsonRpcProvider(config.sepoliaRpcUrl);
const destProvider = new ethers.JsonRpcProvider(config.amoyRpcUrl);

// ── relayer wallet (signs mint() txs on the destination chain) ─
const relayerWallet = new ethers.Wallet(config.relayerPrivateKey, destProvider);

// ── contracts ───────────────────────────────────────────────────
const bridgeSource = new ethers.Contract(
  config.bridgeSourceAddress,
  BridgeSourceABI.abi,
  sourceProvider // read-only, just scanning for events
);

const bridgeDest = new ethers.Contract(
  config.bridgeDestAddress,
  BridgeDestABI.abi,
  relayerWallet // needs a signer to call mint()
);

let stopping = false;

// One full cycle: scan for new locks, advance confirmations, submit
// anything that's ready. Every step is idempotent, so it is always
// safe to run this again even if the previous tick crashed midway.
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
    });

    for (const message of processed) {
      console.log(`Message ${message.message_id} -> ${message.status}`);
    }
  } catch (err) {
    console.error("Relayer tick failed:", err.message);
  }
}

async function start() {
  console.log("Relayer starting...");
  console.log("Relayer wallet:", relayerWallet.address);

  await db.migrate(config.databaseUrl);
  console.log("Database schema ready.");

  console.log("Recovering unfinished messages from the previous run...");
  const recovered = await processor.recoverUnfinishedMessages({
    databaseUrl: config.databaseUrl,
    destProvider,
    bridgeDest,
    config,
  });
  console.log(`Recovery pass touched ${recovered.length} message(s).`);

  console.log(
    `Polling every ${config.pollIntervalMs}ms, ${config.confirmationsRequired} confirmations required, ` +
      `max ${config.maxRetries} retries.`
  );

  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  console.log("Relayer stopped.");
  await db.closePool();
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

start().catch((err) => {
  console.error("Fatal relayer error:", err);
  process.exit(1);
});