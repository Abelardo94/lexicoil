// node upload-pool-audio.mjs <worktree> <lang> <level> [--apply] [--concurrency N]
// Uploads to Netlify Blobs the TTS clips of the PRODUCTION pool's Hören parts that are generated in
// the local cache — the pool counterpart of scripts/upload-tts-cache-to-blobs.mjs, which only covers
// served exams. The part list is read live from Blobs (production serves the pool only from there),
// keys/records are written exactly like upload-tts-cache-to-blobs (cacheKey + same JSON shape).
// Skips keys already in production. Dry by default: --apply WRITES TO PRODUCTION.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [W0, lang, level] = process.argv.slice(2);
const W = W0.split(String.fromCharCode(92)).join('/'); process.chdir(W);
const apply = process.argv.includes('--apply');
const ci = process.argv.indexOf('--concurrency'); const concurrency = ci > 0 ? Math.min(8, Math.max(1, Number(process.argv[ci + 1]) || 4)) : 4;
const require = createRequire(W + '/package.json');
const { loadEnvFile } = await import('file:///' + W + '/scripts/lib/loadEnv.mjs'); loadEnvFile();
const { cacheDir, cacheKey, readCache } = await import('file:///' + W + '/scripts/lib/ttsCache.mjs');
const { collectExamTtsJobs, sanitizeTtsText } = await import('file:///' + W + '/scripts/lib/ttsJobs.mjs');
const { MIN_REAL_AUDIO_BYTES } = require(W + '/netlify/functions/lib/ttsCacheLib.js');
const RPS = require(W + '/netlify/functions/lib/reusablePartsStore.js');
const PF = require(W + '/js/engine/personalLesenPoolFallback.js');
const { loadBlueprintFile } = require(W + '/netlify/functions/lib/hybridExamChunkPrompt.js');
const { getStore } = require('@netlify/blobs');
const siteID = process.env.NETLIFY_SITE_ID; const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) { console.error('Faltan NETLIFY_SITE_ID o NETLIFY_API_TOKEN en el .env.'); process.exit(1); }
const store = getStore({ name: 'lexicoil-data', siteID, token });
const blueprint = loadBlueprintFile(lang, level);

const idx = await RPS.listPartsIndex(store, lang, level, 'horen');
if (!idx.length) { console.error(`ERROR: 0 partes Hören ${lang}/${level} en Blobs — no se ha mirado nada.`); process.exit(1); }
const planned = []; const seen = new Set(); let sinGenerar = 0, mudos = 0, total = 0;
for (const row of idx) {
  const rec = await RPS.getReusablePart(store, lang, level, 'horen', row.id);
  if (!rec || rec.disabled === true) continue;
  const part = PF.reusablePartToHorenPart(rec, blueprint); if (!part) continue;
  for (const j of collectExamTtsJobs({ id: 'pool:' + rec.id, horenParts: [part] }, lang)) {
    const text = sanitizeTtsText(j.text); const key = cacheKey(j.voice, text);
    if (seen.has(key)) continue; seen.add(key); total++;
    const hit = readCache(j.voice, text, lang);
    if (!hit) { sinGenerar++; continue; }
    if (hit.bytes < MIN_REAL_AUDIO_BYTES) { mudos++; continue; }
    planned.push({ file: path.basename(hit.file), voice: j.voice, hash: hit.hash, bytes: hit.bytes, lang, key });
  }
}
const listed = await store.list({ prefix: 'tts:' });
const existing = new Set((listed.blobs || []).map((b) => b.key));
const pending = planned.filter((p) => !existing.has(p.key));
console.log(`${lang}/${level} piscina (Blobs): ${idx.length} partes Hören · ${total} clips pedidos · generados ${planned.length} · sin generar ${sinGenerar} · mudos ${mudos}`);
console.log(`Ya en producción: ${planned.length - pending.length} · por subir: ${pending.length} (${(pending.reduce((a, p) => a + p.bytes, 0) / 1048576).toFixed(1)} MB)`);
if (!apply) { console.log('— SECO, no se escribe nada — (añade --apply para subir)'); process.exit(0); }
const dir = cacheDir(); let ok = 0, fail = 0, cursor = 0; const errores = [];
async function worker() {
  while (cursor < pending.length) {
    const p = pending[cursor++]; const n = cursor;
    try {
      const audio = fs.readFileSync(path.join(dir, p.file));
      await store.setJSON(p.key, { audioBase64: audio.toString('base64'), contentType: 'audio/mpeg', voice: p.voice, lang: p.lang, textHash: p.hash, createdAt: Date.now(), source: 'pregenerated' });
      ok++; if (n % 50 === 0 || n === pending.length) console.log(`  ${n}/${pending.length} · ok ${ok} · fallos ${fail}`);
    } catch (err) { fail++; errores.push(`${p.key}: ${err.message}`); }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`Subidos ${ok} · fallos ${fail}`); if (errores.length) console.log(errores.slice(0, 5).join('\n'));
