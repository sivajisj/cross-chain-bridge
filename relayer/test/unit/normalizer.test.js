const { expect } = require("chai");
const { normalize, denormalize, roundTripLossless, NORMALIZED_DECIMALS } = require("../../src/normalizer");

describe("decimal normalization", function () {
  it("normalizes a 6-decimal amount up to 18 decimals", function () {
    expect(normalize(1_000_000n, 6)).to.equal(10n ** 18n);
  });

  it("normalizes an 8-decimal amount up to 18 decimals", function () {
    expect(normalize(100_000_000n, 8)).to.equal(10n ** 18n);
  });

  it("leaves an 18-decimal amount unchanged", function () {
    const amount = 123456789n;
    expect(normalize(amount, 18)).to.equal(amount);
  });

  it("denormalizes back to the original 6-decimal amount", function () {
    expect(denormalize(10n ** 18n, 6)).to.equal(1_000_000n);
  });

  it("denormalizes back to the original 8-decimal amount", function () {
    expect(denormalize(10n ** 18n, 8)).to.equal(100_000_000n);
  });

  it("accepts number/string inputs and returns BigInt", function () {
    expect(normalize(1000000, "6")).to.equal(10n ** 18n);
  });

  it("round-trips losslessly for every supported decimal count", function () {
    for (const decimals of [6, 8, 18]) {
      expect(roundTripLossless(12345n, decimals)).to.be.true;
    }
  });

  it("exposes the normalized decimal constant", function () {
    expect(NORMALIZED_DECIMALS).to.equal(18n);
  });
});
