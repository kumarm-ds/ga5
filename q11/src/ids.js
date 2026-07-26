import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";

export function newOpaqueId(prefix) {
  // opaque, unique, >= 8 chars
  return `${prefix}_${uuidv4().replace(/-/g, "")}`;
}

export function newNonce() {
  return uuidv4();
}

export function hex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function newTraceId() {
  let id;
  do {
    id = hex(16); // 32 hex chars
  } while (/^0+$/.test(id));
  return id;
}

export function newSpanId() {
  let id;
  do {
    id = hex(8); // 16 hex chars
  } while (/^0+$/.test(id));
  return id;
}

// Parses an incoming "traceparent" header. Returns {traceId, spanId} or null
// if missing/invalid per W3C trace-context rules we care about.
export function parseTraceparent(header) {
  if (typeof header !== "string") return null;
  const m = header
    .trim()
    .match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!m) return null;
  const [, version, traceId, spanId] = m;
  if (version === "ff") return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase() };
}

export function buildTraceparent(traceId, spanId) {
  return `00-${traceId}-${spanId}-01`;
}

// Recursively sort object keys, compact-stringify, SHA-256, lowercase hex.
// Used for the approval argumentsDigest.
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((out, k) => {
        out[k] = sortKeysDeep(value[k]);
        return out;
      }, {});
  }
  return value;
}

export function argumentsDigest(args) {
  const canonical = JSON.stringify(sortKeysDeep(args ?? {}));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
