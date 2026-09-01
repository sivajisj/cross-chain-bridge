const { expect } = require("chai");
const http = require("http");
const { createApp } = require("../../src/api");
const db = require("../../src/db");

const TEST_DB = process.env.TEST_DATABASE_URL ||
  "postgres://bridge:bridge@localhost:5432/bridge_relayer_test";

function get(server, path) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req  = http.get(`http://localhost:${addr.port}${path}`, (res) => {
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
  });
}

describe("Bridge API", function () {
  let server;

  before(async function () {
    await db.migrate(TEST_DB);
    const pool = db.getPool(TEST_DB);
    await pool.query("TRUNCATE bridge_messages, sync_cursor");

    const app = createApp(TEST_DB);
    server = app.listen(0); // random port
  });

  after(async function () {
    server.close();
    await db.closePool();
  });

  it("GET /api/health returns ok", async function () {
    const res = await get(server, "/api/health");
    expect(res.status).to.equal(200);
    expect(res.body.status).to.equal("ok");
  });

  it("GET /api/metrics returns zero counts on empty DB", async function () {
    const res = await get(server, "/api/metrics");
    expect(res.status).to.equal(200);
    expect(res.body.totalMessages).to.equal(0);
    expect(res.body.completed).to.equal(0);
    expect(res.body.pending).to.equal(0);
  });

  it("GET /api/messages returns empty list on empty DB", async function () {
    const res = await get(server, "/api/messages");
    expect(res.status).to.equal(200);
    expect(res.body.messages).to.deep.equal([]);
    expect(res.body.total).to.equal(0);
  });

  it("GET /api/messages/:id returns 404 for unknown message", async function () {
    const fakeId = "0x" + "ab".repeat(32);
    const res = await get(server, `/api/messages/${fakeId}`);
    expect(res.status).to.equal(404);
  });

  it("GET /api/messages/tx/:txHash returns 404 for unknown tx hash", async function () {
    const fakeTx = "0x" + "12".repeat(32);
    const res = await get(server, `/api/messages/tx/${fakeTx}`);
    expect(res.status).to.equal(404);
  });

  it("GET /api/messages/address/:address returns an empty list for an unused address", async function () {
    const res = await get(server, `/api/messages/address/0x${"34".repeat(20)}`);
    expect(res.status).to.equal(200);
    expect(res.body.messages).to.deep.equal([]);
  });

  it("GET /api/metrics, /api/messages and /api/messages/tx reflect an inserted message", async function () {
    const messageId = "0x" + "cc".repeat(32);
    const txHash    = "0x" + "dd".repeat(32);
    const wallet    = "0x" + "ee".repeat(20);
    const token     = "0x" + "ff".repeat(20);

    const pool = db.getPool(TEST_DB);
    await pool.query(
      `INSERT INTO bridge_messages
         (message_id, source_chain_id, destination_chain_id, source_tx_hash,
          source_log_index, source_block_number, sender, recipient, token,
          amount, nonce, direction, status)
       VALUES ($1,11155111,80002,$2,0,100,$3,$3,$4,1000000000000000000,$1,'LOCK','COMPLETED')`,
      [messageId, txHash, wallet, token]
    );

    const metrics = await get(server, "/api/metrics");
    expect(metrics.body.totalMessages).to.equal(1);
    expect(metrics.body.completed).to.equal(1);

    const byId = await get(server, `/api/messages/${messageId}`);
    expect(byId.status).to.equal(200);
    expect(byId.body.message_id).to.equal(messageId);

    const byTx = await get(server, `/api/messages/tx/${txHash}`);
    expect(byTx.status).to.equal(200);
    expect(byTx.body.message_id).to.equal(messageId);

    const list = await get(server, "/api/messages?status=completed&direction=lock");
    expect(list.body.total).to.equal(1);
    expect(list.body.messages[0].message_id).to.equal(messageId);
  });
});
