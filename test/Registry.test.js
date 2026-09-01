const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─────────────────────────────────────────────────────────────────────────────
// TokenRegistry + WrappedToken + BridgeSource management coverage — Phase 4.
// Bridge.test.js and Fuzz.test.js exercise the lock/mint/burn/unlock happy
// and adversarial paths; this file rounds out coverage of the token
// management surface (enable/disable/limits/views) and access control on
// WrappedToken and BridgeSource that those files don't otherwise touch.
// ─────────────────────────────────────────────────────────────────────────────

describe("TokenRegistry, WrappedToken, BridgeSource — management surface", function () {
  let mockToken, bridgeSource, bridgeDest, wrappedToken;
  let owner, user, validators;

  const MIN_AMOUNT = ethers.parseEther("1");
  const MAX_AMOUNT = ethers.parseEther("1000000");

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    owner = signers[0];
    user  = signers[1];
    validators = signers.slice(2, 7);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy();

    const BridgeSource = await ethers.getContractFactory("BridgeSource");
    bridgeSource = await BridgeSource.deploy(validators.map(v => v.address), 3);

    const BridgeDest = await ethers.getContractFactory("BridgeDest");
    bridgeDest = await BridgeDest.deploy(validators.map(v => v.address), 3);

    await bridgeSource.registerToken(mockToken.target, 18, MIN_AMOUNT, MAX_AMOUNT);
    await bridgeDest.registerTokenWithWrapped(mockToken.target, 18, MIN_AMOUNT, MAX_AMOUNT, "Wrapped Mock", "wMOCK");

    const WrappedToken = await ethers.getContractFactory("WrappedToken");
    wrappedToken = WrappedToken.attach(await bridgeDest.wrappedTokens(mockToken.target));
  });

  // ── Registration guards ───────────────────────────────────────────────────

  it("rejects registering the zero address", async function () {
    await expect(
      bridgeSource.registerToken(ethers.ZeroAddress, 18, MIN_AMOUNT, MAX_AMOUNT)
    ).to.be.revertedWith("Invalid token address");
  });

  it("rejects registering the same token twice", async function () {
    await expect(
      bridgeSource.registerToken(mockToken.target, 18, MIN_AMOUNT, MAX_AMOUNT)
    ).to.be.revertedWith("Token already registered");
  });

  it("rejects a maxAmount not exceeding minAmount", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const other = await MockERC20.deploy();
    await expect(
      bridgeSource.registerToken(other.target, 18, ethers.parseEther("10"), ethers.parseEther("10"))
    ).to.be.revertedWith("maxAmount must exceed minAmount");
  });

  it("rejects more than 18 decimals", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const other = await MockERC20.deploy();
    await expect(
      bridgeSource.registerToken(other.target, 19, MIN_AMOUNT, MAX_AMOUNT)
    ).to.be.revertedWith("Decimals must be <= 18");
  });

  it("rejects registration from a non-owner", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const other = await MockERC20.deploy();
    await expect(
      bridgeSource.connect(user).registerToken(other.target, 18, MIN_AMOUNT, MAX_AMOUNT)
    ).to.be.revertedWithCustomError(bridgeSource, "OwnableUnauthorizedAccount");
  });

  // ── Enable / disable ───────────────────────────────────────────────────────

  it("allows owner to disable and re-enable a token", async function () {
    expect(await bridgeSource.isTokenEnabled(mockToken.target)).to.be.true;

    await bridgeSource.disableToken(mockToken.target);
    expect(await bridgeSource.isTokenEnabled(mockToken.target)).to.be.false;

    await mockToken.mint(user.address, ethers.parseEther("10"));
    await mockToken.connect(user).approve(bridgeSource.target, ethers.parseEther("10"));
    await expect(
      bridgeSource.connect(user).lockTokens(mockToken.target, ethers.parseEther("10"))
    ).to.be.revertedWith("Token not supported");

    await bridgeSource.enableToken(mockToken.target);
    expect(await bridgeSource.isTokenEnabled(mockToken.target)).to.be.true;
    await bridgeSource.connect(user).lockTokens(mockToken.target, ethers.parseEther("10"));
  });

  it("rejects disabling a token that is not enabled", async function () {
    await bridgeSource.disableToken(mockToken.target);
    await expect(bridgeSource.disableToken(mockToken.target)).to.be.revertedWith("Token not enabled");
  });

  it("rejects enabling/disabling an unregistered token", async function () {
    await expect(bridgeSource.enableToken(user.address)).to.be.revertedWith("Token not registered");
  });

  // ── Limits ─────────────────────────────────────────────────────────────────

  it("allows owner to update token limits", async function () {
    const newMin = ethers.parseEther("5");
    const newMax = ethers.parseEther("500");
    await bridgeSource.setTokenLimits(mockToken.target, newMin, newMax);

    const cfg = await bridgeSource.getTokenConfig(mockToken.target);
    expect(cfg.minAmount).to.equal(newMin);
    expect(cfg.maxAmount).to.equal(newMax);
  });

  it("rejects invalid limits on update", async function () {
    await expect(
      bridgeSource.setTokenLimits(mockToken.target, ethers.parseEther("100"), ethers.parseEther("1"))
    ).to.be.revertedWith("maxAmount must exceed minAmount");
  });

  // ── Views ──────────────────────────────────────────────────────────────────

  it("lists registered tokens", async function () {
    const tokens = await bridgeSource.getRegisteredTokens();
    expect(tokens).to.deep.equal([mockToken.target]);
  });

  it("normalize/denormalize round-trip through the public helpers for every supported decimal count", async function () {
    for (const decimals of [6, 8, 18]) {
      const raw = 12345n;
      const normalized = await bridgeSource.normalize(raw, decimals);
      const back = await bridgeSource.denormalize(normalized, decimals);
      expect(back).to.equal(raw);
    }
  });

  // ── WrappedToken access control ────────────────────────────────────────────

  it("wrapped token reports the same decimals as its source token", async function () {
    expect(await wrappedToken.decimals()).to.equal(18);
  });

  it("rejects mint/burn on the wrapped token from anyone but its owning bridge", async function () {
    await expect(
      wrappedToken.connect(user).mint(user.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(wrappedToken, "OwnableUnauthorizedAccount");

    await expect(
      wrappedToken.connect(user).burn(user.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(wrappedToken, "OwnableUnauthorizedAccount");
  });

  // ── BridgeSource validator management ──────────────────────────────────────

  it("allows owner to add and remove BridgeSource validators", async function () {
    const newValidator = (await ethers.getSigners())[9];
    await bridgeSource.addValidator(newValidator.address);
    expect(await bridgeSource.isValidator(newValidator.address)).to.be.true;

    await bridgeSource.removeValidator(newValidator.address);
    expect(await bridgeSource.isValidator(newValidator.address)).to.be.false;
  });

  it("allows owner to update BridgeSource threshold", async function () {
    await bridgeSource.setThreshold(4);
    expect(await bridgeSource.threshold()).to.equal(4);
  });

  it("rejects an unpause/pause call from a non-owner on BridgeSource", async function () {
    await expect(
      bridgeSource.connect(user).pauseBridge()
    ).to.be.revertedWithCustomError(bridgeSource, "OwnableUnauthorizedAccount");
  });

  it("blocks lockTokens when BridgeSource is paused, and allows it again after unpause", async function () {
    await bridgeSource.pauseBridge();
    await mockToken.mint(user.address, ethers.parseEther("10"));
    await mockToken.connect(user).approve(bridgeSource.target, ethers.parseEther("10"));

    await expect(
      bridgeSource.connect(user).lockTokens(mockToken.target, ethers.parseEther("10"))
    ).to.be.revertedWithCustomError(bridgeSource, "EnforcedPause");

    await bridgeSource.unpauseBridge();
    await bridgeSource.connect(user).lockTokens(mockToken.target, ethers.parseEther("10"));
  });

  it("returns the BridgeSource validator list", async function () {
    const list = await bridgeSource.getValidators();
    expect(list).to.deep.equal(validators.map(v => v.address));
  });
});
