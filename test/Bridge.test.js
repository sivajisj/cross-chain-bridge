const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 test suite — bidirectional, multi-token, decimal-normalized bridge.
// ─────────────────────────────────────────────────────────────────────────────

describe("Cross-Chain Bridge — Phase 3", function () {
  let mockToken, bridgeSource, bridgeDest, wrappedToken;
  let owner, user;
  let validators; // array of 5 signers acting as validators

  const SOURCE_CHAIN_ID = 31337n;
  const DEST_CHAIN_ID   = 31337n;
  const MIN_AMOUNT = 1n;
  const MAX_AMOUNT = ethers.parseEther("1000000");

  async function getDomain(contract, name) {
    const network = await ethers.provider.getNetwork();
    return {
      name,
      version: "1",
      chainId: Number(network.chainId),
      verifyingContract: await contract.getAddress(),
    };
  }

  const MINT_TYPES = {
    MintRequest: [
      { name: "messageId",        type: "bytes32" },
      { name: "sourceToken",      type: "address" },
      { name: "recipient",        type: "address" },
      { name: "normalizedAmount", type: "uint256" },
      { name: "sourceChainId",    type: "uint256" },
      { name: "destChainId",      type: "uint256" },
    ],
  };

  const UNLOCK_TYPES = {
    UnlockRequest: [
      { name: "messageId",        type: "bytes32" },
      { name: "token",            type: "address" },
      { name: "recipient",        type: "address" },
      { name: "normalizedAmount", type: "uint256" },
      { name: "sourceChainId",    type: "uint256" },
      { name: "destChainId",      type: "uint256" },
    ],
  };

  async function signMint(validator, messageId, sourceToken, recipient, normalizedAmount) {
    const domain = await getDomain(bridgeDest, "CrossChainBridge");
    return validator.signTypedData(domain, MINT_TYPES, {
      messageId, sourceToken, recipient, normalizedAmount,
      sourceChainId: SOURCE_CHAIN_ID, destChainId: DEST_CHAIN_ID,
    });
  }

  async function signUnlock(validator, messageId, token, recipient, normalizedAmount) {
    const domain = await getDomain(bridgeSource, "CrossChainBridgeSource");
    return validator.signTypedData(domain, UNLOCK_TYPES, {
      messageId, token, recipient, normalizedAmount,
      sourceChainId: DEST_CHAIN_ID, destChainId: SOURCE_CHAIN_ID,
    });
  }

  async function collectMintSigs(messageId, sourceToken, recipient, normalizedAmount, count) {
    const sigs = [];
    for (let i = 0; i < count; i++) {
      sigs.push(await signMint(validators[i], messageId, sourceToken, recipient, normalizedAmount));
    }
    return sigs;
  }

  async function collectUnlockSigs(messageId, token, recipient, normalizedAmount, count) {
    const sigs = [];
    for (let i = 0; i < count; i++) {
      sigs.push(await signUnlock(validators[i], messageId, token, recipient, normalizedAmount));
    }
    return sigs;
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    user  = signers[1];
    validators = signers.slice(2, 7); // 5 validators

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy(); // 18 decimals

    const BridgeSource = await ethers.getContractFactory("BridgeSource");
    bridgeSource = await BridgeSource.deploy(validators.map(v => v.address), 3);

    const BridgeDest = await ethers.getContractFactory("BridgeDest");
    bridgeDest = await BridgeDest.deploy(validators.map(v => v.address), 3);

    await bridgeSource.connect(owner).registerToken(mockToken.target, 18, MIN_AMOUNT, MAX_AMOUNT);
    await bridgeDest.connect(owner).registerTokenWithWrapped(
      mockToken.target, 18, MIN_AMOUNT, MAX_AMOUNT, "Wrapped Mock", "wMOCK"
    );

    const WrappedToken = await ethers.getContractFactory("WrappedToken");
    wrappedToken = WrappedToken.attach(await bridgeDest.wrappedTokens(mockToken.target));

    await mockToken.mint(user.address, ethers.parseEther("1000"));
  });

  // ── Lock / mint (Sepolia → Amoy) ──────────────────────────────────────────

  it("locks tokens on source chain", async function () {
    const amount = ethers.parseEther("100");
    await mockToken.connect(user).approve(bridgeSource.target, amount);
    const tx = await bridgeSource.connect(user).lockTokens(mockToken.target, amount);
    const receipt = await tx.wait();

    const event = receipt.logs.find(log => log.fragment?.name === "TokenLocked");
    expect(event).to.not.be.undefined;
    expect(event.args.user).to.equal(user.address);
    expect(event.args.token).to.equal(mockToken.target);
    expect(event.args.amount).to.equal(amount);
    expect(event.args.decimals).to.equal(18);
    expect(await mockToken.balanceOf(bridgeSource.target)).to.equal(amount);
  });

  it("rejects locking an unregistered token", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const other = await MockERC20.deploy();
    await other.mint(user.address, ethers.parseEther("10"));
    await other.connect(user).approve(bridgeSource.target, ethers.parseEther("10"));

    await expect(
      bridgeSource.connect(user).lockTokens(other.target, ethers.parseEther("10"))
    ).to.be.revertedWith("Token not supported");
  });

  it("mints wrapped tokens with exactly threshold signatures (3-of-5)", async function () {
    const amount    = ethers.parseEther("100");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-1"));
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 3);

    await bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);
    expect(await wrappedToken.balanceOf(user.address)).to.equal(amount);
  });

  it("mints with more than threshold signatures (5-of-5)", async function () {
    const amount    = ethers.parseEther("50");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-2"));
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 5);

    await bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);
    expect(await wrappedToken.balanceOf(user.address)).to.equal(amount);
  });

  it("rejects mint with fewer than threshold signatures (2-of-5)", async function () {
    const amount    = ethers.parseEther("50");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-3"));
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 2);

    await expect(
      bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWith("Not enough signatures");
  });

  it("rejects a signature from an unauthorized validator", async function () {
    const amount    = ethers.parseEther("50");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-4"));
    const stranger  = (await ethers.getSigners())[8];

    const sigs = [
      await signMint(stranger, messageId, mockToken.target, user.address, amount),
      await signMint(stranger, messageId, mockToken.target, user.address, amount),
      await signMint(stranger, messageId, mockToken.target, user.address, amount),
    ];

    await expect(
      bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  it("rejects duplicate signatures from the same validator", async function () {
    const amount    = ethers.parseEther("50");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-5"));
    const sig = await signMint(validators[0], messageId, mockToken.target, user.address, amount);

    await expect(
      bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, [sig, sig, sig])
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  it("rejects a replayed message (same messageId used twice)", async function () {
    const amount    = ethers.parseEther("10");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-6"));
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 3);

    await bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);

    const sigs2 = await collectMintSigs(messageId, mockToken.target, user.address, amount, 3);
    await expect(
      bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs2)
    ).to.be.revertedWith("Already processed");
  });

  it("rejects a signature made for a different amount", async function () {
    const amount    = ethers.parseEther("100");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-7"));
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 3);
    const wrongAmount = ethers.parseEther("999");

    await expect(
      bridgeDest.mint(mockToken.target, user.address, wrongAmount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  it("rejects a signature made for a different recipient", async function () {
    const amount    = ethers.parseEther("100");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message-8"));
    const attacker  = (await ethers.getSigners())[9];
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 3);

    await expect(
      bridgeDest.mint(mockToken.target, attacker.address, amount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  // ── Validator management ──────────────────────────────────────────────────

  it("allows owner to add a new validator", async function () {
    const newValidator = (await ethers.getSigners())[9];
    await bridgeDest.connect(owner).addValidator(newValidator.address);
    expect(await bridgeDest.isValidator(newValidator.address)).to.be.true;
  });

  it("allows owner to remove a validator when count stays at or above threshold", async function () {
    await bridgeDest.connect(owner).removeValidator(validators[4].address);
    expect(await bridgeDest.isValidator(validators[4].address)).to.be.false;
  });

  it("prevents removing a validator if it would drop below threshold", async function () {
    await bridgeDest.connect(owner).removeValidator(validators[4].address);
    await bridgeDest.connect(owner).removeValidator(validators[3].address);

    await expect(
      bridgeDest.connect(owner).removeValidator(validators[2].address)
    ).to.be.revertedWith("Below threshold");
  });

  it("allows owner to update threshold", async function () {
    await bridgeDest.connect(owner).setThreshold(4);
    expect(await bridgeDest.threshold()).to.equal(4);
  });

  // ── Burn / unlock (Amoy → Sepolia) ────────────────────────────────────────

  it("user can burn wrapped tokens", async function () {
    const amount    = ethers.parseEther("100");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("burn-test-1"));
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 3);

    await bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);
    await bridgeDest.connect(user).burn(mockToken.target, amount);
    expect(await wrappedToken.balanceOf(user.address)).to.equal(0);
  });

  it("unlocks original tokens on the source chain given threshold signatures", async function () {
    const amount = ethers.parseEther("100");

    // Get real tokens locked on the source side first, so the bridge holds
    // enough balance to release.
    await mockToken.connect(user).approve(bridgeSource.target, amount);
    await bridgeSource.connect(user).lockTokens(mockToken.target, amount);

    const messageId = ethers.keccak256(ethers.toUtf8Bytes("unlock-test-1"));
    const sigs = await collectUnlockSigs(messageId, mockToken.target, user.address, amount, 3);

    await bridgeSource.unlockTokens(mockToken.target, user.address, amount, messageId, DEST_CHAIN_ID, sigs);
    expect(await mockToken.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
  });

  it("rejects a replayed unlock message", async function () {
    const amount = ethers.parseEther("50");
    await mockToken.connect(user).approve(bridgeSource.target, amount);
    await bridgeSource.connect(user).lockTokens(mockToken.target, amount);

    const messageId = ethers.keccak256(ethers.toUtf8Bytes("unlock-test-2"));
    const sigs = await collectUnlockSigs(messageId, mockToken.target, user.address, amount, 3);
    await bridgeSource.unlockTokens(mockToken.target, user.address, amount, messageId, DEST_CHAIN_ID, sigs);

    const sigs2 = await collectUnlockSigs(messageId, mockToken.target, user.address, amount, 3);
    await expect(
      bridgeSource.unlockTokens(mockToken.target, user.address, amount, messageId, DEST_CHAIN_ID, sigs2)
    ).to.be.revertedWith("Already processed");
  });

  // ── Decimal normalization ─────────────────────────────────────────────────

  it("mints the correct amount for a 6-decimal token", async function () {
    const MockUSDC = await ethers.getContractFactory("MockERC20");
    const usdc = await MockUSDC.deploy();
    // MockERC20 is hardcoded to 18 decimals in this repo, so we register it
    // declaring 6 decimals purely to exercise the normalize/denormalize math —
    // the wrapped token below is deployed with 6 decimals independently.
    await bridgeDest.connect(owner).registerTokenWithWrapped(
      usdc.target, 6, 1n, ethers.parseUnits("1000000", 6), "Wrapped USDC", "wUSDC"
    );
    const wUSDC = (await ethers.getContractFactory("WrappedToken")).attach(
      await bridgeDest.wrappedTokens(usdc.target)
    );

    // 1 USDC = 1_000_000 raw (6 decimals) => normalized to 1e18 in transit
    const rawAmount = 1_000_000n;
    const normalizedAmount = ethers.parseUnits("1", 18);
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("usdc-test-1"));
    const sigs = await collectMintSigs(messageId, usdc.target, user.address, normalizedAmount, 3);

    await bridgeDest.mint(usdc.target, user.address, normalizedAmount, messageId, SOURCE_CHAIN_ID, sigs);
    expect(await wUSDC.balanceOf(user.address)).to.equal(rawAmount);
  });

  // ── Emergency controls ─────────────────────────────────────────────────────

  it("blocks operations when bridge is paused", async function () {
    const amount    = ethers.parseEther("10");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("pause-test-1"));
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 3);

    await bridgeDest.connect(owner).pauseBridge();
    await expect(
      bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWithCustomError(bridgeDest, "EnforcedPause");
  });

  it("tracks totalMinted correctly", async function () {
    const amount    = ethers.parseEther("42");
    const messageId = ethers.keccak256(ethers.toUtf8Bytes("stats-test-1"));
    const sigs = await collectMintSigs(messageId, mockToken.target, user.address, amount, 3);

    await bridgeDest.mint(mockToken.target, user.address, amount, messageId, SOURCE_CHAIN_ID, sigs);
    expect(await bridgeDest.totalMinted(mockToken.target)).to.equal(amount);
  });
});
