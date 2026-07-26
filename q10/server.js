import express from "express";
import { buildAgentCard } from "./agentCard.js";
import { hashMessage } from "./lib/hash.js";
import {
  IncomingBatchSchema,
  ResultsDataSchema,
  ProposalsArtifactSchema,
} from "./lib/schema.js";
import {
  newTaskId,
  newContextId,
  saveTask,
  getOwnedTask,
  listTasksForPrincipal,
  checkMessageDedup,
  recordMessage,
  atomicTransition,
} from "./lib/store.js";
import { decideBatch } from "./ai/decide.js";

const app = express();
app.use(express.json({ limit: "2mb", type: () => true })); // accept any Content-Type as JSON body

// If the body isn't valid JSON, express.json() throws — without this handler, Express's
// default error page (HTML) would go out instead of a proper A2A-shaped JSON error.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res
      .status(400)
      .set("Content-Type", "application/a2a+json")
      .json({ error: "INVALID_JSON_BODY" });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}/a2a/`).trim();
const BASE_PATH = "/a2a"; // everything in this file is mounted here; must match the path portion of BASE_URL

const A2A_MEDIA_TYPE = "application/a2a+json";
const MT_BATCH = "application/vnd.ga5.invoice-claim-batch+json";
const MT_PROPOSALS = "application/vnd.ga5.invoice-action-proposals+json";
const MT_RECEIPTS = "application/vnd.ga5.invoice-action-receipts+json";
const MT_RESULTS = "application/vnd.ga5.invoice-action-results+json";

const STATE = {
  SUBMITTED: "SUBMITTED",
  WORKING: "WORKING",
  INPUT_REQUIRED: "TASK_STATE_INPUT_REQUIRED",
  COMPLETED: "COMPLETED",
  CANCELED: "CANCELED",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendA2A(res, status, body) {
  res.status(status).set("Content-Type", A2A_MEDIA_TYPE).json(body);
}

function genericError(res, status, code) {
  // Deliberately generic: never echoes IDs or existence info for other principals.
  sendA2A(res, status, { error: code });
}

function toWireTask(task) {
  return {
    taskId: task.taskId,
    contextId: task.contextId,
    state: task.state,
    history: task.history,
    artifacts: task.artifacts,
  };
}

// ---------------------------------------------------------------------------
// Agent Card — public, origin-level, no auth, no version/content-type gate
// ---------------------------------------------------------------------------

app.get("/.well-known/agent-card.json", (req, res) => {
  res.status(200).json(buildAgentCard(BASE_URL));
});

// ---------------------------------------------------------------------------
// Auth + protocol middleware for everything under BASE_PATH
// ---------------------------------------------------------------------------

const router = express.Router();

router.use((req, res, next) => {
  const authHeader = req.header("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1].trim()) {
    return genericError(res, 401, "UNAUTHENTICATED");
  }
  const token = match[1].trim();

  const allowList = (process.env.ALLOWED_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowList.length > 0 && !allowList.includes(token)) {
    return genericError(res, 403, "FORBIDDEN");
  }

  // The bearer token's exact value identifies the principal (user). Different
  // tokens => different, isolated users. Do not log/echo raw tokens.
  req.principal = token;
  next();
});

router.use((req, res, next) => {
  const version = req.header("a2a-version");
  if (version !== "1.0") {
    return genericError(res, 400, "UNSUPPORTED_VERSION");
  }
  next();
});

router.use((req, res, next) => {
  if (req.method === "POST") {
    const ct = (req.header("content-type") || "").toLowerCase();
    if (!ct.includes(A2A_MEDIA_TYPE)) {
      return genericError(res, 400, "UNSUPPORTED_MEDIA_TYPE");
    }
  }
  next();
});

// ---------------------------------------------------------------------------
// POST /message:send
// ---------------------------------------------------------------------------

router.post(/^\/message:send$/, async (req, res) => {
  try {
    const body = req.body || {};
    const message = body.message;
    if (!message || !message.messageId || !Array.isArray(message.parts) || message.parts.length === 0) {
      return genericError(res, 400, "INVALID_ENVELOPE");
    }
    const part = message.parts[0];
    const mediaType = part && part.mediaType;

    if (mediaType === MT_BATCH) {
      return await handleInitialBatch(req, res, message, part.data);
    }
    if (mediaType === MT_RESULTS) {
      return await handleResultsContinuation(req, res, message, part.data);
    }
    return genericError(res, 400, "UNSUPPORTED_MEDIA_TYPE");
  } catch (err) {
    console.error("message:send error", err);
    return genericError(res, 500, "INTERNAL_ERROR");
  }
});

async function handleInitialBatch(req, res, message, data) {
  const principal = req.principal;
  const contentHash = hashMessage(message);

  const dedup = checkMessageDedup(principal, message.messageId, contentHash);
  if (dedup.status === "conflict") {
    return genericError(res, 409, "IDEMPOTENCY_CONFLICT");
  }
  if (dedup.status === "duplicate") {
    const existing = getOwnedTask(principal, dedup.taskId);
    if (!existing) return genericError(res, 500, "INTERNAL_ERROR");
    return sendA2A(res, 200, { task: toWireTask(existing) });
  }

  const parsed = IncomingBatchSchema.safeParse(data);
  if (!parsed.success) {
    return genericError(res, 400, "INVALID_BATCH");
  }
  const { batchId, policyRevision, packages } = parsed.data;

  // Enforce unique packageId within the batch up front.
  const seenPkgIds = new Set();
  for (const p of packages) {
    const pid = p.packageId ?? p.id;
    if (!pid || seenPkgIds.has(pid)) {
      return genericError(res, 400, "INVALID_BATCH");
    }
    seenPkgIds.add(pid);
  }

  let proposals;
  try {
    proposals = await decideBatch(packages, policyRevision);
  } catch (err) {
    console.error("AI decision error", err);
    return genericError(res, 502, "AI_DECISION_FAILED");
  }

  const proposalsArtifactData = { batchId, proposals };
  const validArtifact = ProposalsArtifactSchema.safeParse(proposalsArtifactData);
  if (!validArtifact.success) {
    console.error("Proposal artifact failed schema", validArtifact.error);
    return genericError(res, 502, "AI_OUTPUT_INVALID");
  }

  const taskId = newTaskId();
  const contextId = newContextId();

  const task = {
    taskId,
    contextId,
    principal,
    state: STATE.INPUT_REQUIRED,
    batchId,
    policyRevision,
    proposalsByKey: new Map(proposals.map((p) => [`${p.packageId}::${p.actionId}`, p])),
    history: [
      {
        messageId: message.messageId,
        role: "ROLE_USER",
        taskId,
        contextId,
        parts: message.parts,
      },
    ],
    artifacts: [{ mediaType: MT_PROPOSALS, data: proposalsArtifactData }],
  };

  saveTask(task);
  recordMessage(dedup.key, contentHash, taskId);

  return sendA2A(res, 200, { task: toWireTask(task) });
}

async function handleResultsContinuation(req, res, message, data) {
  const principal = req.principal;
  const taskId = message.taskId;
  const contextId = message.contextId;

  if (!taskId || !contextId) {
    return genericError(res, 400, "INVALID_ENVELOPE");
  }

  const task = getOwnedTask(principal, taskId);
  if (!task) {
    return genericError(res, 404, "NOT_FOUND");
  }
  if (task.contextId !== contextId) {
    return genericError(res, 400, "CONTEXT_MISMATCH");
  }

  const contentHash = hashMessage(message);
  const dedup = checkMessageDedup(principal, message.messageId, contentHash);
  if (dedup.status === "conflict") {
    return genericError(res, 409, "IDEMPOTENCY_CONFLICT");
  }
  if (dedup.status === "duplicate") {
    // Includes terminal replay: same message, already processed -> return current task as-is.
    return sendA2A(res, 200, { task: toWireTask(task) });
  }

  const parsed = ResultsDataSchema.safeParse(data);
  if (!parsed.success || parsed.data.batchId !== task.batchId) {
    return genericError(res, 400, "INVALID_RESULTS");
  }

  // Every result item must exactly match a stored proposal.
  for (const r of parsed.data.results) {
    const key = `${r.packageId}::${r.actionId}`;
    const proposal = task.proposalsByKey.get(key);
    if (!proposal || proposal.action !== r.action) {
      return genericError(res, 400, "PROPOSAL_MISMATCH");
    }
  }

  const transitioned = atomicTransition(taskId, [STATE.INPUT_REQUIRED], STATE.COMPLETED, (t) => {
    const executions = [];
    for (const r of parsed.data.results) {
      if (r.outcome !== "ACCEPTED") continue;
      const key = `${r.packageId}::${r.actionId}`;
      const proposal = t.proposalsByKey.get(key);
      executions.push({
        packageId: proposal.packageId,
        actionId: proposal.actionId,
        action: proposal.action,
        receiptNonce: r.receiptNonce,
        facts: proposal.facts,
        evidenceRefs: proposal.evidenceRefs,
      });
    }
    t.artifacts.push({
      mediaType: MT_RECEIPTS,
      data: { batchId: t.batchId, executions },
    });
    t.history.push({
      messageId: message.messageId,
      role: "ROLE_USER",
      taskId: t.taskId,
      contextId: t.contextId,
      parts: [{ mediaType: MT_RESULTS, data: parsed.data }],
    });
  });

  if (!transitioned) {
    // Lost a race (e.g. task was just canceled) — do not record this message as processed.
    return genericError(res, 409, "TASK_NOT_ACTIONABLE");
  }

  recordMessage(dedup.key, contentHash, taskId);
  const updated = getOwnedTask(principal, taskId);
  return sendA2A(res, 200, { task: toWireTask(updated) });
}

// ---------------------------------------------------------------------------
// GET /tasks   (list — must come before the /tasks/:id-ish regex route)
// ---------------------------------------------------------------------------

router.get(/^\/tasks$/, (req, res) => {
  const list = listTasksForPrincipal(req.principal).map(toWireTask);
  return sendA2A(res, 200, { tasks: list });
});

// ---------------------------------------------------------------------------
// GET /tasks/{id}
// ---------------------------------------------------------------------------

router.get(/^\/tasks\/([^/]+)$/, (req, res) => {
  const id = req.params[0];
  const task = getOwnedTask(req.principal, id);
  if (!task) return genericError(res, 404, "NOT_FOUND");
  return sendA2A(res, 200, toWireTask(task));
});

// ---------------------------------------------------------------------------
// POST /tasks/{id}:cancel
// ---------------------------------------------------------------------------

router.post(/^\/tasks\/([^/]+):cancel$/, (req, res) => {
  const id = req.params[0];
  const task = getOwnedTask(req.principal, id);
  if (!task) return genericError(res, 404, "NOT_FOUND");

  if (task.state === STATE.CANCELED) {
    // Idempotent repeat cancel.
    return sendA2A(res, 200, toWireTask(task));
  }
  if (task.state === STATE.COMPLETED) {
    return genericError(res, 409, "ALREADY_TERMINAL");
  }

  const transitioned = atomicTransition(
    id,
    [STATE.SUBMITTED, STATE.WORKING, STATE.INPUT_REQUIRED],
    STATE.CANCELED,
    () => {}
  );

  if (!transitioned) {
    // Lost the race to a concurrent result-continuation that just completed the task.
    return genericError(res, 409, "ALREADY_TERMINAL");
  }

  const updated = getOwnedTask(req.principal, id);
  return sendA2A(res, 200, toWireTask(updated));
});

app.use(BASE_PATH, router);

app.listen(PORT, () => {
  console.log(`A2A Invoice Agent listening on port ${PORT}`);
  console.log(`Agent Card:  <origin>/.well-known/agent-card.json`);
  console.log(`Base URL configured as: ${BASE_URL}`);
});
