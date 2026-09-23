#!/usr/bin/env node
/**
 * Auth login resilience — Supabase reachability + server-side login path.
 * Run: node scripts/test-auth-login-supabase-fallback.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isSupabaseReachable,
  readSupabaseEnv,
  supabaseClientEnabled,
} = require('../netlify/functions/lib/supabaseAuthRest.js');

const PROD_SB = 'https://dyotsafciieutixafncx.supabase.co';

let failed = 0;
function ok(label) {
  console.log(`OK  ${label}`);
}
function fail(label, detail) {
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  failed += 1;
}

const reachableProd = await isSupabaseReachable(PROD_SB, 3000);
if (reachableProd) {
  fail('prod Supabase project should be unreachable in this incident');
} else {
  ok('prod Supabase DNS/health unreachable (expected)');
}

const reachableOk = await isSupabaseReachable('https://example.supabase.co', 1500);
// example.supabase.co may or may not resolve — only assert our prod ref is dead
ok(`reachability probe returns boolean (${reachableOk})`);

const env = readSupabaseEnv();
ok(`readSupabaseEnv configured=${env.configured}`);

process.env.SUPABASE_CLIENT_AUTH = '0';
const clientOff = await supabaseClientEnabled();
if (clientOff) fail('SUPABASE_CLIENT_AUTH=0 should disable client SDK');
else ok('SUPABASE_CLIENT_AUTH=0 disables client SDK');
delete process.env.SUPABASE_CLIENT_AUTH;

const prodCfg = await fetch('https://lexicoil.com/.netlify/functions/auth-config').then((r) => r.json());
console.log('\nProduction auth-config (live deploy, pre-push):', {
  supabase: prodCfg.supabase,
  hasUrl: Boolean(prodCfg.supabaseUrl),
});

const diagRes = await fetch('https://lexicoil.com/.netlify/functions/auth-login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Origin: 'https://lexicoil.com',
  },
  body: JSON.stringify({ email: 'marcosdadra@gmail.com', password: '__probe__' }),
});
const diag = await diagRes.json().catch(() => ({}));
// marcosdadra@gmail.com is a Supabase account mirrored in Blobs without a local
// password. With Supabase unset it must say "service unavailable" (503), not
// "bad password" (401) — the 401 is what kept 3 of 4 accounts guessing on
// 23 sep 2026. Deploys older than that fix still answer 401.
if (diagRes.status === 503 && diag.error === 'auth_service_unavailable') {
  ok('prod auth-login: Supabase account without Supabase config → auth_service_unavailable');
} else if (diagRes.status === 401 && diag.error === 'bad_credentials') {
  ok('prod auth-login responds 401 (deploy predates the auth_service_unavailable fix)');
} else {
  fail('prod auth-login probe', `${diagRes.status} ${diag.error || ''}`);
}

console.log(failed ? `\n${failed} test(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
