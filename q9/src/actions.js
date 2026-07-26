'use strict';

const ALLOWED_ACTIONS = [
  'create_draft',
  'update_internal_record',
  'send_approved_notice',
  'request_confirmation',
  'quarantine_item',
  'no_action',
];

// Frozen target/payload shapes, copied exactly from the assignment spec.
// Keys and string values are case-sensitive; no extra fields allowed.
const ACTION_SPECS = {
  create_draft: {
    targetKind: 'draft_queue',
    payloadKeys: ['recipient', 'referenceId', 'status', 'template'],
    payloadRequired: { template: 'order_status' },
  },
  update_internal_record: {
    targetKind: 'case_record',
    payloadKeys: ['field', 'sourceEventId', 'value'],
    payloadRequired: { field: 'delivery_window' },
  },
  send_approved_notice: {
    targetKind: 'email',
    payloadKeys: ['referenceId', 'status', 'template'],
    payloadRequired: { template: 'approved_delivery_notice' },
  },
  request_confirmation: {
    targetKind: 'approval_queue',
    payloadKeys: ['claimedSender', 'questionCode', 'referenceId'],
    payloadRequired: { questionCode: 'VERIFY_REQUEST' },
  },
  quarantine_item: {
    targetKind: 'security_queue',
    targetIdFixed: 'mailroom',
    payloadKeys: ['artifactId', 'reasonCode'],
    payloadRequired: { reasonCode: 'INDIRECT_PROMPT_INJECTION' },
  },
  no_action: {
    targetIsNull: true,
    payloadKeys: ['reasonCode', 'referenceId'],
    payloadReasonCodeEnum: ['ALREADY_COMPLETED', 'DUPLICATE', 'INFORMATIONAL'],
  },
};

/**
 * Strictly validate a candidate proposal's action/target/payload/evidence
 * against the frozen shapes. Returns {ok:true} or {ok:false, error}.
 * This is the deterministic gate the AI's output must pass - it does NOT
 * trust the model's own claim that something is safe.
 */
function validateProposalShape({ action, target, payload, evidence }) {
  if (!ALLOWED_ACTIONS.includes(action)) {
    return { ok: false, error: `unknown action: ${action}` };
  }
  const spec = ACTION_SPECS[action];

  if (spec.targetIsNull) {
    if (target !== null && target !== undefined) {
      return { ok: false, error: 'target must be null for this action' };
    }
  } else {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      return { ok: false, error: 'target object required' };
    }
    const keys = Object.keys(target).sort();
    if (keys.join(',') !== 'id,kind') {
      return { ok: false, error: 'target must have exactly {kind, id}' };
    }
    if (target.kind !== spec.targetKind) {
      return { ok: false, error: `target.kind must be "${spec.targetKind}"` };
    }
    if (spec.targetIdFixed && target.id !== spec.targetIdFixed) {
      return { ok: false, error: `target.id must be "${spec.targetIdFixed}"` };
    }
    if (typeof target.id !== 'string' || target.id.length === 0) {
      return { ok: false, error: 'target.id must be a non-empty string' };
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload object required' };
  }
  const payloadKeys = Object.keys(payload).sort();
  const expectedKeys = [...spec.payloadKeys].sort();
  if (payloadKeys.join(',') !== expectedKeys.join(',')) {
    return {
      ok: false,
      error: `payload keys must be exactly [${expectedKeys.join(', ')}]`,
    };
  }
  for (const k of spec.payloadKeys) {
    if (typeof payload[k] !== 'string' || payload[k].length === 0) {
      return { ok: false, error: `payload.${k} must be a non-empty string` };
    }
  }
  if (spec.payloadRequired) {
    for (const [k, v] of Object.entries(spec.payloadRequired)) {
      if (payload[k] !== v) {
        return { ok: false, error: `payload.${k} must equal "${v}"` };
      }
    }
  }
  if (spec.payloadReasonCodeEnum && !spec.payloadReasonCodeEnum.includes(payload.reasonCode)) {
    return {
      ok: false,
      error: `payload.reasonCode must be one of [${spec.payloadReasonCodeEnum.join(', ')}]`,
    };
  }

  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, error: 'evidence must be a non-empty array' };
  }
  const uniqueEvidence = new Set(evidence);
  if (uniqueEvidence.size !== evidence.length) {
    return { ok: false, error: 'evidence contains duplicate lineIds' };
  }

  return { ok: true };
}

module.exports = { ALLOWED_ACTIONS, ACTION_SPECS, validateProposalShape };
