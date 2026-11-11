// node pool-tts-size.mjs <worktree> <lang> <level> : clips and characters still missing from the TTS cache for
// the served exams + the Hören parts of the reusable pool, collected exactly like pregenerate-tts --pool.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [W0, lang, level] = process.argv.slice(2); const W = W0.replace(/\\/g, '/'); process.chdir(W);
const require = createRequire(W + '/package.json');
const { readCache } = await import('file:///' + W + '/scripts/lib/ttsCache.mjs');
const { resolveServedExams } = await import('file:///' + W + '/scripts/lib/servedExams.mjs');
const { collectExamTtsJobs, sanitizeTtsText } = await import('file:///' + W + '/scripts/lib/ttsJobs.mjs');
const PF = require(W + '/js/engine/personalLesenPoolFallback.js');
const { loadBlueprintFile } = require(W + '/netlify/functions/lib/hybridExamChunkPrompt.js');
const blueprint = loadBlueprintFile(lang, level);
const seedFile = path.join(W, 'library/reusable-seed', `${lang}_${level}.json`);
const seed = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, 'utf8')) : [];
const pool = (seed.records || seed).filter((r) => r.module === 'horen').map((rec) => {
  const part = PF.reusablePartToHorenPart(rec, blueprint); return part ? { id: 'pool:' + rec.id, horenParts: [part] } : null;
}).filter(Boolean);
const served = (await resolveServedExams(lang, level)).exams;
const seen = new Set(); const tally = { served: [0, 0, 0], pool: [0, 0, 0] };
for (const [kind, exams] of [['served', served], ['pool', pool]]) {
  for (const e of exams) for (const j of collectExamTtsJobs(e, lang)) {
    const clean = sanitizeTtsText(j.text); const k = j.voice + '|' + clean;
    if (seen.has(k)) continue; seen.add(k);
    tally[kind][0]++;
    if (!readCache(j.voice, clean, lang)) { tally[kind][1]++; tally[kind][2] += clean.length; }
  }
}
console.log(`${lang}/${level} · pool: ${pool.length} partes Hören · servidos: ${tally.served[0]} clips, faltan ${tally.served[1]} (${tally.served[2]} car.) · piscina: ${tally.pool[0]} clips nuevos, faltan ${tally.pool[1]} (${tally.pool[2]} car.)`);
