#!/usr/bin/env node
/**
 * Smoke: Textos picks must never return official-reserved partIds (A2 Lesen).
 *
 *   POOL_ALLOW_LOCAL_SEED=1 node scripts/smoke-textos-pick-a2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './lib/loadEnv.mjs';

process.env.POOL_ALLOW_LOCAL_SEED = '1';

const require = createRequire(import.meta.url);
const { pickTextosReading } = require(path.join(ROOT, 'netlify/functions/lib/textosPick.js'));
const {
  loadOfficialReservedIndex,
  reservedPartIdSet,
} = require(path.join(ROOT, 'netlify/functions/lib/officialReservedIndex.js'));
const { clearAllPoolCaches } = require(path.join(
  ROOT,
  'netlify/functions/lib/poolSearchCache.js',
));
const { A2_OFFICIAL_TOPICS } = require(path.join(ROOT, 'js/data/a2Topics.js'));

const index = loadOfficialReservedIndex({ lang: 'de', level: 'A2', root: ROOT, refresh: true });
if (!index) {
  console.error('FAIL: official index missing — run node scripts/build-official-reserved-index.mjs --lang de --level A2');
  process.exit(1);
}

const reserved = reservedPartIdSet(index);
const violations = [];
const picks = [];
const topics = [...A2_OFFICIAL_TOPICS];

clearAllPoolCaches();

for (const topicTag of topics) {
  for (const teil of [1, 2, 3, 4]) {
    const result = await pickTextosReading(null, {
      lang: 'de',
      level: 'A2',
      module: 'lesen',
      topicTag,
      teil,
    });
    if (result.status !== 200) continue;
    const { id, reading } = result.body;
    if (reserved.has(id)) {
      violations.push({ topicTag, teil, id });
    }
    if (JSON.stringify(result.body).match(/"questions"|"correct"|"explanation"/)) {
      violations.push({ topicTag, teil, id, leak: 'answer_fields' });
    }
    if (!reading?.passageText) {
      violations.push({ topicTag, teil, id, leak: 'empty_passage' });
    }
    picks.push({ topicTag, teil, id, wordCount: reading.wordCount });
  }
}

const gateLog = {
  script: 'smoke-textos-pick-a2.mjs',
  at: new Date().toISOString(),
  liveExamCount: index.liveExamCount,
  reservedPartCount: index.reservedPartIds?.length ?? 0,
  topicsTried: topics.length,
  successfulPicks: picks.length,
  violations,
  samplePicks: picks.slice(0, 8),
  ok: violations.length === 0,
};

const logDir = path.join(ROOT, 'batches', 'ready', 'gate-logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `smoke-textos-pick-a2-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(logPath, JSON.stringify(gateLog, null, 2));

if (violations.length) {
  console.error('SMOKE FAIL', violations);
  process.exit(1);
}

console.log(JSON.stringify(gateLog, null, 2));
console.log(`\nSMOKE OK — gate log: ${path.relative(ROOT, logPath)}`);
