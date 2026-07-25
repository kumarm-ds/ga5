const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const { Agent, fetch: undiciFetch } = require('undici');

const app = express();
app.use(express.json());

const SANDBOX_ROOT = fs.realpathSync('/srv/agent-redteam/sandbox-74babd62a9');
const ALLOWED_HOSTS = new Set(['example.com', 'www.iana.org']);

// --- helper: is an IP address "private/internal"? ---
function isPrivateIP(ip) {
  // unwrap IPv4-mapped IPv6 like "::ffff:127.0.0.1" -> "127.0.0.1"
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                       // loopback
    if (a === 169 && b === 254) return true;          // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
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

  // Resolve against the sandbox root (this collapses ../.. etc.)
  const candidate = path.resolve(SANDBOX_ROOT, reqPath.replace(/^\/+/, ''));

  let real;
  try {
    // Resolve symlinks too, so a symlink can't escape the sandbox
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'path does not exist' };
  }

  // The check that matters: is the final real path inside the root?
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

// normalize a hostname: lowercase + strip a single trailing dot ("example.com." -> "example.com")
function normalizeHost(hostname) {
  let h = hostname.toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

// Resolve a hostname, verify every returned address is public, and return
// the specific safe IP to connect to. Throws/returns null on any problem.
async function resolveAndValidate(hostname) {
  let addrs;
  try { addrs = await dns.lookup(hostname, { all: true }); }
  catch { return null; }
  if (!addrs.length) return null;
  if (addrs.some(a => isPrivateIP(a.address))) return null;
  return addrs[0]; // { address, family }
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

  let hostname = normalizeHost(u.hostname);
  if (!ALLOWED_HOSTS.has(hostname)) {
    return { ok: false, reason: 'host not allowlisted' };
  }

  let safeAddr = await resolveAndValidate(hostname);
  if (!safeAddr) return { ok: false, reason: 'resolves to private ip' };

  let currentUrl = u.toString();

  for (let i = 0; i < 5; i++) {
    // Pin the actual TCP connection to the exact IP we just validated,
    // so there is no gap between "we checked this IP" and "we used this IP"
    // (prevents DNS-rebinding attacks).
    const pinnedAgent = new Agent({
      connect: {
        lookup: (_hostname, _opts, cb) => {
          cb(null, [{ address: safeAddr.address, family: safeAddr.family }]);
        }
      }
    });

    let resp;
    try {
      resp = await undiciFetch(currentUrl, { redirect: 'manual', dispatcher: pinnedAgent });
    } catch {
      return { ok: false, reason: 'fetch failed' };
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return { ok: false, reason: 'redirect missing location' };

      let next;
      try { next = new URL(loc, currentUrl); }
      catch { return { ok: false, reason: 'invalid redirect location' }; }

      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { ok: false, reason: 'redirect bad protocol' };
      }
      if (next.username || next.password) {
        return { ok: false, reason: 'redirect userinfo' };
      }

      const nextHost = normalizeHost(next.hostname);
      if (!ALLOWED_HOSTS.has(nextHost)) {
        return { ok: false, reason: 'redirect host not allowlisted' };
      }

      const nextSafeAddr = await resolveAndValidate(nextHost);
      if (!nextSafeAddr) return { ok: false, reason: 'redirect resolves private' };

      hostname = nextHost;
      safeAddr = nextSafeAddr;
      currentUrl = next.toString();
      continue;
    }

    let text;
    try { text = await resp.text(); } catch { text = ''; }
    return { ok: true, content: text };
  }

  return { ok: false, reason: 'too many redirects' };
}

app.post('/', async (req, res) => {
  const { tool, arguments: args } = req.body || {};
  const logPrefix = `[${new Date().toISOString()}] tool=${tool} args=${JSON.stringify(args)}`;
  try {
    if (tool === 'read_file') {
      const r = safeReadFile(args && args.path);
      const out = r.ok
        ? { action: 'allow', reason: 'inside sandbox', result: r.content }
        : { action: 'block', reason: r.reason };
      console.log(`${logPrefix} -> ${out.action} (${out.reason})`);
      return res.json(out);
    }
    if (tool === 'fetch_url') {
      const r = await safeFetch(args && args.url);
      const out = r.ok
        ? { action: 'allow', reason: 'host allowlisted', result: r.content }
        : { action: 'block', reason: r.reason };
      console.log(`${logPrefix} -> ${out.action} (${out.reason})`);
      return res.json(out);
    }
    console.log(`${logPrefix} -> block (unknown tool)`);
    return res.json({ action: 'block', reason: 'unknown tool' });
  } catch (err) {
    console.log(`${logPrefix} -> block (internal error: ${err.message})`);
    return res.json({ action: 'block', reason: 'internal error' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'guardrail endpoint is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('listening on', PORT));
