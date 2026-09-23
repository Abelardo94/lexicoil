#!/usr/bin/env node
/**
 * Rebuild assembled exam JSON from current pool-verified (same partIds/sources).
 *   node scripts/reassemble-verified-from-pool.mjs --level A2 --slots 1,2,3,4
 */
import { batchToRecord } from './lib/assembledPoolLoad.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/loadEnv.mjs';
import { poolVerifiedDir, normalizeLevel } from './lib/batchPaths.mjs';
import { normalizeBatch } from './lib/normalizeBatch.mjs';
import { buildLesenSeedRecordFromBatch } from './lib/publishToPool.mjs';
import { buildExamPartsFromPicked, oralTeilsForLevel } from './lib/examLevelCells.mjs';
import { isExamPublishable, partRecordToExamPart } from './audit-pass-2.mjs';
import { assembledExamPath } from './lib/verifiedExamPublishLib.mjs';
import { auditAssembledFreshness } from './lib/assembledExamFreshness.mjs';

function parseArgs(argv) {
  const out = { level: 'A2', slots: [1, 2, 3, 4] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--level') out.level = normalizeLevel(argv[++i]);
    else if (argv[i] === '--slots') {
      out.slots = String(argv[++i] || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    }
  }
  return out;
}

function oralBundleToParts(batch, file, module, level) {
  const lv = normalizeLevel(level);
  const base = file.replace(/\.json$/i, '');
  const schreibenWords =
    lv === 'A2'
      ? { 1: { min: 20, max: 30 }, 2: { min: 30, max: 40 } }
      : { 1: { min: 80, max: 120 }, 2: { min: 80, max: 120 }, 3: { min: 40, max: 60 } };
  const parts = [];
  for (const teil of oralTeilsForLevel(module, lv)) {
    const qs = (batch.questions || []).filter((q) => Number(q.teil) === teil);
    if (!qs.length) continue;
    const rec = {
      id: `${base}-t${teil}`,
      module,
      teil,
      lang: 'de',
      level: lv,
      questions: qs,
      instruction: qs[0]?.question || '',
      task: qs[0]?.question || '',
      topicTag: batch.topicTag || qs[0]?.topicTags?.[0],
      complete: true,
      verified: true,
      ...(module === 'schreiben'
        ? {
            minWords: (schreibenWords[teil] || { min: 80, max: 120 }).min,
            maxWords: (schreibenWords[teil] || { min: 80, max: 120 }).max,
          }
        : {}),
    };
    parts.push({
      cell: `${module}_${teil}`,
      id: rec.id,
      file,
      record: rec,
      part: partRecordToExamPart(rec),
    });
  }
  return parts;
}

function loadPartFromPool(cell, partId, sources, level) {
  const POOL = poolVerifiedDir(level);
  const srcFile = sources[cell];
  const fp = path.join(POOL, srcFile);
  if (!fs.existsSync(fp)) throw new Error(`missing pool file ${srcFile} for ${cell}`);
  let batch = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const [module, teilStr] = cell.split('_');
  const teil = Number(teilStr);
  if (module === 'schreiben' || module === 'sprechen') {
    const parts = oralBundleToParts(batch, srcFile, module, level);
    const hit = parts.find((p) => p.id === partId);
    if (!hit) throw new Error(`Oral part ${partId} not in ${srcFile}`);
    return hit;
  }
  batch = normalizeBatch(batch, { module, teil, lang: 'de', level: normalizeLevel(level) });
  const rec = batchToRecord(batch, srcFile.replace(/\.json$/i, ''), module, teil, level);
  if (rec.id !== partId) rec.id = partId;
  return { cell, id: partId, file: srcFile, record: rec, part: partRecordToExamPart(rec) };
}

const args = parseArgs(process.argv.slice(2));
const report = { at: new Date().toISOString(), level: args.level, slots: [], before: [], after: [] };

for (const slot of args.slots) {
  const asmPath = assembledExamPath(slot, args.level);
  report.before.push(auditAssembledFreshness(asmPath, args.level));
  const prev = JSON.parse(fs.readFileSync(asmPath, 'utf8'));
  const { partIds, sources, topics, poolCells } = prev._meta;
  const picked = {};
  for (const [cell, partId] of Object.entries(partIds)) {
    picked[cell] = loadPartFromPool(cell, partId, sources, args.level);
  }
  const exam = buildExamPartsFromPicked(picked, args.level);
  const gate = isExamPublishable({ exam, level: args.level }, { expectedLevel: args.level });
  const doc = {
    _meta: {
      ...prev._meta,
      generatedAt: new Date().toISOString(),
      reassembledFromPoolAt: report.at,
      reassembledFromPoolNote: 'same partIds/sources, exam body from current pool-verified',
      gate1: { ok: gate.ok, blocking: (gate.blocking || []).slice(0, 12) },
      partIds,
      sources,
      topics,
      poolCells,
    },
    lang: prev.lang || 'de',
    level: args.level,
    goetheFormat: true,
    exam,
  };
  fs.writeFileSync(asmPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  const after = auditAssembledFreshness(asmPath, args.level);
  report.after.push(after);
  report.slots.push({
    slot,
    gate1Ok: gate.ok,
    freshAfter: after.fresh,
    staleCellsAfter: after.staleCells,
  });
  console.log(
    `e${slot} GATE-1=${gate.ok ? 'PASS' : 'FAIL'} fresh=${after.fresh} staleCells=${after.staleCellCount}`,
  );
}

const out = path.join(ROOT, 'batches/ready/gate-logs/a2-reassemble-verified-evidence.json');
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('Wrote', path.relative(ROOT, out));
if (!report.after.every((a) => a.fresh)) process.exit(1);
