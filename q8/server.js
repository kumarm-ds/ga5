const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const app = express();
app.use(express.json());

const SANDBOX_ROOT = fs.realpathSync('/srv/agent-redteam/sandbox-74babd62a9');
const ALLOWED_HOSTS = new Set(['example.com', 'www.iana.org']);

// --- helper: is an IP address "private/internal"? ---
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                     // 10.0.0.0/8
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;// 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1') return true;
    if (l.startsWith('fe80')) return true;
    if (l.startsWith('fc') || l.startsWith('fd')) return true;
    return false;
  }
  return true; // unrecognized -> treat as unsafe
}

// --- read_file guardrail ---
function safeReadFile(reqPath) {
  if (typeof reqPath !== 'string' || !reqPath.length) {
    return { ok: false, reason: 'invalid path' };
  }
  // Step 1: resolve it against the sandbox root (this collapses ../.. etc.)
  const candidate = path.resolve(SANDBOX_ROOT, reqPath.replace(/^\/+/, ''));

  let real;
  try {
    // Step 2: resolve symlinks too, so a symlink can't escape the sandbox
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'path does not exist' };
  }

  // Step 3: the ONLY check that matters — is the final real path inside the root?
  const rel = path.relative(SANDBOX_ROOT, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'path escapes sandbox' };
  }

  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { ok: false, reason: 'not a file' };
    return { ok: true, content: fs.readFileSync(real, 'utf8') };
  } catch {
    return { ok: false, reason: 'read error' };
  }
}

// --- fetch_url guardrail ---
async function safeFetch(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: 'invalid url' }; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'bad protocol' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'userinfo not allowed' }; // blocks user@host tricks
  }

  const hostname = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    return { ok: false, reason: 'host not allowlisted' };
  }

  // Check where the hostname ACTUALLY resolves to
  let addrs;
  try { addrs = await dns.lookup(hostname, { all: true }); }
  catch { return { ok: false, reason: 'dns resolution failed' }; }
  if (addrs.some(a => isPrivateIP(a.address))) {
    return { ok: false, reason: 'resolves to private ip' };
  }

  // Follow redirects manually, re-checking every hop
  let currentUrl = u.toString();
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(currentUrl, { redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return { ok: false, reason: 'redirect missing location' };
      const next = new URL(loc, currentUrl);
      if (next.username || next.password) return { ok: false, reason: 'redirect userinfo' };
      const nextHost = next.hostname.toLowerCase();
      if (!ALLOWED_HOSTS.has(nextHost)) return { ok: false, reason: 'redirect host not allowlisted' };
      let nextAddrs;
      try { nextAddrs = await dns.lookup(nextHost, { all: true }); }
      catch { return { ok: false, reason: 'redirect dns failed' }; }
      if (nextAddrs.some(a => isPrivateIP(a.address))) return { ok: false, reason: 'redirect resolves private' };
      currentUrl = next.toString();
      continue;
    }
    return { ok: true, content: await resp.text() };
  }
  return { ok: false, reason: 'too many redirects' };
}

app.post('/', async (req, res) => {
  const { tool, arguments: args } = req.body || {};
  try {
    if (tool === 'read_file') {
      const r = safeReadFile(args && args.path);
      return res.json(r.ok
        ? { action: 'allow', reason: 'inside sandbox', result: r.content }
        : { action: 'block', reason: r.reason });
    }
    if (tool === 'fetch_url') {
      const r = await safeFetch(args && args.url);
      return res.json(r.ok
        ? { action: 'allow', reason: 'host allowlisted', result: r.content }
        : { action: 'block', reason: r.reason });
    }
    return res.json({ action: 'block', reason: 'unknown tool' });
  } catch {
    return res.json({ action: 'block', reason: 'internal error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('listening on', PORT));