#!/usr/bin/env node
/**
 * Ensambla 1 examen B1 desde partes POOL-2 (pool + generated/).
 * Escribe assembled-exam-b1-clean.json si GATE-1 pasa.
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
import { answerKeySequence } from './lib/balanceMcq.mjs';
import {
  t3SituationFingerprintFromBatch,
  assertT3FingerprintUniqueInCatalog,
  loadCatalogT3Entries,
  validateDistinctT3Fingerprints,
} from './lib/t3GroupFingerprint.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const POOL_FILE = path.join(ROOT, 'library/reusable-seed/de_B1.json');
const GENERATED_DIR = path.join(ROOT, 'batches/generated');
const OUT_FILE = path.join(ROOT, 'assembled-exam-b1-clean.json');

const CELLS = { lesen: [1, 2, 3, 4, 5], horen: [1, 2, 3, 4], schreiben: [1, 2, 3] };
const CELL_KEYS = Object.entries(CELLS).flatMap(([m, ts]) => ts.map((t) => `${m}_${t}`));

const PICKS = {
  lesen_1: { file: 'lesen-t1-gemini-154.json', source: 'generated' },
  lesen_2: { file: 'lesen-t2-gemini-064.json', source: 'generated' },
  lesen_3: { file: 'lesen-t3-auto-001.json', source: 'generated' },
  lesen_4: { file: 'lesen-t4-gemini-004.json', source: 'generated' },
  lesen_5: { file: 'lesen-t5-gemini-016.json', source: 'generated' },
  horen_1: { file: 'horen-t1-gemini-001.json', source: 'generated' },
  horen_2: { file: 'horen-t2-gemini-003.json', source: 'generated' },
  horen_3: { file: 'horen-t3-gemini-002.json', source: 'generated' },
  horen_4: { id: 'gen-h4-010', source: 'pool' },
  schreiben_1: { id: null, source: 'pool' },
  schreiben_2: { id: null, source: 'pool' },
  schreiben_3: { id: null, source: 'pool' },
};

function batchToRecord(batch, file, module, teil) {
  const mod = String(module).toLowerCase();
  const t = Number(teil);
  if (mod === 'lesen') {
    const rec = buildLesenSeedRecordFromBatch(batch, { lang: 'de', level: 'B1', teil: t, idPrefix: 'pub' });
    rec.id = batch.id || file.replace(/\.json$/i, '');
    return rec;
  }
  const passages = batch.passages || [];
  const rec = {
    id: batch.id || file.replace(/\.json$/i, ''),
    module: mod,
    teil: t,
    lang: 'de',
    level: 'B1',
    questions: batch.questions || [],
    topicTag: batch.topicTag || batch._requestedTopic,
  };
  if (mod === 'horen') {
    if (passages.length > 1) {
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
  rec.task = batch.task || batch.instruction || passages[0]?.text || '';
  rec.passage = passages[0] || null;
  return rec;
}

function batchToExamPart(batch, module, teil) {
  const record = batchToRecord(batch, batch.id || 'inline', module, teil);
  const part = partRecordToExamPart(record);
  if (module === 'horen' && !part.segments?.length && batch.passages?.length > 1) {
    part.passages = batch.passages.map((p) => ({
      id: p.id,
      title: p.title || '',
      text: p.text || p.transcript || '',
    }));
  }
  return part;
}

async function loadGeneratedPick(cell, pick) {
  const [module, teilStr] = cell.split('_');
  const teil = Number(teilStr);
  const batch = normalizeBatch(
    JSON.parse(fs.readFileSync(path.join(GENERATED_DIR, pick.file), 'utf8')),
    { module, teil, lang: 'de', level: 'B1' },
  );
  const gate = await validatePart(batch, {
    semantic: false,
    skipSem2: true,
    skipNormalize: true,
    skipDedup: true,
    module,
    teil,
    lang: 'de',
    level: 'B1',
  });
  const record = batchToRecord(batch, pick.file, module, teil);
  const poolGate = await isPartPoolReady(record, { semantic: false, skipSem2: true });
  return {
    cell,
    id: record.id,
    file: pick.file,
    part: batchToExamPart(batch, module, teil),
    record,
    validateOk: gate.ok,
    poolOk: poolGate.ok,
    poolBlock: poolGate.blocking?.[0]?.id,
  };
}

async function loadPoolPick(cell, pick) {
  const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  const [module, teilStr] = cell.split('_');
  const teil = Number(teilStr);
  let candidates = (pool.records || pool).filter(
    (r) => String(r.module).toLowerCase() === module && Number(r.teil) === teil,
  );
  if (pick?.id) {
    candidates = candidates.filter((r) => (r.id || r._id) === pick.id);
  }
  for (const rec of candidates) {
    const gate = await isPartPoolReady(rec, { semantic: false, skipSem2: true });
    if (gate.ok) {
      return {
        cell,
        id: rec.id,
        part: partRecordToExamPart(rec),
        record: rec,
        validateOk: true,
        poolOk: true,
        poolBlock: null,
      };
    }
  }
  return { cell, id: null, poolOk: false, poolBlock: 'none clean in pool' };
}

async function main() {
  const picked = {};
  const partIds = {};
  let allPoolOk = true;

  for (const cell of CELL_KEYS) {
    const pick = PICKS[cell];
    let loaded;
    if (pick?.source === 'generated') {
      loaded = await loadGeneratedPick(cell, pick);
    } else {
      loaded = await loadPoolPick(cell, pick);
    }
    picked[cell] = loaded;
    partIds[cell] = loaded.id;
    if (!loaded.poolOk) {
      allPoolOk = false;
      console.error(`✗ ${cell}: POOL-2 FAIL [${loaded.poolBlock}]`);
    } else {
      console.log(`✓ ${cell}: ${loaded.id}${loaded.file ? ` (${loaded.file})` : ''}`);
    }
  }

  const exam = {
    lesenParts: [1, 2, 3, 4, 5].map((t) => picked[`lesen_${t}`].part),
    horenParts: [1, 2, 3, 4].map((t) => picked[`horen_${t}`].part),
    schreibenParts: [1, 2, 3].map((t) => picked[`schreiben_${t}`].part),
  };

  const gate1 = isExamPublishable({ exam });
  console.log(`\nGATE-1: ${gate1.ok ? 'PASS' : 'FAIL'} (${(gate1.blocking || []).length} blocking)`);
  if (!gate1.ok) {
    for (const b of (gate1.blocking || []).slice(0, 8)) {
      console.error(`  [${b.id}] ${b.message?.slice(0, 100)}`);
    }
    process.exit(1);
  }

  if (!allPoolOk) {
    console.error('\nNo todas las partes pasan POOL-2 — no se escribe ensamblado.');
    process.exit(1);
  }

  const t3Pick = PICKS.lesen_3;
  let t3SituationFp = null;
  if (t3Pick?.source === 'generated') {
    const t3Batch = normalizeBatch(
      JSON.parse(fs.readFileSync(path.join(GENERATED_DIR, t3Pick.file), 'utf8')),
      { module: 'lesen', teil: 3, lang: 'de', level: 'B1' },
    );
    t3SituationFp = t3SituationFingerprintFromBatch(t3Batch);
    const catalogCheck = assertT3FingerprintUniqueInCatalog(t3SituationFp, ROOT);
    if (!catalogCheck.ok) {
      const c = catalogCheck.conflict;
      console.error(
        `\nFATAL T3 grupo duplicado: fp ${t3SituationFp} ya usado en ${c.examFile}` +
          (c.partId ? ` (part ${c.partId})` : ''),
      );
      process.exit(1);
    }
    const catalog = loadCatalogT3Entries(ROOT);
    const validation = validateDistinctT3Fingerprints([
      ...catalog,
      { examFile: path.basename(OUT_FILE), examNumber: 1, t3SituationFp },
    ]);
    if (!validation.ok) {
      console.error('\nFATAL validación catálogo T3:');
      validation.errors.forEach((e) => console.error(`  ${e}`));
      process.exit(1);
    }
  }

  const keyTargets = [
    { label: 'L2', key: 'lesen_2', type: 'multiple_choice' },
    { label: 'L4', key: 'lesen_4', type: 'ja_nein' },
    { label: 'L5', key: 'lesen_5', type: 'multiple_choice' },
    { label: 'H2', key: 'horen_2', type: 'multiple_choice' },
  ];
  const keySequences = Object.fromEntries(
    keyTargets.map((t) => [t.label, answerKeySequence(picked[t.key].part.questions || [], t.type)]),
  );

  const out = {
    _meta: {
      examNumber: 1,
      generatedAt: new Date().toISOString(),
      gate1: { ok: true, blocking: 0, advisory: (gate1.advisory || []).length },
      partIds,
      keySequences,
      t3SituationFp,
    },
    exam,
  };

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`\n✅ Escrito ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
