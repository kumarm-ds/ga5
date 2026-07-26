import { newOpaqueId, newSpanId, newTraceId, buildTraceparent, parseTraceparent, argumentsDigest } from "./ids.js";
import { planIncident, validatePlan } from "./model.js";

function buildDispatch(run, action, attempt, extra = {}) {
  const spanId = newSpanId();
  const traceparent = buildTraceparent(run.traceId, spanId);
  const attemptObj = { attempt, spanId, traceparent, dispatchedAt: Date.now(), outcome: "pending" };
  action.attempts.push(attemptObj);
  const dispatch = {
    actionId: action.actionId,
    callId: action.callId,
    phase: action.phase,
    toolName: action.toolName,
    arguments: action.arguments,
    evidence: action.evidence,
    attempt,
    traceparent,
    ...extra,
  };
  run.actionLog.push(dispatch);
  return dispatch;
}

function newAction(run, { phase, toolName, arguments: args, evidence }) {
  const action = {
    actionId: newOpaqueId("act"),
    callId: newOpaqueId("call"),
    phase,
    toolName,
    arguments: args,
    evidence: evidence || [],
    executeSpanId: newSpanId(),
    attempts: [],
    finalStatus: "pending",
  };
  run.actions[action.actionId] = action;
  run.actionOrder.push(action.actionId);
  return action;
}

export async function createRun(body, incomingTraceparentHeader) {
  const parsed = parseTraceparent(incomingTraceparentHeader);

  const run = {
    runId: body.runId,
    agentName: body.agentName,
    publicMarker: body.publicMarker,
    policy: body.policy,
    createdAt: Date.now(),
    traceId: parsed ? parsed.traceId : newTraceId(),
    incomingParentSpanId: parsed ? parsed.spanId : null,
    rootSpanId: newSpanId(),
    agentSpanId: newSpanId(),
    chatSpanId: newSpanId(),
    joinSpanId: newSpanId(),
    approvalGateSpanId: newSpanId(),
    actions: {},
    actionOrder: [],
    actionLog: [],
    receiptLog: [],
    suppressed: [],
    status: "waiting",
    approval: null,
    effectPlan: null,
    effectActionId: null,
    chosenEffect: null,
  };

  const { plan, modelName } = await planIncident(body);
  validatePlan(plan, body);
  run.chatModelName = modelName;
  run.planCompletedAt = Date.now();
  run.diagnosis = { rootCause: plan.rootCause, evidence: plan.evidence };
  run.effectPlan = plan.effect;

  const dispatches = [];
  for (const d of plan.diagnostics) {
    const action = newAction(run, {
      phase: "diagnostic",
      toolName: d.toolName,
      arguments: d.arguments,
      evidence: d.evidence,
    });
    dispatches.push(buildDispatch(run, action, 1));
  }

  const response = {
    runId: run.runId,
    status: "waiting",
    diagnosis: run.diagnosis,
    dispatches,
    approvals: [],
  };
  run.lastResponse = response;
  return { run, response };
}

export function processReceipts(run, body) {
  const retryDispatches = [];

  for (const outcome of body.outcomes || []) {
    const action = run.actions[outcome.actionId];
    if (!action || action.callId !== outcome.callId) continue; // not a known logical call
    const attemptObj = action.attempts.find(
      (a) => a.attempt === outcome.attempt && a.outcome === "pending"
    );
    if (!attemptObj) continue; // only accept outcomes for pending calls

    attemptObj.resolvedAt = Date.now();
    attemptObj.httpStatus = outcome.status;
    attemptObj.resultClass = outcome.resultClass;
    attemptObj.receiptId = body.receiptId;
    attemptObj.nonce = outcome.nonce;

    run.receiptLog.push({
      receiptId: body.receiptId,
      actionId: outcome.actionId,
      callId: outcome.callId,
      attempt: outcome.attempt,
      status: outcome.status,
      resultClass: outcome.resultClass,
      nonce: outcome.nonce,
    });

    const isTimeout = outcome.status === 0 && outcome.resultClass !== undefined
      ? false
      : outcome.status === 0; // status 0 treated as the timeout signal
    const errorType = outcome.errorType;

    if (outcome.status === 503 && action.attempts.filter((a) => a.attempt).length === 1) {
      attemptObj.outcome = "error";
      const retryDispatch = buildDispatch(run, action, attemptObj.attempt + 1);
      retryDispatches.push(retryDispatch);
      // finalStatus remains pending
    } else if (outcome.status === 0 && errorType === "timeout") {
      attemptObj.outcome = "timeout";
      action.finalStatus = "failed";
    } else if (outcome.status >= 200 && outcome.status < 300) {
      attemptObj.outcome = "success";
      action.finalStatus = "success";
    } else {
      attemptObj.outcome = "error";
      action.finalStatus = "failed";
    }
  }

  for (const a of body.approvals || []) {
    const approval = run.approval;
    if (!approval || approval.approvalId !== a.approvalId || approval.decision !== "pending") continue;
    approval.decision = a.decision;
    approval.nonce = a.nonce;
    approval.decidedAt = Date.now();
    run.receiptLog.push({
      receiptId: body.receiptId,
      approvalId: a.approvalId,
      decision: a.decision,
      nonce: a.nonce,
    });
  }

  // 1) Any retries created this turn -> return them (never mixed with approvals)
  if (retryDispatches.length) {
    const response = { runId: run.runId, status: "waiting", dispatches: retryDispatches, approvals: [] };
    run.lastResponse = response;
    return response;
  }

  const diagActions = run.actionOrder
    .map((id) => run.actions[id])
    .filter((a) => a.phase === "diagnostic");
  const allDiagResolved = diagActions.every((a) => a.finalStatus !== "pending");
  const effectStageStarted = run.effectActionId !== null || run.approval !== null;

  // 2) Diagnostics just finished, effect not yet started
  if (allDiagResolved && !effectStageStarted) {
    const failed = diagActions.filter((a) => a.finalStatus === "failed");
    if (failed.length) {
      run.suppressed = failed.map((a) => a.toolName);
      return finalize(run, "failed");
    }

    const effectPlan = run.effectPlan;
    const effectAction = newAction(run, {
      phase: "effect",
      toolName: effectPlan.toolName,
      arguments: effectPlan.arguments,
      evidence: run.diagnosis.evidence,
    });
    run.effectActionId = effectAction.actionId;

    const needsApproval = (run.policy.approvalRequiredFor || []).includes(effectPlan.toolName);
    if (needsApproval) {
      const approvalId = newOpaqueId("appr");
      run.approval = {
        approvalId,
        actionId: effectAction.actionId,
        toolName: effectPlan.toolName,
        argumentsDigest: argumentsDigest(effectPlan.arguments),
        decision: "pending",
        requestedAt: Date.now(),
      };
      const response = {
        runId: run.runId,
        status: "waiting",
        dispatches: [],
        approvals: [
          {
            approvalId,
            actionId: effectAction.actionId,
            toolName: effectPlan.toolName,
            argumentsDigest: run.approval.argumentsDigest,
          },
        ],
      };
      run.lastResponse = response;
      return response;
    } else {
      const dispatch = buildDispatch(run, effectAction, 1);
      const response = { runId: run.runId, status: "waiting", dispatches: [dispatch], approvals: [] };
      run.lastResponse = response;
      return response;
    }
  }

  // 3) Approval was just decided
  if (run.approval && run.approval.decision !== "pending" && !run.approval.effectDispatched) {
    if (run.approval.decision !== "approved") {
      run.suppressed = [run.approval.toolName];
      return finalize(run, "failed");
    }
    const effectAction = run.actions[run.effectActionId];
    const dispatch = buildDispatch(run, effectAction, 1, {
      approvalId: run.approval.approvalId,
      approvalNonce: run.approval.nonce,
    });
    run.approval.effectDispatched = true;
    const response = { runId: run.runId, status: "waiting", dispatches: [dispatch], approvals: [] };
    run.lastResponse = response;
    return response;
  }

  // 4) Effect action just resolved -> finalize
  const effectAction = run.effectActionId ? run.actions[run.effectActionId] : null;
  if (effectAction && effectAction.finalStatus !== "pending") {
    run.chosenEffect = effectAction.toolName;
    if (effectAction.finalStatus === "failed") run.suppressed = [effectAction.toolName];
    return finalize(run, effectAction.finalStatus === "success" ? "completed" : "failed");
  }

  // Nothing new resolved this turn — echo the last response unchanged.
  return run.lastResponse;
}

function finalize(run, status) {
  run.status = status;
  run.completedAt = Date.now();
  const response = {
    runId: run.runId,
    status,
    diagnosis: run.diagnosis,
    chosenEffect: run.chosenEffect,
    suppressed: run.suppressed,
    actionLog: run.actionLog,
    receiptLog: run.receiptLog,
    otlp: null, // filled in by caller via trace.js (kept separate on purpose)
  };
  run.lastResponse = response;
  return response;
}
