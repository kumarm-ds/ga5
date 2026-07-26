# A2A Invoice Agent

Node.js/Express implementation of the A2A 1.0 HTTP+JSON invoice action agent.

## What's here

```
a2a-invoice-agent/
├── server.js         # routes: agent card, message:send, tasks, cancel
├── agentCard.js       # Agent Card JSON
├── lib/
│   ├── hash.js         # canonical JSON + idempotency hashing
│   ├── schema.js        # zod schemas for proposals/results
│   └── store.js          # in-memory task store, dedup, atomic transitions
├── ai/
│   └── decide.js          # batched AI call + package-content cache
├── test/
│   └── stub-ai-server.js   # fake AI provider, for local testing only
├── package.json
├── .env.example
└── .gitignore
```

Tested locally end-to-end (auth, version check, idempotent replay, 409 conflict,
user isolation, proposal → result → COMPLETED, rejected-proposal exclusion from
receipts, terminal replay, cancel-vs-terminal race) — see "Local test" below.

## 1. Configure environment variables

Copy `.env.example` to `.env` for local runs, and set the same keys as
**environment variables in Render** (not a committed `.env` file):

- `BASE_URL` — the **exact** public URL you will submit, e.g.
  `https://a2a-invoice-agent.onrender.com/a2a/` (must end with `/`).
  This is echoed verbatim into the Agent Card's `supportedInterfaces`.
- `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` — any OpenAI-compatible chat
  completions endpoint (Groq, OpenRouter, Together, a local Ollama
  OpenAI-compat endpoint, etc.). Cost/provider isn't graded.
- `ALLOWED_TOKENS` — optional. Leave empty to accept any non-empty Bearer
  token (each distinct token = a distinct isolated user, which is what the
  grader needs to test user isolation). Set this only if you want to
  restrict to specific known tokens.

## 2. Push to GitHub

```bash
cd a2a-invoice-agent
git init
git add .
git commit -m "A2A invoice agent"
```

Create a new empty repo on GitHub (don't initialize it with a README), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/a2a-invoice-agent.git
git branch -M main
git push -u origin main
```

## 3. Deploy on Render

1. Go to [render.com](https://render.com) → **New** → **Web Service**.
2. Connect your GitHub account (if not already) and select the
   `a2a-invoice-agent` repo.
3. Environment: **Node**.
4. **Build Command**: `npm install`
5. **Start Command**: `npm start`
6. Under **Environment**, add the variables from step 1
   (`BASE_URL`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, optionally
   `ALLOWED_TOKENS`). Leave `PORT` unset — Render sets it automatically and
   the server already reads `process.env.PORT`.
7. Click **Create Web Service** and wait for the build/deploy to finish.
   You'll get a URL like `https://a2a-invoice-agent.onrender.com`.
8. **Important:** once deployed, double-check `BASE_URL` matches that
   exact host with `/a2a/` appended (e.g.
   `https://a2a-invoice-agent.onrender.com/a2a/`), then redeploy if you had
   to change it, since the Agent Card must echo the exact submitted base URL.

## 4. Submit

Submit the base URL (e.g. `https://a2a-invoice-agent.onrender.com/a2a/`) in
the assignment field. Leave the service running and don't touch the code
until grading finishes — a past success doesn't count if the server is down
when the grader hits it later.

## Local test (optional, recommended before deploying)

The repo includes a fake AI provider so you can test the whole protocol
without spending on a real model:

```bash
npm install
node test/stub-ai-server.js &         # fake AI on :4001

BASE_URL="http://localhost:3000/a2a/" \
AI_BASE_URL="http://localhost:4001/v1" \
AI_API_KEY="dummy" \
AI_MODEL="dummy" \
PORT=3000 \
node server.js
```

Then in another terminal, try:

```bash
curl http://localhost:3000/.well-known/agent-card.json

curl -H "Authorization: Bearer userA" -H "A2A-Version: 1.0" \
     http://localhost:3000/a2a/tasks
```

## Known simplifications (double-check against the official A2A spec)

This was built directly from the assignment text, which quotes fragments of
the A2A 1.0 shape rather than the full schema. A few things you should
verify against https://a2a-protocol.org/latest/specification/ and adjust if
the grader expects different exact field names:

- **Storage is in-memory** (`lib/store.js`). This is fine for a single
  Render instance during grading, but data is lost on restart/redeploy —
  don't redeploy mid-grading. If you want durability, swap `store.js` for
  SQLite (e.g. `better-sqlite3`) without touching routes or `ai/decide.js`.
- **Task JSON shape** (`toWireTask` in `server.js`) uses `taskId`,
  `contextId`, `state`, `history`, `artifacts` — matched from the fragments
  given in the assignment. If the official spec uses different field names
  (e.g. `id` instead of `taskId`), change only `toWireTask`.
- **Principal = raw Bearer token value.** Any non-empty token is accepted
  as its own isolated user unless you set `ALLOWED_TOKENS`. If the grader
  instead expects a single fixed secret token, set `ALLOWED_TOKENS` to that
  one value.
- **`SUBMITTED` / `WORKING` states** are defined in the code but the happy
  path jumps straight from receiving the batch to `TASK_STATE_INPUT_REQUIRED`
  (the assignment says these are optional/internal — "You may use SUBMITTED
  and WORKING internally").
