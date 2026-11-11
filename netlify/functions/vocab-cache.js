'use strict';

const crypto = require('crypto');
const { getStoreForEvent } = require('./lib/blobStore.js');
const { corsHeaders, parseJsonBody, jsonResponse, getBearer } = require('./lib/http.js');
const { verifyAuthToken } = require('./lib/authLib.js');
const { freeTranslate, isJunkTranslation } = require('./lib/freeTranslate.js');
const {
  isPassageText,
  isCompletePassageTranslation,
} = require('../../js/engine/passageTranslate.js');

const PASSAGE_MAX = 4000;
const PUT_LIMIT = 40;
const PUT_WINDOW_MS = 60 * 60 * 1000;

const memCache = global.__lexicoilVocabMemCache || (global.__lexicoilVocabMemCache = new Map());

function normalizeText(text) {
  return String(text || '').trim().toLowerCase();
}

function textHash(text) {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 16);
}

function cacheKey(from, to, text) {
  return `xlat:${from}:${to}:${textHash(text)}`;
}

function clientIp(event) {
  const raw =
    event.headers['x-forwarded-for'] ||
    event.headers['X-Forwarded-For'] ||
    event.headers['client-ip'] ||
    '';
  return String(raw).split(',')[0].trim() || 'unknown';
}

function ipHash(ip) {
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
}

async function cacheGet(store, key) {
  if (memCache.has(key)) return memCache.get(key);
  if (!store) return null;
  try {
    const entry = await store.get(key, { type: 'json' });
    if (entry) memCache.set(key, entry);
    return entry;
  } catch (_) {
    return null;
  }
}

async function cacheSet(store, key, payload) {
  memCache.set(key, payload);
  if (!store) return;
  try {
    await store.setJSON(key, payload);
  } catch (_) {
    /* in-memory fallback for this process */
  }
}

async function checkPutRateLimit(store, event) {
  if (!store) return true;
  const key = `ratelimit_vocab_put:${ipHash(clientIp(event))}`;
  let entry = null;
  try {
    entry = await store.get(key, { type: 'json' });
  } catch (_) {
    entry = null;
  }
  const now = Date.now();
  if (!entry || now - entry.since > PUT_WINDOW_MS) {
    try {
      await store.setJSON(key, { count: 1, since: now });
    } catch (_) {
      return true;
    }
    return true;
  }
  if (entry.count >= PUT_LIMIT) return false;
  entry.count += 1;
  try {
    await store.setJSON(key, entry);
  } catch (_) {
    return true;
  }
  return true;
}

function validLang(lang) {
  return /^[a-z]{2}$/.test(String(lang || ''));
}

function validateEntry(from, to, text, translation) {
  if (!validLang(from) || !validLang(to) || from === to) return 'invalid_lang';
  const t = String(text || '').trim();
  const tr = String(translation || '').trim();
  if (!t || !tr) return 'empty';
  if (t.length > PASSAGE_MAX || tr.length > PASSAGE_MAX) return 'too_long';
  if (isJunkTranslation(tr)) return 'junk_translation';
  return null;
}

function lemmaCacheKey(surface, context) {
  const s = normalizeText(surface);
  const c = normalizeText(String(context || '').slice(0, 500));
  return `lemma:de:${textHash(`${s}||${c}`)}`;
}

function genderCacheKey(word) {
  return `gender:de:${textHash(normalizeText(word))}`;
}

function articleToGender(article) {
  const a = String(article || '').toLowerCase();
  if (a === 'der') return 'm';
  if (a === 'die') return 'f';
  if (a === 'das') return 'n';
  return null;
}

exports.handler = async (event) => {
  const cors = corsHeaders(event, 'GET, PUT, OPTIONS');
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };

  try {
    const store = getStoreForEvent(event);

    if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const action = String(params.action || 'translate').trim().toLowerCase();
    const from = String(params.from || '').trim().toLowerCase();
    const to = String(params.to || '').trim().toLowerCase();
    const text = String(params.text || '');
    const context = String(params.context || '').trim().slice(0, PASSAGE_MAX);

    // Separable-verb lemma safety net (only used when client allowlist reunify failed)
    if (action === 'lemma') {
      if (from !== 'de' || !text.trim() || context.length < 8) {
        return jsonResponse(400, cors, { error: 'invalid_params' });
      }
      const { geminiApiKey, resolveSeparableLemma } = require('./lib/freeTranslate.js');
      if (!geminiApiKey()) {
        return jsonResponse(200, cors, { found: false, reason: 'no_api_key' });
      }
      const key = lemmaCacheKey(text, context);
      const entry = await cacheGet(store, key);
      if (entry?.lemma && !isJunkTranslation(entry.lemma)) {
        return jsonResponse(
          200,
          { ...cors, 'Cache-Control': 'public, max-age=86400' },
          { found: true, lemma: entry.lemma, source: entry.source || 'cache' },
        );
      }
      const result = await resolveSeparableLemma(text.trim(), context);
      if (result?.lemma && !isJunkTranslation(result.lemma)) {
        await cacheSet(store, key, {
          lemma: result.lemma,
          source: result.source || 'gemini',
          createdAt: Date.now(),
        });
        return jsonResponse(
          200,
          { ...cors, 'Cache-Control': 'public, max-age=86400' },
          { found: true, lemma: result.lemma, source: result.source || 'gemini' },
        );
      }
      return jsonResponse(200, cors, { found: false, reason: result?.reason || 'lemma_failed' });
    }

    // German noun gender safety net (only when client lexicon missed)
    if (action === 'gender') {
      if (from !== 'de' || !text.trim()) {
        return jsonResponse(400, cors, { error: 'invalid_params' });
      }
      const likelyPlural =
        params.likelyPlural === '1' ||
        params.likelyPlural === 'true' ||
        params.likelyPlural === true;
      const { geminiApiKey, resolveGermanGender } = require('./lib/freeTranslate.js');
      if (!geminiApiKey()) {
        return jsonResponse(200, cors, { found: false, reason: 'no_api_key' });
      }
      const key = genderCacheKey(text);
      const entry = await cacheGet(store, key);
      if (entry?.article && articleToGender(entry.article)) {
        return jsonResponse(
          200,
          { ...cors, 'Cache-Control': 'public, max-age=86400' },
          {
            found: true,
            article: entry.article,
            gender: entry.gender || articleToGender(entry.article),
            plural: !!entry.plural,
            source: entry.source || 'cache',
          },
        );
      }
      const result = await resolveGermanGender(text.trim(), { likelyPlural });
      const gender = articleToGender(result?.article);
      if (result?.article && gender) {
        await cacheSet(store, key, {
          article: result.article,
          gender,
          plural: !!result.plural,
          source: result.source || 'gemini',
          createdAt: Date.now(),
        });
        return jsonResponse(
          200,
          { ...cors, 'Cache-Control': 'public, max-age=86400' },
          {
            found: true,
            article: result.article,
            gender,
            plural: !!result.plural,
            source: result.source || 'gemini',
          },
        );
      }
      return jsonResponse(200, cors, { found: false, reason: result?.reason || 'gender_failed' });
    }

    if (!validLang(from) || !validLang(to) || !text.trim()) {
      return jsonResponse(400, cors, { error: 'invalid_params' });
    }
    const { geminiApiKey } = require('./lib/freeTranslate.js');
    if (!geminiApiKey()) {
      return jsonResponse(200, cors, { found: false, reason: 'no_api_key' });
    }
    if (text.trim().length > PASSAGE_MAX) {
      return jsonResponse(400, cors, { error: 'too_long' });
    }

      const key = cacheKey(from, to, text);
      const entry = await cacheGet(store, key);

    // Serve cache only if translation looks like a real gloss (drop poisoned MyMemory spam)
    if (entry?.translation && !isJunkTranslation(entry.translation)) {
      if (
        !isPassageText(text) ||
        isCompletePassageTranslation(text, entry.translation)
      ) {
        return jsonResponse(
          200,
          { ...cors, 'Cache-Control': 'public, max-age=86400' },
          { found: true, translation: entry.translation, source: entry.source || 'cache' },
        );
      }
    }

    // Long passages: never use word-level freeTranslate (200-char cap / 128 output tokens).
    if (isPassageText(text)) {
      return jsonResponse(200, cors, { found: false, reason: 'passage_requires_ai' });
    }

    const result = await freeTranslate(text.trim(), from, to, context || undefined);
    const translated = result?.translation;
    if (translated && !isJunkTranslation(translated)) {
      const payload = {
        translation: translated,
        source: result.source || 'gemini',
        from,
        to,
        textHash: textHash(text),
        createdAt: Date.now(),
      };
        await cacheSet(store, key, payload);
      return jsonResponse(
        200,
        { ...cors, 'Cache-Control': 'public, max-age=86400' },
        { found: true, translation: translated, source: result.source || 'gemini' },
      );
    }

    return jsonResponse(200, cors, { found: false, reason: result?.reason || 'translate_failed' });
  }

  if (event.httpMethod === 'PUT') {
    // The cache is shared by every user. Anonymous writes let anyone replace the
    // translation other learners see for any word; the app only writes while signed in.
    const auth = verifyAuthToken(getBearer(event));
    if (!auth.ok) return jsonResponse(401, cors, { error: 'login_required' });

    const allowed = await checkPutRateLimit(store, event);
    if (!allowed) return jsonResponse(429, cors, { error: 'rate_limited' });

    let body;
    try {
      body = parseJsonBody(event);
    } catch (_) {
      return jsonResponse(400, cors, { error: 'invalid_json' });
    }

    const from = String(body.from || '').trim().toLowerCase();
    const to = String(body.to || '').trim().toLowerCase();
    const text = String(body.text || '');
    const translation = String(body.translation || '');
    const source = String(body.source || 'manual').slice(0, 24);

    const err = validateEntry(from, to, text, translation);
    if (err) return jsonResponse(400, cors, { error: err });

      const key = cacheKey(from, to, text);
      await cacheSet(store, key, {
      translation: translation.trim(),
      source,
      from,
      to,
      textHash: textHash(text),
      createdAt: Date.now(),
    });
    return jsonResponse(200, cors, { saved: true });
  }

    return jsonResponse(405, cors, { error: 'method_not_allowed' });
  } catch (err) {
    console.error('[vocab-cache]', err?.message || err);
    return jsonResponse(200, cors, { found: false, error: 'lookup_failed' });
  }
};
