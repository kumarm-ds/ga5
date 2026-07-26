# Incident Agent

Implements the `ga5-incident-agent/v2` contract: a persistent run API,
a single model call per new run to diagnose + plan diagnostics/effect,
a receipt-driven state machine (retries, timeouts, approval gate), and
a pure OTLP trace builder that reflects only stored state.

## Project layout

```
src/
  ids.js          opaque IDs, W3C traceparent parse/generate, SHA-256 digest
  db.js           persistence via Upstash Redis REST API (runs + receipts, replay/conflict lookup)
  model.js        the one AI call per new run + strict re-validation of its output
  statemachine.js create + receipt processing (retry/timeout/approval/finalize)
  trace.js        pure OTLP builder — reads stored state only, never re-plans
  validate.js     request schema checks + deep-equal for replay/conflict
  server.js       Express app: POST /v2/incidents, POST .../receipts, GET .../:runId
tools/
  test-client.js  simulates the grader's create/replay/conflict flow
render.yaml        Render deployment blueprint
```

## 1. Get a free AI API key

Any OpenAI-compatible provider works. Groq's free tier is fastest to set up:

1. Go to **https://console.groq.com** → sign up.
2. **API Keys** → **Create API Key** → copy it.
3. Values to set:
   - `AI_BASE_URL=https://api.groq.com/openai/v1`
   - `AI_API_KEY=<your key>`
   - `AI_MODEL=llama-3.3-70b-versatile`

Gemini also works via its OpenAI-compatible endpoint:
- `AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`
- `AI_API_KEY=<Gemini key from https://aistudio.google.com/apikey>`
- `AI_MODEL=gemini-2.5-flash-lite`

## 2. Get a free Upstash Redis database (storage)

Render's **Free** instance type doesn't offer persistent Disks, and its
local filesystem is wiped whenever the instance spins down from idling —
so this project stores state in Upstash Redis over HTTPS instead, which
works fine on Render's free tier.

1. Go to **https://console.upstash.com** → sign up (GitHub/Google login works).
2. **Create Database** → any name, region close to your Render region → Create.
3. On the database's detail page, find the **REST API** section and copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## 3. Run it locally

```bash
npm install
cp .env.example .env
# edit .env: fill in AI_API_KEY and the two UPSTASH_REDIS_REST_* values
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

## 4. Push to GitHub

```bash
cd incident-agent
git init
git add -A
git commit -m "Observable incident agent"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

(If this lives as a subfolder in an existing monorepo like `ga5/q11/`, just
`git add q11 && git commit -m "..." && git push` from the repo root instead.)

## 5. Deploy on Render

Use the manual **Web Service** route — most foolproof for a monorepo
subfolder, and matches the `plan: free` in `render.yaml` (no disk needed):

1. Render dashboard → **New +** → **Web Service** → connect your repo.
2. **Root Directory**: the subfolder this project lives in (e.g. `q11`) —
   leave blank if it's the whole repo.
3. **Runtime**: `Node`. **Build Command**: `npm install`. **Start Command**: `npm start`.
4. **Instance Type**: Free.
5. Under **Environment Variables**, add:

   | Key | Value |
   |---|---|
   | `AI_BASE_URL` | `https://api.groq.com/openai/v1` |
   | `AI_API_KEY` | *(your key)* |
   | `AI_MODEL` | `llama-3.3-70b-versatile` |
   | `UPSTASH_REDIS_REST_URL` | *(from Upstash)* |
   | `UPSTASH_REDIS_REST_TOKEN` | *(from Upstash)* |

6. Click **Create Web Service** and wait for the build to go green.

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
