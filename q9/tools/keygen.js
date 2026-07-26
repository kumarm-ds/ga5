'use strict';

// Generates an Ed25519 keypair for LOCAL TESTING ONLY, mimicking what the
// real grader does (a fresh keypair per evaluation run). Prints the public
// JWK (to send in propose.receiptVerifier) and the raw private key bytes
// (base64) so a test script can sign receipts.
//
// Usage: node tools/keygen.js

const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const publicJwk = publicKey.export({ format: 'jwk' });
// publicJwk looks like: { kty: 'OKP', crv: 'Ed25519', x: '...' }

const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });

console.log(JSON.stringify({
  publicKeyJwk: publicJwk,
  privateKeyPkcs8Base64: privateDer.toString('base64'),
}, null, 2));
