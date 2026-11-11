'use strict';

const { listPayingSubscriptions, bestPlan } = require('./lib/stripeLib.js');
const { getStoreForEvent } = require('./lib/blobStore.js');
const { requireAuth } = require('./lib/authLib.js');
const { corsHeaders, jsonResponse, parseJsonBody } = require('./lib/http.js');
const { getSiteUrl } = require('./lib/siteConfig.js');

exports.handler = async (event) => {
  const cors = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, cors, { error: 'method_not_allowed' });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return jsonResponse(503, cors, { error: 'stripe_not_configured' });
  }

  const store = getStoreForEvent(event);
  // B-2 fix: requireAuth also checks tokenVersion so a revoked token can't start a checkout
  const auth = await requireAuth(event, store);
  if (!auth.ok) {
    return jsonResponse(auth.status || 401, cors, { error: auth.error || 'login_required' });
  }
  const { email: authEmail, user } = auth;

  let body = {};
  try {
    body = parseJsonBody(event);
  } catch (_) {
    body = {};
  }
  const targetPlan = body.plan === 'pro_max' ? 'pro_max' : 'pro';

  const origin =
    (event.headers && (event.headers.origin || event.headers.Origin)) ||
    getSiteUrl();
  const base = origin.replace(/\/$/, '');

  // Prefer pre-created Stripe Price IDs (STRIPE_PRICE_PRO / STRIPE_PRICE_PRO_MAX).
  const stripePricePro = String(process.env.STRIPE_PRICE_PRO || process.env.STRIPE_PRICE_ID || '').trim();
  const stripePriceProMax = String(process.env.STRIPE_PRICE_PRO_MAX || '').trim();
  const stripePriceId = targetPlan === 'pro_max' ? stripePriceProMax : stripePricePro;

  // What is this account already paying for? Without this check a Pro user who clicked
  // "Pro Max" got a second subscription and was billed for both every month, and a
  // second click on "Pro" bought the same plan twice.
  let replaces = [];
  let existingCustomerId = null;
  const current = await listPayingSubscriptions(authEmail, user?.stripeCustomerId || null, secret).catch(
    (err) => {
      console.warn('[stripe-checkout] could not list subscriptions:', err.message);
      return { ok: false, subs: [] };
    },
  );
  if (current.ok && current.subs.length) {
    const have = bestPlan(current.subs);
    if (have === 'pro_max' || have === targetPlan) {
      return jsonResponse(409, cors, { error: 'already_subscribed', plan: have });
    }
    // Pro -> Pro Max: the new subscription replaces the old one(s) once it is paid.
    replaces = current.subs.map((sub) => sub.id);
    existingCustomerId = current.subs.find((sub) => sub.customerId)?.customerId || null;
  }

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('success_url', `${base}/?upgraded=1&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${base}/?cancelled=1`);
  params.set('client_reference_id', authEmail);
  // Same Stripe customer as the subscription being replaced: the credit for its unused
  // time lands on the balance the new subscription is billed from.
  if (existingCustomerId) params.set('customer', existingCustomerId);
  else params.set('customer_email', authEmail);
  if (replaces.length) {
    params.set('metadata[replaces]', replaces.join(','));
    params.set('subscription_data[metadata][replaces]', replaces.join(','));
  }
  params.set('metadata[email]', authEmail);
  params.set('metadata[plan]', targetPlan);
  params.set('subscription_data[metadata][email]', authEmail);
  params.set('subscription_data[metadata][plan]', targetPlan);
  params.append('line_items[0][quantity]', '1');

  if (stripePriceId) {
    // Use the pre-created Price — clean, version-controlled via env
    params.append('line_items[0][price]', stripePriceId);
  } else {
    const amount = targetPlan === 'pro_max' ? '2400' : '1300';
    const name =
      targetPlan === 'pro_max'
        ? 'LexiCoil Pro Max — 12 exams/month + 150 AI credits'
        : 'LexiCoil Pro — 12 exams/month + 40 AI credits';
    params.append('line_items[0][price_data][currency]', 'eur');
    params.append('line_items[0][price_data][unit_amount]', amount);
    params.append('line_items[0][price_data][recurring][interval]', 'month');
    params.append('line_items[0][price_data][product_data][name]', name);
    params.append(
      'line_items[0][price_data][product_data][description]',
      'Monthly subscription with exam generations and AI practice credits.',
    );
  }

  // E-4 fix: Stripe Tax — enable automatic EU VAT collection.
  // Requires Stripe Tax to be activated in your Stripe Dashboard first.
  // Set STRIPE_TAX_ENABLED=true in Netlify env when ready to activate.
  if (process.env.STRIPE_TAX_ENABLED === 'true') {
    params.set('automatic_tax[enabled]', 'true');
    // Collect billing address so Stripe Tax can determine the customer's country
    params.set('billing_address_collection', 'required');
  }

  const createSession = async () => {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  let res;
  let data;
  try {
    ({ res, data } = await createSession());
    // A stored customer id Stripe no longer accepts (deleted, other mode) must not block the sale.
    if (!res.ok && existingCustomerId && /customer/i.test(String(data.error?.message || data.error?.param || ''))) {
      console.warn('[stripe-checkout] customer rejected, retrying with email:', data.error?.message);
      params.delete('customer');
      params.set('customer_email', authEmail);
      ({ res, data } = await createSession());
    }
  } catch (err) {
    console.error('[stripe-checkout] Stripe unreachable:', err.message);
    return jsonResponse(502, cors, { error: 'stripe_error', message: 'Checkout failed' });
  }
  if (!res.ok) {
    return jsonResponse(502, cors, {
      error: 'stripe_error',
      message: data.error?.message || 'Checkout failed',
    });
  }

  return jsonResponse(200, cors, { url: data.url });
};
