require("dotenv").config();
const { ethers } = require("ethers");
const BridgeSourceABI = require("./abis/BridgeSource.json");
const BridgeDestABI = require("./abis/BridgeDest.json");

// ── providers (one per chain) ──────────────────────────────────
const sepoliaProvider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const amoyProvider    = new ethers.JsonRpcProvider(process.env.AMOY_RPC_URL);

// ── relayer wallet (signs mint() txs on Polygon) ───────────────
const relayerWallet = new ethers.Wallet(
  process.env.RELAYER_PRIVATE_KEY,
  amoyProvider
);

// ── contracts ──────────────────────────────────────────────────
const bridgeSource = new ethers.Contract(
  process.env.BRIDGE_SOURCE_ADDRESS,
  BridgeSourceABI.abi,
  sepoliaProvider  // read-only, just listening
);

const bridgeDest = new ethers.Contract(
  process.env.BRIDGE_DEST_ADDRESS,
  BridgeDestABI.abi,
  relayerWallet    // needs signer to call mint()
);

// ── track processed events to prevent double minting ──────────
const processedTxs = new Set();

// ── core handler ───────────────────────────────────────────────
async function handleTokenLocked(user, amount, timestamp, event) {
  const txHash = event.log.transactionHash;

  if (processedTxs.has(txHash)) {
    console.log(`Already processed tx ${txHash} — skipping`);
    return;
  }

  console.log("\n── TokenLocked event detected ──────────────────");
  console.log("User:      ", user);
  console.log("Amount:    ", ethers.formatEther(amount), "BRT");
  console.log("Tx hash:   ", txHash);

  try {
    // Generate deterministic nonce from tx hash
    // Same input always produces same nonce — safe to retry
    const nonce = ethers.keccak256(ethers.toUtf8Bytes(txHash));
    console.log("Nonce:     ", nonce);

    // Check if already minted on dest chain (extra safety)
    const alreadyMinted = await bridgeDest.processedNonces(nonce);
    if (alreadyMinted) {
      console.log("Already minted on dest chain — skipping");
      processedTxs.add(txHash);
      return;
    }

    console.log("Minting wBRT on Polygon Amoy...");
    const tx = await bridgeDest.mint(user, amount, nonce);
    console.log("Mint tx sent:", tx.hash);

    const receipt = await tx.wait();
    console.log("Mint confirmed in block:", receipt.blockNumber);

    processedTxs.add(txHash);
    console.log("Done — user received wBRT on Polygon");

  } catch (err) {
    console.error("Mint failed:", err.message);
  }
}

// ── start listening ────────────────────────────────────────────
async function start() {
  console.log("Relayer starting...");
  console.log("Relayer wallet:", relayerWallet.address);

  const sepoliaBlock = await sepoliaProvider.getBlockNumber();
  const amoyBlock    = await amoyProvider.getBlockNumber();
  console.log("Sepolia block:", sepoliaBlock);
  console.log("Amoy block:   ", amoyBlock);

  // Catch up on missed events since last 1000 blocks
  // (in production you'd store the last processed block in a DB)
  console.log("\nChecking for past events...");
  const pastEvents = await bridgeSource.queryFilter(
    bridgeSource.filters.TokenLocked(),
    sepoliaBlock - 9,
    sepoliaBlock
  );

  if (pastEvents.length > 0) {
    console.log(`Found ${pastEvents.length} past events — processing...`);
    for (const event of pastEvents) {
      const { user, amount, timestamp } = event.args;
      await handleTokenLocked(user, amount, timestamp, event);
    }
  } else {
    console.log("No past events found.");
  }

  // Listen for new events going forward
  console.log("\nListening for new TokenLocked events on Sepolia...");
  bridgeSource.on("TokenLocked", handleTokenLocked);
}

start().catch(console.error);