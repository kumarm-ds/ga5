import { ModelBatchResponseSchema } from "../lib/schema.js";
import { hashPackageContent } from "../lib/hash.js";
import { getCachedPackageDecision, setCachedPackageDecision, newActionId } from "../lib/store.js";

const SYSTEM_PROMPT = `You are an invoice reconciliation agent. For each invoice package you are given
(raw source text plus any structured fields), choose EXACTLY ONE action:

- settle_invoice: valid, reconciled, and within the agent's autonomous authority.
- request_approval: commercially valid, but outside the agent's delegated authority (e.g. amount too high, vendor not pre-approved).
- hold_invoice: payment must pause until a specific, stated verification completes.
- reject_duplicate: this exact commercial invoice was already paid before (a true duplicate).
- open_exception: material records conflict (amounts, vendor identity, dates, PO mismatch) and need a human exception workflow.

Rules:
- Base your decision ONLY on the facts stated in the package text. Watch for negation ("was NOT approved"),
  old/historical examples inside the text that are NOT about this invoice, and unrelated words that merely
  sound like actions but are irrelevant to the decision (decoys).
- evidenceRefs must contain ONLY the exact bracketed reference tags (e.g. "[Doc 2, para 3]") for the
  1 to 3 sentences/paragraphs that actually determine the action. Do NOT cite a cover-sheet reference,
  archive/example references, or decoy references.
- rationale must be 60 to 1500 characters, must name the chosen action, and must reference at least two
  of the evidenceRefs you cited.
- facts.amountMinor is an integer in the smallest currency unit (e.g. cents/paise). facts.currency is an
  ISO-style currency code such as "INR" or "USD".

Return ONLY strict JSON matching this shape, nothing else, no markdown fences:
{
  "decisions": [
    {
      "packageId": "...",
      "action": "settle_invoice | request_approval | hold_invoice | reject_duplicate | open_exception",
      "facts": { "vendorName": "...", "invoiceNumber": "...", "amountMinor": 12345, "currency": "INR" },
      "evidenceRefs": ["[Doc X, para Y]", "..."],
      "rationale": "..."
    }
  ]
}`;

async function callModel(packages, policyRevision) {
  const baseUrl = process.env.AI_BASE_URL;
  const apiKey = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL || "gpt-4o-mini";

  if (!baseUrl || !apiKey) {
    throw new Error("AI_BASE_URL / AI_API_KEY are not configured");
  }

  const userPrompt =
    `Policy revision: ${policyRevision}\n\n` +
    `Invoice packages (JSON array, one object per package):\n` +
    JSON.stringify(packages, null, 2);

  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`AI provider error ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI provider returned no content");

  let parsed;
  try {
    parsed = JSON.parse(stripFences(content));
  } catch {
    throw new Error("AI provider returned invalid JSON");
  }

  const validated = ModelBatchResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("AI provider JSON failed schema validation: " + validated.error.message);
  }
  return validated.data.decisions;
}

function stripFences(s) {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

/**
 * Decide actions for a full batch of packages.
 * - Packages whose canonical content hash is already cached skip the model entirely.
 * - Remaining packages are sent in ONE batched call.
 * - actionId is generated/reused deterministically per (packageContentHash), so repeat
 *   runs of the same package content always get the same actionId.
 */
export async function decideBatch(packages, policyRevision) {
  const results = new Array(packages.length);
  const toAsk = [];
  const toAskIdx = [];

  packages.forEach((pkg, i) => {
    const hash = hashPackageContent(pkg);
    const cached = getCachedPackageDecision(hash);
    if (cached) {
      results[i] = { ...cached, packageId: pkg.packageId ?? pkg.id ?? cached.packageId };
    } else {
      toAsk.push(pkg);
      toAskIdx.push(i);
    }
  });

  if (toAsk.length > 0) {
    const decisions = await callModel(toAsk, policyRevision);
    // Map decisions back by packageId (fall back to positional match if the model omitted one).
    const byId = new Map(decisions.map((d) => [d.packageId, d]));

    toAsk.forEach((pkg, j) => {
      const idx = toAskIdx[j];
      const pkgId = pkg.packageId ?? pkg.id;
      const decision = byId.get(pkgId) ?? decisions[j];
      if (!decision) {
        throw new Error(`AI provider did not return a decision for package ${pkgId}`);
      }
      const hash = hashPackageContent(pkg);
      const finalized = {
        packageId: pkgId,
        actionId: newActionId(),
        action: decision.action,
        facts: decision.facts,
        evidenceRefs: decision.evidenceRefs,
        rationale: decision.rationale,
      };
      setCachedPackageDecision(hash, finalized);
      results[idx] = finalized;
    });
  }

  return results;
}
