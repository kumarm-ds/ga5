import crypto from "crypto";

/**
 * Recursively sort object keys so that two JSON payloads that differ only
 * in key order (or whitespace) produce an identical canonical string.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    const out = {};
    for (const k of sortedKeys) {
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  return value;
}

export function canonicalJsonString(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

/** Hash used for message-level idempotency: only the `message` field, canonicalized. */
export function hashMessage(message) {
  return sha256Hex(canonicalJsonString(message));
}

/** Hash used to cache AI decisions by canonical package *content* (not by IDs). */
export function hashPackageContent(pkg) {
  return sha256Hex(canonicalJsonString(pkg));
}
