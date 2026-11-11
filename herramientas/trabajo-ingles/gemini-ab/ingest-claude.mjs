// Takes the raw answers written by the Claude generator subagents (claude-raw/<name>.txt) through the SAME
// extractJson + normalizeBatch + conformance gate + validate-batch as gen-ab.mjs. Writes out-claude/claude-opus/.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const W = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en';
const imp = (p) => import('file:///' + W + '/scripts/lib/' + p);
const { extractJson } = await imp('extractJson.mjs');
const { normalizeBatch } = await imp('normalizeBatch.mjs');
const { gateBatchBeforeWrite } = await imp('generateConformanceGate.mjs');
const require = createRequire(import.meta.url);
const EB = require(W + '/js/library/ExamBlueprint.js');
const blueprint = JSON.parse(fs.readFileSync(`${W}/library/blueprints/${EB.INDEX.en_B1}.json`, 'utf8'));
const model = 'claude-opus';
const list = JSON.parse(fs.readFileSync('claude-prompts/list.json', 'utf8'));
const dir = `out-claude/${model}`; fs.mkdirSync(dir, { recursive: true });
const runs = [];
for (const it of list) {
  const rec = { key: `${it.module}-t${it.teil}-r${it.rep}-${model}`, model, module: it.module, teil: it.teil, rep: it.rep, topic: it.topic, slug: it.slug, file: `${dir}/${it.name}.json` };
  const raw = `claude-raw/${it.name}.txt`;
  if (!fs.existsSync(raw)) { rec.error = 'no raw output'; runs.push(rec); console.log(rec.key, 'MISSING'); continue; }
  try {
    const obj = extractJson(fs.readFileSync(raw, 'utf8'));
    const q0 = obj.questions?.[0] || {};
    if (!String(q0.id || '').includes(it.slug)) rec.slugMismatch = q0.id; // subagent answered a different prompt?
    const batch = normalizeBatch(obj, { lang: 'en', level: 'B1', module: it.module, teil: it.teil });
    const conf = gateBatchBeforeWrite(batch, blueprint);
    rec.conformant = conf.ok;
    if (!conf.ok) rec.confReasons = conf.items.filter((i) => !i.ok).map((i) => `${i.id}: ${i.reasons.join('; ')}`);
    fs.writeFileSync(rec.file, JSON.stringify(batch, null, 2) + '\n');
    try { execSync(`node scripts/validate-batch.mjs --lang en --level B1 --file "${path.resolve(rec.file)}"`, { cwd: W, stdio: 'pipe' }); rec.valid = true; }
    catch (e) { rec.valid = false; rec.validOut = String(e.stdout || '').split('\n').filter((l) => /✗|ERROR|error|FAIL/i.test(l)).slice(0, 8); }
  } catch (e) { rec.error = e.message.slice(0, 300); }
  runs.push(rec);
  console.log(rec.key, rec.error ? 'ERROR ' + rec.error : `conf=${rec.conformant} valid=${rec.valid}${rec.slugMismatch ? ' SLUG? ' + rec.slugMismatch : ''}`, (rec.confReasons || rec.validOut || []).join(' | '));
}
fs.writeFileSync('runs-claude.json', JSON.stringify(runs, null, 1));
