// READ-ONLY. node pool-blob-vs-seed.mjs <worktree> <lang> <level>
// Compares the TTS texts of the Hören pool parts in production (Netlify Blobs) with the ones
// pregenerate-tts --pool would build from library/reusable-seed. Audio is keyed by exact text, so
// only texts that exist in Blobs are worth paying for.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [W0, lang, level] = process.argv.slice(2); const W = W0.replace(/\\/g, '/'); process.chdir(W);
const require = createRequire(W + '/package.json');
const { loadEnvFile } = await import('file:///' + W + '/scripts/lib/loadEnv.mjs'); loadEnvFile?.();
const { readCache } = await import('file:///' + W + '/scripts/lib/ttsCache.mjs');
const { collectExamTtsJobs, sanitizeTtsText } = await import('file:///' + W + '/scripts/lib/ttsJobs.mjs');
const RPS = require(W + '/netlify/functions/lib/reusablePartsStore.js');
const PF = require(W + '/js/engine/personalLesenPoolFallback.js');
const { loadBlueprintFile } = require(W + '/netlify/functions/lib/hybridExamChunkPrompt.js');
const blueprint = loadBlueprintFile(lang, level);
const jobsOf = (rec) => { const part = PF.reusablePartToHorenPart(rec, blueprint); if (!part) return []; return collectExamTtsJobs({ id: 'pool:' + rec.id, horenParts: [part] }, lang).map((j) => ({ voice: j.voice, text: sanitizeTtsText(j.text) })); };

// getBlobStore() only works inside Netlify (no siteID/token): open it like upload-tts-cache-to-blobs does.
const { getStore } = createRequire(W + '/package.json')('@netlify/blobs');
const store = getStore({ name: 'lexicoil-data', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN });
const idx = await RPS.listPartsIndex(store, lang, level, 'horen');
const blobRecs = [];
for (const row of idx) { const rec = await RPS.getReusablePart(store, lang, level, 'horen', row.id); if (rec && rec.disabled !== true) blobRecs.push(rec); }
const seedRaw = JSON.parse(fs.readFileSync(path.join(W, 'library/reusable-seed', `${lang}_${level}.json`), 'utf8'));
const seedRecs = (seedRaw.records || seedRaw).filter((r) => r.module === 'horen');
const seedIds = new Set(seedRecs.map((r) => r.id)); const blobIds = new Set(blobRecs.map((r) => r.id));

const key = (j) => j.voice + '|' + j.text;
const seedJobs = new Set(seedRecs.flatMap(jobsOf).map(key));
const blobJobs = new Map(); for (const r of blobRecs) for (const j of jobsOf(r)) blobJobs.set(key(j), j);
let inSeed = 0, missingAudio = 0, missingChars = 0, blobOnly = 0;
for (const [k, j] of blobJobs) { if (seedJobs.has(k)) inSeed++; else blobOnly++; if (!readCache(j.voice, j.text, lang)) { missingAudio++; missingChars += j.text.length; } }
const seedOnly = [...seedJobs].filter((k) => !blobJobs.has(k)).length;
console.log(`${lang}/${level} horen · Blobs: ${blobRecs.length} partes (${idx.length} en indice) · seed: ${seedRecs.length} · ids comunes ${[...blobIds].filter((i) => seedIds.has(i)).length}`);
console.log(`  textos de audio en Blobs: ${blobJobs.size} · iguales en seed ${inSeed} · solo en Blobs ${blobOnly} · solo en seed ${seedOnly}`);
console.log(`  de lo de Blobs, sin audio en cache: ${missingAudio} clips, ${missingChars} caracteres`);
if (process.argv.includes('--dump')) fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), `pool-blob-${lang}-${level}.json`), JSON.stringify(blobRecs));
