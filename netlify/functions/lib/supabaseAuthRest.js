'use strict';

/** Cached reachability probe (avoids hammering auth/v1/health on every auth-config). */
let reachCache = { at: 0, url: '', ok: false, gone: false };

function trimEnv(v) {
  return String(v || '').trim();
}

function supabaseBase(url) {
  return trimEnv(url).replace(/\/$/, '');
}

function readSupabaseEnv() {
  const supabaseUrl = trimEnv(process.env.SUPABASE_URL);
  const supabaseAnonKey = trimEnv(process.env.SUPABASE_ANON_KEY);
  return { supabaseUrl, supabaseAnonKey, configured: Boolean(supabaseUrl && supabaseAnonKey) };
}

function clientAuthDisabled() {
  return trimEnv(process.env.SUPABASE_CLIENT_AUTH).toLowerCase() === '0';
}

/** A fetch that failed because the hostname does not exist (paused or deleted project). */
function isDnsNotFound(err) {
  const code = err?.cause?.code || err?.code || '';
  return code === 'ENOTFOUND';
}

/**
 * GoTrue's /auth/v1/health answers 401 without an `apikey` header, so a keyless
 * probe reported every healthy project as unreachable. No key → no probe.
 *
 * `gone` is the hard case: the project hostname does not resolve. Supabase drops
 * the DNS record of a paused project, so this is not a blip and will not heal by
 * retrying — someone has to restore the project in the Supabase dashboard.
 */
async function probeSupabase(supabaseUrl, anonKey, timeoutMs = 2500) {
  const base = supabaseBase(supabaseUrl);
  const key = trimEnv(anonKey);
  if (!base || !key) return { ok: false, gone: false };

  const now = Date.now();
  if (reachCache.url === base && now - reachCache.at < 60000) {
    return { ok: reachCache.ok, gone: reachCache.gone };
  }

  let ok = false;
  let gone = false;
  try {
    const res = await fetch(`${base}/auth/v1/health`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    ok = res.ok;
  } catch (err) {
    ok = false;
    gone = isDnsNotFound(err);
  }

  reachCache = { at: now, url: base, ok, gone };
  if (gone) {
    console.error('[supabaseAuthRest] Supabase project hostname does not resolve (paused or deleted?):', base);
  } else if (!ok) {
    console.warn('[supabaseAuthRest] Supabase unreachable:', base);
  }
  return { ok, gone };
}

async function isSupabaseReachable(supabaseUrl, anonKey, timeoutMs = 2500) {
  return (await probeSupabase(supabaseUrl, anonKey, timeoutMs)).ok;
}

/** Whether the browser may use the Supabase JS SDK (OAuth, signup). */
async function supabaseClientEnabled() {
  if (clientAuthDisabled()) return false;
  const { supabaseUrl, supabaseAnonKey, configured } = readSupabaseEnv();
  if (!configured) return false;
  // Do not gate client auth on a failed /auth/v1/health — Netlify cold starts and transient
  // network blips were disabling Google OAuth + signup in auth-config (supabase: false).
  // A hostname that does not exist is different: the SDK cannot work at all, and telling
  // the browser to use it leaves sign-up, Google and password reset dead (11 nov 2026).
  // Without it the client falls back to auth-register / auth-forgot, which only need Blobs.
  const { gone } = await probeSupabase(supabaseUrl, supabaseAnonKey);
  return !gone;
}

async function supabasePasswordGrant(supabaseUrl, anonKey, email, password) {
  const base = supabaseBase(supabaseUrl);
  if (!base || !anonKey) {
    return { accessToken: null, error: 'supabase_not_configured' };
  }

  let res;
  try {
    res = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error('[supabaseAuthRest] password grant fetch failed:', err.message);
    return { accessToken: null, error: 'supabase_unreachable', gone: isDnsNotFound(err) };
  }

  let data = {};
  try {
    data = await res.json();
  } catch (_) {
    data = {};
  }

  if (!res.ok) {
    const msg = String(data.error_description || data.msg || data.error || '').toLowerCase();
    if (msg.includes('email not confirmed')) {
      return { accessToken: null, error: 'email_not_confirmed' };
    }
    return { accessToken: null, error: 'bad_credentials' };
  }

  const accessToken = trimEnv(data.access_token);
  if (!accessToken) {
    return { accessToken: null, error: 'bad_credentials' };
  }
  return { accessToken, error: null };
}

async function fetchSupabaseUser(supabaseUrl, anonKey, accessToken) {
  const base = supabaseBase(supabaseUrl);
  let res;
  try {
    res = await fetch(`${base}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anonKey,
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error('[supabaseAuthRest] user fetch failed:', err.message);
    return { user: null, error: 'supabase_unreachable' };
  }
  if (!res.ok) {
    return { user: null, error: 'invalid_supabase_session' };
  }
  let user;
  try {
    user = await res.json();
  } catch (_) {
    return { user: null, error: 'invalid_supabase_session' };
  }
  if (!user?.email) {
    return { user: null, error: 'invalid_supabase_session' };
  }
  return { user, error: null };
}

module.exports = {
  readSupabaseEnv,
  clientAuthDisabled,
  isSupabaseReachable,
  probeSupabase,
  isDnsNotFound,
  supabaseClientEnabled,
  supabasePasswordGrant,
  fetchSupabaseUser,
};
