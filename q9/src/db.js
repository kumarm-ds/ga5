'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS dossier_cache (
  content_hash   TEXT PRIMARY KEY,
  dossier_id     TEXT NOT NULL,
  proposal_json  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id         TEXT PRIMARY KEY,
  input_digest          TEXT NOT NULL,
  verifier_jwk          TEXT NOT NULL,
  propose_response_json TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commits (
  evaluation_id        TEXT PRIMARY KEY,
  receipts_hash        TEXT NOT NULL,
  commit_response_json TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
`);

module.exports = db;
