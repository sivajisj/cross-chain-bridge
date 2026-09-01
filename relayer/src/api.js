const express = require("express");
const cors    = require("cors");
const db      = require("./db");

// ─────────────────────────────────────────────────────────────────────────────
// Bridge REST API — Phase 5
//
// Exposes message state and metrics so the frontend bridge explorer
// can show real data without the user having to check a block explorer.
//
// All endpoints are read-only. The relayer's write path (scan/submit)
// is completely separate and unaffected by this server.
// ─────────────────────────────────────────────────────────────────────────────

function createApp(databaseUrl) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── GET /api/health ──────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ── GET /api/metrics ─────────────────────────────────────────────────────
  app.get("/api/metrics", async (_req, res) => {
    try {
      const pool = db.getPool(databaseUrl);

      const [counts, volume, timing] = await Promise.all([
        pool.query(`
          SELECT status, COUNT(*) as count
          FROM bridge_messages
          GROUP BY status
        `),
        pool.query(`
          SELECT token, SUM(amount) as total_volume, COUNT(*) as message_count
          FROM bridge_messages
          WHERE status = 'COMPLETED'
          GROUP BY token
        `),
        pool.query(`
          SELECT
            AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
            MIN(EXTRACT(EPOCH FROM (updated_at - created_at))) as min_seconds,
            MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
          FROM bridge_messages
          WHERE status = 'COMPLETED'
        `),
      ]);

      const statusCounts = {
        DETECTED: 0, CONFIRMING: 0, FINALIZED: 0,
        SUBMITTED: 0, COMPLETED: 0, FAILED: 0, RETRYING: 0,
      };
      counts.rows.forEach(r => {
        statusCounts[r.status] = parseInt(r.count, 10);
      });

      const totalMessages = Object.values(statusCounts).reduce((a, b) => a + b, 0);
      const pending = statusCounts.DETECTED + statusCounts.CONFIRMING +
                      statusCounts.FINALIZED + statusCounts.SUBMITTED +
                      statusCounts.RETRYING;

      res.json({
        totalMessages,
        pending,
        completed: statusCounts.COMPLETED,
        failed:    statusCounts.FAILED,
        retrying:  statusCounts.RETRYING,
        byStatus:  statusCounts,
        volume:    volume.rows,
        timing: timing.rows[0] || { avg_seconds: null, min_seconds: null, max_seconds: null },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/messages ─────────────────────────────────────────────────────
  // List messages with optional filters. Query params: status, direction,
  // limit (default 20, max 100), offset.
  app.get("/api/messages", async (req, res) => {
    try {
      const pool   = db.getPool(databaseUrl);
      const limit  = Math.min(parseInt(req.query.limit  || "20", 10), 100);
      const offset = parseInt(req.query.offset || "0", 10);

      const conditions = [];
      const filterValues = [];
      let idx = 1;

      if (req.query.status) {
        conditions.push(`status = $${idx++}`);
        filterValues.push(req.query.status.toUpperCase());
      }
      if (req.query.direction) {
        conditions.push(`direction = $${idx++}`);
        filterValues.push(req.query.direction.toUpperCase());
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await pool.query(
        `SELECT * FROM bridge_messages
         ${where}
         ORDER BY created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...filterValues, limit, offset]
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM bridge_messages ${where}`,
        filterValues
      );

      res.json({
        messages: result.rows,
        total: parseInt(countResult.rows[0].count, 10),
        limit,
        offset,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/messages/tx/:txHash ─────────────────────────────────────────
  // Registered before /api/messages/:messageId so "tx" is never matched as
  // a messageId.
  app.get("/api/messages/tx/:txHash", async (req, res) => {
    try {
      const pool   = db.getPool(databaseUrl);
      const result = await pool.query(
        `SELECT * FROM bridge_messages WHERE LOWER(source_tx_hash) = LOWER($1)`,
        [req.params.txHash]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "No message found for this transaction" });
      }
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/messages/address/:address ───────────────────────────────────
  app.get("/api/messages/address/:address", async (req, res) => {
    try {
      const pool   = db.getPool(databaseUrl);
      const result = await pool.query(
        `SELECT * FROM bridge_messages
         WHERE LOWER(sender) = LOWER($1)
         ORDER BY created_at DESC
         LIMIT 50`,
        [req.params.address]
      );
      res.json({ messages: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/messages/:messageId ─────────────────────────────────────────
  // Kept last among /api/messages/* routes so the more specific paths above
  // (tx/:txHash, address/:address) are matched first.
  app.get("/api/messages/:messageId", async (req, res) => {
    try {
      const message = await db.getMessageById(databaseUrl, req.params.messageId);
      if (!message) return res.status(404).json({ error: "Message not found" });
      res.json(message);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

function startApiServer(databaseUrl, port = 3001) {
  const app = createApp(databaseUrl);
  const server = app.listen(port, () => {
    console.log(`Bridge API running on http://localhost:${port}`);
    console.log(`  GET /api/health`);
    console.log(`  GET /api/metrics`);
    console.log(`  GET /api/messages`);
    console.log(`  GET /api/messages/:messageId`);
    console.log(`  GET /api/messages/tx/:txHash`);
    console.log(`  GET /api/messages/address/:address`);
  });
  return server;
}

module.exports = { createApp, startApiServer };
