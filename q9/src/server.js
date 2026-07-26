'use strict';

require('dotenv').config();

const express = require('express');
const { canonicalize, sha256hex, computeInputDigest, computeProposalDigest } = require('./canonical');
const { validateProposeRequest, validateCommitRequest, PROFILE } = require('./validation');
const { decideActionsBatch } = require('./model');
const { buildSafeProposal } = require('./safety');
const { importEd25519PublicKeyFromJwk, verifyReceiptSignature } = require('./receipt-crypto');
const store = require('./store');

const app = express();

// Bound body size - the core corpus is ~70-75k input tokens of text, so
// allow generous headroom while still bounding it.
app.use(express.json({ limit: '15mb' }));

// Malformed JSON -> 400, before any other work.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'malformed JSON body');
  }
  next(err);
});

function sendError(res, code, message) {
  res.status(code).set('Content-Type', 'application/json').json({ error: message });
}

// How many uncached dossiers go into a single model call. Batching keeps
// total request count low enough to fit free-tier rate limits and the 55s
// per-request budget (e.g. 67 dossiers / batch size 10 = ~7 calls instead
// of 67).
const BATCH_SIZE = Number(process.env.MODEL_BATCH_SIZE || 10);
// How many batches run concurrently. Keep this low - it directly multiplies
// your requests-per-minute against the model provider.
const BATCH_CONCURRENCY = Number(process.env.MODEL_CONCURRENCY || 2);

async function buildAllProposals(dossiers) {
  const results = new Array(dossiers.length);
  const pending = []; // {index, dossier, contentHash, callId}

  for (let i = 0; i < dossiers.length; i++) {
    const dossier = dossiers[i];
    const contentHash = sha256hex(canonicalize(dossier));
    const callId = 'call-' + contentHash.slice(0, 40);

    const cached = store.getDossierCache(contentHash);
    if (cached) {
      results[i] = JSON.parse(cached.proposal_json ?? cached.proposalJson);
    } else {
      pending.push({ index: i, dossier, contentHash, callId });
    }
  }

  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE));
  }

  let cursor = 0;
  async function worker() {
    for (;;) {
      const b = cursor++;
      if (b >= batches.length) return;
      const batch = batches[b];

      let decisionMap = new Map();
      try {
        decisionMap = await decideActionsBatch(batch.map((item) => item.dossier));
      } catch (e) {
        decisionMap = new Map(); // whole batch falls back to safe defaults below
      }

      for (const item of batch) {
        const rawDecision = decisionMap.get(item.dossier.dossierId) || null;
        const proposal = buildSafeProposal(item.dossier, rawDecision, item.callId);
        store.setDossierCache(item.contentHash, item.dossier.dossierId, JSON.stringify(proposal));
        results[item.index] = proposal;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(BATCH_CONCURRENCY, batches.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function handlePropose(body, res) {
  const validation = validateProposeRequest(body);
  if (!validation.valid) return sendError(res, 422, validation.error);

  const inputDigest = computeInputDigest(body.dossiers);

  const existingEval = store.getEvaluation(body.evaluationId);
  if (existingEval) {
    if (existingEval.inputDigest === inputDigest) {
      // Exact replay: return the byte-equivalent stored response, no new
      // model work.
      return res.status(200).json(JSON.parse(existingEval.proposeResponseJson));
    }
    return sendError(res, 409, 'evaluationId already used with different dossier content');
  }

  let proposals;
  try {
    proposals = await buildAllProposals(body.dossiers);
  } catch (e) {
    return sendError(res, 500, 'failed to build proposals');
  }

  const proposeResponse = {
    profile: PROFILE,
    evaluationId: body.evaluationId,
    status: 'awaiting_receipts',
    inputDigest,
    proposals,
  };

  store.saveEvaluation({
    evaluationId: body.evaluationId,
    inputDigest,
    verifierJwk: body.receiptVerifier.publicKeyJwk,
    proposeResponseJson: JSON.stringify(proposeResponse),
  });

  return res.status(200).json(proposeResponse);
}

async function handleCommit(body, res) {
  const validation = validateCommitRequest(body);
  if (!validation.valid) return sendError(res, 422, validation.error);

  const evalRecord = store.getEvaluation(body.evaluationId);
  if (!evalRecord) return sendError(res, 422, 'unknown evaluationId');

  if (evalRecord.inputDigest !== body.inputDigest) {
    return sendError(res, 409, 'inputDigest does not match the stored evaluation');
  }

  const requestReceiptsHash = sha256hex(canonicalize(body.receipts));
  const existingCommit = store.getCommit(body.evaluationId);
  if (existingCommit) {
    if (existingCommit.receiptsHash === requestReceiptsHash) {
      // Exact replay.
      return res.status(200).json(JSON.parse(existingCommit.commitResponseJson));
    }
    return sendError(res, 409, 'commit already recorded for this evaluationId with different receipts');
  }

  // Duplicate receiptId check.
  const seenReceiptIds = new Set();
  for (const r of body.receipts) {
    if (seenReceiptIds.has(r.receiptId)) {
      return sendError(res, 422, `duplicate receiptId: ${r.receiptId}`);
    }
    seenReceiptIds.add(r.receiptId);
  }

  let publicKey;
  try {
    publicKey = importEd25519PublicKeyFromJwk(JSON.parse(evalRecord.verifierJwk));
  } catch (e) {
    return sendError(res, 422, 'stored receipt verifier key is invalid');
  }

  const proposeResponse = JSON.parse(evalRecord.proposeResponseJson);
  const proposalByKey = new Map();
  for (const p of proposeResponse.proposals) {
    proposalByKey.set(`${p.dossierId}::${p.callId}`, p);
  }

  // Verify EVERY receipt fully before applying ANY effect.
  for (const r of body.receipts) {
    const key = `${r.dossierId}::${r.callId}`;
    const proposal = proposalByKey.get(key);
    if (!proposal) {
      return sendError(res, 422, `receipt references unknown proposal (${key})`);
    }
    if (proposal.action !== r.action) {
      return sendError(res, 422, `receipt action does not match stored proposal (${key})`);
    }
    const expectedDigest = computeProposalDigest(proposal);
    if (expectedDigest !== r.proposalDigest) {
      return sendError(res, 422, `proposalDigest mismatch for ${key}`);
    }
    const sigOk = verifyReceiptSignature(publicKey, body.evaluationId, body.inputDigest, r);
    if (!sigOk) {
      return sendError(res, 422, `invalid receiptSignature for receiptId ${r.receiptId}`);
    }
  }

  // All receipts verified - now, and only now, record outcomes/effects.
  const outcomes = body.receipts.map((r) => ({
    dossierId: r.dossierId,
    callId: r.callId,
    action: r.action,
    proposalDigest: r.proposalDigest,
    receiptId: r.receiptId,
    status: r.accepted ? 'executed' : 'rejected',
  }));

  const commitResponse = {
    profile: PROFILE,
    evaluationId: body.evaluationId,
    status: 'completed',
    inputDigest: body.inputDigest,
    outcomes,
  };

  store.saveCommit({
    evaluationId: body.evaluationId,
    receiptsHash: requestReceiptsHash,
    commitResponseJson: JSON.stringify(commitResponse),
  });

  return res.status(200).json(commitResponse);
}

app.post('/mailroom', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return sendError(res, 400, 'invalid JSON body');
  }
  try {
    if (body.operation === 'propose') return await handlePropose(body, res);
    if (body.operation === 'commit') return await handleCommit(body, res);
    return sendError(res, 400, 'operation must be "propose" or "commit"');
  } catch (e) {
    console.error(e);
    return sendError(res, 500, 'internal error');
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mailroom agent listening on port ${PORT}`);
});

module.exports = app;
