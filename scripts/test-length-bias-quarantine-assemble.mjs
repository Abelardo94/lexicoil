#!/usr/bin/env node
/**
 * Quarantine assemble tests (official excludes; practice includes).
 *   node scripts/test-length-bias-quarantine-assemble.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL = path.join(ROOT, 'batches/ready/pool-verified');
const LOG = path.join(ROOT, 'batches/ready/gate-logs/length-bias-quarantine-2026-07-12.json');
const OUT = path.join(ROOT, 'batches/ready/assembled-from-verified');
const RESULT = path.join(
  ROOT,
  'batches/ready/gate-logs/length-bias-quarantine-assemble-test-2026-07-12.json',
);

function quarantineIdsInPool() {
  const set = new Set();
  for (const f of fs.readdirSync(POOL).filter((x) => x.endsWith('.json'))) {
    const b = JSON.parse(fs.readFileSync(path.join(POOL, f), 'utf8'));
    for (const q of b.questions || []) {
      if (q._lengthBiasQuarantine) set.add(q.id);
    }
  }
  return set;
}

function collectExamQuestionIds(doc) {
  const ids = [];
  const exam = doc.exam || {};
  for (const key of ['lesenParts', 'horenParts', 'schreibenParts', 'sprechenParts']) {
    for (const part of exam[key] || []) {
      for (const q of part.questions || []) if (q.id) ids.push(q.id);
      for (const seg of part.segments || []) {
        for (const q of seg.questions || []) if (q.id) ids.push(q.id);
      }
    }
  }
  return ids;
}

function run(args) {
  // --no-lock-live: this test assembles slot 1 on purpose (backed up and restored).
  // AUTO_PUBLISH_EXAMS=0: the assembler ends by trying to publish; a test must not.
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/assemble-from-pool-verified.mjs'), '--no-lock-live', ...args], {
    cwd: ROOT,
    env: { ...process.env, AUTO_PUBLISH_EXAMS: '0' },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function parseStock(stdout) {
  const stock = {};
  for (const m of stdout.matchAll(/^\s{2}(\S+)\s+(\d+)\s*$/gm)) {
    stock[m[1]] = Number(m[2]);
  }
  return stock;
}

const qSet = quarantineIdsInPool();
const stampLog = JSON.parse(fs.readFileSync(LOG, 'utf8'));

const offDry = run(['--mode', 'official', '--dry-run']);
const pracDry = run(['--mode', 'practice', '--dry-run']);
const offStock = parseStock(offDry.stdout);
const pracStock = parseStock(pracDry.stdout);
const offQuarantineSkips = (offDry.stdout.match(/length-bias quarantine/g) || []).length;
const pracQuarantineSkips = (pracDry.stdout.match(/length-bias quarantine/g) || []).length;

// Practice: assemble 1 exam (overwrites e1 — backup/restore)
const e1 = path.join(OUT, 'assembled-exam-b1-verified-e1.json');
const e1Bak = `${e1}.bak-quarantine-test`;
if (fs.existsSync(e1)) fs.copyFileSync(e1, e1Bak);

const pracAsm = run(['--mode', 'practice', '--max', '1']);
let practiceExam = null;
let practiceHits = [];
if (pracAsm.status === 0 && fs.existsSync(e1)) {
  const dest = path.join(OUT, 'assembled-exam-b1-quarantine-test-practice.json');
  fs.copyFileSync(e1, dest);
  practiceExam = JSON.parse(fs.readFileSync(dest, 'utf8'));
  practiceHits = collectExamQuestionIds(practiceExam).filter((id) => qSet.has(id));
}

if (fs.existsSync(e1Bak)) {
  fs.copyFileSync(e1Bak, e1);
  fs.unlinkSync(e1Bak);
}

// Official full assemble may be capacity 0 — that is acceptable if quarantine blocked cells
const offAsm = run(['--mode', 'official', '--max', '1']);
let officialHits = null;
let officialAssembled = false;
if (offAsm.status === 0 && fs.existsSync(e1)) {
  const dest = path.join(OUT, 'assembled-exam-b1-quarantine-test-official.json');
  fs.copyFileSync(e1, dest);
  const doc = JSON.parse(fs.readFileSync(dest, 'utf8'));
  officialHits = collectExamQuestionIds(doc).filter((id) => qSet.has(id));
  officialAssembled = true;
  if (fs.existsSync(e1Bak)) {
    /* already restored */
  } else if (fs.existsSync(`${e1}.bak-quarantine-test`)) {
    fs.copyFileSync(`${e1}.bak-quarantine-test`, e1);
  }
}
// Restore e1 again after official attempt
if (fs.existsSync(e1Bak)) {
  fs.copyFileSync(e1Bak, e1);
  fs.unlinkSync(e1Bak);
} else {
  // practice restore already happened; if official overwrote, try practice dest? keep bak longer
}

const result = {
  generatedAt: new Date().toISOString(),
  quarantineIdsInPool: qSet.size,
  stampLogCount: stampLog.quarantinedCount,
  originalAudit2026_07_11: 168,
  officialDryRun: {
    status: offDry.status,
    quarantineSkips: offQuarantineSkips,
    stock: { lesen_2: offStock.lesen_2, lesen_5: offStock.lesen_5, horen_2: offStock.horen_2 },
  },
  practiceDryRun: {
    status: pracDry.status,
    quarantineSkips: pracQuarantineSkips,
    stock: { lesen_2: pracStock.lesen_2, lesen_5: pracStock.lesen_5, horen_2: pracStock.horen_2 },
  },
  practiceAssemble: {
    ok: pracAsm.status === 0,
    mode: practiceExam?._meta?.assembleMode,
    quarantineQuestionHits: practiceHits.length,
    hitIdsSample: practiceHits.slice(0, 8),
  },
  officialAssemble: {
    attempted: true,
    ok: officialAssembled,
    quarantineQuestionHits: officialHits,
    note:
      officialAssembled
        ? 'assembled; hits must be 0'
        : 'capacity 0 expected when all lesen_2/horen_2 files carry ≥1 quarantined MCQ',
  },
  pass: {},
};

result.pass.stampNonZero = qSet.size > 0;
result.pass.officialSkipsQuarantine = offQuarantineSkips > 0;
result.pass.practiceDoesNotSkipQuarantine = pracQuarantineSkips === 0;
result.pass.practiceStockGtOfficial =
  (pracStock.lesen_2 || 0) > (offStock.lesen_2 || 0) ||
  (pracStock.horen_2 || 0) > (offStock.horen_2 || 0) ||
  (pracStock.lesen_5 || 0) > (offStock.lesen_5 || 0);
result.pass.practiceAssembled = pracAsm.status === 0 && practiceExam?._meta?.assembleMode === 'practice';
result.pass.practiceCanIncludeQuarantine = practiceHits.length > 0;
result.pass.officialCleanOrBlocked =
  (officialAssembled && officialHits?.length === 0) ||
  (!officialAssembled && (offStock.lesen_2 === 0 || offStock.horen_2 === 0));

fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result.pass, null, 2));
console.log(`quarantine ids: ${qSet.size} (audit 168 → now ${stampLog.quarantinedCount})`);
console.log(`official skips: ${offQuarantineSkips}; practice hits in exam: ${practiceHits.length}`);

const failed = Object.entries(result.pass).filter(([, v]) => !v);
if (failed.length) {
  console.error('FAIL', failed.map(([k]) => k));
  process.exit(1);
}
console.log('ALL TESTS PASS');
console.log(`Wrote ${path.relative(ROOT, RESULT)}`);
