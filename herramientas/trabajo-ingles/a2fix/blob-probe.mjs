import { createRequire } from 'node:module';
// READ-ONLY probe of the Netlify Blobs store used for the reusable pool.
const W = process.argv[2].split(String.fromCharCode(92)).join('/'); process.chdir(W);
const { loadEnvFile } = await import('file:///' + W + '/scripts/lib/loadEnv.mjs'); if (typeof loadEnvFile === 'function') loadEnvFile();
// getBlobStore() only works inside Netlify (no siteID/token): open it like upload-tts-cache-to-blobs does.
const { getStore } = createRequire(W + '/package.json')('@netlify/blobs');
const store = getStore({ name: 'lexicoil-data', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN });
console.log('store:', store ? (Object.keys(store).slice(0, 8).join(',') || typeof store) : store);
for (const prefix of ['reusable_part_idx:de:B1:horen:', 'reusable_part_idx:de:A2:', 'reusable_part_idx:en:B1:', 'reusable_part:', 'reusable_part_idx:', 'tts:']) {
  try {
    const r = await store.list({ prefix });
    console.log(prefix.padEnd(34), (r && r.blobs ? r.blobs.length : 0), (r && r.blobs ? r.blobs.slice(0, 2).map((b) => b.key).join(' | ') : ''));
  } catch (e) { console.log(prefix.padEnd(34), 'ERROR', String(e.message).slice(0, 200)); }
}
