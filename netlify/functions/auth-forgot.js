'use strict';

const { randomBytes } = require('crypto');
const { getStoreForEvent } = require('./lib/blobStore.js');
const { normalizeEmail, userKey } = require('./lib/authLib.js');
const { corsHeaders, parseJsonBody, jsonResponse } = require('./lib/http.js');
const { getSiteUrl, appEntryUrl } = require('./lib/siteConfig.js');
const { sendPasswordResetEmail } = require('./lib/email.js');
const { checkIpRateLimit, recordIpRateLimitHit } = require('./lib/ipRateLimit.js');

// Each call can send an email: without a cap this endpoint is a mail bomb aimed at any address.
const FORGOT_LIMIT = 5;
const FORGOT_WINDOW_MS = 60 * 60 * 1000;
const PER_EMAIL_COOLDOWN_MS = 2 * 60 * 1000;

const GENERIC_MSG = 'If that email exists, a reset link was sent.';

exports.handler = async (event) => {
  const cors = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, cors, { error: 'method_not_allowed' });
  }

  let body;
  try {
    body = parseJsonBody(event);
  } catch (_) {
    return jsonResponse(400, cors, { error: 'invalid_json' });
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return jsonResponse(400, cors, { error: 'invalid_email' });
  }

  const store = getStoreForEvent(event);
  const rl = await checkIpRateLimit(store, event, 'ratelimit_forgot', {
    limit: FORGOT_LIMIT,
    windowMs: FORGOT_WINDOW_MS,
  });
  if (!rl.ok) {
    return jsonResponse(429, cors, { error: 'too_many_attempts' });
  }
  await recordIpRateLimitHit(store, { ...rl, windowMs: FORGOT_WINDOW_MS });

  let user = null;
  try {
    user = await store.get(userKey(email), { type: 'json' });
  } catch (_) {
    user = null;
  }

  // One mail per address every 2 minutes, whatever the caller's IP. Same generic answer
  // either way, so this does not reveal whether the address has an account.
  let recent = null;
  try {
    recent = await store.get(`reset_sent:${email}`, { type: 'json' });
  } catch (_) {
    recent = null;
  }
  const coolingDown = recent?.at && Date.now() - recent.at < PER_EMAIL_COOLDOWN_MS;

  if (user && !coolingDown) {
    await store.setJSON(`reset_sent:${email}`, { at: Date.now() });
    const token = randomBytes(24).toString('hex');
    const exp = Date.now() + 60 * 60 * 1000;
    await store.setJSON(`reset:${token}`, { email, exp }, { metadata: { ttl: 3600 } });
    const resetUrl = `${appEntryUrl()}?reset=${token}`;
    try {
      await sendPasswordResetEmail(email, resetUrl);
    } catch (err) {
      console.error('[auth-forgot] email failed:', err.message);
    }
  }

  return jsonResponse(200, cors, { ok: true, message: GENERIC_MSG });
};
