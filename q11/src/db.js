// Persistence via Upstash Redis REST API. No local disk needed, so this
// works fine on Render's Free instance type (which doesn't offer Disks).
// Get a free database at https://console.upstash.com -> Redis -> Create.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured");
  }
  const resp = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  if (!resp.ok) {
    throw new Error(`Upstash error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.result;
}

export async function getRun(runId) {
  const raw = await redis(["GET", `run:${runId}`]);
  return raw ? JSON.parse(raw) : null;
}

export async function saveRun(runId, state) {
  await redis(["SET", `run:${runId}`, JSON.stringify(state)]);
}

export async function getReceipt(runId, receiptId) {
  const raw = await redis(["GET", `receipt:${runId}:${receiptId}`]);
  return raw ? JSON.parse(raw) : null;
}

export async function saveReceipt(runId, receiptId, body, response) {
  await redis([
    "SET",
    `receipt:${runId}:${receiptId}`,
    JSON.stringify({ body, response }),
  ]);
}
