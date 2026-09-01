const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// One pool per process. Tests and the live relayer both call getPool()
// with the same connection string, so they share a single pool instead
// of leaking connections.
let pool = null;

function getPool(connectionString) {
  if (!pool) {
    pool = new Pool({ connectionString });
  }
  return pool;
}

async function migrate(connectionString) {
  const p = getPool(connectionString);
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await p.query(schema);
}

// Insert a newly detected on-chain event as a DETECTED message.
// If this exact source event was already inserted (same chain, tx hash,
// log index), the unique constraint silently blocks the duplicate and
// we return the existing row instead. This is the core defense against
// re-processing the same lock event twice.
async function insertDetectedMessage(connectionString, msg) {
  const p = getPool(connectionString);

  const result = await p.query(
    `INSERT INTO bridge_messages
       (message_id, source_chain_id, destination_chain_id, source_tx_hash,
        source_log_index, source_block_number, sender, recipient, token,
        amount, nonce, direction, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DETECTED')
     ON CONFLICT (source_chain_id, source_tx_hash, source_log_index) DO NOTHING
     RETURNING *`,
    [
      msg.messageId,
      msg.sourceChainId,
      msg.destinationChainId,
      msg.sourceTxHash,
      msg.sourceLogIndex,
      msg.sourceBlockNumber,
      msg.sender,
      msg.recipient,
      msg.token,
      msg.amount.toString(),
      msg.nonce,
      msg.direction || "LOCK",
    ]
  );

  if (result.rows.length > 0) {
    return { row: result.rows[0], inserted: true };
  }

  const existing = await p.query(
    `SELECT * FROM bridge_messages
     WHERE source_chain_id = $1 AND source_tx_hash = $2 AND source_log_index = $3`,
    [msg.sourceChainId, msg.sourceTxHash, msg.sourceLogIndex]
  );
  return { row: existing.rows[0], inserted: false };
}

// Atomically move a message from one of `fromStatuses` to `toStatus`.
// The WHERE clause is the whole safety story here: if the row isn't
// currently in one of the expected states (because another pass, or
// another relayer instance, already moved it) zero rows match and we
// return null instead of double-processing anything.
async function transitionStatus(connectionString, messageId, fromStatuses, toStatus, extra = {}) {
  const p = getPool(connectionString);

  const setClauses = ["status = $2", "updated_at = now()"];
  const values = [messageId, toStatus];
  let idx = 3;
  for (const [key, value] of Object.entries(extra)) {
    setClauses.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  values.push(fromStatuses);

  const result = await p.query(
    `UPDATE bridge_messages
     SET ${setClauses.join(", ")}
     WHERE message_id = $1 AND status = ANY($${idx})
     RETURNING *`,
    values
  );

  return result.rows[0] || null;
}

async function getMessagesByStatus(connectionString, status, sourceChainId) {
  const p = getPool(connectionString);
  const result = await p.query(
    `SELECT * FROM bridge_messages
     WHERE status = $1 AND source_chain_id = $2
     ORDER BY source_block_number ASC`,
    [status, sourceChainId]
  );
  return result.rows;
}

async function getRetryableMessages(connectionString) {
  const p = getPool(connectionString);
  const result = await p.query(
    `SELECT * FROM bridge_messages
     WHERE status = 'RETRYING' AND (next_retry_at IS NULL OR next_retry_at <= now())
     ORDER BY updated_at ASC`
  );
  return result.rows;
}

// Everything not in a terminal state. Called once on boot to figure out
// what was left mid-flight the last time the process ran.
async function getUnfinishedMessages(connectionString) {
  const p = getPool(connectionString);
  const result = await p.query(
    `SELECT * FROM bridge_messages
     WHERE status NOT IN ('COMPLETED', 'FAILED')
     ORDER BY source_block_number ASC`
  );
  return result.rows;
}

async function getMessageById(connectionString, messageId) {
  const p = getPool(connectionString);
  const result = await p.query(`SELECT * FROM bridge_messages WHERE message_id = $1`, [messageId]);
  return result.rows[0] || null;
}

async function getCursor(connectionString, chainId, fallbackBlock) {
  const p = getPool(connectionString);
  const result = await p.query(`SELECT last_scanned_block FROM sync_cursor WHERE chain_id = $1`, [chainId]);
  if (result.rows.length === 0) return fallbackBlock;
  return Number(result.rows[0].last_scanned_block);
}

async function setCursor(connectionString, chainId, blockNumber) {
  const p = getPool(connectionString);
  await p.query(
    `INSERT INTO sync_cursor (chain_id, last_scanned_block, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (chain_id) DO UPDATE SET last_scanned_block = $2, updated_at = now()`,
    [chainId, blockNumber]
  );
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  migrate,
  insertDetectedMessage,
  transitionStatus,
  getMessagesByStatus,
  getRetryableMessages,
  getUnfinishedMessages,
  getMessageById,
  getCursor,
  setCursor,
  closePool,
};