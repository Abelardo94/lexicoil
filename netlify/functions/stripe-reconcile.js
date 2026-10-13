'use strict';

// LexiCoil — stripe-reconcile.js
// Scheduled function (daily cron) that reconciles Stripe subscription state
// with our user records in Netlify Blobs.
//
// This catches cases where webhook delivery failed (Stripe outage, cold-start
// timeouts, network drops) so users are never stuck with wrong plan access.
//
// Schedule: configured in netlify.toml as a scheduled function (daily at 02:00 UTC).
// Can also be triggered manually via the Netlify Functions dashboard.

const { getStoreForEvent } = require('./lib/blobStore.js');
const { normalizeEmail, userKey } = require('./lib/authLib.js');
const { activatePlanForEmail, revokeProForEmail } = require('./lib/proUpgrade.js');
const { resolvePlan } = require('./lib/quotaLib.js');
const sb = require('./lib/supabaseAdmin.js');

const STRIPE_API = 'https://api.stripe.com/v1';

// Still paying (past_due = Stripe is retrying the card; the webhook keeps Pro meanwhile).
const PAYING_STATUSES = new Set(['active', 'trialing', 'past_due']);
const ENDED_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

async function stripeGet(path, secret) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Stripe API error (${res.status})`);
  return data;
}

// Fetch every subscription (all statuses) from Stripe, paginated
async function fetchAllSubscriptions(secret) {
  const subs = [];
  let startingAfter = null;
  for (;;) {
    const qs = new URLSearchParams({
      status: 'all',
      limit: '100',
      'expand[]': 'data.customer',
    });
    if (startingAfter) qs.set('starting_after', startingAfter);
    const page = await stripeGet(`/subscriptions?${qs}`, secret);
    subs.push(...(page.data || []));
    if (!page.has_more || !page.data?.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return subs;
}

// The app account a subscription belongs to: stripe-checkout stamps metadata.email
// with the login email; the customer email can be edited in the billing portal.
function emailFromSub(sub) {
  const custEmail =
    typeof sub.customer === 'object' ? sub.customer?.email : null;
  const metaEmail = sub.metadata?.email || null;
  return normalizeEmail(metaEmail || custEmail || '');
}

function customerIdFromSub(sub) {
  return typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;
}

function planFromSub(sub) {
  return sub.metadata?.plan === 'pro_max' ? 'pro_max' : 'pro';
}

async function reconcileSubscriptions(store, subs, stats) {
  // email -> best plan among the subscriptions still paying
  const paying = new Map();
  const ended = new Set();
  const customerByEmail = new Map();
  for (const sub of subs) {
    const email = emailFromSub(sub);
    if (!email) continue;
    const status = String(sub.status || '').toLowerCase();
    if (PAYING_STATUSES.has(status)) {
      const plan = planFromSub(sub);
      if (paying.get(email) !== 'pro_max') paying.set(email, plan);
      if (!customerByEmail.has(email)) customerByEmail.set(email, customerIdFromSub(sub));
    } else if (ENDED_STATUSES.has(status)) {
      ended.add(email);
    }
  }

  // Step 1: activate users paying in Stripe whose record says otherwise
  for (const [email, plan] of paying) {
    stats.checked++;
    try {
      const user = await store.get(userKey(email), { type: 'json' }).catch(() => null);
      if (!user) continue; // user not registered yet — skip
      const current = resolvePlan(user);
      if (current === plan || current === 'pro_max') continue; // never downgrade
      const res = await activatePlanForEmail(store, email, plan, {
        sendEmail: false,
        stripeCustomerId: customerByEmail.get(email) || undefined,
      });
      if (res.ok) {
        stats.activated++;
        console.log('[reconcile] activated', plan, 'for:', email);
      }
    } catch (err) {
      console.error('[reconcile] error activating', email, err.message);
      stats.errors++;
    }
  }

  // Step 2: revoke paid plans whose every Stripe subscription has ended. Only
  // Stripe-billed users: a Pro granted by hand (billingSource 'manual') is not ours to touch.
  for (const email of ended) {
    if (paying.has(email)) continue;
    try {
      const user = await store.get(userKey(email), { type: 'json' }).catch(() => null);
      if (!user || resolvePlan(user) === 'free') continue;
      if (user.billingSource === 'manual') continue;
      if (user.billingSource !== 'stripe' && !user.stripeCustomerId) continue;
      const res = await revokeProForEmail(store, email, { reason: 'reconcile_subscription_ended' });
      if (res.ok) {
        stats.revoked++;
        console.log('[reconcile] revoked Pro for:', email);
      }
    } catch (err) {
      console.error('[reconcile] error revoking', email, err.message);
      stats.errors++;
    }
  }
}

exports.handler = async (event) => {
  const secret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secret) {
    console.warn('[reconcile] STRIPE_SECRET_KEY not set — skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'no_secret' }) };
  }

  // Same store as every other function (it used getStore('lexicoil'), a store nothing
  // else writes, so the nightly pass never found a user).
  const store = getStoreForEvent(event);
  if (!store) {
    return { statusCode: 500, body: JSON.stringify({ error: 'store_unavailable' }) };
  }
  const stats = { checked: 0, activated: 0, revoked: 0, errors: 0, generationsPurged: 0 };

  try {
    const subs = await fetchAllSubscriptions(secret);
    await reconcileSubscriptions(store, subs, stats);
  } catch (err) {
    console.error('[reconcile] fatal error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message, stats }) };
  }

  if (sb.isConfigured()) {
    try {
      stats.generationsPurged = await sb.purgeOldGenerations(90);
      if (stats.generationsPurged > 0) {
        console.log('[reconcile] purged old AI generations:', stats.generationsPurged);
      }
    } catch (err) {
      console.error('[reconcile] generation purge failed:', err.message);
    }
  }

  console.log('[reconcile] done', stats);
  return { statusCode: 200, body: JSON.stringify({ ok: true, stats }) };
};

exports._test = { reconcileSubscriptions, emailFromSub, planFromSub };
