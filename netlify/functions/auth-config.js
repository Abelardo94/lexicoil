'use strict';

const { getJwtSecret } = require('./lib/authLib.js');
const { getSiteUrl } = require('./lib/siteConfig.js');
const { corsHeaders, jsonResponse } = require('./lib/http.js');
const {
  readSupabaseEnv,
  supabaseClientEnabled,
  isSupabaseReachable,
} = require('./lib/supabaseAuthRest.js');

exports.handler = async function handler(event) {
  const cors = corsHeaders(event, 'GET, OPTIONS');
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, cors, { error: 'method_not_allowed' });
  }

  const { supabaseUrl, supabaseAnonKey, configured: hasSupabase } = readSupabaseEnv();
  const clientSupabase = hasSupabase ? await supabaseClientEnabled() : false;
  const supabaseReachable =
    hasSupabase ? await isSupabaseReachable(supabaseUrl, supabaseAnonKey) : false;

  return jsonResponse(200, cors, {
    enabled: Boolean(getJwtSecret()),
    siteUrl: getSiteUrl(),
    // Client SDK (OAuth / signup) when env is configured; password login uses auth-login server-side.
    supabase: clientSupabase,
    supabaseReachable,
    supabaseUrl: clientSupabase ? supabaseUrl : '',
    supabaseAnonKey: clientSupabase ? supabaseAnonKey : '',
    emailRedirectTo: `${getSiteUrl()}/confirmacion`,
    oauthRedirectTo: `${getSiteUrl()}/app.html`,
  });
};
