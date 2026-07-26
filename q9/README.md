# Mailroom Agent

Implements the `ga5-mailroom-action-gate/v2` `propose`/`commit` contract:
canonical hashing, an AI reading step wrapped in a deterministic safety
gate, content-keyed caching, and Ed25519 receipt verification.

## Project layout

```
src/
  canonical.js       canonicalize(), sha256hex(), digest helpers
  actions.js         allowed actions + frozen target/payload shape checks
  model.js           the AI call (Anthropic Messages API, tool-forced JSON)
  safety.js          validates/normalizes model output into a safe proposal
  receipt-crypto.js  Ed25519 JWK import + signature verification
  validation.js      request schema validation (400/422 before AI/DB work)
  db.js              SQLite setup
  store.js           persistence helpers (dossier cache, evaluations, commits)
  server.js          Express app: POST /mailroom (propose + commit)
tools/
  keygen.js          generate a test Ed25519 keypair
  test-client.js      simulates the grader against your local server
render.yaml           Render deployment blueprint
```

## 1. Run it locally

```bash
npm install
cp .env.example .env
# get a free key at https://aistudio.google.com/apikey (no credit card needed
# for the Flash / Flash-Lite models), then edit .env and set GEMINI_API_KEY=...
npm start
```

In a second terminal, run the simulated grader to sanity-check the whole
flow (propose → commit → replay → conflict) without touching the real
Check:

```bash
npm run test:client
```

You should see: a 200 propose response with one proposal per dossier
(the injection dossier should come back as `quarantine_item`), a 200
commit response with `"status": "executed"` for both proposals, an
identical replayed propose response, and a `409` for the changed-content
case.

## 2. Push to GitHub

```bash
cd mailroom-agent
git init
git add -A
git commit -m "Safe AI mailroom agent"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 3. Deploy on Render

**Option A — Blueprint (recommended, uses `render.yaml`):**

1. Go to https://dashboard.render.com → **New** → **Blueprint**.
2. Connect the GitHub repo you just pushed.
3. Render reads `render.yaml` and proposes one Web Service (`mailroom-agent`)
   with a 1 GB persistent disk mounted at `/var/data`.
4. Before deploying, set the `GEMINI_API_KEY` environment variable
   (marked `sync: false` in the blueprint, so Render will prompt you for it).
   Get a free key at https://aistudio.google.com/apikey.
5. Click **Apply** / **Create**. Wait for the build + deploy to finish.

**Option B — Manual Web Service:**

1. **New** → **Web Service** → connect your repo.
2. Environment: **Node**. Build command: `npm install`. Start command:
   `node src/server.js`.
3. Add environment variables:
   - `GEMINI_API_KEY` = your free key from https://aistudio.google.com/apikey
   - `MODEL_NAME` = `gemini-2.5-flash` (or `gemini-2.5-flash-lite` for higher free-tier request limits)
   - `MODEL_CONCURRENCY` = `8`
   - `DB_PATH` = `/var/data/mailroom.db`
4. Add a **Disk**: mount path `/var/data`, size 1 GB (needs a paid instance
   type — the free plan doesn't support persistent disks; see note below).
5. Deploy.

### About persistence on Render's free plan

The spec requires stable dossiers to produce the *same* proposal across
evaluations and later Checks, and says not to rely on process memory for
durable state. A Render **persistent Disk** (Option A/B above) is the
simplest way to guarantee that survives restarts and redeploys.

If you're on the free plan (no disk support), `DB_PATH` will just write to
the container's local ephemeral disk. That's fine *within* one running
instance (a whole Check's ~180s verification window won't restart your
dyno), but a restart between separate Check/Save runs would lose the
cache — your service would simply recompute decisions rather than reusing
them, which costs a few cents of extra model calls but shouldn't break
correctness as long as the model's answers stay consistent (we already set
`temperature: 0` in `src/model.js` to help with that). For full compliance,
upgrade to a plan that supports a Disk.

## 4. Get your submission URL

After deploy, Render gives you a URL like:

```
https://mailroom-agent-xxxx.onrender.com
```

Your public endpoint is that URL plus `/mailroom`, e.g.:

```
https://mailroom-agent-xxxx.onrender.com/mailroom
```

That's the exact URL to submit — it has no credentials, query string, or
fragment, as required.

## 5. Tuning before the real Check

- **Timing:** the first `propose` call for a fresh Check has to run the AI
  step on all ~67 dossiers (64 core + 3 audit) within 55 seconds. Adjust
  `MODEL_CONCURRENCY` up or down based on your model provider's rate
  limits and observed latency. Gemini's free tier caps requests-per-minute
  (roughly 10-15 RPM depending on model as of mid-2026) - if you hit 429s,
  lower `MODEL_CONCURRENCY` and/or switch `MODEL_NAME` to
  `gemini-2.5-flash-lite`, which has a higher free-tier RPM/RPD ceiling.
- **Safety prompt:** `src/model.js`'s `SYSTEM_PROMPT` is a starting point.
  Once you see real dossier shapes (their `provenance` values especially),
  tighten the guidance — e.g. what counts as a "trusted, scoped approval"
  for `send_approved_notice`.
- **Fallback behavior:** `src/safety.js` currently falls back to
  `request_confirmation` whenever the model's output is missing or fails
  schema validation. That's a safe default (never an unauthorized outbound
  action) but review it against the accuracy rubric.
