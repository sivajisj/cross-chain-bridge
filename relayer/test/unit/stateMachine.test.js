const { expect } = require("chai");
const { STATES, isValidTransition, assertTransition, isTerminal } = require("../../src/stateMachine");

describe("state machine", function () {
  it("allows the documented happy path", function () {
    expect(isValidTransition(STATES.DETECTED, STATES.CONFIRMING)).to.be.true;
    expect(isValidTransition(STATES.CONFIRMING, STATES.FINALIZED)).to.be.true;
    expect(isValidTransition(STATES.FINALIZED, STATES.SUBMITTED)).to.be.true;
    expect(isValidTransition(STATES.SUBMITTED, STATES.COMPLETED)).to.be.true;
  });

  it("allows the retry path", function () {
    expect(isValidTransition(STATES.SUBMITTED, STATES.RETRYING)).to.be.true;
    expect(isValidTransition(STATES.RETRYING, STATES.SUBMITTED)).to.be.true;
    expect(isValidTransition(STATES.RETRYING, STATES.FAILED)).to.be.true;
    expect(isValidTransition(STATES.SUBMITTED, STATES.FAILED)).to.be.true;
  });

  it("rejects skipping states", function () {
    expect(isValidTransition(STATES.DETECTED, STATES.SUBMITTED)).to.be.false;
    expect(isValidTransition(STATES.DETECTED, STATES.COMPLETED)).to.be.false;
    expect(isValidTransition(STATES.CONFIRMING, STATES.SUBMITTED)).to.be.false;
  });

  it("rejects leaving a terminal state", function () {
    expect(isValidTransition(STATES.COMPLETED, STATES.RETRYING)).to.be.false;
    expect(isValidTransition(STATES.FAILED, STATES.RETRYING)).to.be.false;
    expect(isValidTransition(STATES.COMPLETED, STATES.DETECTED)).to.be.false;
  });

  it("throws on an invalid transition instead of silently allowing it", function () {
    expect(() => assertTransition(STATES.COMPLETED, STATES.DETECTED)).to.throw(/Invalid state transition/);
  });

  it("does not throw on a valid transition", function () {
    expect(() => assertTransition(STATES.DETECTED, STATES.CONFIRMING)).to.not.throw();
  });

  it("identifies terminal states correctly", function () {
    expect(isTerminal(STATES.COMPLETED)).to.be.true;
    expect(isTerminal(STATES.FAILED)).to.be.true;
    expect(isTerminal(STATES.SUBMITTED)).to.be.false;
    expect(isTerminal(STATES.RETRYING)).to.be.false;
  });
});