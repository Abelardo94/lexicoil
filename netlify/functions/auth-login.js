'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getStoreForEvent } = require('./lib/blobStore.js');
const {
  getJwtSecret,
  normalizeEmail,
  userKey,
  signAuthToken,
  getTokenVersion,
} = require('./lib/authLib.js');
const { corsHeaders, parseJsonBody, authSessionResponse, jsonResponse } = require('./lib/http.js');
const { isEmailVerified } = require('./lib/emailVerify.js');
const { completeSupabaseSession } = require('./lib/completeSupabaseSession.js');
const { readSupabaseEnv, supabasePasswordGrant } = require('./lib/supabaseAuthRest.js');

async function recordLoginFailure(store, rl, rateLimitKey) {
  await store.setJSON(rateLimitKey, {
    count: (rl?.count || 0) + 1,
    resetAt: Date.now() + 15 * 60 * 1000,
  });
}

exports.handler = async (event) => {
  const cors = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, cors, { error: 'method_not_allowed' });
  }
  if (!getJwtSecret()) {
    return jsonResponse(503, cors, { error: 'auth_not_configured' });
  }

  let body;
  try {
    body = parseJsonBody(event);
  } catch (_) {
    return jsonResponse(400, cors, { error: 'invalid_json' });
  }

  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!email || !password) {
    return jsonResponse(400, cors, { error: 'invalid_fields' });
  }

  const store = getStoreForEvent(event);

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ipSalt =
    process.env.GUEST_IP_SALT ||
    process.env.AUTH_JWT_SECRET ||
    process.env.LEXICOIL_JWT_SECRET ||
    'lexicoil-guest';
  const ipHash = crypto
    .createHash('sha256')
    .update(`${ip}:${ipSalt}`)
    .digest('hex')
    .slice(0, 24);
  const rateLimitKey = `ratelimit_login:${ipHash}`;

  let rl = null;
  try {
    rl = await store.get(rateLimitKey, { type: 'json' });
  } catch (_) {}

  if (rl && rl.count >= 10 && Date.now() < rl.resetAt) {
    return jsonResponse(429, cors, { error: 'too_many_attempts' });
  }

  let user;
  try {
    user = await store.get(userKey(email), { type: 'json' });
  } catch (_) {
    user = null;
  }

  if (user?.passwordHash && bcrypt.compareSync(password, user.passwordHash)) {
    if (!isEmailVerified(user)) {
      return jsonResponse(403, cors, { error: 'email_not_confirmed' });
    }
    try {
      await store.delete(rateLimitKey);
    } catch (_) {}

    const session = signAuthToken(email, user.name, getTokenVersion(user));
    return authSessionResponse(
      200,
      cors,
      {
        expiresAt: session.expiresAt,
        user: {
          name: user.name,
          email,
          plan: user.plan === 'pro_max' ? 'pro_max' : user.pro ? 'pro' : user.plan || 'free',
          pro: Boolean(user.pro || user.plan === 'pro' || user.plan === 'pro_max'),
        },
      },
      session.token,
      event,
    );
  }

  const { supabaseUrl, supabaseAnonKey, configured } = readSupabaseEnv();

  // A Supabase account (profile mirrored in Blobs, no local password) cannot be
  // checked without Supabase. Saying "bad_credentials" here sent users hunting
  // for a wrong password: on 23 sep 2026 production had no SUPABASE_URL /
  // SUPABASE_ANON_KEY and 3 of its 4 accounts were locked out this way.
  if (!configured && user?.supabaseId && !user.passwordHash) {
    console.error(
      '[auth-login] Supabase account but SUPABASE_URL/SUPABASE_ANON_KEY are not set in this context',
    );
    return jsonResponse(503, cors, { error: 'auth_service_unavailable' });
  }

  if (configured) {
    const grant = await supabasePasswordGrant(supabaseUrl, supabaseAnonKey, email, password);
    if (grant.accessToken) {
      try {
        await store.delete(rateLimitKey);
      } catch (_) {}
      return completeSupabaseSession(event, cors, grant.accessToken, body);
    }
    if (grant.error === 'email_not_confirmed') {
      return jsonResponse(403, cors, { error: 'email_not_confirmed' });
    }
    if (grant.error === 'supabase_unreachable') {
      return jsonResponse(503, cors, { error: 'auth_service_unavailable' });
    }
  }

  await recordLoginFailure(store, rl, rateLimitKey);
  return jsonResponse(401, cors, { error: 'bad_credentials' });
};
