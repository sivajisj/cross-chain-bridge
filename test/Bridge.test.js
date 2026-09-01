const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 test suite
// Tests cover: Phase 1 functionality still works + all new signature/threshold
// scenarios. Every test that existed before still passes unchanged.
// ─────────────────────────────────────────────────────────────────────────────

describe("Cross-Chain Bridge — Phase 2", function () {
  let mockToken, bridgeSource, bridgeDest;
  let owner, user;
  let validators; // array of 5 signers acting as validators

  // Chain IDs used in tests — match what the contract sees via block.chainid
  const SOURCE_CHAIN_ID = 31337n; // Hardhat local chain
  const DEST_CHAIN_ID   = 31337n;

  // Helper: build the EIP-712 domain matching the deployed contract
  async function getDomain() {
    const network = await ethers.provider.getNetwork();
    return {
      name: "CrossChainBridge",
      version: "1",
      chainId: Number(network.chainId),
      verifyingContract: await bridgeDest.getAddress(),
    };
  }

  // Helper: sign one MintRequest as a given validator
  async function signMint(validator, messageId, recipient, amount) {
    const domain = await getDomain();
    const types = {
      MintRequest: [
        { name: "messageId",     type: "bytes32" },
        { name: "recipient",     type: "address" },
        { name: "amount",        type: "uint256" },
        { name: "sourceChainId", type: "uint256" },
        { name: "destChainId",   type: "uint256" },
      ],
    };
    const value = {
      messageId,
      recipient,
      amount,
      sourceChainId: SOURCE_CHAIN_ID,
      destChainId:   DEST_CHAIN_ID,
    };
    return validator.signTypedData(domain, types, value);
  }

  // Helper: collect N signatures from the first N validators
  async function collectSigs(messageId, recipient, amount, count) {
    const sigs = [];
    for (let i = 0; i < count; i++) {
      sigs.push(await signMint(validators[i], messageId, recipient, amount));
    }
    return sigs;
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    user  = signers[1];
    validators = signers.slice(2, 7); // 5 validators

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy();

    const BridgeSource = await ethers.getContractFactory("BridgeSource");
    bridgeSource = await BridgeSource.deploy(mockToken.target);

    // Deploy BridgeDest with 5 validators and threshold of 3
    const BridgeDest = await ethers.getContractFactory("BridgeDest");
    bridgeDest = await BridgeDest.deploy(
      validators.map(v => v.address),
      3
    );

    await mockToken.mint(user.address, ethers.parseEther("1000"));
  });

  // ── Original Phase 1 tests (all must still pass) ──────────────────────────

  it("locks tokens on source chain", async function () {
    const amount = ethers.parseEther("100");
    await mockToken.connect(user).approve(bridgeSource.target, amount);
    const tx = await bridgeSource.connect(user).lockTokens(amount);
    const receipt = await tx.wait();

    const event = receipt.logs.find(log => log.fragment?.name === "TokenLocked");
    expect(event).to.not.be.undefined;
    expect(event.args.user).to.equal(user.address);
    expect(event.args.amount).to.equal(amount);
    expect(await bridgeSource.bridgeBalance()).to.equal(amount);
  });

  it("mints wrapped tokens with exactly threshold signatures (3-of-5)", async function () {
    const amount    = ethers.parseEther("100");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-1"));
    const sigs      = await collectSigs(messageId, user.address, amount, 3);

    await bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);
    expect(await bridgeDest.balanceOf(user.address)).to.equal(amount);
  });

  it("mints with more than threshold signatures (5-of-5)", async function () {
    const amount    = ethers.parseEther("50");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-2"));
    const sigs      = await collectSigs(messageId, user.address, amount, 5);

    await bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);
    expect(await bridgeDest.balanceOf(user.address)).to.equal(amount);
  });

  it("rejects mint with fewer than threshold signatures (2-of-5)", async function () {
    const amount    = ethers.parseEther("50");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-3"));
    const sigs      = await collectSigs(messageId, user.address, amount, 2);

    await expect(
      bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWith("Not enough signatures");
  });

  it("rejects a signature from an unauthorized validator", async function () {
    const amount    = ethers.parseEther("50");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-4"));
    const stranger  = (await ethers.getSigners())[8]; // not in validator set

    const sigs = [
      await signMint(stranger, messageId, user.address, amount),
      await signMint(stranger, messageId, user.address, amount),
      await signMint(stranger, messageId, user.address, amount),
    ];

    await expect(
      bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  it("rejects duplicate signatures from the same validator", async function () {
    const amount    = ethers.parseEther("50");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-5"));
    const sig       = await signMint(validators[0], messageId, user.address, amount);

    // Same validator signing 3 times — should not count as 3 valid sigs
    await expect(
      bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, [sig, sig, sig])
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  it("rejects a replayed message (same messageId used twice)", async function () {
    const amount    = ethers.parseEther("10");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-6"));
    const sigs      = await collectSigs(messageId, user.address, amount, 3);

    await bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);

    // Second mint with the same messageId — must revert even with fresh sigs
    const sigs2 = await collectSigs(messageId, user.address, amount, 3);
    await expect(
      bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs2)
    ).to.be.revertedWith("Message already processed");
  });

  it("rejects a signature made for a different amount", async function () {
    const amount    = ethers.parseEther("100");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-7"));

    // Validators signed for 100, but caller submits with 999
    const sigs = await collectSigs(messageId, user.address, amount, 3);
    const wrongAmount = ethers.parseEther("999");

    await expect(
      bridgeDest.mint(user.address, wrongAmount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  it("rejects a signature made for a different recipient", async function () {
    const amount    = ethers.parseEther("100");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-8"));
    const attacker  = (await ethers.getSigners())[9];

    // Validators signed for user.address, but caller tries to redirect to attacker
    const sigs = await collectSigs(messageId, user.address, amount, 3);

    await expect(
      bridgeDest.mint(attacker.address, amount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  it("allows owner to add a new validator", async function () {
    const newValidator = (await ethers.getSigners())[9];
    await bridgeDest.connect(owner).addValidator(newValidator.address);
    expect(await bridgeDest.isValidator(newValidator.address)).to.be.true;
    expect(await bridgeDest.validatorCount()).to.equal(6);
  });

  it("allows owner to remove a validator when count stays at or above threshold", async function () {
    await bridgeDest.connect(owner).removeValidator(validators[4].address);
    expect(await bridgeDest.isValidator(validators[4].address)).to.be.false;
    expect(await bridgeDest.validatorCount()).to.equal(4);
  });

  it("prevents removing a validator if it would drop below threshold", async function () {
    // Remove two validators to get to exactly threshold (3)
    await bridgeDest.connect(owner).removeValidator(validators[4].address);
    await bridgeDest.connect(owner).removeValidator(validators[3].address);

    // Removing one more would bring count to 2, below threshold of 3
    await expect(
      bridgeDest.connect(owner).removeValidator(validators[2].address)
    ).to.be.revertedWith("Would fall below threshold");
  });

  it("allows owner to update threshold", async function () {
    await bridgeDest.connect(owner).setThreshold(4);
    expect(await bridgeDest.threshold()).to.equal(4);
  });

  it("user can burn wrapped tokens", async function () {
    const amount    = ethers.parseEther("100");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("burn-test-1"));
    const sigs      = await collectSigs(messageId, user.address, amount, 3);

    await bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);
    await bridgeDest.connect(user).burn(amount);
    expect(await bridgeDest.balanceOf(user.address)).to.equal(0);
  });

  it("blocks operations when bridge is paused", async function () {
    const amount    = ethers.parseEther("10");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("pause-test-1"));
    const sigs      = await collectSigs(messageId, user.address, amount, 3);

    await bridgeDest.connect(owner).pauseBridge();
    await expect(
      bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWithCustomError(bridgeDest, "EnforcedPause");
  });

  it("tracks totalMinted correctly", async function () {
    const amount    = ethers.parseEther("42");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("stats-test-1"));
    const sigs      = await collectSigs(messageId, user.address, amount, 3);

    await bridgeDest.mint(user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);
    expect(await bridgeDest.totalMinted()).to.equal(amount);
  });
});