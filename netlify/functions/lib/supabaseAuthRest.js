'use strict';

/** Cached reachability probe (avoids hammering auth/v1/health on every auth-config). */
let reachCache = { at: 0, url: '', ok: false };

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

/**
 * GoTrue's /auth/v1/health answers 401 without an `apikey` header, so a keyless
 * probe reported every healthy project as unreachable. No key → no probe.
 */
async function isSupabaseReachable(supabaseUrl, anonKey, timeoutMs = 2500) {
  const base = supabaseBase(supabaseUrl);
  const key = trimEnv(anonKey);
  if (!base || !key) return false;

  const now = Date.now();
  if (reachCache.url === base && now - reachCache.at < 60000) {
    return reachCache.ok;
  }

  let ok = false;
  try {
    const res = await fetch(`${base}/auth/v1/health`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    ok = res.ok;
  } catch (_) {
    ok = false;
  }

  reachCache = { at: now, url: base, ok };
  if (!ok) {
    console.warn('[supabaseAuthRest] Supabase unreachable:', base);
  }
  return ok;
}

/** Whether the browser may use the Supabase JS SDK (OAuth, signup). */
async function supabaseClientEnabled() {
  if (clientAuthDisabled()) return false;
  const { configured } = readSupabaseEnv();
  if (!configured) return false;
  // Do not gate client auth on /auth/v1/health — Netlify cold starts and transient
  // network blips were disabling Google OAuth + signup in auth-config (supabase: false).
  return true;
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
    return { accessToken: null, error: 'supabase_unreachable' };
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
  supabaseClientEnabled,
  supabasePasswordGrant,
  fetchSupabaseUser,
};
