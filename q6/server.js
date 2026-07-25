import express from "express";
import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const EMAIL = "23f3004181@ds.study.iitm.ac.in"; // your registered exam email, already lowercase/trimmed

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  // A brand new "mini server" for this one request only
  const server = new McpServer({ name: "exam-server", version: "1.0.0" });

  server.registerTool(
    "solve_challenge",
    {
      description: "Solves the exam challenge using the HTTP request headers",
      inputSchema: {}, // no required properties — empty is fine
    },
    async () => {
      // Read the header from THIS request (headers are lowercase in Node/Express)
      const challenge = req.headers["x-exam-challenge"];

      const text = crypto
        .createHash("sha256")
        .update(`${challenge}:${EMAIL}`)
        .digest("hex")
        .slice(0, 16); // first 16 lowercase hex chars

      return {
        content: [{ type: "text", text }],
      };
    }
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode — simplest for this use case
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MCP server listening on port ${PORT}`));