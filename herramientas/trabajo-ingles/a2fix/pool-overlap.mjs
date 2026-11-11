// READ-ONLY. How many pool clips missing from the LOCAL cache are already in production (tts:* keys)?
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [W0, lang, level] = process.argv.slice(2);
const W = W0.split(String.fromCharCode(92)).join('/'); process.chdir(W);
const require = createRequire(W + '/package.json');
const { loadEnvFile } = await import('file:///' + W + '/scripts/lib/loadEnv.mjs'); loadEnvFile();
const { cacheKey, readCache } = await import('file:///' + W + '/scripts/lib/ttsCache.mjs');
const { collectExamTtsJobs, sanitizeTtsText } = await import('file:///' + W + '/scripts/lib/ttsJobs.mjs');
const PF = require(W + '/js/engine/personalLesenPoolFallback.js');
const { loadBlueprintFile } = require(W + '/netlify/functions/lib/hybridExamChunkPrompt.js');
const { getStore } = require('@netlify/blobs');
const store = getStore({ name: 'lexicoil-data', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN });
const blueprint = loadBlueprintFile(lang, level);
const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const recs = JSON.parse(fs.readFileSync(path.join(here, `pool-blob-${lang}-${level}.json`), 'utf8'));
const prod = new Set(((await store.list({ prefix: 'tts:' })).blobs || []).map((b) => b.key));
const seen = new Set(); let missLocal = 0, missLocalInProd = 0, charsInProd = 0, missBoth = 0, charsBoth = 0;
for (const rec of recs) {
  const part = PF.reusablePartToHorenPart(rec, blueprint); if (!part) continue;
  for (const j of collectExamTtsJobs({ id: 'pool:' + rec.id, horenParts: [part] }, lang)) {
    const text = sanitizeTtsText(j.text); const k = cacheKey(j.voice, text); if (seen.has(k)) continue; seen.add(k);
    if (readCache(j.voice, text, lang)) continue;
    missLocal++;
    if (prod.has(k)) { missLocalInProd++; charsInProd += text.length; } else { missBoth++; charsBoth += text.length; }
  }
}
console.log(`tts:* en prod ${prod.size} · sin clip local ${missLocal}: ya en prod ${missLocalInProd} (${charsInProd} car.) · en ningun sitio ${missBoth} (${charsBoth} car.)`);
