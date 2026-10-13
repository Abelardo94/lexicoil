#!/usr/bin/env node
/**
 * Stripe payment flows end to end against a mock Blobs store and a mock Stripe API:
 * activation keeps paid credits, Pro Max survives stripe-confirm, an old session cannot
 * re-activate a cancelled subscription, refunds of packs keep the plan, a pack is credited
 * once across payment_intent/charge events, and the nightly reconcile reads the real store.
 *
 * Run: node scripts/test-stripe-payments.mjs
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const FN = (p) => path.join(ROOT, 'netlify/functions', p);

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'STRIPE_TAX_ENABLED']) delete process.env[k];
process.env.AUTH_JWT_SECRET = 'test-secret-for-stripe-payments-0123456789';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';

// ── mock Blobs store with etags (onlyIfNew / onlyIfMatch, as casWriteJson uses them) ──
const data = new Map();
const etags = new Map();
let etagN = 0;
const store = {
  async get(key, opts) {
    const v = data.get(key);
    if (v == null) return null;
    return opts?.type === 'json' ? JSON.parse(v) : v;
  },
  async getWithMetadata(key, opts) {
    if (!data.has(key)) return null;
    return { data: await store.get(key, opts), etag: etags.get(key), metadata: {} };
  },
  async setJSON(key, val, opts = {}) {
    if (opts.onlyIfNew && data.has(key)) return { modified: false };
    if (opts.onlyIfMatch && etags.get(key) !== opts.onlyIfMatch) return { modified: false };
    data.set(key, JSON.stringify(val));
    etags.set(key, `e${++etagN}`);
    return { modified: true };
  },
  async delete(key) {
    data.delete(key);
  },
};
const json = (k) => (data.has(k) ? JSON.parse(data.get(k)) : null);
const put = (k, v) => { data.set(k, JSON.stringify(v)); etags.set(k, `e${++etagN}`); };

require.cache[FN('lib/blobStore.js')] = {
  id: FN('lib/blobStore.js'),
  filename: FN('lib/blobStore.js'),
  loaded: true,
  exports: { getStoreForEvent: () => store, STORE_NAME: 'lexicoil-data' },
};

const emailMod = require(FN('lib/email.js'));
let welcomeEmails = 0;
emailMod.sendProWelcomeEmail = async () => { welcomeEmails++; };
emailMod.sendPaymentFailedEmail = async () => {};

// ── mock Stripe API ──
const sessions = new Map();
let subscriptionsList = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  let body;
  const m = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
  if (m && sessions.has(m[1])) body = sessions.get(m[1]);
  else if (u.pathname === '/v1/subscriptions') body = { data: subscriptionsList, has_more: false };
  else return { ok: false, status: 404, json: async () => ({ error: { message: `mock: ${u.pathname}` } }) };
  return { ok: true, status: 200, json: async () => body };
};

const { userKey, signAuthToken } = require(FN('lib/authLib.js'));
const { activateProForEmail, activateProMaxForEmail } = require(FN('lib/proUpgrade.js'));
const confirm = require(FN('stripe-confirm.js'));
const webhook = require(FN('stripe-webhook.js'));
const reconcile = require(FN('stripe-reconcile.js'));

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('OK  ', msg); } else { failed++; console.error('FAIL', msg); }
}

function addUser(email, extra = {}) {
  put(userKey(email), { email, name: 'T', plan: 'free', pro: false, createdAt: 1, ...extra });
}
function authHeaders(email) {
  const { token } = signAuthToken(email, 'T', 1);
  return { authorization: `Bearer ${token}`, origin: 'https://lexicoil.com' };
}
async function callConfirm(email, sessionId) {
  return confirm.handler({ httpMethod: 'POST', headers: authHeaders(email), body: JSON.stringify({ session_id: sessionId }) });
}
let evN = 0;
async function sendEvent(type, object) {
  const body = JSON.stringify({ id: `evt_${++evN}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return webhook.handler({ httpMethod: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body });
}

// 1. Activation keeps paid credits and is idempotent
{
  const e = 'credits@test.com';
  addUser(e);
  put(`quota:${e}`, { month: '2026-10', used: 3, aiUsed: 9, creditTopups: 40, rollover: 7, autoRecharge: { enabled: true, pack: 40 } });
  welcomeEmails = 0;
  await activateProForEmail(store, e, { sendEmail: true });
  let q = json(`quota:${e}`);
  ok(q.creditTopups === 40, `1a pack credits survive activation (${q.creditTopups})`);
  ok(q.rollover === 7 && q.autoRecharge?.enabled === true, '1b rollover and auto-recharge survive');
  ok(q.used === 0 && q.aiUsed === 0, '1c a real upgrade still resets the month counters');
  put(`quota:${e}`, { ...q, used: 5, aiUsed: 12 });
  await activateProForEmail(store, e, { sendEmail: true });
  q = json(`quota:${e}`);
  ok(q.used === 5 && q.aiUsed === 12, '1d re-activating the same plan does not reset usage');
  ok(welcomeEmails === 1, `1e welcome email sent once (${welcomeEmails})`);
}

// 2. Pro Max survives the late stripe-confirm
{
  const e = 'max@test.com';
  addUser(e);
  sessions.set('cs_max', {
    id: 'cs_max', mode: 'subscription', status: 'complete', payment_status: 'paid',
    customer: 'cus_max', metadata: { email: e, plan: 'pro_max' },
    subscription: { id: 'sub_max', status: 'active' },
  });
  await sendEvent('checkout.session.completed', sessions.get('cs_max'));
  ok(json(userKey(e)).plan === 'pro_max', '2a webhook sets pro_max');
  const r = await callConfirm(e, 'cs_max');
  ok(r.statusCode === 200, `2b confirm answers 200 (${r.statusCode})`);
  ok(json(userKey(e)).plan === 'pro_max', '2c confirm after webhook keeps pro_max');

  const e2 = 'max2@test.com';
  addUser(e2);
  sessions.set('cs_max2', { ...sessions.get('cs_max'), id: 'cs_max2', metadata: { email: e2, plan: 'pro_max' } });
  await callConfirm(e2, 'cs_max2');
  ok(json(userKey(e2)).plan === 'pro_max', '2d confirm before webhook activates pro_max');
  await activateProForEmail(store, e2, {});
  ok(json(userKey(e2)).plan === 'pro_max', '2e a later pro activation never downgrades pro_max');
}

// 3. An old session cannot re-activate a cancelled subscription
{
  const e = 'replay@test.com';
  addUser(e);
  sessions.set('cs_old', {
    id: 'cs_old', mode: 'subscription', status: 'complete', payment_status: 'paid',
    customer: 'cus_old', metadata: { email: e, plan: 'pro' },
    subscription: { id: 'sub_old', status: 'canceled' },
  });
  const r = await callConfirm(e, 'cs_old');
  ok(r.statusCode === 402, `3a replay of a cancelled subscription refused (${r.statusCode})`);
  ok(json(userKey(e)).plan === 'free', '3b user stays free');
}

// 4. Refunding a credit pack keeps the plan
{
  const e = 'refund@test.com';
  addUser(e, { plan: 'pro', pro: true, billingSource: 'stripe' });
  await sendEvent('charge.refunded', { id: 'ch_r', metadata: { kind: 'credit_pack', email: e, credits: '40' } });
  ok(json(userKey(e)).plan === 'pro', '4a credit-pack refund keeps Pro');
  await sendEvent('charge.refunded', { id: 'ch_s', metadata: { email: e } });
  ok(json(userKey(e)).plan === 'free', '4b a non-pack refund still revokes');
}

// 5. A pack is credited once across payment_intent.succeeded + charge.succeeded
{
  const e = 'twice@test.com';
  addUser(e, { plan: 'pro', pro: true });
  const meta = { kind: 'credit_pack', email: e, credits: '40' };
  await sendEvent('payment_intent.succeeded', { id: 'pi_1', metadata: meta });
  await sendEvent('charge.succeeded', { id: 'ch_1', payment_intent: 'pi_1', metadata: meta });
  ok(json(`quota:${e}`)?.creditTopups === 40, `5a credited once (${json(`quota:${e}`)?.creditTopups})`);
}

// 6. Nightly reconcile
{
  const P = 'rc-paying@test.com';   // paying in Stripe, free here (webhook lost)
  const M = 'rc-max@test.com';      // pro_max here, sub says pro_max
  const C = 'rc-cancel@test.com';   // cancelled in Stripe, still pro here
  const H = 'rc-manual@test.com';   // pro given by hand, has an old cancelled sub
  const T = 'rc-two@test.com';      // one cancelled sub + one active
  addUser(P);
  addUser(M, { plan: 'pro_max', pro: true, billingSource: 'stripe' });
  addUser(C, { plan: 'pro', pro: true, billingSource: 'stripe', stripeCustomerId: 'cus_c' });
  addUser(H, { plan: 'pro', pro: true, billingSource: 'manual' });
  addUser(T, { plan: 'pro', pro: true, billingSource: 'stripe' });
  put(`quota:${P}`, { month: '2026-10', creditTopups: 15 });
  const sub = (email, status, plan = 'pro') => ({ id: `sub_${email}_${status}`, status, customer: { id: `cus_${email}`, email }, metadata: { email, plan } });
  subscriptionsList = [
    sub(P, 'active'), sub(M, 'active', 'pro_max'), sub(C, 'canceled'),
    sub(H, 'canceled'), sub(T, 'canceled'), sub(T, 'active'),
  ];
  const res = await reconcile.handler({});
  const body = JSON.parse(res.body);
  ok(res.statusCode === 200, `6a reconcile runs (${res.statusCode})`);
  ok(json(userKey(P)).plan === 'pro' && json(`quota:${P}`).creditTopups === 15, '6b lost webhook: activated, credits kept');
  ok(json(userKey(M)).plan === 'pro_max', '6c pro_max not downgraded');
  ok(json(userKey(C)).plan === 'free', '6d cancelled subscription revoked');
  ok(json(userKey(H)).plan === 'pro', '6e manual Pro untouched');
  ok(json(userKey(T)).plan === 'pro', '6f a cancelled + an active sub keeps Pro');
  ok(body.stats?.activated === 1 && body.stats?.revoked === 1, `6g stats ${JSON.stringify(body.stats)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
