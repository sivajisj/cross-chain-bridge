const { expect } = require("chai");
const { computeMessageId } = require("../../src/messageId");

describe("message id generation", function () {
  const base = {
    sourceChainId: 11155111,
    destinationChainId: 80002,
    sourceTxHash: "0x" + "11".repeat(32),
    sourceLogIndex: 0,
  };

  it("is deterministic for identical inputs", function () {
    expect(computeMessageId(base)).to.equal(computeMessageId({ ...base }));
  });

  it("changes when the log index changes", function () {
    expect(computeMessageId(base)).to.not.equal(computeMessageId({ ...base, sourceLogIndex: 1 }));
  });

  it("changes when the source tx hash changes", function () {
    const other = "0x" + "22".repeat(32);
    expect(computeMessageId(base)).to.not.equal(computeMessageId({ ...base, sourceTxHash: other }));
  });

  it("changes when the destination chain changes", function () {
    expect(computeMessageId(base)).to.not.equal(computeMessageId({ ...base, destinationChainId: 1 }));
  });

  it("changes when the source chain changes", function () {
    expect(computeMessageId(base)).to.not.equal(computeMessageId({ ...base, sourceChainId: 80002 }));
  });

  it("produces a well-formed 32-byte hex string", function () {
    expect(computeMessageId(base)).to.match(/^0x[0-9a-f]{64}$/);
  });
});