'use strict';

const { getStoreForEvent } = require('./lib/blobStore.js');
const { requireAuth } = require('./lib/authLib.js');
const { corsHeaders, jsonResponse, parseJsonBody, isAllowedOrigin } = require('./lib/http.js');
const { getSiteUrl, appEntryUrl } = require('./lib/siteConfig.js');

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

  // Only our own origins may decide where Stripe sends the user back.
  const reqOrigin =
    (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const origin = reqOrigin && isAllowedOrigin(reqOrigin) ? reqOrigin : getSiteUrl();
  const base = origin.replace(/\/$/, '');

  // Prefer pre-created Stripe Price IDs (STRIPE_PRICE_PRO / STRIPE_PRICE_PRO_MAX).
  const stripePricePro = String(process.env.STRIPE_PRICE_PRO || process.env.STRIPE_PRICE_ID || '').trim();
  const stripePriceProMax = String(process.env.STRIPE_PRICE_PRO_MAX || '').trim();
  const stripePriceId = targetPlan === 'pro_max' ? stripePriceProMax : stripePricePro;

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('success_url', `${appEntryUrl(base)}?upgraded=1&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${appEntryUrl(base)}?cancelled=1`);
  params.set('client_reference_id', authEmail);
  params.set('customer_email', authEmail);
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

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return jsonResponse(502, cors, {
      error: 'stripe_error',
      message: data.error?.message || 'Checkout failed',
    });
  }

  return jsonResponse(200, cors, { url: data.url });
};
