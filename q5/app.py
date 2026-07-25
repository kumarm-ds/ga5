"""
Run Budget & Loop Guard endpoint.

POST / with JSON:
  { "budget_tokens": <int>, "steps": [ {step_number, tool, args, tokens_used}, ... ] }

Returns JSON:
  { "decision": "continue" | "halt", "reason": "<short string>" }

Run locally:
    pip install flask
    python app.py
Then POST to http://localhost:8000/

Deploy anywhere that runs a Python web app (Render, Railway, Replit, Fly.io, etc.)
and give the grader the public URL.
"""

import os
import re
import json
from flask import Flask, request, jsonify

app = Flask(__name__)

TRACING_KEY = "request_id"


def canonicalize(value):
    """
    Recursively normalize a JSON-like value so that two calls that are
    'functionally identical' compare equal:
      - dict keys sorted alphabetically
      - the 'request_id' key removed at any depth (it's just a trace id)
      - whitespace inside strings collapsed and trimmed
      - lists normalized element-by-element (order within a list still matters,
        since order can be meaningful, e.g. a list of file paths)
    """
    if isinstance(value, dict):
        cleaned = {}
        for k, v in value.items():
            if k == TRACING_KEY:
                continue
            cleaned[k] = canonicalize(v)
        return {k: cleaned[k] for k in sorted(cleaned.keys())}
    elif isinstance(value, list):
        return [canonicalize(v) for v in value]
    elif isinstance(value, str):
        return re.sub(r"\s+", " ", value).strip()
    else:
        return value


def signature(step):
    """A hashable/comparable fingerprint for a step: (tool, canonical args as JSON string)."""
    tool = step.get("tool")
    args = step.get("args", {})
    canonical_args = canonicalize(args)
    # sort_keys=True is a belt-and-suspenders guarantee of stable string output
    return (tool, json.dumps(canonical_args, sort_keys=True))


def find_trailing_run_length(sigs):
    """How many identical signatures appear consecutively at the very end of the list."""
    if not sigs:
        return 0
    run_len = 1
    for i in range(len(sigs) - 1, 0, -1):
        if sigs[i] == sigs[i - 1]:
            run_len += 1
        else:
            break
    return run_len


def is_trailing_two_cycle(sigs, window=6):
    """
    Checks whether the last `window` steps (default 6) form an alternating
    A, B, A, B, A, B... pattern of two DISTINCT signatures.
    """
    if len(sigs) < window:
        return False
    last = sigs[-window:]
    a, b = last[0], last[1]
    if a == b:
        return False  # not actually two distinct things -> that's rule 1's job, not this rule
    for i, sig in enumerate(last):
        expected = a if i % 2 == 0 else b
        if sig != expected:
            return False
    return True


@app.route("/", methods=["POST"])
def run_guard():
    data = request.get_json(force=True, silent=True) or {}
    budget_tokens = data.get("budget_tokens", 0)
    steps = data.get("steps", []) or []

    # No steps yet -> nothing to evaluate, always fine to take the first step.
    if len(steps) == 0:
        return jsonify({
            "decision": "continue",
            "reason": "No steps taken yet; this would be the first step of the run."
        })

    # --- Budget rule (independent of loop rule) ---
    total_tokens = sum(step.get("tokens_used", 0) for step in steps)
    if total_tokens >= budget_tokens:
        return jsonify({
            "decision": "halt",
            "reason": f"Cumulative tokens_used ({total_tokens}) has reached the budget ({budget_tokens})."
        })

    # --- Loop rules ---
    sigs = [signature(s) for s in steps]

    run_len = find_trailing_run_length(sigs)
    if run_len >= 3:
        tool_name = steps[-1].get("tool", "<unknown>")
        return jsonify({
            "decision": "halt",
            "reason": f"Tool '{tool_name}' was called {run_len} times in a row with functionally identical arguments."
        })

    if is_trailing_two_cycle(sigs, window=6):
        return jsonify({
            "decision": "halt",
            "reason": "Detected a 2-step alternating loop (A, B, A, B, A, B) in the trailing steps."
        })

    return jsonify({
        "decision": "continue",
        "reason": "Under budget and no repeated-call or alternating-cycle loop detected in the trailing steps."
    })


if __name__ == "__main__":
    # host="0.0.0.0" so it's reachable from outside your own machine.
    # Render (and most hosts) assign the port dynamically via the PORT
    # env var, so we read that first and fall back to 8000 for local testing.
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port)
