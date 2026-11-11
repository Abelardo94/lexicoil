// READ-ONLY. GET /.netlify/functions/tts for every Hören clip of the production pool (dumped list),
// the way the app asks for it. GET only reads the cache: {found:true,audioBase64} = present.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [W0, lang, level] = process.argv.slice(2);
const W = W0.split(String.fromCharCode(92)).join('/'); process.chdir(W);
const require = createRequire(W + '/package.json');
const { collectExamTtsJobs } = await import('file:///' + W + '/scripts/lib/ttsJobs.mjs');
const PF = require(W + '/js/engine/personalLesenPoolFallback.js');
const { loadBlueprintFile } = require(W + '/netlify/functions/lib/hybridExamChunkPrompt.js');
const blueprint = loadBlueprintFile(lang, level);
const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const recs = JSON.parse(fs.readFileSync(path.join(here, `pool-blob-${lang}-${level}.json`), 'utf8'));
const jobs = []; const seen = new Set();
for (const rec of recs) {
  const part = PF.reusablePartToHorenPart(rec, blueprint); if (!part) continue;
  for (const j of collectExamTtsJobs({ id: 'pool:' + rec.id, horenParts: [part] }, lang)) { const k = j.voice + '|' + j.text; if (!seen.has(k)) { seen.add(k); jobs.push({ ...j, part: rec.id }); } }
}
let next = 0, ok = 0, missing = 0, err = 0; const missParts = new Set(); const errs = [];
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    const url = `https://www.lexicoil.com/.netlify/functions/tts?lang=${lang}&voice=${encodeURIComponent(j.voice)}&text=${encodeURIComponent(j.text)}`;
    let kind;
    try {
      let r = null;
      for (let t = 0; t < 8; t++) { try { r = await fetch(url); } catch (e) { r = null; if (t === 7) throw e; } if (r && r.status !== 429) break; await new Promise((ok2) => setTimeout(ok2, 4000 * (t + 1))); }
      const body = await r.text(); let js = null; try { js = JSON.parse(body); } catch {}
      kind = js && js.found === true && String(js.audioBase64 || '').length > 1300 ? 'ok' : js && js.found === false ? 'missing' : 'err ' + r.status;
    } catch (e) { kind = 'err ' + e.message; }
    if (kind === 'ok') ok++; else if (kind === 'missing') { missing++; missParts.add(j.part); } else { err++; errs.push(kind); }
  }
}
await Promise.all(Array.from({ length: 2 }, worker));
console.log(`${lang}/${level} piscina: ${jobs.length} clips · responden ${ok} · faltan ${missing} (en ${missParts.size} partes) · errores ${err}`);
if (errs.length) console.log(errs.slice(0, 5).join(' | '));
