'use strict';

const db = require('./db');

function nowIso() {
  return new Date().toISOString();
}

// ---- Dossier cache: keyed by canonical dossier CONTENT hash, not by
// dossierId or evaluationId. This is what lets us skip repeat model calls
// when the same 64 core dossiers reappear under a new evaluationId. ----

function getDossierCache(contentHash) {
  const row = db
    .prepare('SELECT * FROM dossier_cache WHERE content_hash = ?')
    .get(contentHash);
  return row || null;
}

function setDossierCache(contentHash, dossierId, proposalJson) {
  db.prepare(
    `INSERT OR IGNORE INTO dossier_cache (content_hash, dossier_id, proposal_json, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(contentHash, dossierId, proposalJson, nowIso());
}

// ---- Evaluations: one row per propose call, keyed by evaluationId. ----

function getEvaluation(evaluationId) {
  const row = db
    .prepare('SELECT * FROM evaluations WHERE evaluation_id = ?')
    .get(evaluationId);
  if (!row) return null;
  return {
    evaluationId: row.evaluation_id,
    inputDigest: row.input_digest,
    verifierJwk: row.verifier_jwk,
    proposeResponseJson: row.propose_response_json,
  };
}

function saveEvaluation({ evaluationId, inputDigest, verifierJwk, proposeResponseJson }) {
  db.prepare(
    `INSERT INTO evaluations (evaluation_id, input_digest, verifier_jwk, propose_response_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(evaluationId, inputDigest, JSON.stringify(verifierJwk), proposeResponseJson, nowIso());
}

// ---- Commits: one row per completed commit, keyed by evaluationId. ----

function getCommit(evaluationId) {
  const row = db.prepare('SELECT * FROM commits WHERE evaluation_id = ?').get(evaluationId);
  if (!row) return null;
  return {
    evaluationId: row.evaluation_id,
    receiptsHash: row.receipts_hash,
    commitResponseJson: row.commit_response_json,
  };
}

function saveCommit({ evaluationId, receiptsHash, commitResponseJson }) {
  db.prepare(
    `INSERT INTO commits (evaluation_id, receipts_hash, commit_response_json, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(evaluationId, receiptsHash, commitResponseJson, nowIso());
}

module.exports = {
  getDossierCache,
  setDossierCache,
  getEvaluation,
  saveEvaluation,
  getCommit,
  saveCommit,
};
