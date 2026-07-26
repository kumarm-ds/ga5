'use strict';

const PROFILE = 'ga5-mailroom-action-gate/v2';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function validateProposeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'body must be a JSON object' };
  }
  if (body.profile !== PROFILE) {
    return { valid: false, error: `profile must be "${PROFILE}"` };
  }
  if (body.operation !== 'propose') {
    return { valid: false, error: 'operation must be "propose"' };
  }
  if (!isNonEmptyString(body.evaluationId)) {
    return { valid: false, error: 'evaluationId must be a non-empty string' };
  }

  const rv = body.receiptVerifier;
  if (!rv || rv.algorithm !== 'Ed25519' || !rv.publicKeyJwk) {
    return { valid: false, error: 'receiptVerifier with Ed25519 publicKeyJwk is required' };
  }
  const jwk = rv.publicKeyJwk;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !isNonEmptyString(jwk.x)) {
    return { valid: false, error: 'receiptVerifier.publicKeyJwk must be a valid Ed25519 OKP JWK' };
  }

  if (!Array.isArray(body.dossiers) || body.dossiers.length === 0) {
    return { valid: false, error: 'dossiers must be a non-empty array' };
  }

  const seenDossierIds = new Set();

  for (const dossier of body.dossiers) {
    if (!dossier || typeof dossier !== 'object') {
      return { valid: false, error: 'each dossier must be an object' };
    }
    if (!isNonEmptyString(dossier.dossierId)) {
      return { valid: false, error: 'dossier.dossierId must be a non-empty string' };
    }
    if (seenDossierIds.has(dossier.dossierId)) {
      return { valid: false, error: `duplicate dossierId: ${dossier.dossierId}` };
    }
    seenDossierIds.add(dossier.dossierId);

    if (dossier.partition !== 'stable_core' && dossier.partition !== 'fresh_audit') {
      return { valid: false, error: `dossier.partition invalid for ${dossier.dossierId}` };
    }
    if (!isNonEmptyString(dossier.mailbox)) {
      return { valid: false, error: `dossier.mailbox required for ${dossier.dossierId}` };
    }
    if (!isNonEmptyString(dossier.objective)) {
      return { valid: false, error: `dossier.objective required for ${dossier.dossierId}` };
    }
    if (!Array.isArray(dossier.sources) || dossier.sources.length === 0) {
      return { valid: false, error: `dossier.sources required for ${dossier.dossierId}` };
    }
    for (const source of dossier.sources) {
      if (
        !source ||
        !isNonEmptyString(source.sourceId) ||
        !isNonEmptyString(source.kind) ||
        !isNonEmptyString(source.provenance) ||
        typeof source.title !== 'string'
      ) {
        return { valid: false, error: `malformed source in ${dossier.dossierId}` };
      }
      if (!Array.isArray(source.lines) || source.lines.length === 0) {
        return { valid: false, error: `source.lines required in ${dossier.dossierId}` };
      }
      for (const line of source.lines) {
        if (!line || !isNonEmptyString(line.lineId) || typeof line.text !== 'string') {
          return { valid: false, error: `malformed line in ${dossier.dossierId}` };
        }
      }
    }
  }

  return { valid: true };
}

function validateCommitRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'body must be a JSON object' };
  }
  if (body.profile !== PROFILE) {
    return { valid: false, error: `profile must be "${PROFILE}"` };
  }
  if (body.operation !== 'commit') {
    return { valid: false, error: 'operation must be "commit"' };
  }
  if (!isNonEmptyString(body.evaluationId)) {
    return { valid: false, error: 'evaluationId must be a non-empty string' };
  }
  if (!isNonEmptyString(body.inputDigest)) {
    return { valid: false, error: 'inputDigest must be a non-empty string' };
  }
  if (!Array.isArray(body.receipts) || body.receipts.length === 0) {
    return { valid: false, error: 'receipts must be a non-empty array' };
  }
  for (const r of body.receipts) {
    if (
      !r ||
      !isNonEmptyString(r.dossierId) ||
      !isNonEmptyString(r.callId) ||
      !isNonEmptyString(r.action) ||
      typeof r.accepted !== 'boolean' ||
      !isNonEmptyString(r.proposalDigest) ||
      !isNonEmptyString(r.receiptId) ||
      !isNonEmptyString(r.receiptSignature)
    ) {
      return { valid: false, error: 'malformed receipt object' };
    }
  }
  return { valid: true };
}

module.exports = { PROFILE, validateProposeRequest, validateCommitRequest };
