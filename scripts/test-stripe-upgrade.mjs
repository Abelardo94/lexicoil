#!/usr/bin/env node
/**
 * Pro -> Pro Max without paying twice, against a mock Stripe that keeps subscription state.
 *
 * Before: stripe-checkout always opened a brand-new subscription, so a Pro user who
 * upgraded was billed for Pro AND Pro Max every month; cancelling either one fired
 * customer.subscription.deleted, which revoked the whole plan.
 *
 * Run: node scripts/test-stripe-upgrade.mjs
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const FN = (p) => path.join(ROOT, 'netlify/functions', p);

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'STRIPE_TAX_ENABLED', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_PRO_MAX', 'STRIPE_PRICE_ID']) delete process.env[k];
process.env.AUTH_JWT_SECRET = 'test-secret-for-stripe-upgrade-0123456789';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';

// ── mock Blobs store with etags ──
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
  async delete(key) { data.delete(key); },
};
const json = (k) => (data.has(k) ? JSON.parse(data.get(k)) : null);
const put = (k, v) => { data.set(k, JSON.stringify(v)); etags.set(k, `e${++etagN}`); };
require.cache[FN('lib/blobStore.js')] = {
  id: FN('lib/blobStore.js'), filename: FN('lib/blobStore.js'), loaded: true,
  exports: { getStoreForEvent: () => store, STORE_NAME: 'lexicoil-data' },
};
const emailMod = require(FN('lib/email.js'));
emailMod.sendProWelcomeEmail = async () => {};
emailMod.sendPaymentFailedEmail = async () => {};

// ── mock Stripe: subscriptions and checkout sessions with state ──
const subs = new Map(); // id -> subscription object
const sessions = new Map();
const log = []; // every request, in order
let stripeDown = false;
let sessionN = 0;
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = (init.method || 'GET').toUpperCase();
  const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
  log.push({ method, path: u.pathname, form: Object.fromEntries(form), query: Object.fromEntries(u.searchParams) });
  if (stripeDown) throw new TypeError('fetch failed');

  if (u.pathname === '/v1/subscriptions/search') {
    const m = /metadata\['email'\]:'([^']+)'/.exec(u.searchParams.get('query') || '');
    return reply(200, { data: [...subs.values()].filter((s) => s.metadata?.email === m?.[1]), has_more: false });
  }
  if (u.pathname === '/v1/subscriptions' && method === 'GET') {
    const cus = u.searchParams.get('customer');
    return reply(200, { data: [...subs.values()].filter((s) => !cus || s.customer === cus), has_more: false });
  }
  const sm = /^\/v1\/subscriptions\/([^/]+)$/.exec(u.pathname);
  if (sm) {
    const sub = subs.get(decodeURIComponent(sm[1]));
    if (!sub) return reply(404, { error: { message: 'No such subscription' } });
    if (method === 'POST') {
      for (const [k, v] of form) {
        const mm = /^metadata\[(.+)\]$/.exec(k);
        if (mm) sub.metadata[mm[1]] = v;
      }
    }
    if (method === 'DELETE') {
      if (sub.status === 'canceled') return reply(400, { error: { message: 'already canceled' } });
      sub.status = 'canceled';
    }
    return reply(200, sub);
  }
  if (u.pathname === '/v1/checkout/sessions' && method === 'POST') {
    const id = `cs_test_${++sessionN}`;
    sessions.set(id, { id, form: Object.fromEntries(form) });
    return reply(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const cm = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(u.pathname);
  if (cm && sessions.has(cm[1])) return reply(200, sessions.get(cm[1]));
  return reply(404, { error: { message: `mock: ${method} ${u.pathname}` } });
};

const { userKey, signAuthToken } = require(FN('lib/authLib.js'));
const checkout = require(FN('stripe-checkout.js'));
const confirm = require(FN('stripe-confirm.js'));
const webhook = require(FN('stripe-webhook.js'));

let passed = 0;
let failed = 0;
const ok = (cond, msg) => {
  if (cond) { passed++; console.log('OK  ', msg); } else { failed++; console.error('FAIL', msg); }
};
const addUser = (email, extra = {}) => put(userKey(email), { email, name: 'T', plan: 'free', pro: false, createdAt: 1, ...extra });
const addSub = (id, email, plan, customer, status = 'active') =>
  subs.set(id, { id, status, customer, metadata: { email, plan } });
const headers = (email) => ({ authorization: `Bearer ${signAuthToken(email, 'T', 1).token}`, origin: 'https://lexicoil.com' });
const callCheckout = async (email, plan) => {
  const res = await checkout.handler({ httpMethod: 'POST', headers: headers(email), body: JSON.stringify(plan ? { plan } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};
const lastSessionForm = () => [...sessions.values()].pop()?.form || {};
let evN = 0;
const sendEvent = async (type, object) => {
  const body = JSON.stringify({ id: `evt_up_${++evN}`, type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return webhook.handler({ httpMethod: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body });
};
const plan = (email) => { const u = json(userKey(email)); return u?.pro ? u.plan : 'free'; };
const deletesOf = (id) => log.filter((r) => r.method === 'DELETE' && r.path === `/v1/subscriptions/${id}`);

// 1. First purchase is untouched
{
  const e = 'new@test.com';
  addUser(e);
  const r = await callCheckout(e);
  const f = lastSessionForm();
  ok(r.status === 200 && /checkout\.stripe\.com/.test(r.body.url || ''), `1a a free user gets a checkout (${r.status})`);
  ok(f.customer_email === e && !f.customer && !f['metadata[replaces]'], '1b new customer, nothing to replace');
}

// 2. Buying the plan you already pay for is refused
{
  const e = 'pro@test.com';
  addUser(e, { plan: 'pro', pro: true, stripeCustomerId: 'cus_pro' });
  addSub('sub_proA0001', e, 'pro', 'cus_pro');
  const before = sessions.size;
  const r = await callCheckout(e, 'pro');
  ok(r.status === 409 && r.body.error === 'already_subscribed', `2a Pro buying Pro again -> 409 (${r.status} ${r.body.error || ''})`);
  ok(sessions.size === before, '2b no checkout session was created');
}

// 3. Pro -> Pro Max: one subscription replaces the other
{
  const e = 'pro@test.com';
  const r = await callCheckout(e, 'pro_max');
  const f = lastSessionForm();
  ok(r.status === 200, `3a Pro buying Pro Max gets a checkout (${r.status} ${r.body.error || ''})`);
  ok(f.customer === 'cus_pro' && !f.customer_email, `3b reuses the Stripe customer (${f.customer})`);
  ok(f['metadata[replaces]'] === 'sub_proA0001' && f['subscription_data[metadata][replaces]'] === 'sub_proA0001', '3c the session says which subscription it replaces');

  // Stripe: payment done, new subscription exists
  addSub('sub_maxB0001', e, 'pro_max', 'cus_pro');
  const session = {
    id: 'cs_up_1', mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_pro',
    subscription: 'sub_maxB0001', metadata: { email: e, plan: 'pro_max', replaces: 'sub_proA0001' },
  };
  await sendEvent('checkout.session.completed', session);
  ok(plan(e) === 'pro_max', `3d the account is Pro Max (${plan(e)})`);
  const old = subs.get('sub_proA0001');
  const del = deletesOf('sub_proA0001');
  ok(old.status === 'canceled' && del.length === 1, `3e the old Pro subscription was cancelled once (${old.status}, ${del.length} DELETE)`);
  ok(del[0]?.form.prorate === 'true' && del[0]?.form.invoice_now === 'true', '3f unused Pro time is credited (prorate + invoice_now)');
  ok(old.metadata.replaced_by === 'sub_maxB0001', '3g and stamped replaced_by before the cancel');
  ok(subs.get('sub_maxB0001').status === 'active', '3h the new subscription is untouched');

  // Stripe now reports the old subscription as deleted
  await sendEvent('customer.subscription.deleted', { ...old });
  ok(plan(e) === 'pro_max', `3i its "deleted" event does not revoke the plan (${plan(e)})`);

  // The browser comes back and calls stripe-confirm
  sessions.set('cs_up_1', { ...session, subscription: subs.get('sub_maxB0001') });
  const res = await confirm.handler({ httpMethod: 'POST', headers: headers(e), body: JSON.stringify({ session_id: 'cs_up_1' }) });
  ok(res.statusCode === 200 && plan(e) === 'pro_max', `3j stripe-confirm keeps Pro Max (${res.statusCode})`);
  ok(deletesOf('sub_proA0001').length === 1, '3k and does not cancel anything a second time');

  const again = await callCheckout(e, 'pro');
  ok(again.status === 409 && again.body.plan === 'pro_max', `3l Pro Max asking for Pro -> 409 (${again.status})`);
}

// 4. Accounts that already have two subscriptions (bought before this fix)
{
  const e = 'double@test.com';
  addUser(e, { plan: 'pro_max', pro: true, stripeCustomerId: 'cus_dbl2' });
  addSub('sub_dblA0001', e, 'pro', 'cus_dbl1'); // older checkout created its own customer
  addSub('sub_dblB0001', e, 'pro_max', 'cus_dbl2');
  subs.get('sub_dblB0001').status = 'canceled';
  await sendEvent('customer.subscription.deleted', subs.get('sub_dblB0001'));
  ok(plan(e) === 'pro', `4a Pro Max cancelled, Pro still billed -> account is Pro, not free (${plan(e)})`);
  subs.get('sub_dblA0001').status = 'canceled';
  await sendEvent('customer.subscription.deleted', subs.get('sub_dblA0001'));
  ok(plan(e) === 'free', `4b last subscription cancelled -> free (${plan(e)})`);
}

// 5. A session cannot cancel someone else's subscription
{
  const victim = 'victim@test.com';
  const e = 'mallory@test.com';
  addUser(victim, { plan: 'pro', pro: true, stripeCustomerId: 'cus_vic' });
  addUser(e);
  addSub('sub_vicA0001', victim, 'pro', 'cus_vic');
  addSub('sub_malB0001', e, 'pro_max', 'cus_mal');
  await sendEvent('checkout.session.completed', {
    id: 'cs_mal', mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_mal',
    subscription: 'sub_malB0001', metadata: { email: e, plan: 'pro_max', replaces: 'sub_vicA0001' },
  });
  ok(subs.get('sub_vicA0001').status === 'active' && deletesOf('sub_vicA0001').length === 0, '5a "replaces" only cancels subscriptions of the same account');
}

// 6. Stripe unreachable
{
  const e = 'down@test.com';
  addUser(e, { plan: 'pro', pro: true, stripeCustomerId: 'cus_down' });
  addSub('sub_dwnA0001', e, 'pro', 'cus_down');
  stripeDown = true;
  const r = await callCheckout(e, 'pro').catch((err) => ({ status: 'THROW', body: { error: err.message } }));
  ok(r.status === 502 && r.body.error === 'stripe_error', `6a Stripe down -> clean 502, not "already subscribed" and not a crash (${r.status})`);
  subs.get('sub_dwnA0001').status = 'canceled';
  await sendEvent('customer.subscription.deleted', subs.get('sub_dwnA0001'));
  ok(plan(e) === 'free', `6b with Stripe down a deleted subscription still revokes (${plan(e)})`);
  stripeDown = false;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
