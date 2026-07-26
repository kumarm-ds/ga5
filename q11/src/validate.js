export function validateIncidentRequest(body) {
  if (!body || typeof body !== "object") return "body must be an object";
  if (body.profile !== "ga5-incident-agent/v2") return "unsupported profile";
  if (typeof body.runId !== "string" || body.runId.length < 8) return "invalid runId";
  if (typeof body.agentName !== "string") return "invalid agentName";
  if (typeof body.publicMarker !== "string") return "invalid publicMarker";
  if (!body.incident || typeof body.incident.transcript !== "string") return "invalid incident";
  if (!Array.isArray(body.incident.allowedRootCauses) || !body.incident.allowedRootCauses.length)
    return "invalid allowedRootCauses";
  if (!Array.isArray(body.toolCatalog)) return "invalid toolCatalog";
  if (!body.policy || typeof body.policy.maximumDiagnostics !== "number") return "invalid policy";
  return null;
}

export function validateReceiptsRequest(body) {
  if (!body || typeof body !== "object") return "body must be an object";
  if (typeof body.receiptId !== "string" || body.receiptId.length < 1) return "invalid receiptId";
  if (body.outcomes && !Array.isArray(body.outcomes)) return "invalid outcomes";
  if (body.approvals && !Array.isArray(body.approvals)) return "invalid approvals";
  return null;
}

// Deep-equal used for replay-vs-conflict detection.
export function deepEqual(a, b) {
  return JSON.stringify(sortForCompare(a)) === JSON.stringify(sortForCompare(b));
}

function sortForCompare(v) {
  if (Array.isArray(v)) return v.map(sortForCompare);
  if (v && typeof v === "object") {
    return Object.keys(v)
      .sort()
      .reduce((o, k) => ((o[k] = sortForCompare(v[k])), o), {});
  }
  return v;
}
