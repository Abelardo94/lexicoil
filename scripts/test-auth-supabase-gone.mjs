#!/usr/bin/env node
/**
 * Supabase project hostname gone (paused/deleted → NXDOMAIN), as on 11 nov 2026:
 *   - auth-config must stop telling the browser to use the Supabase SDK, so sign-up
 *     and password reset fall back to auth-register / auth-forgot (Blobs only);
 *   - a mere timeout must NOT disable it (cold starts and blips);
 *   - auth-forgot / auth-resend-confirm / level-notify are capped (they send mail
 *     or grow a blob for anyone who asks).
 *
 * Offline: in-memory store + stubbed fetch and mailer. Run: node scripts/test-auth-supabase-gone.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const mem = new Map();
const store = {
  async get(key) { return mem.has(key) ? JSON.parse(mem.get(key)) : null; },
  async setJSON(key, value) { mem.set(key, JSON.stringify(value)); },
  async delete(key) { mem.delete(key); },
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../netlify/functions/lib/blobStore.js', { getStoreForEvent: () => store, STORE_NAME: 'lexicoil-data' });
const sent = [];
stub('../netlify/functions/lib/email.js', {
  sendPasswordResetEmail: async (to, url) => { sent.push(['reset', to, url]); },
  sendSignupConfirmationEmail: async (to) => { sent.push(['verify', to]); },
  sendProWelcomeEmail: async () => {},
  sendPaymentFailedEmail: async () => {},
});

process.env.AUTH_JWT_SECRET = 'test-secret-for-auth-config-only-0123456789';
process.env.SUPABASE_ANON_KEY = 'anon-key';

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const ev = (body, ip = '203.0.113.9', method = 'POST') => ({
  httpMethod: method,
  headers: { 'content-type': 'application/json', origin: 'https://lexicoil.com', 'x-forwarded-for': ip },
  body: body ? JSON.stringify(body) : undefined,
});
const call = async (handler, event) => {
  const res = await handler(event);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};

// ── auth-config ──────────────────────────────────────────────────────────────
const { handler: authConfig } = require('../netlify/functions/auth-config.js');
const realFetch = globalThis.fetch;
const configWith = async (url, fetchImpl) => {
  process.env.SUPABASE_URL = url; // distinct URL per case: the probe caches per URL for 60 s
  globalThis.fetch = fetchImpl;
  try { return (await call(authConfig, ev(null, '203.0.113.9', 'GET'))).body; } finally { globalThis.fetch = realFetch; }
};

const dnsErr = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; return e; };
const gone = await configWith('https://gone.supabase.co', async () => { throw dnsErr(); });
check('hostname does not resolve → supabase:false', gone.supabase === false && gone.supabaseUrl === '', JSON.stringify({ s: gone.supabase, r: gone.supabaseReachable }));

const slow = await configWith('https://slow.supabase.co', async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; });
check('timeout (blip) → supabase stays true', slow.supabase === true && slow.supabaseReachable === false);

const up = await configWith('https://up.supabase.co', async () => ({ ok: true }));
check('healthy → supabase:true, reachable:true', up.supabase === true && up.supabaseReachable === true);

// ── auth-forgot ──────────────────────────────────────────────────────────────
const { handler: forgot } = require('../netlify/functions/auth-forgot.js');
mem.set('user:a@example.com', JSON.stringify({ name: 'A', email: 'a@example.com', supabaseId: 'uuid-1' }));
mem.set('user:b@example.com', JSON.stringify({ name: 'B', email: 'b@example.com', passwordHash: 'x' }));

const f1 = await call(forgot, ev({ email: 'a@example.com' }));
const f2 = await call(forgot, ev({ email: 'a@example.com' }, '198.51.100.1'));
const resets = sent.filter((s) => s[0] === 'reset' && s[1] === 'a@example.com').length;
check('forgot: Supabase-only account gets a local reset link', f1.status === 200 && resets >= 1);
check('forgot: the link opens the app, not the landing (/ is the landing in production)', /^https:\/\/lexicoil\.com\/app\.html\?reset=[0-9a-f]{48}$/.test(sent.find((s) => s[0] === 'reset')?.[2] || ''), sent.find((s) => s[0] === 'reset')?.[2]);
check('forgot: second request for the same address inside the cooldown sends nothing', f2.status === 200 && resets === 1, `${resets} mails`);

let last = null;
for (let i = 0; i < 6; i++) last = await call(forgot, ev({ email: `nobody${i}@example.com` }, '198.51.100.7'));
check('forgot: 6th request from one IP in an hour → 429', last.status === 429, String(last.status));
const other = await call(forgot, ev({ email: 'b@example.com' }, '198.51.100.8'));
check('forgot: another IP is not affected', other.status === 200 && sent.some((s) => s[1] === 'b@example.com'));

// ── auth-resend-confirm ──────────────────────────────────────────────────────
const { handler: resend } = require('../netlify/functions/auth-resend-confirm.js');
mem.set('user:c@example.com', JSON.stringify({ name: 'C', email: 'c@example.com', emailVerified: false }));
await call(resend, ev({ email: 'c@example.com' }, '198.51.100.20'));
await call(resend, ev({ email: 'c@example.com' }, '198.51.100.21'));
const verifies = sent.filter((s) => s[0] === 'verify').length;
check('resend-confirm: one mail per address inside the cooldown', verifies === 1, `${verifies} mails`);
for (let i = 0; i < 6; i++) last = await call(resend, ev({ email: `x${i}@example.com` }, '198.51.100.22'));
check('resend-confirm: 6th request from one IP → 429', last.status === 429, String(last.status));

// ── return URLs ──────────────────────────────────────────────────────────────
const { appEntryUrl } = require('../netlify/functions/lib/siteConfig.js');
check('appEntryUrl: production → /app.html', appEntryUrl('https://lexicoil.com/') === 'https://lexicoil.com/app.html');
check('appEntryUrl: local dev → /', appEntryUrl('http://localhost:8888') === 'http://localhost:8888/');
const { handler: verify } = require('../netlify/functions/auth-verify-email.js');
mem.set('verify:tok1', JSON.stringify({ email: 'c@example.com', exp: Date.now() + 60000 }));
const vr = await verify({ httpMethod: 'GET', headers: {}, queryStringParameters: { token: 'tok1' } });
check('verify-email: redirects into the app', vr.statusCode === 302 && vr.headers.Location === 'https://lexicoil.com/app.html?emailVerified=1', vr.headers?.Location);

// ── level-notify ─────────────────────────────────────────────────────────────
const { handler: notify } = require('../netlify/functions/level-notify.js');
for (let i = 0; i < 11; i++) last = await call(notify, ev({ email: `w${i}@example.com`, lang: 'en', level: 'B2' }, '198.51.100.30'));
const list = JSON.parse(mem.get('level_waitlist:en_B2'));
check('level-notify: 11th sign-up from one IP in a day → 429, list holds 10', last.status === 429 && list.length === 10, `${last.status}, ${list.length}`);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
