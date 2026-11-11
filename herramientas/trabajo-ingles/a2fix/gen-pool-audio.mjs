// node gen-pool-audio.mjs <worktree> <lang> <level> <maxChars> [--apply]
// Generates TTS for the Hören parts of the PRODUCTION pool (pool-blob-<lang>-<level>.json, dumped
// read-only from Netlify Blobs by pool-blob-vs-seed.mjs --dump), with the exact conversion the app
// and pregenerate-tts --pool use, so the cache keys are the ones production will ask for.
// Production serves the pool from Blobs only (poolSourceMode.js), so seed-only texts are skipped.
// Whole parts only, Teile interleaved (T1,T2,T3,T4,T1…) so the budget spreads across the module;
// stops before the next part would exceed maxChars. Dry by default.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [W0, lang, level, maxCharsArg] = process.argv.slice(2);
const W = W0.split(String.fromCharCode(92)).join('/'); process.chdir(W);
const apply = process.argv.includes('--apply'); const maxChars = Number(maxCharsArg);
const require = createRequire(W + '/package.json');
const { loadEnvFile } = await import('file:///' + W + '/scripts/lib/loadEnv.mjs'); loadEnvFile();
const { readCache, writeCache } = await import('file:///' + W + '/scripts/lib/ttsCache.mjs');
const { collectExamTtsJobs, sanitizeTtsText } = await import('file:///' + W + '/scripts/lib/ttsJobs.mjs');
const { synthesize, isProviderConfigured } = require(W + '/netlify/functions/lib/ttsProvider.js');
const PF = require(W + '/js/engine/personalLesenPoolFallback.js');
const { loadBlueprintFile } = require(W + '/netlify/functions/lib/hybridExamChunkPrompt.js');
const blueprint = loadBlueprintFile(lang, level);
const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const recs = JSON.parse(fs.readFileSync(path.join(here, `pool-blob-${lang}-${level}.json`), 'utf8'));

// Missing jobs per part (deduped across parts: a text shared by two parts is paid once).
const seen = new Set(); const parts = [];
for (const rec of recs.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
  const part = PF.reusablePartToHorenPart(rec, blueprint); if (!part) continue;
  const jobs = [];
  for (const j of collectExamTtsJobs({ id: 'pool:' + rec.id, horenParts: [part] }, lang)) {
    const text = sanitizeTtsText(j.text); const k = j.voice + '|' + text;
    if (seen.has(k)) continue; seen.add(k);
    if (!readCache(j.voice, text, lang)) jobs.push({ voice: j.voice, text });
  }
  if (jobs.length) parts.push({ id: rec.id, teil: Number(rec.teil), jobs, chars: jobs.reduce((a, j) => a + j.text.length, 0) });
}
const byTeil = {}; for (const p of parts) (byTeil[p.teil] = byTeil[p.teil] || []).push(p);
const order = []; const teile = Object.keys(byTeil).sort();
for (let i = 0; order.length < parts.length; i++) for (const t of teile) if (byTeil[t][i]) order.push(byTeil[t][i]);
const chosen = []; let budget = 0;
for (const p of order) { if (budget + p.chars > maxChars) break; chosen.push(p); budget += p.chars; }
const allChars = parts.reduce((a, p) => a + p.chars, 0);
const perTeil = {}; for (const p of chosen) perTeil['T' + p.teil] = (perTeil['T' + p.teil] || 0) + 1;
console.log(`${lang}/${level} pool (Blobs): ${parts.length} partes con audio pendiente, ${parts.reduce((a, p) => a + p.jobs.length, 0)} clips, ${allChars} car.`);
console.log(`Presupuesto ${maxChars} car. -> ${chosen.length} partes ${JSON.stringify(perTeil)}, ${chosen.reduce((a, p) => a + p.jobs.length, 0)} clips, ${budget} car.`);
if (!apply) { console.log('SECO (pasa --apply para generar)'); process.exit(0); }
if (!isProviderConfigured()) { console.error('TTS provider no configurado (.env)'); process.exit(1); }
let ok = 0, fail = 0, done = 0; const failed = [];
for (const p of chosen) {
  for (const j of p.jobs) {
    let audio = null;
    for (let a = 0; a < 4 && !(audio && audio.length); a++) { if (a) await new Promise((r) => setTimeout(r, 1500 * a)); audio = await synthesize(j.text, j.voice, lang); }
    if (audio && audio.length) { writeCache(j.voice, j.text, audio); ok++; } else { fail++; failed.push(p.id + ' ' + j.text.slice(0, 40)); }
    if (++done % 50 === 0) console.log(`  ${done} · ok ${ok} · fallos ${fail}`);
    await new Promise((r) => setTimeout(r, 120));
  }
  if (fail >= 8 && ok === 0) { console.error('Demasiados fallos seguidos, paro.'); break; }
}
console.log(`Generados ${ok} · fallos ${fail}`); if (failed.length) console.log(failed.slice(0, 10).join('\n'));
