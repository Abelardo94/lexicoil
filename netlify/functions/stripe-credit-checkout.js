'use strict';

const { getStoreForEvent } = require('./lib/blobStore.js');
const { requireAuth } = require('./lib/authLib.js');
const { corsHeaders, jsonResponse, parseJsonBody, isAllowedOrigin } = require('./lib/http.js');
const { getSiteUrl, appEntryUrl } = require('./lib/siteConfig.js');
const {
  CREDIT_PACKS,
  creditsForPack,
  normalizeCreditPack,
  stripePriceIdForPack,
} = require('./lib/creditPacksLib.js');

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
  const auth = await requireAuth(event, store);
  if (!auth.ok) {
    return jsonResponse(auth.status || 401, cors, { error: auth.error || 'login_required' });
  }

  let body;
  try {
    body = parseJsonBody(event);
  } catch (_) {
    return jsonResponse(400, cors, { error: 'invalid_json' });
  }

  const normalized = normalizeCreditPack(body.pack);
  const credits = creditsForPack(body.pack);
  if (!normalized || !credits) {
    return jsonResponse(400, cors, { error: 'invalid_pack' });
  }

  const stripePriceId = stripePriceIdForPack(normalized);
  if (!stripePriceId) {
    return jsonResponse(503, cors, { error: 'credit_pack_not_configured', pack: normalized });
  }

  // Only our own origins may decide where Stripe sends the user back.
  const reqOrigin =
    (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const origin = reqOrigin && isAllowedOrigin(reqOrigin) ? reqOrigin : getSiteUrl();
  const base = origin.replace(/\/$/, '');

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set(
    'success_url',
    `${appEntryUrl(base)}?credits=1&pack_credits=${credits}&session_id={CHECKOUT_SESSION_ID}`,
  );
  params.set('cancel_url', `${appEntryUrl(base)}?cancelled=1`);
  params.set('client_reference_id', auth.email);
  params.set('customer_email', auth.email);
  params.set('metadata[kind]', 'credit_pack');
  params.set('metadata[email]', auth.email);
  params.set('metadata[credits]', String(credits));
  params.set('metadata[pack]', String(normalized));
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price]', stripePriceId);

  if (process.env.STRIPE_TAX_ENABLED === 'true') {
    params.set('automatic_tax[enabled]', 'true');
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

  return jsonResponse(200, cors, { url: data.url, pack: normalized, credits });
};
