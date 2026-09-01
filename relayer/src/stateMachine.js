// Every bridge message moves through exactly these states, in exactly
// these directions. Nothing in the relayer is allowed to jump straight
// from DETECTED to COMPLETED, skip finality, or leave a terminal state.
const STATES = Object.freeze({
  DETECTED: "DETECTED", // event seen, row inserted, not yet tracked toward finality
  CONFIRMING: "CONFIRMING", // waiting for enough source-chain confirmations
  FINALIZED: "FINALIZED", // confirmations satisfied, ready to submit
  SUBMITTED: "SUBMITTED", // a destination transaction is in flight
  COMPLETED: "COMPLETED", // destination transaction confirmed successful (terminal)
  FAILED: "FAILED", // retries exhausted (terminal)
  RETRYING: "RETRYING", // submission failed, waiting for backoff before trying again
});

const TRANSITIONS = Object.freeze({
  [STATES.DETECTED]: [STATES.CONFIRMING],
  [STATES.CONFIRMING]: [STATES.FINALIZED],
  [STATES.FINALIZED]: [STATES.SUBMITTED, STATES.RETRYING],
  [STATES.SUBMITTED]: [STATES.COMPLETED, STATES.RETRYING, STATES.FAILED],
  [STATES.RETRYING]: [STATES.SUBMITTED, STATES.FAILED],
  [STATES.COMPLETED]: [],
  [STATES.FAILED]: [],
});

function isValidTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function assertTransition(from, to) {
  if (!isValidTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}

function isTerminal(status) {
  return status === STATES.COMPLETED || status === STATES.FAILED;
}

module.exports = { STATES, TRANSITIONS, isValidTransition, assertTransition, isTerminal };