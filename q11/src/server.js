import express from "express";
import { getRun, saveRun, getReceipt, saveReceipt } from "./db.js";
import { validateIncidentRequest, validateReceiptsRequest, deepEqual } from "./validate.js";
import { createRun, processReceipts } from "./statemachine.js";
import { buildTrace } from "./trace.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

function withTrace(run, response) {
  if (response.status === "completed" || response.status === "failed") {
    if (!response.otlp) response.otlp = buildTrace(run);
  }
  return response;
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > 768 * 1024) {
    // Should not happen in practice, but guard the hard size limit anyway.
    res.status(500).json({ error: "response too large" });
    return;
  }
  res.status(status).type("application/json").send(json);
}

app.post("/v2/incidents", async (req, res) => {
  try {
    const body = req.body;
    const err = validateIncidentRequest(body);
    if (err) return sendJson(res, 422, { error: err });

    const existing = await getRun(body.runId);
    if (existing) {
      if (deepEqual(existing.requestSnapshot, body)) {
        return sendJson(res, 200, existing.lastResponse); // pure replay
      }
      return sendJson(res, 409, { error: "runId already used with different content" });
    }

    const { run, response } = await createRun(body, req.header("traceparent"));
    run.requestSnapshot = body;
    await saveRun(run.runId, run);
    return sendJson(res, 200, response);
  } catch (e) {
    console.error(e);
    return sendJson(res, 400, { error: "invalid request" });
  }
});

app.post("/v2/incidents/:runId/receipts", async (req, res) => {
  try {
    const { runId } = req.params;
    const body = req.body;
    const err = validateReceiptsRequest(body);
    if (err) return sendJson(res, 422, { error: err });

    const run = await getRun(runId);
    if (!run) return sendJson(res, 404, { error: "unknown runId" });

    const existingReceipt = await getReceipt(runId, body.receiptId);
    if (existingReceipt) {
      if (deepEqual(existingReceipt.body, body)) {
        return sendJson(res, 200, existingReceipt.response); // pure replay
      }
      return sendJson(res, 409, { error: "receiptId already used with different content" });
    }

    let response = processReceipts(run, body);
    response = withTrace(run, response);

    run.lastResponse = response;
    await saveRun(run.runId, run);
    await saveReceipt(run.runId, body.receiptId, body, response);

    return sendJson(res, 200, response);
  } catch (e) {
    console.error(e);
    return sendJson(res, 400, { error: "invalid request" });
  }
});

app.get("/v2/incidents/:runId", async (req, res) => {
  try {
    const run = await getRun(req.params.runId);
    if (!run) return sendJson(res, 404, { error: "unknown runId" });
    return sendJson(res, 200, run.lastResponse);
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { error: "storage error" });
  }
});

app.get("/health", (req, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`incident-agent listening on ${PORT}`));
