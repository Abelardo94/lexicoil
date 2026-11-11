'use strict';

const { userKey } = require('./authLib.js');

async function stripeRequest(path, { method = 'GET', body = null } = {}, secret) {
  const headers = { Authorization: `Bearer ${secret}` };
  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = body instanceof URLSearchParams ? body.toString() : body;
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Stripe error ${res.status}`);
    err.stripeCode = data.error?.code;
    throw err;
  }
  return data;
}

function stripeQueryEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findCustomerByEmail(email, secret) {
  const q = new URLSearchParams();
  q.set('email', email);
  q.set('limit', '1');
  const data = await stripeRequest(`/customers?${q.toString()}`, {}, secret);
  return data.data?.[0]?.id || null;
}

/** Stripe Search API — catches customers the list endpoint misses. */
async function searchCustomerByEmail(email, secret) {
  const esc = stripeQueryEscape(email);
  const q = new URLSearchParams();
  q.set('query', `email:'${esc}'`);
  q.set('limit', '1');
  try {
    const data = await stripeRequest(`/customers/search?${q.toString()}`, {}, secret);
    return data.data?.[0]?.id || null;
  } catch (_) {
    return null;
  }
}

/** Match checkout metadata email on active/trialing subscriptions. */
async function findCustomerIdBySubscriptionEmail(email, secret) {
  const esc = stripeQueryEscape(email);
  const q = new URLSearchParams();
  q.set('query', `metadata['email']:'${esc}'`);
  q.set('limit', '10');
  try {
    const data = await stripeRequest(`/subscriptions/search?${q.toString()}`, {}, secret);
    for (const sub of data.data || []) {
      const cid = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (cid) return cid;
    }
  } catch (_) {
    /* search unavailable or no hits */
  }
  return null;
}

async function persistStripeCustomerId(store, email, customerId) {
  if (!customerId || !store || !email) return;
  const key = userKey(email);
  let user = null;
  try {
    user = await store.get(key, { type: 'json' });
  } catch (_) {
    user = null;
  }
  if (!user || user.stripeCustomerId === customerId) return;
  await store.setJSON(key, { ...user, stripeCustomerId: customerId, billingSource: 'stripe' });
}

async function resolveStripeCustomerId(store, email, secret) {
  const key = userKey(email);
  let user = null;
  try {
    user = await store.get(key, { type: 'json' });
  } catch (_) {
    user = null;
  }
  if (user?.stripeCustomerId) return user.stripeCustomerId;

  const lookups = [
    () => findCustomerByEmail(email, secret),
    () => searchCustomerByEmail(email, secret),
    () => findCustomerIdBySubscriptionEmail(email, secret),
  ];
  for (const lookup of lookups) {
    const found = await lookup();
    if (found) {
      await persistStripeCustomerId(store, email, found);
      return found;
    }
  }
  return null;
}

async function createBillingPortalSession(customerId, returnUrl, secret) {
  const params = new URLSearchParams();
  params.set('customer', customerId);
  params.set('return_url', returnUrl);
  return stripeRequest('/billing_portal/sessions', { method: 'POST', body: params }, secret);
}

function checkoutSessionIsPaid(session) {
  if (!session) return false;
  if (session.status === 'complete') {
    if (session.mode === 'subscription') return true;
    return session.payment_status === 'paid';
  }
  return session.payment_status === 'paid';
}

/** Cancel all billable subscriptions for a customer (account deletion / refund). */
async function cancelActiveSubscriptions(customerId, secret) {
  if (!customerId || !secret) return { cancelled: 0 };
  const statuses = ['active', 'trialing', 'past_due', 'unpaid'];
  let cancelled = 0;
  for (const status of statuses) {
    const q = new URLSearchParams();
    q.set('customer', customerId);
    q.set('status', status);
    q.set('limit', '20');
    let data;
    try {
      data = await stripeRequest(`/subscriptions?${q.toString()}`, {}, secret);
    } catch (err) {
      console.warn('[stripeLib] list subscriptions:', err.message);
      continue;
    }
    for (const sub of data.data || []) {
      if (!sub?.id) continue;
      try {
        const params = new URLSearchParams();
        params.set('invoice_now', 'false');
        params.set('prorate', 'false');
        await stripeRequest(`/subscriptions/${encodeURIComponent(sub.id)}`, { method: 'DELETE', body: params }, secret);
        cancelled++;
      } catch (err) {
        console.warn('[stripeLib] cancel subscription:', sub.id, err.message);
      }
    }
  }
  return { cancelled };
}

/** Subscriptions Stripe still bills (past_due = card is being retried, access is kept). */
const PAYING_SUB_STATUSES = new Set(['active', 'trialing', 'past_due']);

function subscriptionPlan(sub) {
  return sub?.metadata?.plan === 'pro_max' ? 'pro_max' : 'pro';
}

function subscriptionCustomerId(sub) {
  return typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id || null;
}

/**
 * Every subscription of this account that is still being billed.
 *
 * Two sources, merged by id: the customer's own list (consistent the moment a
 * subscription exists) and a search on metadata.email (finds subscriptions that sit on
 * another Stripe customer — Checkout used to create a new customer per purchase — but
 * the search index lags about a minute).
 *
 * @returns {Promise<{ ok: boolean, subs: Array<{id, plan, status, customerId}> }>}
 *   ok:false when Stripe could not be asked at all — callers must not read that as "none".
 */
async function listPayingSubscriptions(email, customerId, secret) {
  const byId = new Map();
  const wanted = String(email || '').trim().toLowerCase();
  let asked = 0;
  const add = (sub) => {
    if (!sub?.id || !PAYING_SUB_STATUSES.has(String(sub.status || '').toLowerCase())) return;
    const metaEmail = String(sub.metadata?.email || '').trim().toLowerCase();
    if (metaEmail && wanted && metaEmail !== wanted) return;
    byId.set(sub.id, {
      id: sub.id,
      plan: subscriptionPlan(sub),
      status: String(sub.status).toLowerCase(),
      customerId: subscriptionCustomerId(sub),
    });
  };

  if (customerId) {
    try {
      const q = new URLSearchParams();
      q.set('customer', customerId);
      q.set('status', 'all');
      q.set('limit', '20');
      const data = await stripeRequest(`/subscriptions?${q.toString()}`, {}, secret);
      asked++;
      (data.data || []).forEach(add);
    } catch (err) {
      console.warn('[stripeLib] list subscriptions by customer:', err.message);
    }
  }
  if (wanted) {
    try {
      const q = new URLSearchParams();
      q.set('query', `metadata['email']:'${stripeQueryEscape(wanted)}'`);
      q.set('limit', '20');
      const data = await stripeRequest(`/subscriptions/search?${q.toString()}`, {}, secret);
      asked++;
      (data.data || []).forEach(add);
    } catch (err) {
      console.warn('[stripeLib] search subscriptions by email:', err.message);
    }
  }
  return { ok: asked > 0, subs: [...byId.values()] };
}

function bestPlan(subs) {
  if (!subs || !subs.length) return null;
  return subs.some((sub) => sub.plan === 'pro_max') ? 'pro_max' : 'pro';
}

const SUB_ID_RE = /^sub_[A-Za-z0-9]{8,}$/;

/**
 * After an upgrade checkout: end the subscription(s) it replaces, so the user is not
 * billed for Pro and Pro Max at once. Unused time is credited to the customer's balance
 * (prorate + invoice_now) and comes off the next invoice.
 *
 * Each old subscription is stamped `replaced_by` BEFORE it is cancelled: that stamp
 * travels in the customer.subscription.deleted event and tells the webhook the plan
 * must not be revoked. Safe to call twice (webhook + stripe-confirm).
 */
async function cancelReplacedSubscriptions(session, secret) {
  const out = { cancelled: [], skipped: [], errors: [] };
  const raw = String(session?.metadata?.replaces || '').trim();
  if (!raw || !secret) return out;
  const newSubId =
    typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null;
  const email = String(session?.metadata?.email || '').trim().toLowerCase();
  if (!newSubId || !email) return out;

  for (const oldId of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!SUB_ID_RE.test(oldId) || oldId === newSubId) {
      out.skipped.push(oldId);
      continue;
    }
    try {
      const old = await stripeRequest(`/subscriptions/${encodeURIComponent(oldId)}`, {}, secret);
      const oldEmail = String(old?.metadata?.email || '').trim().toLowerCase();
      if (oldEmail !== email || !PAYING_SUB_STATUSES.has(String(old.status || '').toLowerCase())) {
        out.skipped.push(oldId); // someone else's, or already ended (second call)
        continue;
      }
      const stamp = new URLSearchParams();
      stamp.set('metadata[replaced_by]', newSubId);
      await stripeRequest(`/subscriptions/${encodeURIComponent(oldId)}`, { method: 'POST', body: stamp }, secret);
      const params = new URLSearchParams();
      params.set('prorate', 'true');
      params.set('invoice_now', 'true');
      await stripeRequest(`/subscriptions/${encodeURIComponent(oldId)}`, { method: 'DELETE', body: params }, secret);
      out.cancelled.push(oldId);
      console.log('[stripeLib] replaced subscription cancelled:', oldId, '->', newSubId);
    } catch (err) {
      out.errors.push(oldId);
      console.error('[stripeLib] could not cancel replaced subscription', oldId, err.message);
    }
  }
  return out;
}

module.exports = {
  PAYING_SUB_STATUSES,
  listPayingSubscriptions,
  bestPlan,
  cancelReplacedSubscriptions,
  stripeRequest,
  findCustomerByEmail,
  searchCustomerByEmail,
  findCustomerIdBySubscriptionEmail,
  persistStripeCustomerId,
  resolveStripeCustomerId,
  createBillingPortalSession,
  checkoutSessionIsPaid,
  cancelActiveSubscriptions,
};
