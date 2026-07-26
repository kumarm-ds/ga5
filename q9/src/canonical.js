'use strict';

const crypto = require('crypto');

/**
 * Recursively key-sorted, compact JSON serialization.
 * Arrays keep their order. Objects have their keys sorted (recursively).
 * This is used both for hashing (inputDigest, proposalDigest) and for
 * building the exact bytes that receipt signatures are verified against.
 */
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') +
      '}'
    );
  }

  // strings, numbers, booleans
  return JSON.stringify(value);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Digest of the `dossiers` array exactly as received in a propose request.
 */
function computeInputDigest(dossiers) {
  return sha256hex(canonicalize(dossiers));
}

/**
 * Digest of a single proposal, normalized per spec:
 * keep exactly dossierId, callId, action, target (null if absent),
 * payload, evidence (sorted) - then hash canonical compact JSON.
 */
function computeProposalDigest(proposal) {
  const normalized = {
    dossierId: proposal.dossierId,
    callId: proposal.callId,
    action: proposal.action,
    target: proposal.target === undefined ? null : proposal.target,
    payload: proposal.payload,
    evidence: [...proposal.evidence].sort(),
  };
  return sha256hex(canonicalize(normalized));
}

module.exports = {
  canonicalize,
  sha256hex,
  computeInputDigest,
  computeProposalDigest,
};
