// A/B Flash vs Pro: same prompt (same seeded topic) for both models, same normalizer + conformance gate
// + validate-batch as generate-batch-gemini.mjs. Writes only here (out/<model>/), never to the bank.
// Usage: node gen-ab.mjs [reps=3]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const W = process.env.AB_WORKTREE || 'C:/Danilo/Programas/LEXICOIL/lexiloop-en';
const TAG = process.env.AB_TAG || '';
const imp = (p) => import('file:///' + W + '/scripts/lib/' + p);
const { loadEnvFile } = await imp('loadEnv.mjs');
loadEnvFile();
const { buildBatchParams, buildMasterPrompt, loadPools } = await imp('batchParams.mjs');
const { generateContent } = await imp('geminiClient.mjs');
const { extractJson } = await imp('extractJson.mjs');
const { normalizeBatch } = await imp('normalizeBatch.mjs');
const { gateBatchBeforeWrite } = await imp('generateConformanceGate.mjs');
const require = createRequire(import.meta.url);
const EB = require(W + '/js/library/ExamBlueprint.js');
const blueprint = JSON.parse(fs.readFileSync(`${W}/library/blueprints/${EB.INDEX.en_B1}.json`, 'utf8'));

const REPS = Number(process.argv[2] || 3);
const PARTS = process.env.AB_PARTS ? process.env.AB_PARTS.split(',').map((x) => [x.split(':')[0], Number(x.split(':')[1])]) : [['lesen', 4], ['lesen', 5], ['lesen', 6], ['horen', 2], ['horen', 4]];
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro'];
const PRICE = { 'gemini-2.5-flash': [0.30, 2.50], 'gemini-2.5-pro': [1.25, 10.0] }; // $/M in, out(incl. thinking)
const MAX_TOKENS = 32768; // generous for both: 2.5 Pro spends thinking tokens out of this budget

function seeded(seed) { let s = seed >>> 0; for (let i = 0; i < 8; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; } return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const RUNS = `runs${TAG}.json`;
const pools = loadPools('en');
const log = fs.existsSync(RUNS) ? JSON.parse(fs.readFileSync(RUNS, 'utf8')) : [];
const done = new Set(log.map((r) => r.key));
const realRandom = Math.random;

for (const [module, teil] of PARTS) {
  for (let rep = 0; rep < REPS; rep++) {
    Math.random = seeded(1000 * teil + (module === 'horen' ? 500 : 0) + rep * 7 + 3);
    const params = buildBatchParams(pools, 'en', { level: 'B1', module, teil: String(teil) });
    Math.random = realRandom;
    const prompt = buildMasterPrompt('en', params);
    for (const model of MODELS) {
      const key = `${module}-t${teil}-r${rep}-${model}`;
      if (done.has(key)) continue;
      const dir = `out${TAG}/${model}`; fs.mkdirSync(dir, { recursive: true });
      const file = `${dir}/${module}-t${teil}-r${rep}-${params.slug}.json`;
      const rec = { key, model, module, teil, rep, topic: params.topic, slug: params.slug, file };
      const t0 = Date.now();
      try {
        const r = await generateContent({ prompt, model, maxTokens: MAX_TOKENS });
        const u = r.usage || {};
        rec.ms = Date.now() - t0;
        rec.tokIn = u.promptTokenCount || 0; rec.tokOut = u.candidatesTokenCount || 0; rec.tokThink = u.thoughtsTokenCount || 0;
        rec.usd = (rec.tokIn * PRICE[model][0] + (rec.tokOut + rec.tokThink) * PRICE[model][1]) / 1e6;
        const batch = normalizeBatch(extractJson(r.text), { lang: 'en', level: 'B1', module, teil });
        const conf = gateBatchBeforeWrite(batch, blueprint);
        rec.conformant = conf.ok;
        if (!conf.ok) rec.confReasons = conf.items.filter((i) => !i.ok).map((i) => `${i.id}: ${i.reasons.join('; ')}`);
        fs.writeFileSync(file, JSON.stringify(batch, null, 2) + '\n');
        try { execSync(`node scripts/validate-batch.mjs --lang en --level B1 --file "${path.resolve(file)}"`, { cwd: W, stdio: 'pipe' }); rec.valid = true; }
        catch (e) { rec.valid = false; rec.validOut = String(e.stdout || '').split('\n').filter((l) => /✗|ERROR|error|FAIL/i.test(l)).slice(0, 8); }
      } catch (e) { rec.ms = Date.now() - t0; rec.error = e.message.slice(0, 300); }
      console.log(JSON.stringify({ key, topic: rec.topic, ms: rec.ms, think: rec.tokThink, out: rec.tokOut, usd: rec.usd?.toFixed(4), conf: rec.conformant, valid: rec.valid, err: rec.error }));
      log.push(rec); fs.writeFileSync(RUNS, JSON.stringify(log, null, 1));
    }
  }
}
