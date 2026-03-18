const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Cross-Chain Bridge", function () {
  let mockToken, bridgeSource, bridgeDest;
  let owner, user, relayer;

  beforeEach(async function () {
    [owner, user, relayer] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy();

    const BridgeSource = await ethers.getContractFactory("BridgeSource");
    bridgeSource = await BridgeSource.deploy(mockToken.target);

    const BridgeDest = await ethers.getContractFactory("BridgeDest");
    bridgeDest = await BridgeDest.deploy();
    await bridgeDest.transferOwnership(relayer.address);

    await mockToken.mint(user.address, ethers.parseEther("1000"));
  });

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
    expect(await bridgeSource.lockedBalances(user.address)).to.equal(amount);
  });

  it("relayer mints wrapped tokens on destination chain", async function () {
    const amount = ethers.parseEther("100");
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("test-nonce-1"));

    await bridgeDest.connect(relayer).mint(user.address, amount, nonce);

    expect(await bridgeDest.balanceOf(user.address)).to.equal(amount);
  });

  it("user can burn wrapped tokens to get real tokens back", async function () {
    const amount = ethers.parseEther("100");
    const mintNonce   = ethers.keccak256(ethers.toUtf8Bytes("mint-nonce-1"));
    const unlockNonce = ethers.keccak256(ethers.toUtf8Bytes("unlock-nonce-1"));

    await mockToken.connect(user).approve(bridgeSource.target, amount);
    await bridgeSource.connect(user).lockTokens(amount);
    await bridgeDest.connect(relayer).mint(user.address, amount, mintNonce);

    await bridgeDest.connect(user).burn(amount);
    expect(await bridgeDest.balanceOf(user.address)).to.equal(0);

    await bridgeSource.connect(owner).unlockTokens(user.address, amount, unlockNonce);

    expect(await mockToken.balanceOf(user.address)).to.equal(
      ethers.parseEther("1000")
    );
  });

  it("rejects duplicate nonces", async function () {
    const amount = ethers.parseEther("10");
    const nonce = ethers.keccak256(ethers.toUtf8Bytes("test-nonce-1"));

    await bridgeDest.connect(relayer).mint(user.address, amount, nonce);

    await expect(
      bridgeDest.connect(relayer).mint(user.address, amount, nonce)
    ).to.be.revertedWith("Nonce already processed");
  });

  it("blocks operations when paused", async function () {
    const amount = ethers.parseEther("10");
    await bridgeSource.connect(owner).pauseBridge();

    await mockToken.connect(user).approve(bridgeSource.target, amount);
    await expect(
      bridgeSource.connect(user).lockTokens(amount)
    ).to.be.revertedWithCustomError(bridgeSource, "EnforcedPause");
  });

  it("prevents reentrancy on lockTokens", async function () {
    const amount = ethers.parseEther("100");
    await mockToken.connect(user).approve(bridgeSource.target, amount);
    await bridgeSource.connect(user).lockTokens(amount);
    expect(await bridgeSource.lockedBalances(user.address)).to.equal(amount);
    expect(await bridgeSource.totalLocked()).to.equal(amount);
  });

  it("tracks total locked and unlocked stats", async function () {
    const amount = ethers.parseEther("50");
    const mintNonce   = ethers.keccak256(ethers.toUtf8Bytes("mint-nonce-2"));
    const unlockNonce = ethers.keccak256(ethers.toUtf8Bytes("unlock-nonce-2"));

    await mockToken.connect(user).approve(bridgeSource.target, amount);
    await bridgeSource.connect(user).lockTokens(amount);
    expect(await bridgeSource.totalLocked()).to.equal(amount);

    await bridgeDest.connect(relayer).mint(user.address, amount, mintNonce);
    await bridgeDest.connect(user).burn(amount);
    await bridgeSource.connect(owner).unlockTokens(user.address, amount, unlockNonce);

    expect(await bridgeSource.totalUnlocked()).to.equal(amount);
  });
});