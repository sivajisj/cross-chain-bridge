const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const db = require("../relayer/src/db");
const processor = require("../relayer/src/processor");
const { STATES } = require("../relayer/src/stateMachine");

// A dedicated test database, separate from the one the live relayer
// uses in development. Override with TEST_DATABASE_URL if needed.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://bridge:bridge@localhost:5432/bridge_relayer_test";

// Hardhat only gives us one in-process chain, so these tests use it to
// simulate both "source" and "destination" — the same pattern the
// relayer code would see against two real chains, just without a
// second RPC endpoint. sourceChainId/destinationChainId are set equal
// here purely to keep the test simple; in production they are 11155111
// and 80002 respectively.
describe("Relayer persistence and state machine (Phase 1)", function () {
  this.timeout(60000);

  let mockToken, bridgeSource, bridgeDest;
  let owner, user, relayer;

  const testConfig = {
    sourceChainId: 31337,
    destinationChainId: 31337,
    confirmationsRequired: 3,
    maxRetries: 2,
    retryBaseDelayMs: 0,
  };

  before(async function () {
    await db.migrate(TEST_DATABASE_URL);
  });

  after(async function () {
    await db.closePool();
  });

  beforeEach(async function () {
    const pool = db.getPool(TEST_DATABASE_URL);
    await pool.query("TRUNCATE bridge_messages, sync_cursor");

    [owner, user, relayer] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy();

    const BridgeSource = await ethers.getContractFactory("BridgeSource");
    bridgeSource = await BridgeSource.deploy(mockToken.target);

    const BridgeDest = await ethers.getContractFactory("BridgeDest");
    bridgeDest = (await BridgeDest.deploy()).connect(relayer);
    await bridgeDest.connect(owner).transferOwnership(relayer.address);

    await mockToken.mint(user.address, ethers.parseEther("1000"));
    await mockToken.connect(user).approve(bridgeSource.target, ethers.parseEther("1000"));
  });

  async function mineBlocks(n) {
    for (let i = 0; i < n; i++) {
      await network.provider.send("evm_mine");
    }
  }

  async function lockAndScan(amount) {
    const tx = await bridgeSource.connect(user).lockTokens(amount);
    await tx.wait();
    const latestBlock = await ethers.provider.getBlockNumber();
    const found = await processor.scanForNewMessages({
      databaseUrl: TEST_DATABASE_URL,
      bridgeSource,
      config: testConfig,
      fromBlock: latestBlock,
      toBlock: latestBlock,
    });
    return found[0];
  }

  it("processes a normal lock -> mint flow end to end", async function () {
    const amount = ethers.parseEther("100");
    const message = await lockAndScan(amount);
    expect(message.status).to.equal(STATES.CONFIRMING);

    await mineBlocks(testConfig.confirmationsRequired);
    await processor.checkFinality({
      databaseUrl: TEST_DATABASE_URL,
      sourceProvider: ethers.provider,
      config: testConfig,
    });
    await processor.processReadyMessages({
      databaseUrl: TEST_DATABASE_URL,
      bridgeDest,
      config: testConfig,
    });

    const stored = await db.getMessageById(TEST_DATABASE_URL, message.message_id);
    expect(stored.status).to.equal(STATES.COMPLETED);
    expect(await bridgeDest.balanceOf(user.address)).to.equal(amount);
  });

  it("does not finalize a message before enough confirmations", async function () {
    const amount = ethers.parseEther("50");
    const message = await lockAndScan(amount);

    await mineBlocks(testConfig.confirmationsRequired - 2);
    await processor.checkFinality({
      databaseUrl: TEST_DATABASE_URL,
      sourceProvider: ethers.provider,
      config: testConfig,
    });

    const stored = await db.getMessageById(TEST_DATABASE_URL, message.message_id);
    expect(stored.status).to.equal(STATES.CONFIRMING);
  });

  it("does not create a duplicate row when the same block range is scanned twice", async function () {
    const amount = ethers.parseEther("20");
    await bridgeSource.connect(user).lockTokens(amount);
    const latestBlock = await ethers.provider.getBlockNumber();

    const scanArgs = {
      databaseUrl: TEST_DATABASE_URL,
      bridgeSource,
      config: testConfig,
      fromBlock: latestBlock,
      toBlock: latestBlock,
    };
    const first = await processor.scanForNewMessages(scanArgs);
    const second = await processor.scanForNewMessages(scanArgs); // duplicate event scan

    expect(first.length).to.equal(1);
    expect(second.length).to.equal(0);

    const pool = db.getPool(TEST_DATABASE_URL);
    const count = await pool.query("SELECT count(*) FROM bridge_messages");
    expect(Number(count.rows[0].count)).to.equal(1);
  });

  it("recovers a message stuck mid-flight after a simulated relayer restart", async function () {
    const amount = ethers.parseEther("30");
    const message = await lockAndScan(amount);
    await mineBlocks(testConfig.confirmationsRequired);
    await processor.checkFinality({
      databaseUrl: TEST_DATABASE_URL,
      sourceProvider: ethers.provider,
      config: testConfig,
    });

    // Simulate a crash: the process claimed the message (moved it to
    // SUBMITTED) but died before a transaction was ever sent or a hash
    // recorded. destination_tx_hash stays null.
    await db.transitionStatus(TEST_DATABASE_URL, message.message_id, [STATES.FINALIZED], STATES.SUBMITTED);

    const recovered = await processor.recoverUnfinishedMessages({
      databaseUrl: TEST_DATABASE_URL,
      destProvider: ethers.provider,
      bridgeDest,
      config: testConfig,
    });
    expect(recovered[0].status).to.equal(STATES.RETRYING);

    await processor.processReadyMessages({
      databaseUrl: TEST_DATABASE_URL,
      bridgeDest,
      config: testConfig,
    });

    const stored = await db.getMessageById(TEST_DATABASE_URL, message.message_id);
    expect(stored.status).to.equal(STATES.COMPLETED);
    expect(await bridgeDest.balanceOf(user.address)).to.equal(amount);
  });

  it("retries on destination transaction failure and stops after max retries", async function () {
    const amount = ethers.parseEther("10");
    const message = await lockAndScan(amount);
    await mineBlocks(testConfig.confirmationsRequired);
    await processor.checkFinality({
      databaseUrl: TEST_DATABASE_URL,
      sourceProvider: ethers.provider,
      config: testConfig,
    });

    await bridgeDest.pauseBridge(); // makes every mint() revert

    for (let attempt = 0; attempt <= testConfig.maxRetries; attempt++) {
      await processor.processReadyMessages({
        databaseUrl: TEST_DATABASE_URL,
        bridgeDest,
        config: testConfig,
      });
    }

    const stored = await db.getMessageById(TEST_DATABASE_URL, message.message_id);
    expect(stored.status).to.equal(STATES.FAILED);
    expect(stored.retry_count).to.equal(testConfig.maxRetries + 1);
    expect(await bridgeDest.balanceOf(user.address)).to.equal(0);
  });

  it("is idempotent: resubmitting an already-completed message mints nothing extra", async function () {
    const amount = ethers.parseEther("15");
    const message = await lockAndScan(amount);
    await mineBlocks(testConfig.confirmationsRequired);
    await processor.checkFinality({
      databaseUrl: TEST_DATABASE_URL,
      sourceProvider: ethers.provider,
      config: testConfig,
    });
    await processor.processReadyMessages({
      databaseUrl: TEST_DATABASE_URL,
      bridgeDest,
      config: testConfig,
    });

    const completed = await db.getMessageById(TEST_DATABASE_URL, message.message_id);
    const secondAttempt = await processor.submitMessage({
      databaseUrl: TEST_DATABASE_URL,
      bridgeDest,
      config: testConfig,
      message: completed,
    });

    expect(secondAttempt).to.be.null; // not FINALIZED/RETRYING anymore, so it's a no-op
    expect(await bridgeDest.balanceOf(user.address)).to.equal(amount);
  });
});