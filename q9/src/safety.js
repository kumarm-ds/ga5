'use strict';

const { validateProposalShape } = require('./actions');

/**
 * Collect every valid lineId that actually exists in this dossier.
 */
function collectValidLineIds(dossier) {
  const ids = new Set();
  for (const source of dossier.sources || []) {
    for (const line of source.lines || []) {
      ids.add(line.lineId);
    }
  }
  return ids;
}

function firstLineId(dossier) {
  const source = (dossier.sources || [])[0];
  const line = source && source.lines && source.lines[0];
  return line ? line.lineId : undefined;
}

/**
 * Safe, conservative fallback used whenever the model's output is missing,
 * malformed, or fails shape validation. We never fall back to an outbound
 * or record-mutating action - only to a human-review action.
 */
function fallbackProposal(dossier, callId) {
  const evidence = firstLineId(dossier) ? [firstLineId(dossier)] : [];
  return {
    dossierId: dossier.dossierId,
    callId,
    action: 'request_confirmation',
    target: { kind: 'approval_queue', id: 'mailroom-general' },
    payload: {
      claimedSender: dossier.mailbox || 'unknown',
      questionCode: 'VERIFY_REQUEST',
      referenceId: dossier.dossierId,
    },
    evidence,
  };
}

/**
 * Turn a raw model decision into a validated, schema-correct proposal for
 * this dossier. This is the single place where "the model only reads and
 * drafts, plain code decides what's actually safe to return" is enforced.
 */
function buildSafeProposal(dossier, rawDecision, callId) {
  if (!rawDecision || typeof rawDecision !== 'object' || !rawDecision.action) {
    return fallbackProposal(dossier, callId);
  }

  const validLineIds = collectValidLineIds(dossier);

  let { action, target, payload, evidence } = rawDecision;
  target = target === undefined ? null : target;
  payload = payload && typeof payload === 'object' ? payload : {};

  // Drop any evidence lineId that doesn't actually belong to this dossier,
  // and de-duplicate. Unknown/duplicate lineIds are schema errors, so we
  // never forward them.
  evidence = Array.isArray(evidence)
    ? [...new Set(evidence)].filter((id) => validLineIds.has(id))
    : [];

  const candidate = { dossierId: dossier.dossierId, callId, action, target, payload, evidence };
  const check = validateProposalShape(candidate);

  if (!check.ok) {
    return fallbackProposal(dossier, callId);
  }

  return candidate;
}

module.exports = { buildSafeProposal, collectValidLineIds };
