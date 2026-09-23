#!/usr/bin/env node
/**
 * auth-login without Supabase config: a Supabase account (profile mirrored in
 * Blobs, no local password) must get 503 auth_service_unavailable, not 401
 * bad_credentials. On 23 sep 2026 production had no SUPABASE_URL /
 * SUPABASE_ANON_KEY and 3 of its 4 accounts were told their password was wrong.
 *
 * Offline: in-memory store injected through the require cache, no network.
 * Run: node scripts/test-auth-login-supabase-account.mjs
 */
import { createRequire } from 'node:module';
import bcrypt from 'bcryptjs';

const require = createRequire(import.meta.url);

const mem = new Map();
const store = {
  async get(key) { return mem.has(key) ? JSON.parse(mem.get(key)) : null; },
  async setJSON(key, value) { mem.set(key, JSON.stringify(value)); },
  async set(key, value) { mem.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
  async delete(key) { mem.delete(key); },
};
const blobStorePath = require.resolve('../netlify/functions/lib/blobStore.js');
require.cache[blobStorePath] = {
  id: blobStorePath,
  filename: blobStorePath,
  loaded: true,
  exports: { getStoreForEvent: () => store, STORE_NAME: 'lexicoil-data' },
};

process.env.AUTH_JWT_SECRET = 'test-secret-for-auth-login-only-0123456789';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;

const { handler } = require('../netlify/functions/auth-login.js');

mem.set('user:sb@example.com', JSON.stringify({ name: 'SB', email: 'sb@example.com', supabaseId: 'uuid-1', plan: 'pro', pro: true }));
mem.set('user:pw@example.com', JSON.stringify({ name: 'PW', email: 'pw@example.com', passwordHash: bcrypt.hashSync('secret-pass-1', 4) }));

const login = async (email, password) => {
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://lexicoil.com', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.statusCode, error: JSON.parse(res.body || '{}').error };
};

let failed = 0;
const check = (label, got, want) => {
  const ok = got.status === want.status && got.error === want.error;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${got.status} ${got.error ?? ''}`);
  if (!ok) failed += 1;
};

check('Supabase account, Supabase not configured', await login('sb@example.com', 'whatever-123'), { status: 503, error: 'auth_service_unavailable' });
check('Blobs account, wrong password', await login('pw@example.com', 'wrong-pass-9'), { status: 401, error: 'bad_credentials' });
check('Blobs account, right password', await login('pw@example.com', 'secret-pass-1'), { status: 200, error: undefined });
check('Unknown email', await login('nobody@example.com', 'whatever-123'), { status: 401, error: 'bad_credentials' });

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
