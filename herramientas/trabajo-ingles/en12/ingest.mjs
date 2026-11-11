// raw/<name>.txt (subagent output) -> extractJson + normalizeBatch + conformance gate + validate-batch,
// using lexiloop-en12 (main + PR #18). Writes norm/<name>.json and runs.json. Checks the slug.
import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process'; import { createRequire } from 'node:module';
const W = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en12';
const imp = (p) => import('file:///' + W + '/scripts/lib/' + p);
const { extractJson } = await imp('extractJson.mjs'); const { normalizeBatch } = await imp('normalizeBatch.mjs'); const { gateBatchBeforeWrite } = await imp('generateConformanceGate.mjs');
const require = createRequire(import.meta.url); const EB = require(W + '/js/library/ExamBlueprint.js');
const blueprint = JSON.parse(fs.readFileSync(`${W}/library/blueprints/${EB.INDEX.en_B1}.json`, 'utf8'));
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const list = JSON.parse(fs.readFileSync('prompts/list.json', 'utf8')).filter((x) => !only || only.test(x.name));
fs.mkdirSync('norm', { recursive: true });
const prev = fs.existsSync('runs.json') ? JSON.parse(fs.readFileSync('runs.json', 'utf8')) : [];
const runs = prev.filter((r) => !list.some((x) => x.name === r.name));
for (const it of list) {
  const rec = { name: it.name, exam: it.exam, module: it.module, teil: it.teil, file: `norm/${it.name}.json` };
  const raw = `raw/${it.name}.txt`;
  if (!fs.existsSync(raw)) { rec.error = 'no raw'; runs.push(rec); console.log(it.name, 'MISSING'); continue; }
  try {
    const obj = extractJson(fs.readFileSync(raw, 'utf8'));
    const ids = (obj.questions || []).map((q) => q.id).join(' ');
    if (!ids.includes(it.slug)) rec.slugMismatch = (obj.questions?.[0] || {}).id;
    const batch = normalizeBatch(obj, { lang: 'en', level: 'B1', module: it.module, teil: it.teil, stripPoolLegacy: false });
    const conf = gateBatchBeforeWrite(batch, blueprint); rec.conformant = conf.ok;
    if (!conf.ok) rec.confReasons = conf.items.filter((i) => !i.ok).map((i) => `${i.id}: ${i.reasons.join('; ')}`);
    rec.nQ = batch.questions?.length; rec.nP = batch.passages?.length;
    fs.writeFileSync(rec.file, JSON.stringify(batch, null, 2) + '\n');
    try { execSync(`node scripts/validate-batch.mjs --lang en --level B1 --file "${path.resolve(rec.file)}"`, { cwd: W, stdio: 'pipe' }); rec.valid = true; }
    catch (e) { rec.valid = false; rec.validOut = String(e.stdout || '').split('\n').filter((l) => /✗|ERROR|error|FAIL/i.test(l)).slice(0, 8); }
  } catch (e) { rec.error = e.message.slice(0, 300); }
  runs.push(rec);
  console.log(it.name.padEnd(52), rec.error ? 'ERROR ' + rec.error : `Q=${rec.nQ} P=${rec.nP} conf=${rec.conformant} valid=${rec.valid}${rec.slugMismatch ? ' SLUG? ' + rec.slugMismatch : ''}`, (rec.confReasons || rec.validOut || []).join(' | '));
}
runs.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync('runs.json', JSON.stringify(runs, null, 1));
