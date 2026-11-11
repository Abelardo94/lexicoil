'use strict';

const { getStoreForEvent } = require('./lib/blobStore.js');
const { normalizeEmail, userKey } = require('./lib/authLib.js');
const { corsHeaders, parseJsonBody, jsonResponse } = require('./lib/http.js');
const {
  isEmailVerified,
  createEmailVerifyToken,
  sendUserVerifyEmail,
} = require('./lib/emailVerify.js');

const { checkIpRateLimit, recordIpRateLimitHit } = require('./lib/ipRateLimit.js');

// Each call can send an email: cap it per IP and per address.
const RESEND_LIMIT = 5;
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const PER_EMAIL_COOLDOWN_MS = 2 * 60 * 1000;

const GENERIC_MSG = 'If that email is pending confirmation, a new link was sent.';

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
  const rl = await checkIpRateLimit(store, event, 'ratelimit_resend', {
    limit: RESEND_LIMIT,
    windowMs: RESEND_WINDOW_MS,
  });
  if (!rl.ok) {
    return jsonResponse(429, cors, { error: 'too_many_attempts' });
  }
  await recordIpRateLimitHit(store, { ...rl, windowMs: RESEND_WINDOW_MS });

  let recent = null;
  try {
    recent = await store.get(`verify_sent:${email}`, { type: 'json' });
  } catch (_) {
    recent = null;
  }
  const coolingDown = recent?.at && Date.now() - recent.at < PER_EMAIL_COOLDOWN_MS;

  let user = null;
  try {
    user = await store.get(userKey(email), { type: 'json' });
  } catch (_) {
    user = null;
  }

  if (user && !isEmailVerified(user) && !coolingDown) {
    try {
      await store.setJSON(`verify_sent:${email}`, { at: Date.now() });
      const token = await createEmailVerifyToken(store, email);
      await sendUserVerifyEmail(email, user.name || email, token);
    } catch (err) {
      console.error('[auth-resend-confirm] email failed:', err.message);
    }
  }

  return jsonResponse(200, cors, { ok: true, message: GENERIC_MSG });
};
