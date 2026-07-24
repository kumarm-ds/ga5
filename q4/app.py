import os
import re
from flask import Flask, request, jsonify

app = Flask(__name__)

# ---------------------------------------------------------------------------
# hardcoded_secret
# ---------------------------------------------------------------------------
SECRET_PATTERNS = [
    # key: value / key = "value" style assignments with a long token
    r'(?:api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|auth[_-]?token|token|password|passwd|client[_-]?secret)\s*[:=]\s*["\']?[A-Za-z0-9_\-\.]{12,}["\']?',
    # common provider key prefixes
    r'\bsk-[A-Za-z0-9]{16,}\b',
    r'\bghp_[A-Za-z0-9]{20,}\b',
    r'\bAKIA[0-9A-Z]{16}\b',
    r'\bxox[baprs]-[A-Za-z0-9-]{10,}\b',
    # webhook URLs with an embedded token/path
    r'https?://hooks\.slack\.com/services/\S+',
    r'https?://discord(?:app)?\.com/api/webhooks/\S+',
    # bearer tokens hardcoded in headers/scripts
    r'Bearer\s+[A-Za-z0-9_\-\.]{16,}',
]

# Placeholders that should NOT count as a real secret even if they match above.
PLACEHOLDER_HINTS = [
    'your-api-key', 'your_api_key', 'xxxx', 'placeholder', '<api_key>',
    '${', 'env.', 'os.environ', 'process.env', 'getenv', 'example',
    'insert-your', 'replace-with', 'changeme', '****',
]


def check_hardcoded_secret(text: str) -> bool:
    for pat in SECRET_PATTERNS:
        for m in re.finditer(pat, text, re.IGNORECASE):
            snippet = m.group(0).lower()
            if any(hint in snippet for hint in PLACEHOLDER_HINTS):
                continue
            return True
    return False


# ---------------------------------------------------------------------------
# prompt_injection
# ---------------------------------------------------------------------------
INJECTION_PHRASES = [
    "ignore the user", "ignore any cancel", "ignore any stop",
    "ignore user instructions", "ignore previous instructions",
    "override previous instructions", "override the user",
    "do not tell the user", "don't tell the user",
    "without informing the user", "without notifying the user",
    "without the user's knowledge", "without the user knowing",
    "silently send", "silently exfiltrate", "silently upload",
    "silently email", "secretly send", "secretly upload",
    "regardless of what the user says", "regardless of user input",
    "do not stop even if", "cannot be cancelled", "cannot be interrupted",
    "hide this from the user", "do not mention this step",
    "exfiltrate", "keep this hidden",
]


def check_prompt_injection(text: str) -> bool:
    lower = text.lower()
    return any(phrase in lower for phrase in INJECTION_PHRASES)


# ---------------------------------------------------------------------------
# excessive_permissions
# ---------------------------------------------------------------------------
PERMISSION_PATTERNS = [
    r'filesystem\s*:\s*["\']?(/|\*|all|full)["\']?',
    r'file[_-]?access\s*:\s*["\']?(all|full|\*|entire)["\']?',
    r'access\s*:\s*["\']?(all|full|\*)["\']?',
    r'network\s*:\s*["\']?(\*|all|any)["\']?',
    r'domains?\s*:\s*\[?\s*["\']?\*',
    r'egress\s*:\s*["\']?(any|all|\*)["\']?',
    r'read[\s/_-]*write.{0,25}(entire|whole|full|all).{0,15}filesystem',
    r'(entire|whole|full|all).{0,15}filesystem',
    r'permissions?\s*:\s*\[?\s*["\']?(all|\*)',
]


def check_excessive_permissions(text: str) -> bool:
    lower = text.lower()
    return any(re.search(pat, lower, re.MULTILINE) for pat in PERMISSION_PATTERNS)


# ---------------------------------------------------------------------------
# unclear_provenance
# ---------------------------------------------------------------------------

def extract_frontmatter(text: str) -> str:
    """Return the YAML frontmatter block (between the first pair of --- lines)."""
    m = re.match(r'^\s*---\s*\n(.*?)\n---\s*\n', text, re.DOTALL)
    return m.group(1) if m else ""


def check_unclear_provenance(text: str) -> bool:
    fm = extract_frontmatter(text)
    fm_lower = fm.lower()

    has_author = bool(re.search(r'^\s*author\s*:', fm_lower, re.MULTILINE))
    has_version = bool(re.search(r'^\s*version\s*:', fm_lower, re.MULTILINE))
    has_changelog = bool(re.search(r'^\s*changelog\s*:', fm_lower, re.MULTILINE))

    # Flag only when ALL THREE are missing from frontmatter (strong signal).
    missing_all = not (has_author or has_version or has_changelog)

    # Flag a step that rewrites/bumps version metadata without surfacing it
    # to the reviewer (i.e. no mention of notifying/surfacing/showing the change).
    lower_full = text.lower()
    version_rewrite = bool(
        re.search(r'(update|bump|rewrite|increment|change).{0,20}version', lower_full)
    )
    surfaced = any(
        kw in lower_full for kw in ['notify', 'surface', 'show the reviewer', 'flag this', 'display this change', 'inform the reviewer']
    )
    silent_rewrite = version_rewrite and not surfaced and 'silent' in lower_full

    return missing_all or silent_rewrite


# ---------------------------------------------------------------------------
# endpoint
# ---------------------------------------------------------------------------
@app.route("/q4/scan", methods=["POST"])
def scan():
    try:
        data = request.get_json(force=True, silent=True) or {}
        text = data.get("skill", "")
        if not isinstance(text, str):
            text = str(text)
    except Exception:
        return jsonify({"categories": []}), 200

    categories = []
    if check_hardcoded_secret(text):
        categories.append("hardcoded_secret")
    if check_prompt_injection(text):
        categories.append("prompt_injection")
    if check_excessive_permissions(text):
        categories.append("excessive_permissions")
    if check_unclear_provenance(text):
        categories.append("unclear_provenance")

    return jsonify({"categories": categories}), 200


@app.route("/", methods=["GET"])
def health():
    return jsonify({"status": "ok"}), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
