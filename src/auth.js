// src/auth.js — login gate for /configure + admin control APIs.
// Zero runtime deps. Session = stateless HMAC-signed cookie. PIN is the
// ADMIN_PIN worker secret, compared constant-time. Brute-force defended
// by a KV fixed-window counter (per-IP + global lockout).

const COOKIE_NAME = "mylist_session";

const SESSION_TTL_DEFAULT_MS = 12 * 60 * 60 * 1000;       // 12h
const SESSION_TTL_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // 30d
const AUTH_VERSION = "v1";

// Admin control-plane routes that MUST require a valid session.
// Catalog + manifest + status + root + export-config + runs stay public
// so the GitHub Actions workflows (no browser cookie) keep working.
const ADMIN_PREFIXES = [
  "/configure",            // the page itself (pathname === "/configure")
  "/save-config",
  "/trigger-refresh",
  "/tmdb/",
  "/mdblist/",
];

// ── base64url helpers (work in both Workers & Node via TextEncoder/atob) ──
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeStr(s) {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded + "===".slice((padded.length + 3) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return null; }
}
function b64urlDecode(s) {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded + "===".slice((padded.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
}

// ── HMAC helpers (WebCrypto; verify() is spec-guaranteed constant-time) ────
async function hmacKey(env, purpose) {
  const secret = env.SESSION_SECRET || env.ADMIN_PIN || "change-me";
  const material = `${AUTH_VERSION}:${purpose}:${secret}`;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
async function sign(env, payload) {
  const key = await hmacKey(env, "session");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig));
}
async function verifyMac(env, payload, sigB64) {
  const key = await hmacKey(env, "session");
  const sig = b64urlDecode(sigB64);
  if (!sig) return false;
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  // crypto.subtle.verify() is constant-time; guard length first so a
  // mismatched-length MAC short-circuits without a length oracle.
  if (sig.byteLength !== expected.byteLength) return false;
  return await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
}

// ── constant-time PIN check ───────────────────────────────────────────────
// Compare the submitted PIN against env.ADMIN_PIN without a timing side
// channel that could leak the value one byte at a time. Uses an
// equal-length XOR accumulator so every byte is always compared.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function pinMatches(env, submitted) {
  const expected = String(env.ADMIN_PIN || "");
  // Burn comparable work on length mismatch so length isn't trivially leaked.
  if (submitted.length !== expected.length) {
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(submitted));
    return false;
  }
  return constantTimeEqual(submitted, expected);
}

// ── PIN fingerprint (revoke-by-rotate) ────────────────────────────────────
// Changing ADMIN_PIN invalidates ALL existing session cookies.
async function fingerprint(env, value) {
  const key = await hmacKey(env, "pinfp");
  const d = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return b64url(new Uint8Array(d)).slice(0, 16);
}

// ── session cookie ─────────────────────────────────────────────────────────
// Format: b64url( version|exp|pinfp|nonce ) . b64url(hmac)
export async function issueSession(env, remember) {
  const now = Date.now();
  const exp = now + (remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_DEFAULT_MS);
  const pinfp = await fingerprint(env, env.ADMIN_PIN || "");
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = [AUTH_VERSION, String(exp), pinfp, nonce].join("|");
  const mac = await sign(env, payload);
  const value = `${b64url(new TextEncoder().encode(payload))}.${mac}`;
  return { value, exp, maxAge: remember ? SESSION_TTL_REMEMBER_MS / 1000 : undefined };
}

function readCookie(request, name) {
  const h = request.headers.get("Cookie");
  if (!h) return null;
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function checkSession(env, request) {
  const cookie = readCookie(request, COOKIE_NAME);
  if (!cookie) return { ok: false };
  const dot = cookie.indexOf(".");
  if (dot <= 0) return { ok: false };
  const [b64Payload, mac] = [cookie.slice(0, dot), cookie.slice(dot + 1)];
  const payload = b64urlDecodeStr(b64Payload);
  if (!payload) return { ok: false };
  if (!(await verifyMac(env, payload, mac))) return { ok: false }; // forged/tampered
  const [version, expStr, pinfp, _nonce] = payload.split("|");
  if (version !== AUTH_VERSION) return { ok: false };
  if (Number(expStr) < Date.now()) return { ok: false };          // expired
  const expectPinfp = await fingerprint(env, env.ADMIN_PIN || "");
  if (pinfp !== expectPinfp) return { ok: false };                // PIN rotated
  return { ok: true, exp: Number(expStr) };
}

// ── route classification ──────────────────────────────────────────────────
// Master switch: AUTH_ENABLED="false" opens /configure + admin APIs without
// a session. Absent/misspelled value = ON (secure default) so a typo can
// never silently leave the admin surface open.
export function isAuthEnabled(env) {
  return String(env.AUTH_ENABLED ?? "true").trim().toLowerCase() !== "false";
}
export function isPublic(pathname) {
  if (pathname === "/" || pathname === "") return true;
  if (pathname === "/manifest.json") return true;
  if (pathname === "/status") return true;            // read-only, linked from page
  if (/^\/catalog\//.test(pathname)) return true;     // Stremio catalogs
  // Export-config + runs must stay open for the GitHub Actions workflows
  // (they call /export-config and POST /runs with no browser cookie).
  if (pathname === "/export-config") return true;
  if (pathname === "/runs") return true;
  return false;
}
// F17: isAuthRoute deleted - never imported (index.js matches the
// login/logout routes by hand); an exported function nothing calls.
export function isAdminPath(pathname) {
  return pathname === "/configure" || ADMIN_PREFIXES.some((p) => pathname.startsWith(p));
}

// ── brute-force protection (KV fixed-window) ──────────────────────────────
const WINDOW_S = 5 * 60;          // 5-minute window
const MAX_PER_IP = 10;            // attempts per IP per window
const MAX_GLOBAL = 60;            // attempts per window across all IPs

export async function rateLimitLogin(kv, request) {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";
  const win = Math.floor(Date.now() / 1000 / WINDOW_S);
  const keyIp = `rl:login:${ip}:${win}`;
  const keyGlob = `rl:login:global:${win}`;
  const [ipCount, globCount] = await Promise.all([
    kv.get(keyIp).then((v) => parseInt(v, 10) || 0).catch(() => 0),
    kv.get(keyGlob).then((v) => parseInt(v, 10) || 0).catch(() => 0),
  ]);
  if (ipCount >= MAX_PER_IP || globCount >= MAX_GLOBAL) return { blocked: true };
  await Promise.all([
    kv.put(keyIp, String(ipCount + 1), { expirationTtl: Math.max(60, WINDOW_S) }).catch(() => {}),
    kv.put(keyGlob, String(globCount + 1), { expirationTtl: Math.max(60, WINDOW_S) }).catch(() => {}),
  ]);
  return { blocked: false };
}

// ── login / logout handlers ───────────────────────────────────────────────
function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
  });
}
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleLogin(env, request) {
  const rl = await rateLimitLogin(env.STORE, request);
  if (rl.blocked) {
    return html(loginPageHtml({ error: "Too many attempts. Try again later.", blocked: true }), 429);
  }
  let pin, remember;
  try {
    const body = await request.json().catch(() => null);
    pin = String(body?.pin ?? "").trim();
    remember = !!body?.remember;
  } catch {
    return html(loginPageHtml({ error: "Bad request." }), 400);
  }
  if (!/^\d{4,12}$/.test(pin)) return html(loginPageHtml({ error: "Enter a valid PIN." }), 400);
  const okPin = await pinMatches(env, pin);
  if (!okPin) return html(loginPageHtml({ error: "Incorrect PIN." }), 401);
  const sess = await issueSession(env, remember);
  const setCookie = `${COOKIE_NAME}=${sess.value}; Path=/; HttpOnly; Secure; SameSite=Lax` +
    (sess.maxAge ? `; Max-Age=${sess.maxAge}` : "");
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/configure",
      "Set-Cookie": setCookie,
      "Cache-Control": "no-store",
    },
  });
}

export function handleLogout() {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/configure",
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      "Cache-Control": "no-store",
    },
  });
}

// ── theme-matched, mobile-responsive login page ────────────────────────────
export function loginPageHtml({ error = null, blocked = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#050508">
<meta name="color-scheme" content="dark">
<title>my-list &mdash; Sign in</title>
<style>
  :root {
    color-scheme: dark; accent-color: #06b6d4;
    --bg:#050508; --surface:#0c0c13; --surface2:#13131d; --surface3:#1a1a26;
    --border:#1b1b26; --border2:#262635; --border-icon-hover:#2f2f42;
    --text:#e8edf4; --dim:#a5aebc; --muted:#8a93a8;
    --accent:#06b6d4; --accent-soft:rgba(6,182,212,.06); --accent-dim:rgba(6,182,212,.10);
    --danger:#ff5f66; --danger-bg:rgba(255,95,102,.10); --danger-border:rgba(255,95,102,.30);
    --r:9px; --r-sm:8px; --r2:14px;
    --font:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;min-height:100vh;line-height:1.5}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  input{font:inherit}
  body{
    display:flex;align-items:center;justify-content:center;
    padding:24px;min-height:100dvh;
    padding-top:max(24px, env(safe-area-inset-top,0px));
    padding-bottom:max(24px, env(safe-area-inset-bottom,0px));
  }
  .login-card{
    width:100%;max-width:320px;
    background:var(--surface3);border:1px solid var(--border);border-radius:var(--r2);
    padding:24px 22px;box-shadow:0 24px 56px -16px rgba(0,0,0,.85);
    animation:card-in .18s cubic-bezier(.22,1,.36,1);
  }
  @keyframes card-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
  .lock{width:28px;height:28px;border-radius:var(--r);background:var(--accent-soft);
    border:1px solid rgba(6,182,212,.35);display:flex;align-items:center;justify-content:center;
    margin-bottom:14px;color:var(--accent)}
  .lock svg{width:14px;height:14px}
  h1{font-size:15px;font-weight:600;margin-bottom:3px;letter-spacing:.01em}
  p.sub{color:var(--dim);font-size:12px;margin-bottom:18px}
  .field{display:flex;flex-direction:column;gap:6px;margin:25px 0}
  .field-label{font-size:11px;font-weight:500;color:var(--muted);letter-spacing:.02em}
  /* Compact PIN input matching the app's small text inputs */
  input[type="password"]{
    background:var(--surface);color:var(--text);
    border:1px solid var(--border2);border-radius:var(--r-sm);
    padding:8px 10px;font-size:14px;letter-spacing:.18em;text-align:center;
    font-variant-numeric:tabular-nums;outline:none;transition:border-color .12s;
  }
  input[type="password"]::placeholder{color:var(--muted);opacity:.6;letter-spacing:.08em;font-size:12px}
  input[type="password"]:hover{border-color:var(--border2)}
  input[type="password"]:focus{border-color:var(--accent)}
  /* filter-check checkbox (same as simkl page): click area is the box only */
  .remember-row{display:flex;align-items:center;gap:7px;margin-bottom:14px;font-size:12px;color:var(--dim);user-select:none}
  .filter-check{
    appearance:none !important;-webkit-appearance:none !important;accent-color:transparent;
    -webkit-tap-highlight-color:transparent;width:14px;height:14px;padding:0;margin:0;
    border-radius:3px;border:1px solid var(--border2);background-color:var(--surface2);
    display:grid;place-content:center;cursor:pointer;flex-shrink:0;
    transition:border-color .12s ease,background-color .12s ease;
  }
  .filter-check:checked{background-color:var(--text);border-color:var(--text)}
  .filter-check::before{content:'';width:8px;height:8px;
    clip-path:polygon(14% 44%,0% 65%,50% 100%,100% 16%,80% 0%,43% 62%);
    background-color:var(--bg);transform:scale(0);transform-origin:bottom left;
    transition:transform 120ms ease-in-out}
  .filter-check:checked::before{transform:scale(1)}
  .filter-check:focus-visible{outline:2px solid var(--muted);outline-offset:2px}
  /* Hover/active refines only fire on real mouse devices - touch keeps the
     plain checked/unchecked state (sticky :hover on mobile would otherwise
     dim a freshly-checked box). */
  @media (hover: hover) {
    .filter-check:hover{border-color:var(--muted);background-color:var(--surface2)}
    .filter-check:active{background-color:var(--surface3);border-color:var(--border-icon-hover)}
    .filter-check:checked:hover{background-color:var(--dim);border-color:var(--dim)}
    .filter-check:checked:active{background-color:var(--muted);border-color:var(--muted)}
  }
  .remember-text{font-size:12px;color:var(--dim)}
  /* Compact sign-in button matching the app's small solid-accent button */
  button[type="submit"]{
    width:100%;padding:8px 14px;border-radius:var(--r);border:1px solid var(--accent);
    background:var(--accent);color:#040507;font-size:13px;font-weight:600;cursor:pointer;
    transition:filter .15s,transform .1s;
  }
  button[type="submit"]:hover{filter:brightness(1.1)}
  button[type="submit"]:active{transform:translateY(1px)}
  .err{margin-bottom:12px;font-size:12px;color:var(--danger);background:var(--danger-bg);
    border:1px solid var(--danger-border);border-radius:var(--r-sm);padding:8px 10px}
  .foot{margin-top:14px;font-size:11px;color:var(--muted);text-align:center;line-height:1.6}
  @media (max-width:640px){
    body{padding:16px}
    .login-card{padding:20px 18px;max-width:none}
  }
  @media (max-width:380px){.login-card{padding:18px 14px}}
</style>
</head>
<body>
  <main class="login-card">
    <div class="lock" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </div>
    <h1>my-list</h1>
    <p class="sub">Sign in to manage your catalogs.</p>
    ${error ? '<div class="err" role="alert">' + error + '</div>' : ''}
    <form id="loginForm" autocomplete="off" novalidate>
      <div class="field">
        <label class="field-label" for="pin">PIN</label>
        <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*"
               autocomplete="off" maxlength="12" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;" required autofocus>
      </div>
      <div class="remember-row">
        <input type="checkbox" class="filter-check" id="remember" name="remember">
        <span class="remember-text">Remember me for 30 days</span>
      </div>
      <button type="submit">Sign in</button>
    </form>
    <div class="foot">Catalog &amp; control surface are protected.<br>You'll be returned to /configure.</div>
  </main>
  <script>
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = document.getElementById('pin').value.trim();
      const remember = document.getElementById('remember').checked;
      if (!/^\\d{4,12}$/.test(pin)) { show('Enter a valid PIN.'); return; }
      try {
        const res = await fetch('/configure/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin, remember }),
        });
        if (res.status === 303 || res.ok) { window.location.href = '/configure'; return; }
        let msg = 'Incorrect PIN.';
        try { const t = await res.json(); if (t && t.error) msg = t.error; } catch {}
        show(msg);
      } catch (err) { show('Sign-in failed.'); }
    });
    function show(msg) {
      let el = document.querySelector('.err');
      if (!el) { el = document.createElement('div'); el.className='err'; el.setAttribute('role','alert'); form.parentNode.insertBefore(el, form); }
      el.textContent = msg;
    }
  </script>
</body>
</html>`;
}

export { COOKIE_NAME };
