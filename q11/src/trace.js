const KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3 };

function attr(key, value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return { key, value: { intValue: value } };
  }
  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }
  return { key, value: { stringValue: String(value) } };
}

function nano(ms) {
  return (BigInt(Math.round(ms)) * 1000000n).toString();
}

function baseAttrs(run) {
  return [attr("ga5.run.id", run.runId), attr("ga5.public.marker", run.publicMarker)];
}

function span({ traceId, spanId, parentSpanId, name, kind, start, end, attributes, statusCode, statusMessage, links }) {
  const s = {
    traceId,
    spanId,
    name,
    kind,
    startTimeUnixNano: nano(start),
    endTimeUnixNano: nano(end),
    attributes,
  };
  if (parentSpanId) s.parentSpanId = parentSpanId;
  if (statusCode !== undefined) {
    s.status = { code: statusCode, ...(statusMessage ? { message: statusMessage } : {}) };
  }
  if (links && links.length) s.links = links;
  return s;
}

// Pure function: state in, OTLP JSON out. Never calls the model, never
// re-derives the plan — only reflects what actually happened.
export function buildTrace(run) {
  const traceId = run.traceId;
  const spans = [];
  const now = Date.now();
  const end = run.completedAt || now;

  spans.push(
    span({
      traceId,
      spanId: run.rootSpanId,
      parentSpanId: run.incomingParentSpanId || undefined,
      name: "POST /v2/incidents",
      kind: KIND.SERVER,
      start: run.createdAt,
      end,
      attributes: baseAttrs(run),
    })
  );

  spans.push(
    span({
      traceId,
      spanId: run.agentSpanId,
      parentSpanId: run.rootSpanId,
      name: "invoke_agent incident-response",
      kind: KIND.INTERNAL,
      start: run.createdAt,
      end,
      attributes: baseAttrs(run),
    })
  );

  spans.push(
    span({
      traceId,
      spanId: run.chatSpanId,
      parentSpanId: run.agentSpanId,
      name: "chat incident-plan",
      kind: KIND.CLIENT,
      start: run.createdAt,
      end: run.planCompletedAt || run.createdAt,
      attributes: [
        ...baseAttrs(run),
        attr("gen_ai.operation.name", "chat"),
        attr("gen_ai.request.model", run.chatModelName || "unknown"),
      ],
    })
  );

  const diagnosticActionIds = [];
  let approvalActionId = null;

  for (const actionId of run.actionOrder) {
    const action = run.actions[actionId];
    if (action.phase === "diagnostic") diagnosticActionIds.push(actionId);
    if (action.finalStatus === "pending" && !action.attempts.length) continue; // reserved but never dispatched

    const attempts = action.attempts;
    const execEnd = attempts.length ? attempts[attempts.length - 1].resolvedAt || end : end;

    spans.push(
      span({
        traceId,
        spanId: action.executeSpanId,
        parentSpanId: run.agentSpanId,
        name: `execute_tool ${action.toolName}`,
        kind: KIND.INTERNAL,
        start: attempts[0]?.dispatchedAt || run.createdAt,
        end: execEnd,
        attributes: [
          ...baseAttrs(run),
          attr("ga5.action.id", action.actionId),
          attr("gen_ai.tool.name", action.toolName),
          attr("gen_ai.tool.call.id", action.callId),
          attr("gen_ai.operation.name", "execute_tool"),
        ],
      })
    );

    for (const a of attempts) {
      const attrs = [
        ...baseAttrs(run),
        attr("ga5.action.id", action.actionId),
        attr("ga5.attempt", a.attempt),
        attr("http.request.method", "POST"),
        attr("http.request.resend_count", a.attempt - 1),
      ];
      if (a.receiptId) attrs.push(attr("ga5.receipt.id", a.receiptId));
      if (a.nonce) attrs.push(attr("ga5.receipt.nonce", a.nonce));

      let statusCode; // 0=UNSET,1=OK,2=ERROR
      if (a.outcome === "timeout") {
        attrs.push(attr("error.type", "timeout"));
        statusCode = 2;
      } else if (a.httpStatus && a.httpStatus >= 400) {
        attrs.push(attr("error.type", String(a.httpStatus)));
        attrs.push(attr("http.response.status_code", a.httpStatus));
        statusCode = 2;
      } else if (a.httpStatus) {
        attrs.push(attr("http.response.status_code", a.httpStatus));
        statusCode = 1;
      }

      spans.push(
        span({
          traceId,
          spanId: a.spanId,
          parentSpanId: action.executeSpanId,
          name: `POST tool/${action.toolName}`,
          kind: KIND.CLIENT,
          start: a.dispatchedAt,
          end: a.resolvedAt || a.dispatchedAt,
          attributes: attrs,
          statusCode,
        })
      );
    }

    if (action.approvalId) approvalActionId = actionId;
  }

  if (diagnosticActionIds.length >= 2) {
    spans.push(
      span({
        traceId,
        spanId: run.joinSpanId,
        parentSpanId: run.agentSpanId,
        name: "incident.join",
        kind: KIND.INTERNAL,
        start: run.createdAt,
        end,
        attributes: baseAttrs(run),
        links: diagnosticActionIds.map((id) => ({
          traceId,
          spanId: run.actions[id].executeSpanId,
        })),
      })
    );
  }

  if (run.approval) {
    spans.push(
      span({
        traceId,
        spanId: run.approvalGateSpanId,
        parentSpanId: run.agentSpanId,
        name: "approval_gate",
        kind: KIND.INTERNAL,
        start: run.approval.requestedAt || run.createdAt,
        end: run.approval.decidedAt || end,
        attributes: [
          ...baseAttrs(run),
          attr("ga5.approval.id", run.approval.approvalId),
          ...(run.approval.nonce ? [attr("ga5.approval.receipt.nonce", run.approval.nonce)] : []),
        ],
      })
    );
  }

  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}
