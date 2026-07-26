'use strict';

const crypto = require('crypto');
const { canonicalize } = require('./canonical');

/**
 * Import an Ed25519 public key from the JWK the grader sent us in
 * propose.receiptVerifier.publicKeyJwk : {kty:'OKP', crv:'Ed25519', x:'...'}
 */
function importEd25519PublicKeyFromJwk(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('invalid Ed25519 JWK');
  }
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    format: 'jwk',
  });
}

/**
 * Build the exact canonical bytes a receipt signature is computed over.
 */
function buildSignedReceiptMessage({ evaluationId, inputDigest, receipt }) {
  const signedObject = {
    profile: 'ga5-mailroom-action-gate/v2',
    evaluationId,
    inputDigest,
    receipt: {
      dossierId: receipt.dossierId,
      callId: receipt.callId,
      action: receipt.action,
      accepted: receipt.accepted,
      proposalDigest: receipt.proposalDigest,
      receiptId: receipt.receiptId,
    },
  };
  return canonicalize(signedObject);
}

/**
 * Verify a single receipt's Ed25519 signature.
 * Returns true/false, never throws (crypto errors count as invalid).
 */
function verifyReceiptSignature(publicKey, evaluationId, inputDigest, receipt) {
  try {
    const message = buildSignedReceiptMessage({ evaluationId, inputDigest, receipt });
    const sig = Buffer.from(receipt.receiptSignature, 'base64');
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, sig);
  } catch (e) {
    return false;
  }
}

module.exports = {
  importEd25519PublicKeyFromJwk,
  verifyReceiptSignature,
};
