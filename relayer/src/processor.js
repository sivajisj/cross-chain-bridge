const db = require("./db");
const { computeMessageId } = require("./messageId");
const { STATES, assertTransition } = require("./stateMachine");

function backoffDelayMs(retryCount, baseDelayMs) {
  return baseDelayMs * Math.pow(2, retryCount);
}

// Scan [fromBlock, toBlock] on the source chain for TokenLocked events
// and persist each one as a DETECTED -> CONFIRMING message. Safe to
// call with an overlapping or repeated range: the DB unique constraint
// on (chain, tx hash, log index) makes the insert a no-op the second
// time, so this function is idempotent by construction.
async function scanForNewMessages({ databaseUrl, bridgeSource, config, fromBlock, toBlock }) {
  const events = await bridgeSource.queryFilter(bridgeSource.filters.TokenLocked(), fromBlock, toBlock);
  if (events.length === 0) return [];

  const tokenAddress = await bridgeSource.token();
  const newlyDetected = [];

  for (const event of events) {
    const { user, amount } = event.args;
    const messageId = computeMessageId({
      sourceChainId: config.sourceChainId,
      destinationChainId: config.destinationChainId,
      sourceTxHash: event.transactionHash,
      sourceLogIndex: event.index,
    });

    const { row, inserted } = await db.insertDetectedMessage(databaseUrl, {
      messageId,
      sourceChainId: config.sourceChainId,
      destinationChainId: config.destinationChainId,
      sourceTxHash: event.transactionHash,
      sourceLogIndex: event.index,
      sourceBlockNumber: event.blockNumber,
      sender: user,
      recipient: user,
      token: tokenAddress,
      amount,
      nonce: messageId,
    });

    if (!inserted) continue; // already known, nothing new to do

    assertTransition(STATES.DETECTED, STATES.CONFIRMING);
    const confirming = await db.transitionStatus(databaseUrl, messageId, [STATES.DETECTED], STATES.CONFIRMING);
    if (confirming) newlyDetected.push(confirming);
  }

  return newlyDetected;
}

// Promote CONFIRMING messages to FINALIZED once the source chain has
// produced enough blocks on top of them. The confirmation depth is
// configurable per deployment instead of assumed in code.
async function checkFinality({ databaseUrl, sourceProvider, config }) {
  const currentBlock = await sourceProvider.getBlockNumber();
  const confirming = await db.getMessagesByStatus(databaseUrl, STATES.CONFIRMING, config.sourceChainId);

  const finalized = [];
  for (const message of confirming) {
    const confirmations = currentBlock - Number(message.source_block_number);
    if (confirmations < config.confirmationsRequired) continue;

    assertTransition(STATES.CONFIRMING, STATES.FINALIZED);
    const updated = await db.transitionStatus(databaseUrl, message.message_id, [STATES.CONFIRMING], STATES.FINALIZED);
    if (updated) finalized.push(updated);
  }
  return finalized;
}

// Record a failed submission attempt: either schedule a backoff retry,
// or give up permanently once maxRetries is exceeded. Bounded retries
// stop a broken destination chain from spinning forever.
async function failOrRetry({ databaseUrl, config, message, error }) {
  const nextRetryCount = message.retry_count + 1;

  if (nextRetryCount > config.maxRetries) {
    assertTransition(STATES.SUBMITTED, STATES.FAILED);
    return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.FAILED, {
      last_error: error,
      retry_count: nextRetryCount,
    });
  }

  assertTransition(STATES.SUBMITTED, STATES.RETRYING);
  const delay = backoffDelayMs(nextRetryCount, config.retryBaseDelayMs);
  return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.RETRYING, {
    last_error: error,
    retry_count: nextRetryCount,
    next_retry_at: new Date(Date.now() + delay),
  });
}

// Attempt to submit exactly one FINALIZED or RETRYING message to the
// destination chain. The atomic transitionStatus() claim is what makes
// this safe to call more than once, or from more than one process, for
// the same message: only whoever wins the UPDATE actually sends a tx.
async function submitMessage({ databaseUrl, bridgeDest, config, message }) {
  const fromStatus = message.status;
  if (![STATES.FINALIZED, STATES.RETRYING].includes(fromStatus)) return null;

  // If the destination contract already shows this nonce as processed
  // (for example a previous run's transaction landed but the process
  // died before it could record COMPLETED), reconcile instead of
  // sending a second transaction.
  const alreadyProcessedOnChain = await bridgeDest.processedNonces(message.message_id);
  if (alreadyProcessedOnChain) {
    assertTransition(fromStatus, STATES.COMPLETED);
    return db.transitionStatus(databaseUrl, message.message_id, [fromStatus], STATES.COMPLETED);
  }

  assertTransition(fromStatus, STATES.SUBMITTED);
  const claimed = await db.transitionStatus(databaseUrl, message.message_id, [fromStatus], STATES.SUBMITTED);
  if (!claimed) return null; // someone else already claimed this message

  try {
    const tx = await bridgeDest.mint(message.recipient, message.amount, message.message_id);
    await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.SUBMITTED, {
      destination_tx_hash: tx.hash,
    });

    const receipt = await tx.wait();
    if (receipt.status === 1) {
      assertTransition(STATES.SUBMITTED, STATES.COMPLETED);
      return db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.COMPLETED);
    }
    return failOrRetry({ databaseUrl, config, message: claimed, error: "destination transaction reverted" });
  } catch (err) {
    return failOrRetry({ databaseUrl, config, message: claimed, error: err.message });
  }
}

// One pass over everything ready to submit right now: freshly FINALIZED
// messages, plus RETRYING messages whose backoff window has elapsed.
async function processReadyMessages({ databaseUrl, bridgeDest, config }) {
  const finalized = await db.getMessagesByStatus(databaseUrl, STATES.FINALIZED, config.sourceChainId);
  const retrying = await db.getRetryableMessages(databaseUrl);

  const results = [];
  for (const message of [...finalized, ...retrying]) {
    const result = await submitMessage({ databaseUrl, bridgeDest, config, message });
    if (result) results.push(result);
  }
  return results;
}

// Run once on boot. Anything not COMPLETED or FAILED survived the last
// crash in some intermediate state. CONFIRMING/FINALIZED/RETRYING just
// re-enter the normal pipeline on the next tick. SUBMITTED is the
// dangerous one: we genuinely don't know if the mint transaction landed,
// so we check the chain directly instead of guessing.
async function recoverUnfinishedMessages({ databaseUrl, destProvider, bridgeDest, config }) {
  const unfinished = await db.getUnfinishedMessages(databaseUrl);
  const recovered = [];

  for (const message of unfinished) {
    if (message.status !== STATES.SUBMITTED) {
      recovered.push(message);
      continue;
    }

    const alreadyProcessedOnChain = await bridgeDest.processedNonces(message.message_id);
    if (alreadyProcessedOnChain) {
      recovered.push(await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.COMPLETED));
      continue;
    }

    if (message.destination_tx_hash) {
      const receipt = await destProvider.getTransactionReceipt(message.destination_tx_hash);
      if (receipt && receipt.status === 1) {
        recovered.push(await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.COMPLETED));
        continue;
      }
    }

    // No confirmed receipt and the chain doesn't show it processed —
    // safe to resubmit. Route it through RETRYING rather than firing a
    // transaction immediately, so it still respects maxRetries.
    recovered.push(
      await db.transitionStatus(databaseUrl, message.message_id, [STATES.SUBMITTED], STATES.RETRYING, {
        last_error: "recovered after relayer restart",
      })
    );
  }

  return recovered;
}

module.exports = {
  backoffDelayMs,
  scanForNewMessages,
  checkFinality,
  submitMessage,
  processReadyMessages,
  recoverUnfinishedMessages,
};