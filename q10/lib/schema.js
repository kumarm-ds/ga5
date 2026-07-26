import { z } from "zod";

export const ACTIONS = [
  "settle_invoice",
  "request_approval",
  "hold_invoice",
  "reject_duplicate",
  "open_exception",
];

export const FactsSchema = z.object({
  vendorName: z.string().min(1),
  invoiceNumber: z.string().min(1),
  amountMinor: z.number().int(),
  currency: z.string().min(1),
});

export const ProposalSchema = z.object({
  packageId: z.string().min(1),
  actionId: z.string().min(12),
  action: z.enum(ACTIONS),
  facts: FactsSchema,
  evidenceRefs: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(60).max(1500),
});

export const ProposalsArtifactSchema = z.object({
  batchId: z.string().min(1),
  proposals: z.array(ProposalSchema),
});

export const ResultItemSchema = z.object({
  packageId: z.string().min(1),
  actionId: z.string().min(1),
  action: z.enum(ACTIONS),
  outcome: z.enum(["ACCEPTED", "REJECTED"]),
  receiptNonce: z.string().min(1),
});

export const ResultsDataSchema = z.object({
  batchId: z.string().min(1),
  results: z.array(ResultItemSchema),
});

export const IncomingBatchSchema = z.object({
  batchId: z.string().min(1),
  policyRevision: z.string().min(1),
  packages: z.array(z.record(z.any())).min(1),
});

/** Raw shape the model is asked to return for one package (before we attach our own actionId). */
export const ModelDecisionSchema = z.object({
  packageId: z.string().min(1),
  action: z.enum(ACTIONS),
  facts: FactsSchema,
  evidenceRefs: z.array(z.string().min(1)).min(1).max(3),
  rationale: z.string().min(60).max(1500),
});

export const ModelBatchResponseSchema = z.object({
  decisions: z.array(ModelDecisionSchema),
});
