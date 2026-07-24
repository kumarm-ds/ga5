import os
import re
from flask import Flask, request, jsonify

app = Flask(__name__)

# ---------------------------------------------------------------------------
# hardcoded_secret
# ---------------------------------------------------------------------------
SECRET_PATTERNS = [
    # key: value / key = "value" style assignments with a long token
    r'(?:api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|auth[_-]?key|bearer[_-]?token|session[_-]?token|token|password|passwd|pwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*["\']?[A-Za-z0-9_\-\./+=]{10,}["\']?',
    # common provider key prefixes
    r'\bsk-[A-Za-z0-9]{16,}\b',
    r'\bsk-proj-[A-Za-z0-9_\-]{16,}\b',
    r'\bghp_[A-Za-z0-9]{20,}\b',
    r'\bgithub_pat_[A-Za-z0-9_]{20,}\b',
    r'\bAKIA[0-9A-Z]{16}\b',
    r'\bxox[baprs]-[A-Za-z0-9-]{10,}\b',
    r'\bAIza[A-Za-z0-9_\-]{20,}\b',  # Google API key
    r'\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}\b',  # JWT-looking token
    # webhook URLs with an embedded token/path
    r'https?://hooks\.slack\.com/services/\S+',
    r'https?://discord(?:app)?\.com/api/webhooks/\S+',
    r'https?://[A-Za-z0-9_\-\.]+/webhook[s]?/[A-Za-z0-9_\-]{10,}',
    # bearer tokens hardcoded in headers/scripts
    r'Bearer\s+[A-Za-z0-9_\-\.]{16,}',
    # PEM-style private key blocks
    r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    # curl/header lines with an inline credential
    r'(?:Authorization|X-Api-Key)\s*[:=]\s*["\']?[A-Za-z0-9_\-\.]{10,}',
]

# Placeholders that should NOT count as a real secret even if they match above.
PLACEHOLDER_HINTS = [
    'your-api-key', 'your_api_key', 'your api key', 'xxxx', 'placeholder',
    '<api_key>', '<your', '${', 'env.', 'os.environ', 'process.env',
    'getenv', 'example.com', 'insert-your', 'insert your', 'replace-with',
    'replace with', 'changeme', 'change_me', '****', 'sample-key',
    'dummy', 'fake-key', 'not-a-real', 'redacted',
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
    "ignore the user's request to stop", "ignore user instructions",
    "ignore previous instructions", "ignore prior instructions",
    "ignore all previous", "override previous instructions",
    "override the user", "override any user", "bypass user",
    "bypass the user", "bypass confirmation", "skip confirmation",
    "no need to ask permission", "no need to confirm with the user",
    "don't ask for confirmation", "do not ask for confirmation",
    "do not tell the user", "don't tell the user", "never tell the user",
    "without informing the user", "without notifying the user",
    "without asking the user", "without the user's knowledge",
    "without the user knowing", "the user does not need to know",
    "the user doesn't need to know",
    "silently send", "silently exfiltrate", "silently upload",
    "silently email", "silently forward", "silently copy",
    "silently transmit", "secretly send", "secretly upload",
    "secretly forward", "secretly transmit",
    "regardless of what the user says", "regardless of user input",
    "regardless of any stop request", "even if the user cancels",
    "even if the user says stop", "do not stop even if",
    "cannot be cancelled", "cannot be interrupted", "ignore stop requests",
    "hide this from the user", "hide this step from the user",
    "do not mention this step", "do not log this", "don't log this",
    "avoid logging this", "delete the logs", "cover your tracks",
    "exfiltrate", "keep this hidden", "keep this step hidden",
    "act autonomously without confirmation", "auto-approve",
    "always comply", "disregard any", "disregard the user",
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
    r'^\s*access\s*:\s*["\']?(all|full|\*)["\']?',
    r'network\s*:\s*["\']?(\*|all|any)["\']?',
    r'domains?\s*:\s*\[?\s*["\']?\*',
    r'egress\s*:\s*["\']?(any|all|\*)["\']?',
    r'scopes?\s*:\s*\[?\s*["\']?(all|\*)',
    r'permissions?\s*:\s*\[?\s*["\']?(all|\*)',
    r'0\.0\.0\.0/0',
]

# Prose phrases that indicate an unscoped / broader-than-needed capability
# request, for skills that describe permissions in sentences rather than
# structured YAML.
PERMISSION_PHRASES = [
    "full filesystem access", "entire filesystem", "whole filesystem",
    "access to the entire filesystem", "read/write access to the entire",
    "read and write access to the entire", "access to all files",
    "access every file", "any file on the system", "any file on disk",
    "full disk access", "root access", "sudo access", "administrator access",
    "unrestricted filesystem", "unrestricted network", "unrestricted access",
    "unlimited access", "unlimited network access",
    "access to any domain", "connect to any domain", "any external domain",
    "any host", "outbound to any", "network access to any",
    "access to the entire network", "all network access",
]


def check_excessive_permissions(text: str) -> bool:
    lower = text.lower()
    if any(re.search(pat, lower, re.MULTILINE) for pat in PERMISSION_PATTERNS):
        return True
    return any(phrase in lower for phrase in PERMISSION_PHRASES)


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

    # Flag a step that rewrites/bumps version (or other provenance) metadata
    # without surfacing that change to the reviewer.
    lower_full = text.lower()
    version_rewrite = bool(
        re.search(
            r'(silently\s+)?(update|updates|bump|bumps|rewrite|rewrites|'
            r'increment|increments|overwrite|overwrites|change|changes|set|sets)'
            r'.{0,25}(version|changelog|metadata|author)\b',
            lower_full,
        )
    )
    surfaced = any(
        kw in lower_full
        for kw in [
            'notify', 'notifies', 'surface', 'surfaces', 'show the reviewer',
            'flag this', 'flags this', 'display this change', 'inform the reviewer',
            'informs the reviewer', 'alert the reviewer', 'log this change',
            'logs this change', 'visible to the reviewer', 'shown to the reviewer',
        ]
    )
    explicitly_silent = any(
        kw in lower_full
        for kw in [
            'silent', 'quietly', 'without telling', 'without surfacing',
            'without notice', 'without the reviewer', 'behind the scenes',
            'unnoticed', 'without showing',
        ]
    )
    silent_rewrite = version_rewrite and explicitly_silent

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
