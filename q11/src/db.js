import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/incident-agent.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    runId TEXT PRIMARY KEY,
    state TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS receipts (
    runId TEXT NOT NULL,
    receiptId TEXT NOT NULL,
    body TEXT NOT NULL,
    response TEXT NOT NULL,
    PRIMARY KEY (runId, receiptId)
  );
`);

export function getRun(runId) {
  const row = db.prepare("SELECT state FROM runs WHERE runId = ?").get(runId);
  return row ? JSON.parse(row.state) : null;
}

export function saveRun(runId, state) {
  db.prepare(
    `INSERT INTO runs (runId, state) VALUES (?, ?)
     ON CONFLICT(runId) DO UPDATE SET state = excluded.state`
  ).run(runId, JSON.stringify(state));
}

export function getReceipt(runId, receiptId) {
  const row = db
    .prepare("SELECT body, response FROM receipts WHERE runId = ? AND receiptId = ?")
    .get(runId, receiptId);
  if (!row) return null;
  return { body: JSON.parse(row.body), response: JSON.parse(row.response) };
}

export function saveReceipt(runId, receiptId, body, response) {
  db.prepare(
    `INSERT INTO receipts (runId, receiptId, body, response) VALUES (?, ?, ?, ?)`
  ).run(runId, receiptId, JSON.stringify(body), JSON.stringify(response));
}

export default db;
