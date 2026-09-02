require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function int(name, fallback) {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

const config = {
  sepoliaRpcUrl: required("SEPOLIA_RPC_URL"),
  amoyRpcUrl: required("AMOY_RPC_URL"),
  bridgeSourceAddress: required("BRIDGE_SOURCE_ADDRESS"),
  bridgeDestAddress: required("BRIDGE_DEST_ADDRESS"),
  databaseUrl: required("DATABASE_URL"),

  sourceChainId: int("SOURCE_CHAIN_ID", 11155111),
  destinationChainId: int("DESTINATION_CHAIN_ID", 80002),

  confirmationsRequired: int("CONFIRMATIONS_REQUIRED", 5),
  maxRetries: int("MAX_RETRIES", 5),
  retryBaseDelayMs: int("RETRY_BASE_DELAY_MS", 30000),
  pollIntervalMs: int("POLL_INTERVAL_MS", 15000),
  startBlockLookback: int("START_BLOCK_LOOKBACK", 2000),
  eventScanBatchSize: int("EVENT_SCAN_BATCH_SIZE", 2000),
  threshold: int("THRESHOLD", 3),

  // Solana leg (Phase 6) — all optional. If SOLANA_RPC_URL/SOLANA_PROGRAM_ID
  // are unset, the relayer simply skips the Solana scan loop and behaves
  // exactly as it did before Phase 6.
  solanaRpcUrl: process.env.SOLANA_RPC_URL || null,
  solanaProgramId: process.env.SOLANA_PROGRAM_ID || null,
  solanaCommitment: process.env.SOLANA_COMMITMENT || "finalized",
  solanaScanBatchSize: int("SOLANA_SCAN_BATCH_SIZE", 200),
};

module.exports = config;
