import express from "express";
const app = express();
app.use(express.json());

app.post("/v1/chat/completions", (req, res) => {
  const userMsg = req.body.messages.find((m) => m.role === "user").content;
  const pkgMatch = userMsg.match(/Invoice packages[\s\S]*?(\[[\s\S]*\])/);
  const packages = JSON.parse(pkgMatch[1]);

  const decisions = packages.map((p) => ({
    packageId: p.packageId,
    action: "settle_invoice",
    facts: {
      vendorName: p.vendorName || "Acme Corp",
      invoiceNumber: p.invoiceNumber || "INV-0001",
      amountMinor: 100000,
      currency: "INR",
    },
    evidenceRefs: ["[Doc 1, para 2]", "[Doc 1, para 3]"],
    rationale:
      "settle_invoice: the invoice is valid and reconciled per [Doc 1, para 2] and confirmed within authority per [Doc 1, para 3], so it should be paid now.",
  }));

  res.json({
    choices: [{ message: { content: JSON.stringify({ decisions }) } }],
  });
});

app.listen(4001, () => console.log("stub AI server on :4001"));
