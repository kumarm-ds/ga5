export function buildAgentCard(baseUrl) {
  return {
    name: "Invoice Action Agent",
    description:
      "Reads invoice claim batches, understands each package with an AI model, proposes exactly one typed action per invoice with cited evidence, and executes only after an explicit accepted result is returned.",
    version: "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills: [
      {
        id: "invoice_action_agent",
        name: "Invoice Action Agent",
        description:
          "Reconciles invoice packages against policy and evidence in the source documents, proposing settle_invoice, request_approval, hold_invoice, reject_duplicate, or open_exception actions.",
        tags: ["invoice", "finance", "reconciliation", "a2a"],
      },
    ],
    supportedInterfaces: [
      {
        url: baseUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    defaultInputModes: ["application/vnd.ga5.invoice-claim-batch+json"],
    defaultOutputModes: [
      "application/vnd.ga5.invoice-action-proposals+json",
      "application/vnd.ga5.invoice-action-receipts+json",
    ],
  };
}
