const { expect } = require("chai");
const { ethers } = require("hardhat");
const { normalize, roundTripLossless } = require("../relayer/src/normalizer");

// ─────────────────────────────────────────────────────────────────────────────
// Fuzz + Invariant tests — Phase 4
//
// These tests run the bridge contracts and relayer math with random inputs
// to find edge cases no hand-written test would discover.
//
// Invariants tested:
//   1. Wrapped supply never exceeds locked deposits (normalized)
//   2. Processed nonces can never be reused
//   3. Unauthorized accounts cannot mint or unlock
//   4. Paused bridge blocks all restricted operations
//   5. Decimal normalization is always lossless for supported decimal counts
//   6. Threshold can never be bypassed with duplicate signatures
// ─────────────────────────────────────────────────────────────────────────────

describe("Fuzz and Invariant Tests — Phase 4", function () {
  this.timeout(120000);

  let token18, token6, token8;
  let bridgeSource, bridgeDest;
  let owner, user, attacker;
  let validators;

  const SOURCE_CHAIN_ID = 31337n;

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

  async function getDomainDest() {
    return {
      name: "CrossChainBridge",
      version: "1",
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      verifyingContract: await bridgeDest.getAddress(),
    };
  }

  async function signMint(validator, messageId, sourceToken, recipient, normalizedAmount) {
    const domain = await getDomainDest();
    return validator.signTypedData(domain, MINT_TYPES, {
      messageId, sourceToken, recipient, normalizedAmount,
      sourceChainId: SOURCE_CHAIN_ID,
      destChainId:   SOURCE_CHAIN_ID,
    });
  }

  async function collectMintSigs(messageId, sourceToken, recipient, normalizedAmount, count) {
    const sigs = [];
    for (let i = 0; i < count; i++) {
      sigs.push(await signMint(validators[i], messageId, sourceToken, recipient, normalizedAmount));
    }
    return sigs;
  }

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner    = signers[0];
    user     = signers[1];
    attacker = signers[9];
    validators = signers.slice(2, 7);

    const MockERC20  = await ethers.getContractFactory("MockERC20");
    const MockToken6 = await ethers.getContractFactory("MockToken6");
    const MockToken8 = await ethers.getContractFactory("MockToken8");
    token18 = await MockERC20.deploy();
    token6  = await MockToken6.deploy();
    token8  = await MockToken8.deploy();

    const validatorAddrs = validators.map(v => v.address);

    const BridgeSource = await ethers.getContractFactory("BridgeSource");
    const BridgeDest   = await ethers.getContractFactory("BridgeDest");
    bridgeSource = await BridgeSource.deploy(validatorAddrs, 3);
    bridgeDest   = await BridgeDest.deploy(validatorAddrs, 3);

    const min18 = ethers.parseEther("0.001");
    const max18 = ethers.parseEther("1000000");
    await bridgeSource.registerToken(token18.target, 18, min18, max18);
    await bridgeDest.registerTokenWithWrapped(token18.target, 18, min18, max18, "wBRT", "wBRT");

    await bridgeSource.registerToken(token6.target, 6, 1000n, 1_000_000_000_000n);
    await bridgeDest.registerTokenWithWrapped(token6.target, 6, 1000n, 1_000_000_000_000n, "wUSDC", "wUSDC");

    await bridgeSource.registerToken(token8.target, 8, 1000n, 10_000_000_000n);
    await bridgeDest.registerTokenWithWrapped(token8.target, 8, 1000n, 10_000_000_000n, "wWBTC", "wWBTC");

    await token18.mint(user.address, ethers.parseEther("1000000"));
    await token6.mint(user.address,  1_000_000_000_000n);
    await token8.mint(user.address,  10_000_000_000n);
  });

  // ── Invariant 1: wrapped supply never exceeds locked deposits ─────────────
  it("INVARIANT: wrapped supply never exceeds locked deposits after N random mints", async function () {
    const wBRT = await ethers.getContractAt("WrappedToken", await bridgeDest.wrappedTokens(token18.target));
    let totalLocked = 0n;

    // 20 random lock + mint operations
    for (let i = 0; i < 20; i++) {
      const rawAmount = ethers.parseEther((Math.random() * 99.999 + 0.001).toFixed(6));
      const normalizedAmount = normalize(rawAmount, 18);
      const messageId = ethers.keccak256(ethers.toUtf8Bytes(`fuzz-inv-${i}-${Date.now()}-${Math.random()}`));

      await token18.connect(user).approve(bridgeSource.target, rawAmount);
      await bridgeSource.connect(user).lockTokens(token18.target, rawAmount);
      totalLocked += rawAmount;

      const sigs = await collectMintSigs(messageId, token18.target, user.address, normalizedAmount, 3);
      await bridgeDest.mint(token18.target, user.address, normalizedAmount, messageId, SOURCE_CHAIN_ID, sigs);
    }

    const wrappedSupply = await wBRT.totalSupply();

    // INVARIANT: wrapped supply must never exceed what was locked
    // (it can be less if some was burned, but never more)
    expect(wrappedSupply).to.be.lte(totalLocked);
  });

  // ── Invariant 2: processed nonces cannot be reused ────────────────────────
  it("INVARIANT: processed messageId can never authorize a second mint", async function () {
    const amount     = ethers.parseEther("10");
    const messageId  = ethers.keccak256(ethers.toUtf8Bytes("nonce-invariant-1"));
    const normalized = normalize(amount, 18);

    await token18.connect(user).approve(bridgeSource.target, amount);
    await bridgeSource.connect(user).lockTokens(token18.target, amount);

    const sigs1 = await collectMintSigs(messageId, token18.target, user.address, normalized, 3);
    await bridgeDest.mint(token18.target, user.address, normalized, messageId, SOURCE_CHAIN_ID, sigs1);

    expect(await bridgeDest.processedNonces(messageId)).to.be.true;

    const sigs2 = await collectMintSigs(messageId, token18.target, user.address, normalized, 3);
    await expect(
      bridgeDest.mint(token18.target, user.address, normalized, messageId, SOURCE_CHAIN_ID, sigs2)
    ).to.be.revertedWith("Already processed");
  });

  // ── Invariant 3: unauthorized accounts cannot mint ────────────────────────
  it("INVARIANT: attacker with no validator key cannot forge a valid mint", async function () {
    const amount     = ethers.parseEther("1000000");
    const messageId  = ethers.keccak256(ethers.toUtf8Bytes("forge-attempt-1"));
    const normalized = normalize(amount, 18);

    const domain = await getDomainDest();
    const forgeSig = await attacker.signTypedData(domain, MINT_TYPES, {
      messageId,
      sourceToken:      token18.target,
      recipient:        attacker.address,
      normalizedAmount: normalized,
      sourceChainId:    SOURCE_CHAIN_ID,
      destChainId:      SOURCE_CHAIN_ID,
    });

    await expect(
      bridgeDest.mint(
        token18.target, attacker.address, normalized, messageId,
        SOURCE_CHAIN_ID, [forgeSig, forgeSig, forgeSig]
      )
    ).to.be.revertedWith("Insufficient valid signatures");

    const wBRT = await ethers.getContractAt("WrappedToken", await bridgeDest.wrappedTokens(token18.target));
    expect(await wBRT.balanceOf(attacker.address)).to.equal(0n);
  });

  // ── Invariant 4: paused bridge blocks minting ─────────────────────────────
  it("INVARIANT: paused bridge cannot process any mint regardless of signatures", async function () {
    await bridgeDest.connect(owner).pauseBridge();

    const amount     = ethers.parseEther("1");
    const messageId  = ethers.keccak256(ethers.toUtf8Bytes("pause-inv-1"));
    const normalized = normalize(amount, 18);

    const sigs = await collectMintSigs(messageId, token18.target, user.address, normalized, 3);

    await expect(
      bridgeDest.mint(token18.target, user.address, normalized, messageId, SOURCE_CHAIN_ID, sigs)
    ).to.be.revertedWithCustomError(bridgeDest, "EnforcedPause");
  });

  // ── Invariant 5: decimal normalization is always lossless ─────────────────
  it("INVARIANT: normalize -> denormalize is lossless for 50 random 6-decimal amounts", function () {
    for (let i = 0; i < 50; i++) {
      const rawAmount = BigInt(Math.floor(Math.random() * 1_000_000_000) + 1);
      const lossless = roundTripLossless(rawAmount, 6);
      expect(lossless, `Amount ${rawAmount} round-trip failed`).to.be.true;
    }
  });

  it("INVARIANT: normalize -> denormalize is lossless for 50 random 8-decimal amounts", function () {
    for (let i = 0; i < 50; i++) {
      const rawAmount = BigInt(Math.floor(Math.random() * 10_000_000_000) + 1);
      const lossless = roundTripLossless(rawAmount, 8);
      expect(lossless, `Amount ${rawAmount} round-trip failed`).to.be.true;
    }
  });

  // ── Invariant 6: threshold cannot be bypassed with duplicates ─────────────
  it("INVARIANT: submitting the same signature N times never bypasses threshold", async function () {
    const amount     = ethers.parseEther("50");
    const messageId  = ethers.keccak256(ethers.toUtf8Bytes("dup-bypass-1"));
    const normalized = normalize(amount, 18);

    const oneSig = await signMint(validators[0], messageId, token18.target, user.address, normalized);
    const dupSigs = [oneSig, oneSig, oneSig];

    await expect(
      bridgeDest.mint(token18.target, user.address, normalized, messageId, SOURCE_CHAIN_ID, dupSigs)
    ).to.be.revertedWith("Insufficient valid signatures");
  });

  // ── Fuzz: random amounts stay within limits ───────────────────────────────
  it("FUZZ: amounts below minimum are always rejected", async function () {
    const belowMin = [1n, 10n, 100n, 999n]; // minAmount for token6 is 1000
    for (const amount of belowMin) {
      await token6.connect(user).approve(bridgeSource.target, amount);
      await expect(
        bridgeSource.connect(user).lockTokens(token6.target, amount)
      ).to.be.revertedWith("Amount below minimum");
    }
  });

  it("FUZZ: amounts above maximum are always rejected", async function () {
    const aboveMax = [
      1_000_000_000_001n,
      1_000_000_000_000_000n,
      ethers.MaxUint256 / 2n,
    ];
    for (const amount of aboveMax) {
      await token6.mint(user.address, amount);
      await token6.connect(user).approve(bridgeSource.target, amount);
      await expect(
        bridgeSource.connect(user).lockTokens(token6.target, amount)
      ).to.be.revertedWith("Amount exceeds maximum");
    }
  });
});
