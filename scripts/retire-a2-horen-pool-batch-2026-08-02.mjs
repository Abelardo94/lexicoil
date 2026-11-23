#!/usr/bin/env node
/**
 * Retira archivos Hören A2 del pool servible (pool-verified + reusable-seed).
 *   node scripts/retire-a2-horen-pool-batch-2026-08-02.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/loadEnv.mjs';

const FILES = [
  {
    file: 'horen-t1-gemini-073.json',
    seedIds: ['horen-t1-gemini-073'],
    reasons: [
      'Q1 ambiguous: options b and c both supported by Text 1 (external review + PASO 1)',
    ],
  },
  {
    file: 'horen-t4-gemini-043.json',
    seedIds: ['horen-t4-gemini-043'],
    reasons: ['B1 register / CEFR miscalibration (Herausforderung, zu-Infinitiv, Sendungs-Intro)'],
  },
  {
    file: 'horen-t4-gemini-044.json',
    seedIds: ['horen-t4-gemini-044'],
    reasons: ['B1 register / CEFR miscalibration (same family as 043)'],
  },
  {
    file: 'horen-t4-gemini-045.json',
    seedIds: ['horen-t4-gemini-045'],
    reasons: ['B1 register post-diagnosis (Experte, Herausforderung, kritisch zu sein)'],
  },
];

const poolDir = path.join(ROOT, 'batches/ready/pool-verified/A2');
const needsDir = path.join(ROOT, 'batches/needs-regeneration/A2');
const seedPath = path.join(ROOT, 'library/reusable-seed/de_A2.json');
const at = new Date().toISOString();

const log = { at, files: [], seedRecordsBefore: null, seedRecordsAfter: null };

fs.mkdirSync(needsDir, { recursive: true });

for (const entry of FILES) {
  const row = { file: entry.file, reasons: entry.reasons, poolVerifiedRemoved: false, seedRemoved: false };
  const poolSrc = path.join(poolDir, entry.file);
  if (fs.existsSync(poolSrc)) {
    const batch = JSON.parse(fs.readFileSync(poolSrc, 'utf8'));
    batch._poolRetiredAt = at;
    batch._poolRetiredReason = 'operator-retire-2026-08-02-horen-a2-calibration-q1-ambiguity';
    batch._poolRetiredFrom = `pool-verified/A2/${entry.file}`;
    batch._notServableUntil = 'horen A2 CEFR/register gate + content fix';
    fs.writeFileSync(path.join(needsDir, entry.file), `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
    fs.unlinkSync(poolSrc);
    row.poolVerifiedRemoved = true;
  }
  log.files.push(row);
}

const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
log.seedRecordsBefore = seed.records?.length ?? 0;
const retireIds = new Set(FILES.flatMap((f) => f.seedIds));
const retireFiles = new Set(FILES.map((f) => f.file));
seed.records = (seed.records || []).filter(
  (r) => !retireIds.has(r.id) && !retireFiles.has(path.basename(String(r.sourceFile || ''))),
);
log.seedRecordsAfter = seed.records.length;
log.seedRemoved = log.seedRecordsAfter < log.seedRecordsBefore;
fs.writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

const out = path.join(ROOT, 'batches/ready/gate-logs/retire-a2-horen-pool-batch-2026-08-02-evidence.json');
fs.writeFileSync(out, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(log, null, 2));
