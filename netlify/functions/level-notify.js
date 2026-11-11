'use strict';

const { corsHeaders, parseJsonBody, jsonResponse } = require('./lib/http.js');
const { getStoreForEvent } = require('./lib/blobStore.js');
const { checkIpRateLimit, recordIpRateLimitHit } = require('./lib/ipRateLimit.js');

// Public and unauthenticated: without caps anyone can grow the waitlist blob without bound.
const NOTIFY_LIMIT = 10;
const NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;
const WAITLIST_MAX = 5000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LANGS = new Set(['de', 'en', 'es']);
const LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, headers, { error: 'method_not_allowed' });
  }

  let body;
  try {
    body = parseJsonBody(event);
  } catch (_) {
    return jsonResponse(400, headers, { error: 'invalid_json' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const lang = String(body.lang || '').trim();
  const level = String(body.level || '').trim();

  if (!EMAIL_RE.test(email)) {
    return jsonResponse(400, headers, { error: 'invalid_email' });
  }
  if (!LANGS.has(lang) || !LEVELS.has(level)) {
    return jsonResponse(400, headers, { error: 'invalid_combo' });
  }

  const key = `level_waitlist:${lang}_${level}`;
  const store = getStoreForEvent(event);
  if (!store) return jsonResponse(503, headers, { error: 'storage_unavailable' });
  if (email.length > 254) return jsonResponse(400, headers, { error: 'invalid_email' });
  const rl = await checkIpRateLimit(store, event, 'ratelimit_level_notify', {
    limit: NOTIFY_LIMIT,
    windowMs: NOTIFY_WINDOW_MS,
  });
  if (!rl.ok) return jsonResponse(429, headers, { error: 'too_many_attempts' });
  await recordIpRateLimitHit(store, { ...rl, windowMs: NOTIFY_WINDOW_MS });

  let list = [];
  try {
    const raw = await store.get(key, { type: 'json' });
    if (Array.isArray(raw)) list = raw;
  } catch (_) {
    /* first entry */
  }
  if (!list.includes(email)) {
    if (list.length >= WAITLIST_MAX) return jsonResponse(200, headers, { ok: true });
    list.push(email);
    await store.setJSON(key, list);
  }

  return jsonResponse(200, headers, { ok: true });
};
