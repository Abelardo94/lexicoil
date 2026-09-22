#!/usr/bin/env node
/**
 * audit-exam-pool.mjs — Stock POOL-2 + capacidad GATE-1 para exámenes B1 completos.
 *
 * Escanea:
 *   - library/reusable-seed/de_B1.json (pool oficial)
 *   - batches/generated/*.json (partes generadas, aún no publicadas)
 *
 * Uso:
 *   node scripts/audit-exam-pool.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBatch } from './lib/normalizeBatch.mjs';
import { validatePart } from './lib/partGate.mjs';
import { buildLesenSeedRecordFromBatch } from './lib/publishToPool.mjs';
import {
  isExamPublishable,
  isPartPoolReady,
  partRecordToExamPart,
} from './audit-pass-2.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL_FILE = path.join(ROOT, 'library/reusable-seed/de_B1.json');
const GENERATED_DIR = path.join(ROOT, 'batches/generated');

const CELLS = { lesen: [1, 2, 3, 4, 5], horen: [1, 2, 3, 4], schreiben: [1, 2, 3] };
const CELL_KEYS = Object.entries(CELLS).flatMap(([m, ts]) => ts.map((t) => `${m}_${t}`));

const JSON_OUT = process.argv.includes('--json');
const SKIP_GENERATED = process.argv.includes('--pool-only');

function parseGeneratedName(filename) {
  const base = filename.replace(/\.json$/i, '');
  const parts = base.split('-');
  const mod = parts[0];
  const tPart = parts.find((p) => /^t\d$/i.test(p));
  const teil = tPart ? Number(tPart.slice(1)) : null;
  return { module: mod, teil };
}

function isAuditFile(name) {
  if (!name.endsWith('.json') || name.startsWith('.')) return false;
  if (/^\.tmp-|^verify-|^\.tmp-test-/i.test(name)) return false;
  return true;
}

function batchToRecord(batch, file, module, teil) {
  const mod = String(batch.module || module).toLowerCase();
  const t = Number(batch.teil ?? teil ?? batch.questions?.[0]?.teil);

  if (mod === 'lesen') {
    const rec = buildLesenSeedRecordFromBatch(batch, {
      lang: 'de',
      level: 'B1',
      teil: t,
      idPrefix: 'audit',
    });
    rec.id = batch.id || file.replace(/\.json$/i, '');
    rec._source = 'generated';
    rec._file = file;
    return rec;
  }

  const passages = batch.passages || [];
  const rec = {
    id: batch.id || file.replace(/\.json$/i, ''),
    module: mod,
    teil: t,
    questions: batch.questions || [],
    topicTag: batch.topicTag || batch._requestedTopic,
    _source: 'generated',
    _file: file,
  };

  if (mod === 'horen') {
    if (Array.isArray(batch.segments) && batch.segments.length) {
      rec.segments = batch.segments;
    } else if (passages.length > 1) {
      rec.segments = passages.map((p, i) => ({
        passageId: p.id,
        label: p.title || `Aufnahme ${i + 1}`,
        text: p.text || p.transcript || '',
        transcript: p.transcript || p.text || '',
        questions: (batch.questions || []).filter((q) => q.passageId === p.id),
      }));
    }
    rec.passage = passages[0]
      ? { title: passages[0].title, text: passages[0].text, transcript: passages[0].transcript || passages[0].text }
      : null;
    return rec;
  }

  if (mod === 'schreiben' || mod === 'sprechen') {
    rec.task = batch.task || batch.instruction || passages[0]?.text || '';
    rec.passage = passages[0] || null;
    return rec;
  }

  rec.passage = passages[0] || batch.passage || null;
  if (batch.ads) rec.ads = batch.ads;
  if (passages.length > 1) rec.passages = passages;
  return rec;
}

/** Exam part shape for GATE-1 (flattenExam-compatible). */
function batchToExamPart(batch, module, teil) {
  const mod = String(module).toLowerCase();
  const t = Number(teil);
  const record = batchToRecord(batch, batch.id || 'inline', mod, t);
  const fromRecord = partRecordToExamPart(record);
  if (!fromRecord) return null;

  if (mod === 'horen' && !fromRecord.segments?.length && (batch.passages || []).length > 1) {
    fromRecord.passages = batch.passages.map((p) => ({
      id: p.id,
      title: p.title || '',
      text: p.text || p.transcript || '',
    }));
  }
  return fromRecord;
}

async function auditPart(input, opts = {}) {
  const { module, teil, file } = opts;
  let batch = input;
  if (!Array.isArray(batch.passages) && batch.passage) {
    batch = {
      passages: batch.passages || (batch.passage ? [batch.passage] : []),
      questions: batch.questions || [],
      module: batch.module || module,
      teil: batch.teil || teil,
    };
  }

  batch = normalizeBatch(batch, { module, teil, lang: 'de', level: 'B1' });

  const gate = await validatePart(batch, {
    semantic: false,
    skipSem2: true,
    skipNormalize: true,
    skipDedup: true,
    module,
    teil,
    lang: 'de',
    level: 'B1',
    structuralCorpusDir: GENERATED_DIR,
  });

  return {
    ok: gate.ok,
    blocking: gate.blocking || [],
    topBlock: gate.blocking?.[0]?.id || null,
    message: gate.blocking?.[0]?.message || null,
    batch: gate.batch,
  };
}

function loadPoolRecords() {
  if (!fs.existsSync(POOL_FILE)) return [];
  const raw = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  return (raw.records || raw).filter((r) => r && (r.id || r.module));
}

async function auditPoolRecord(rec) {
  const part = partRecordToExamPart(rec);
  if (!part) {
    return { ok: false, blocking: [{ id: 'PARSE', message: 'partRecordToExamPart falló' }], topBlock: 'PARSE' };
  }
  const gate = await isPartPoolReady(rec, { semantic: false, skipSem2: true });
  return {
    ok: gate.ok,
    blocking: gate.blocking || [],
    topBlock: gate.blocking?.[0]?.id || null,
    message: gate.blocking?.[0]?.message || null,
    part,
  };
}

function maxDistinctExams(cleanByCell) {
  const usedIds = new Set();
  let count = 0;

  while (true) {
    const picked = {};
    for (const key of CELL_KEYS) {
      const pool = cleanByCell[key] || [];
      const chosen = pool.find((c) => !usedIds.has(c.id));
      if (!chosen) break;
      picked[key] = chosen;
    }
    if (Object.keys(picked).length !== CELL_KEYS.length) break;

    const assembled = {
      exam: {
        lesenParts: [1, 2, 3, 4, 5].map((t) => picked[`lesen_${t}`].part),
        horenParts: [1, 2, 3, 4].map((t) => picked[`horen_${t}`].part),
        schreibenParts: [1, 2, 3].map((t) => picked[`schreiben_${t}`].part),
      },
    };
    const gate = isExamPublishable(assembled);
    if (!gate.ok) break;

    count += 1;
    for (const key of CELL_KEYS) {
      usedIds.add(picked[key].id);
    }
  }

  const usedIdsReuse = new Set();
  let countWithReuse = 0;
  const overlap = {};

  for (let e = 0; e < 100; e++) {
    const picked = {};
    let missing = false;
    for (const key of CELL_KEYS) {
      const pool = cleanByCell[key] || [];
      let chosen = pool.find((c) => !usedIdsReuse.has(c.id));
      let reused = false;
      if (!chosen && pool.length) {
        chosen = pool[e % pool.length];
        reused = true;
        overlap[key] = (overlap[key] || 0) + 1;
      }
      if (!chosen) {
        missing = true;
        break;
      }
      picked[key] = { ...chosen, reused };
      if (!reused) usedIdsReuse.add(chosen.id);
    }
    if (missing) break;
    const assembled = {
      exam: {
        lesenParts: [1, 2, 3, 4, 5].map((t) => picked[`lesen_${t}`].part),
        horenParts: [1, 2, 3, 4].map((t) => picked[`horen_${t}`].part),
        schreibenParts: [1, 2, 3].map((t) => picked[`schreiben_${t}`].part),
      },
    };
    const gate = isExamPublishable(assembled);
    if (!gate.ok) break;
    countWithReuse += 1;
  }

  return { distinct: count, withReuse: countWithReuse, overlap };
}

async function main() {
  const poolRecords = loadPoolRecords();
  const poolIds = new Set(poolRecords.map((r) => r.id).filter(Boolean));

  const cleanPool = Object.fromEntries(CELL_KEYS.map((k) => [k, []]));
  const poolFail = Object.fromEntries(CELL_KEYS.map((k) => [k, []]));

  process.stderr.write(`Auditando pool (${poolRecords.length} records)…\n`);
  for (const rec of poolRecords) {
    const mod = String(rec.module || '').toLowerCase();
    const teil = Number(rec.teil);
    const key = `${mod}_${teil}`;
    if (!cleanPool[key]) continue;
    const result = await auditPoolRecord(rec);
    const entry = {
      id: rec.id,
      source: 'pool',
      part: result.part || partRecordToExamPart(rec),
      topBlock: result.topBlock,
      message: result.message,
    };
    if (result.ok) cleanPool[key].push(entry);
    else poolFail[key].push(entry);
  }

  const cleanGenerated = Object.fromEntries(CELL_KEYS.map((k) => [k, []]));
  const genFail = [];

  if (!SKIP_GENERATED && fs.existsSync(GENERATED_DIR)) {
    const files = fs.readdirSync(GENERATED_DIR).filter(isAuditFile).sort();
    process.stderr.write(`Auditando generated (${files.length} archivos)…\n`);

    for (const file of files) {
      const { module, teil } = parseGeneratedName(file);
      if (!module || !['lesen', 'horen', 'schreiben', 'sprechen'].includes(module)) continue;

      let batch;
      try {
        batch = JSON.parse(fs.readFileSync(path.join(GENERATED_DIR, file), 'utf8'));
      } catch {
        continue;
      }

      const effectiveTeil =
        teil ??
        Number(batch.teil ?? batch.questions?.[0]?.teil ?? (module === 'schreiben' ? 1 : null));
      const key = `${module}_${effectiveTeil}`;
      if (!cleanGenerated[key]) continue;

      const result = await auditPart(batch, { module, teil: effectiveTeil, file });
      const record = batchToRecord(result.batch || batch, file, module, effectiveTeil);
      const entry = {
      id: record.id,
      file,
      source: 'generated',
      inPool: poolIds.has(record.id),
      part: batchToExamPart(result.batch || batch, module, effectiveTeil),
      topBlock: result.topBlock,
      message: result.message,
    };

      if (result.ok) {
        if (!poolIds.has(record.id)) cleanGenerated[key].push(entry);
      } else {
        genFail.push(entry);
      }
    }
  }

  const combined = Object.fromEntries(
    CELL_KEYS.map((k) => [k, [...cleanPool[k], ...cleanGenerated[k]]]),
  );

  const maxExams = maxDistinctExams(combined);
  const poolOnlyExams = maxDistinctExams(cleanPool);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      summary: {
        maxDistinctExams: maxExams.distinct,
        maxExamsWithReuse: maxExams.withReuse,
        maxDistinctExamsPoolOnly: poolOnlyExams.distinct,
        generatedFailed: genFail.length,
      },
      cells: CELL_KEYS.reduce((acc, k) => {
        acc[k] = {
          poolReady: combined[k].length,
          fromPool: cleanPool[k].length,
          fromGeneratedOnly: cleanGenerated[k].length,
          generatedReady: cleanGenerated[k].map((e) => e.file),
        };
        return acc;
      }, {}),
    }, null, 2));
    return;
  }

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('  AUDITORÍA POOL-2 — partes listas para ensamblar exámenes B1');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  console.log('  STOCK POR CELDA (POOL-2 ok)');
  console.log('  pool = de_B1.json · gen = generated/ no en pool\n');
  for (const key of CELL_KEYS) {
    const poolReady = combined[key].length;
    const fromPool = cleanPool[key].length;
    const fromGen = cleanGenerated[key].length;
    const flag = poolReady >= 5 ? '✅' : poolReady >= 1 ? `⚠ ${poolReady}/5` : '❌';
    console.log(
      `  ${key.padEnd(14)}  ${String(poolReady).padStart(2)} total` +
        `  (pool ${fromPool} + gen ${fromGen})   ${flag}`,
    );
  }

  console.log('\n── Exámenes completos (GATE-1) ──');
  console.log(`  Distintos (sin reutilizar partes):     ${maxExams.distinct}`);
  console.log(`  Con reutilización si falta stock:      ${maxExams.withReuse}`);
  console.log(`  Solo pool oficial (sin generated/):    ${poolOnlyExams.distinct}`);

  console.log('\n── Generated/ listas para publicar al pool ──');
  let genReadyTotal = 0;
  for (const key of CELL_KEYS) {
    const files = cleanGenerated[key].map((e) => e.file);
    if (!files.length) continue;
    genReadyTotal += files.length;
    console.log(`  ${key}: ${files.length}`);
    for (const f of files.slice(0, 6)) console.log(`    · ${f}`);
    if (files.length > 6) console.log(`    … +${files.length - 6} más`);
  }
  if (!genReadyTotal) console.log('  (ninguna parte nueva en generated/ pasa POOL-2)');

  console.log('\n── Generated/ bloqueadas (top motivos) ──');
  const failByBlock = {};
  for (const f of genFail) {
    const id = f.topBlock || '?';
    failByBlock[id] = (failByBlock[id] || 0) + 1;
  }
  for (const [id, n] of Object.entries(failByBlock).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${id.padEnd(12)} ${n} archivos`);
  }

  const pubDir = path.join(ROOT, 'library/published-exams/de/B1');
  const pubCount = fs.existsSync(pubDir)
    ? fs.readdirSync(pubDir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).length
    : 0;

  console.log('\n── Visualización web local ──');
  console.log('  Modo por defecto: published (LEXICOIL_EXAM_SOURCE en index.html)');
  console.log(`  Exámenes ya publicados: ${pubCount} en library/published-exams/de/B1/`);
  console.log('  Las partes POOL-2 en generated/ NO están en la web hasta publicarlas al pool');
  console.log('  Ensamblados nuevos requieren: official:publish-exam o curated-to-served --apply');
  console.log('  Servir: npm start  |  npm run dev');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
