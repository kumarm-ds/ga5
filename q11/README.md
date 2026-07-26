# Incident Agent

Implements the `ga5-incident-agent/v2` contract: a persistent run API,
a single model call per new run to diagnose + plan diagnostics/effect,
a receipt-driven state machine (retries, timeouts, approval gate), and
a pure OTLP trace builder that reflects only stored state.

## Project layout

```
src/
  ids.js          opaque IDs, W3C traceparent parse/generate, SHA-256 digest
  db.js           SQLite persistence (runs + receipts, replay/conflict lookup)
  model.js        the one AI call per new run + strict re-validation of its output
  statemachine.js create + receipt processing (retry/timeout/approval/finalize)
  trace.js        pure OTLP builder — reads stored state only, never re-plans
  validate.js     request schema checks + deep-equal for replay/conflict
  server.js       Express app: POST /v2/incidents, POST .../receipts, GET .../:runId
tools/
  test-client.js  simulates the grader's create/replay/conflict flow
render.yaml        Render deployment blueprint
```

## 1. Run it locally

```bash
npm install
cp .env.example .env
# edit .env: set AI_API_KEY (Groq/Gemini/OpenRouter/etc — any OpenAI-compatible
# chat completions endpoint works; model choice earns no marks)
npm start
```

In a second terminal:

```bash
npm run test:client
```

This exercises create → replay (must match exactly) → conflict (expects `409`)
→ `GET`. For retry/timeout/approval behavior, see the inline unit-style
scenario you can adapt from `tools/test-client.js` (build outcomes with
`status: 503`, then `status: 0, resultClass/errorType: "timeout"`, then an
approval decision, mirroring the grader's receipt shapes).

## 2. Get a free AI API key

Any OpenAI-compatible provider works. Groq's free tier is fastest to set up:

1. Go to **https://console.groq.com** → sign up.
2. **API Keys** → **Create API Key** → copy it.
3. Set in `.env` (local) / Render environment (deployed):
   - `AI_BASE_URL=https://api.groq.com/openai/v1`
   - `AI_API_KEY=<your key>`
   - `AI_MODEL=llama-3.3-70b-versatile`

Gemini also works via its OpenAI-compatible endpoint:
- `AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`
- `AI_API_KEY=<Gemini key from https://aistudio.google.com/apikey>`
- `AI_MODEL=gemini-2.5-flash-lite`

## 3. Push to GitHub

```bash
cd incident-agent
git init
git add -A
git commit -m "Observable incident agent"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 4. Deploy on Render

**Option A — Blueprint (uses `render.yaml`):**
1. https://dashboard.render.com → **New** → **Blueprint** → connect this repo.
2. Render reads `render.yaml` automatically. When prompted, paste your
   `AI_API_KEY` (marked `sync: false`, so it's not committed to git).
3. Deploy. You'll get a URL like `https://incident-agent-xxxx.onrender.com`.

**Option B — Manual web service:**
1. **New** → **Web Service** → connect this repo.
2. Environment: **Node**. Build: `npm install`. Start: `npm start`.
3. Add a **Disk** (1 GB, mount path `/var/data`) so SQLite state survives
   restarts, and set `DB_PATH=/var/data/incident-agent.db`.
4. Add env vars `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`.
5. Create the service and wait for the build to go green.

## 5. Submit

Submit the base URL, e.g. `https://incident-agent-xxxx.onrender.com` (no
credentials/query/fragment, HTTPS, no redirects). Leave the service running
— Check/Save reuse the same routes with new run IDs later.

## Notes on correctness (read before you extend this)

- **Only `model.js` calls the AI**, and only once per brand-new `runId`
  (inside `createRun`). Nothing in `statemachine.js` or `trace.js` ever
  calls it — receipts, retries, approvals, and replay are pure bookkeeping.
- **Replay/conflict** is handled at the HTTP layer in `server.js` by
  comparing the incoming body against the stored `requestSnapshot` /
  stored receipt body via `deepEqual`, before any state-machine logic runs.
- **`trace.js` is a pure function** of the stored run object — call it as
  many times as you want, it always returns the same trace for the same
  state. This is what makes `GET` and replay trivially consistent.
- The `sensitive` object is read only to be discarded — `model.js` never
  receives it, and it's never written into `run.actionLog`, `run.receiptLog`,
  or the OTLP output.
- This is a working reference implementation, not a guarantee of full marks
  — re-read the assignment's edge cases (duplicate evidence, exact digest
  computation, multi-diagnostic timeout combinations) against your actual
  graded incidents and adjust `model.js`'s prompt / `statemachine.js`'s
  branches if the grader's feedback flags a specific category.
