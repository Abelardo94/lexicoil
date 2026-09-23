#!/usr/bin/env node
/**
 * assemble-from-pool-verified.mjs
 *
 * Ensambla exámenes Goethe B1 **solo** desde batches/ready/pool-verified/.
 * Incluye Lesen + Hören + Schreiben + Sprechen.
 *
 * Modo (alineado con S.mode en producto: official | practice):
 *   --mode official  (default) — excluye partes con preguntas _lengthBiasQuarantine
 *                      o _lexicalCueingQuarantine
 *   --mode practice            — permite cuarentenas de sesgo de longitud / cueing léxico
 *
 * Capacidad = min(stock por celda). Hoy el cuello de botella suele ser Hören T1.
 * Cuando haya más partes verificadas, re-ejecutar este script ensambla más exámenes
 * sin cambiar el flujo.
 *
 *   node scripts/assemble-from-pool-verified.mjs
 *   node scripts/assemble-from-pool-verified.mjs --max 1
 *   node scripts/assemble-from-pool-verified.mjs --mode practice --max 1
 *   node scripts/assemble-from-pool-verified.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBatch } from './lib/normalizeBatch.mjs';
import { collectPassageIds, loadLiveExamLocks } from './lib/liveExamLock.mjs';
import { buildLesenSeedRecordFromBatch } from './lib/publishToPool.mjs';
import {
  isExamPublishable,
  isPartPoolReady,
  partRecordToExamPart,
} from './audit-pass-2.mjs';
import { normalizeB1Topic } from './lib/b1Topics.mjs';
import {
  loadAssembleDiscardLists,
  isAssembleBlocked,
  formatDiscardSummary,
} from './lib/assembleDiscardLists.mjs';
import { t3SituationFingerprintFromBatch } from './lib/t3GroupFingerprint.mjs';
import {
  poolVerifiedDir,
  listJsonInStagingRoot,
  normalizeLevel,
  inferBatchLevel,
  batchDeclaresUniformLevel,
  POOL_VERIFIED_DIR,
} from './lib/batchPaths.mjs';
import {
  mcqCellKeys,
  allAssembleCellKeys,
  fileResForLevel,
  buildExamPartsFromPicked,
  expectedOralPartCount,
  oralTeilsForLevel,
  layoutForLevel,
  hasExplicitAssembleLayout,
} from './lib/examLevelCells.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'batches/ready/assembled-from-verified');

const CELLS = {
  lesen: [1, 2, 3, 4, 5],
  horen: [1, 2, 3, 4],
};

function cellKeysForLevel(level) {
  return mcqCellKeys(level);
}

function fileReForLevel(level) {
  return fileResForLevel(level);
}

function parseArgs(argv) {
  // Product already models official vs practice via S.mode (js/bootstrap/state.js).
  // This batch assembler defaults to official (= paid/catalog exams).
  const args = { max: null, dryRun: false, prefer: new Set(), mode: 'official', level: 'B1', lockLive: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max') args.max = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--no-lock-live') args.lockLive = false;
    else if (argv[i] === '--level') args.level = normalizeLevel(argv[++i]);
    else if (argv[i] === '--mode') {
      const m = String(argv[++i] || '').toLowerCase();
      if (m !== 'official' && m !== 'practice') {
        console.error(`FATAL: --mode must be official|practice (got ${m})`);
        process.exit(1);
      }
      args.mode = m;
    } else if (argv[i] === '--prefer') {
      for (const name of String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        args.prefer.add(name);
      }
    }
  }
  return args;
}

/** True if any question is stamped for official-assemble quarantine. */
function batchHasOfficialQuarantine(batch) {
  return (batch?.questions || []).some(
    (q) =>
      q &&
      (q._lengthBiasQuarantine === true || q._lexicalCueingQuarantine === true),
  );
}

function quarantineQuestionIds(batch) {
  return (batch?.questions || [])
    .filter(
      (q) =>
        q &&
        (q._lengthBiasQuarantine === true || q._lexicalCueingQuarantine === true),
    )
    .map((q) => q.id)
    .filter(Boolean);
}

function quarantineSkipReason(batch) {
  const qs = batch?.questions || [];
  const nLen = qs.filter((q) => q && q._lengthBiasQuarantine === true).length;
  const nLex = qs.filter((q) => q && q._lexicalCueingQuarantine === true).length;
  const parts = [];
  if (nLen) parts.push(`length-bias ${nLen} q`);
  if (nLex) parts.push(`lexical-cueing ${nLex} q`);
  return parts.join(' + ') || 'quarantine';
}

function modeTopicFromTags(tags) {
  const counts = new Map();
  for (const t of tags || []) {
    const n = normalizeB1Topic(t) || (typeof t === 'string' && t.trim() ? t.trim() : null);
    if (!n) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [k, v] of counts) {
    if (v > n) {
      best = k;
      n = v;
    }
  }
  return best;
}

function extractTopic(rec, batch) {
  const qTags = [
    ...(batch?.questions || []).flatMap((q) => q.topicTags || []),
    ...(rec?.questions || []).flatMap((q) => q.topicTags || []),
  ];
  const fromQuestions = modeTopicFromTags(qTags);
  if (fromQuestions) return fromQuestions;
  const raw = batch?.topicTag || rec?.topicTag || batch?.passages?.[0]?.topicTag || null;
  return normalizeB1Topic(raw) || (raw ? String(raw) : null);
}

function batchToRecord(batch, file, module, teil, level = 'B1') {
  const lv = normalizeLevel(level || batch?.level || 'B1');
  const mod = String(module).toLowerCase();
  const t = Number(teil);
  if (mod === 'lesen') {
    const rec = buildLesenSeedRecordFromBatch(batch, { lang: 'de', level: lv, teil: t, idPrefix: 'pv' });
    rec.id = file.replace(/\.json$/i, '');
    return rec;
  }
  const passages = batch.passages || [];
  const rec = {
    id: file.replace(/\.json$/i, ''),
    module: mod,
    teil: t,
    lang: 'de',
    level: lv,
    questions: batch.questions || [],
    topicTag: batch.topicTag || passages[0]?.topicTag,
    complete: true,
    verified: true,
  };
  if (mod === 'horen') {
    const p0 = passages[0];
    const pictures = p0?.pictures || batch.pictures;
    const isPictureT2 =
      lv === 'A2' && t === 2 && Array.isArray(pictures) && pictures.length >= 9;
    if (passages.length > 1 || isPictureT2) {
      rec.segments = passages.map((p, i) => ({
        passageId: p.id,
        label: p.title || `Aufnahme ${i + 1}`,
        text: p.text || p.transcript || '',
        transcript: p.transcript || p.text || '',
        ...(Array.isArray(p.pictures) && p.pictures.length ? { pictures: p.pictures } : {}),
        questions: (batch.questions || []).filter((q) => q.passageId === p.id),
      }));
    }
    rec.passage = p0
      ? {
          title: p0.title,
          text: p0.text,
          transcript: p0.transcript || p0.text,
          topicTag: p0.topicTag,
          ...(Array.isArray(p0.pictures) ? { pictures: p0.pictures } : {}),
        }
      : null;
  }
  return rec;
}

function oralBundleToParts(batch, file, module, level = 'B1') {
  const lv = normalizeLevel(level || batch?.level || 'B1');
  const base = file.replace(/\.json$/i, '');
  const topic = extractTopic(null, batch);
  const parts = [];
  const schreibenWords =
    lv === 'A2'
      ? { 1: { min: 20, max: 30 }, 2: { min: 30, max: 40 } }
      : { 1: { min: 80, max: 120 }, 2: { min: 80, max: 120 }, 3: { min: 40, max: 60 } };
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
      topicTag: topic || qs[0]?.topicTags?.[0],
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
      topic: extractTopic(rec, batch),
      bundle: base,
    });
  }
  return parts;
}

function poolVerifiedIndex(level = 'B1') {
  const lv = normalizeLevel(level);
  const map = new Map();
  const roots = [poolVerifiedDir(lv)];
  // Legacy flat pool-verified/ is B1-only; do not mix into A2 assembly.
  if (lv === 'B1') roots.push(POOL_VERIFIED_DIR);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const abs of listJsonInStagingRoot(root)) {
      const base = path.basename(abs);
      if (!map.has(base)) map.set(base, abs);
    }
  }
  return map;
}

async function screenCell(cell, blockedIds, assembleMode = 'official', level = 'B1') {
  const [module, teilStr] = cell.split('_');
  const teil = Number(teilStr);
  const FILE_RE = fileReForLevel(level);
  const re = FILE_RE[cell];
  const index = poolVerifiedIndex(level);
  if (!re || !index.size) return [];
  const files = [...index.keys()].filter((f) => re.test(f) && !f.includes('.raw')).sort();
  const out = [];
  for (const file of files) {
    if (isAssembleBlocked(file, blockedIds)) continue;
    let batch;
    try {
      batch = JSON.parse(fs.readFileSync(index.get(file), 'utf8'));
    } catch {
      continue;
    }
    // Official (= catalog/paid-style) excludes parts that still carry quarantine stamps.
    // Practice free may include them. Whole-file skip: parts are atomic (can't drop one MCQ).
    if (assembleMode === 'official' && batchHasOfficialQuarantine(batch)) {
      const qids = quarantineQuestionIds(batch);
      console.log(
        `  skip ${file}: ${quarantineSkipReason(batch)} (${qids.length} q stamped) — official mode`,
      );
      continue;
    }
    const rawLevel = inferBatchLevel(batch);
    if (rawLevel === 'MIXED') {
      console.log(`  skip ${file}: level MIXED (questions/passages disagree) — blocked for official assemble`);
      continue;
    }
    if (!batchDeclaresUniformLevel(batch, level)) {
      console.log(
        `  skip ${file}: not 100% level ${normalizeLevel(level)} on all questions (infer=${rawLevel})`,
      );
      continue;
    }
    if (rawLevel !== normalizeLevel(level)) continue;
    let normalized;
    try {
      normalized = normalizeBatch(batch, { module, teil, lang: 'de', level: normalizeLevel(level) });
    } catch (err) {
      console.log(`  skip ${file}: normalize failed — ${err?.message || err}`);
      continue;
    }
    batch = normalized;
    const record = batchToRecord(batch, file, module, teil, level);
    if (isAssembleBlocked(record.id, blockedIds)) continue;
    const gate = await isPartPoolReady(record, { semantic: false, skipSem2: true });
    if (!gate.ok) {
      console.log(`  skip ${file}: ${gate.issue || gate.blocking?.[0]?.message || 'gate fail'}`);
      continue;
    }
    out.push({
      cell,
      id: record.id,
      file,
      record,
      part: partRecordToExamPart(record),
      topic: extractTopic(record, batch),
      t3Fp: cell === 'lesen_3' ? t3SituationFingerprintFromBatch(batch) : null,
      quarantinedQuestionIds: quarantineQuestionIds(batch),
    });
  }
  return out;
}

async function screenOralSingleTeilFiles(module, teil, blockedIds, level = 'B1') {
  const lv = normalizeLevel(level);
  const index = poolVerifiedIndex(level);
  const re =
    module === 'schreiben'
      ? new RegExp(`^schreiben(?:-t${teil}-|-).*\\.json$`, 'i')
      : new RegExp(`^sprechen-t${teil}-.*\\.json$`, 'i');
  const files = [...index.keys()].filter((f) => re.test(f)).sort();
  const out = [];
  for (const file of files) {
    if (isAssembleBlocked(file, blockedIds)) continue;
    const batch = JSON.parse(fs.readFileSync(index.get(file), 'utf8'));
    const rawLevel = inferBatchLevel(batch);
    if (rawLevel === 'MIXED' || !batchDeclaresUniformLevel(batch, level)) continue;
    if (rawLevel !== lv) continue;
    const parts = oralBundleToParts(batch, file, module, level);
    const part = parts.find((p) => p.cell === `${module}_${teil}`);
    if (!part) continue;
    const gate = await isPartPoolReady(part.record, { semantic: false, skipSem2: true });
    if (!gate.ok) {
      console.log(`  skip ${file} ${part.cell}: ${gate.issue || 'gate fail'}`);
      continue;
    }
    out.push(part);
  }
  return out;
}

async function screenOralSplitBundles(module, blockedIds, level = 'B1') {
  const lv = normalizeLevel(level);
  const teils = oralTeilsForLevel(module, lv);
  const byTeil = {};
  for (const teil of teils) {
    byTeil[teil] = await screenOralSingleTeilFiles(module, teil, blockedIds, level);
    if (!byTeil[teil].length) return [];
  }
  const parts = teils.map((t) => byTeil[t][0]);
  const fileKey = parts.map((p) => p.file).join('+');
  return [{ file: fileKey, topic: parts[0].topic, parts, module, splitBundle: true }];
}

async function screenOralBundles(module, blockedIds, level = 'B1') {
  const lv = normalizeLevel(level);
  const re = module === 'schreiben' ? /^schreiben-.*\.json$/i : /^sprechen-.*\.json$/i;
  const index = poolVerifiedIndex(level);
  const expected = expectedOralPartCount(module, level);
  const files = [...index.keys()].filter((f) => re.test(f)).sort();
  const bundles = [];
  for (const file of files) {
    if (isAssembleBlocked(file, blockedIds)) continue;
    const batch = JSON.parse(fs.readFileSync(index.get(file), 'utf8'));
    const rawLevel = inferBatchLevel(batch);
    if (rawLevel === 'MIXED' || !batchDeclaresUniformLevel(batch, level)) {
      console.log(`  skip ${file}: level not uniform ${normalizeLevel(level)} (infer=${rawLevel})`);
      continue;
    }
    if (rawLevel !== normalizeLevel(level)) continue;
    const parts = oralBundleToParts(batch, file, module, level);
    if (parts.length !== expected) continue;
    if (parts.some((p) => isAssembleBlocked(p.id, blockedIds))) continue;
    let allOk = true;
    for (const p of parts) {
      const gate = await isPartPoolReady(p.record, { semantic: false, skipSem2: true });
      if (!gate.ok) {
        console.log(`  skip ${file} ${p.cell}: ${gate.issue || 'gate fail'}`);
        allOk = false;
        break;
      }
    }
    if (allOk) bundles.push({ file, topic: parts[0].topic, parts, module });
  }
  if (!bundles.length && (lv === 'B2' || lv === 'C1')) {
    return screenOralSplitBundles(module, blockedIds, level);
  }
  return bundles;
}

function candidatePassageIds(c) {
  if (!c.passageIds) c.passageIds = collectPassageIds(c.record);
  return c.passageIds;
}

function pickBest(pool, usedTopics, usedIds, usedT3Fp, preferFiles = null, usedPassageIds = new Set()) {
  let best = null;
  let bestScore = -Infinity;
  for (const c of pool) {
    if (usedIds.has(c.id)) continue;
    // Different part files can carry the same passage (curated parts reuse bank
    // passages): one text must not appear in two exams.
    if ([...candidatePassageIds(c)].some((pid) => usedPassageIds.has(pid))) continue;
    if (c.t3Fp && usedT3Fp.has(c.t3Fp)) continue;
    let score = 100;
    if (c.topic && usedTopics.has(c.topic)) score -= 40;
    if (c.topic) score += 5;
    // Prefer today's / canary-promoted files on first exam(s)
    if (preferFiles?.has(c.file)) score += 1000;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lv = normalizeLevel(args.level);
  const CELL_KEYS = cellKeysForLevel(lv);
  const layout = layoutForLevel(lv);
  const poolIndex = poolVerifiedIndex(args.level);
  if (!poolIndex.size) {
    if (args.dryRun) {
      const keys = allAssembleCellKeys(lv);
      console.log(`\n══ Layout ${lv} (pool vacío — dry-run estructura) ══`);
      console.log(
        `  explicit layout: ${hasExplicitAssembleLayout(lv) ? 'yes' : 'no (fallback B1)'}`,
      );
      console.log(`  celdas totales: ${keys.length}`);
      console.log(
        `  lesen [${layout.lesen.join(', ')}] · horen [${layout.horen.join(', ')}] · ` +
          `schreiben [${layout.schreibenTeils.join(', ')}] · sprechen [${layout.sprechenTeils.join(', ')}]`,
      );
      console.log(`  keys: ${keys.join(', ')}`);
      for (const key of CELL_KEYS) console.log(`  ${key.padEnd(12)} 0`);
      console.log('  schreiben sets 0');
      console.log('  sprechen sets  0');
      console.log('\n--dry-run: no se escriben archivos.');
      return;
    }
    console.error(`FATAL: no hay archivos en pool-verified/${args.level} (ni legacy plano)`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const discard = loadAssembleDiscardLists();
  console.log(formatDiscardSummary(discard));
  const blockedIds = discard.blockedIds;

  console.log(`\n══ Assemble mode: ${args.mode} ══`);
  console.log(
    args.mode === 'official'
      ? '  (excluye partes con _lengthBiasQuarantine / _lexicalCueingQuarantine — S.mode=official)'
      : '  (práctica libre — permite cuarentenas de longitud / cueing léxico)',
  );

  console.log(`\n══ Stock pool-verified/${args.level} (tras gates) ══`);
  const cleanPool = {};
  for (const key of CELL_KEYS) {
    cleanPool[key] = await screenCell(key, blockedIds, args.mode, args.level);
    console.log(`  ${key.padEnd(12)} ${cleanPool[key].length}`);
  }

  const schBundles = await screenOralBundles('schreiben', blockedIds, args.level);
  const sprBundles = await screenOralBundles('sprechen', blockedIds, args.level);
  console.log(`  schreiben sets ${schBundles.length}`);
  console.log(`  sprechen sets  ${sprBundles.length}`);

  const stock = {
    ...Object.fromEntries(CELL_KEYS.map((k) => [k, cleanPool[k].length])),
    schreiben_sets: schBundles.length,
    sprechen_sets: sprBundles.length,
  };
  const stockKeys = [...CELL_KEYS, 'schreiben_sets', 'sprechen_sets'];
  const bottlenecks = Object.entries(stock).sort((a, b) => a[1] - b[1]);
  const capacity = Math.min(...stockKeys.map((k) => stock[k]));
  const maxExams = args.max != null ? Math.min(args.max, capacity) : capacity;

  console.log('\n══ Capacidad ══');
  console.log(`  min stock = ${capacity} examen(es) completo(s)`);
  console.log(`  cuello de botella: ${bottlenecks[0][0]} = ${bottlenecks[0][1]}`);
  console.log(`  a ensamblar ahora: ${maxExams}`);

  if (maxExams < 1) {
    console.error(`FATAL: no se puede ensamblar examen ${lv}: falta stock en al menos una celda.`);
    for (const [cell, count] of bottlenecks.filter(([, n]) => n < 1)) {
      console.error(`  ${cell}: disponible 0, necesario 1`);
    }
    console.error(
      `  Pool consultado: batches/ready/pool-verified/${lv}/ (sin fallback a otro nivel).`,
    );
    console.error(
      `  Celdas requeridas: Lesen T${layout.lesen.join(',')}, Hören T${layout.horen.join(',')}, Schreiben T${layout.schreibenTeils.join(',')}, Sprechen T${layout.sprechenTeils.join(',')}.`,
    );
    process.exit(1);
  }

  if (args.dryRun) {
    console.log('\n--dry-run: no se escriben archivos.');
    fs.writeFileSync(
      path.join(OUT_DIR, 'capacity-report.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: args.mode, stock, capacity, bottlenecks }, null, 2)}\n`,
    );
    return;
  }

  const usedIds = new Set();
  const usedPassageIds = new Set();
  const usedT3Fp = new Set();

  // Live exams are never reassembled; their parts and passages are reserved.
  // --no-lock-live restores the old rebuild-everything behaviour.
  const locks = args.lockLive
    ? loadLiveExamLocks('de', lv)
    : { slots: new Set(), partIds: new Set(), passageIds: new Set(), missing: [] };
  if (locks.missing.length) {
    console.error(`FATAL: slots live sin manifiesto publicado (${locks.missing.join(', ')}): no se pueden reservar sus partes`);
    process.exit(1);
  }
  for (const id of locks.partIds) usedIds.add(id);
  for (const pid of locks.passageIds) usedPassageIds.add(pid);
  if (locks.slots.size) {
    console.log(`
Slots live bloqueados (no se reensamblan): ${[...locks.slots].sort((a, b) => a - b).join(', ')} · ${locks.partIds.size} partes y ${locks.passageIds.size} textos reservados`);
  }
  const usedSch = new Set();
  const usedSpr = new Set();
  const exams = [];

  // Prefer today's canary / Option-c fix content on exam 1 only
  const preferExam1 = args.prefer.size
    ? args.prefer
    : new Set([
        'horen-t1-gemini-016.json', // Option-letter explanation resync fix
        'horen-t3-gemini-008.json', // canary RF chrono reorder
        'horen-t3-gemini-009.json',
        'horen-t3-gemini-010.json',
        'lesen-t4-gemini-043.json', // canary promote
        'lesen-t4-gemini-044.json',
        'lesen-t4-gemini-045.json',
        'lesen-t5-gemini-076.json',
        'lesen-t5-gemini-077.json',
        'lesen-t5-gemini-078.json',
      ]);

  examLoop: for (let e = 0; e < maxExams; e++) {
    if (locks.slots.has(e + 1)) continue;
    const picked = {};
    const usedTopics = new Set();
    const preferThisExam = e === 0 ? preferExam1 : null;

    const bundleFree = (b) => !b.parts.some((p) => usedIds.has(p.id));
    const sch = schBundles.find((b) => !usedSch.has(b.file) && bundleFree(b));
    const spr = sprBundles.find((b) => !usedSpr.has(b.file) && bundleFree(b));
    if (!sch || !spr) {
      // Stop here and keep the exams already built: the count-based capacity
      // does not know about reserved live parts or shared passages.
      console.warn(`
⚠ Examen ${e + 1}: sin bundle schreiben/sprechen libre — se montan ${exams.length} examen(es) nuevos`);
      break examLoop;
    }
    usedSch.add(sch.file);
    usedSpr.add(spr.file);
    for (const p of sch.parts) {
      picked[p.cell] = p;
      usedIds.add(p.id);
      if (p.topic) usedTopics.add(p.topic);
    }
    for (const p of spr.parts) {
      picked[p.cell] = p;
      usedIds.add(p.id);
      if (p.topic) usedTopics.add(p.topic);
    }

    for (const key of CELL_KEYS) {
      let c = pickBest(cleanPool[key], usedTopics, usedIds, usedT3Fp, preferThisExam, usedPassageIds);
      if (!c) c = pickBest(cleanPool[key], new Set(), usedIds, usedT3Fp, preferThisExam, usedPassageIds);
      if (!c) {
        const avail = cleanPool[key]?.length ?? 0;
        console.warn(
          `
⚠ Examen ${e + 1}: sin parte libre en [${key}] (${avail} en stock, reservadas o con texto ya usado) — se montan ${exams.length} examen(es) nuevos`,
        );
        break examLoop;
      }
      picked[key] = c;
      usedIds.add(c.id);
      for (const pid of candidatePassageIds(c)) usedPassageIds.add(pid);
      if (c.topic) usedTopics.add(c.topic);
      if (c.t3Fp) usedT3Fp.add(c.t3Fp);
    }

    const exam = buildExamPartsFromPicked(picked, lv);
    const gate = isExamPublishable({ exam, level: lv }, { expectedLevel: lv });
    const allKeys = allAssembleCellKeys(lv);
    const partIds = Object.fromEntries(allKeys.map((k) => [k, picked[k].id]));
    const topics = Object.fromEntries(allKeys.map((k) => [k, picked[k].topic || null]));
    const sources = Object.fromEntries(allKeys.map((k) => [k, picked[k].file]));
    const poolCells = Object.fromEntries(
      allKeys.map((k) => [
        k,
        {
          poolLevel: lv,
          poolFile: `batches/ready/pool-verified/${lv}/${picked[k].file}`,
          partId: picked[k].id,
          declaredLevel: normalizeLevel(lv),
        },
      ]),
    );

    exams.push({ n: e + 1, exam, gate, partIds, topics, sources, poolCells, picked });
  }

  const summaryRows = [];
  for (const x of exams) {
    const examId = `verified-de-${lv}-e${x.n}`;
    const outName =
      lv === 'B1'
        ? `assembled-exam-b1-verified-e${x.n}.json`
        : `assembled-exam-${lv.toLowerCase()}-verified-e${x.n}.json`;
    const outPath = path.join(OUT_DIR, outName);
    const doc = {
      _meta: {
        examNumber: x.n,
        examId,
        generatedAt: new Date().toISOString(),
        purpose: `assembled from pool-verified only (${args.mode} mode: ${lv} official parts)`,
        assembleMode: args.mode,
        sourceRoot: `batches/ready/pool-verified/${lv}`,
        capacityAtAssemble: capacity,
        bottleneck: bottlenecks[0],
        gate1: { ok: x.gate.ok, blocking: (x.gate.blocking || []).slice(0, 8) },
        partIds: x.partIds,
        topics: x.topics,
        sources: x.sources,
        poolCells: x.poolCells,
      },
      lang: 'de',
      level: lv,
      goetheFormat: true,
      exam: x.exam,
    };
    fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
    summaryRows.push({
      examId,
      file: path.relative(ROOT, outPath).replace(/\\/g, '/'),
      gate1: x.gate.ok,
      partIds: x.partIds,
      topics: x.topics,
    });
    console.log(`\n✓ ${examId} → ${path.relative(ROOT, outPath)} GATE-1=${x.gate.ok ? 'PASS' : 'FAIL'}`);
    if (!x.gate.ok) {
      for (const b of (x.gate.blocking || []).slice(0, 5)) {
        console.log(`  [${b.id}] ${String(b.message || '').slice(0, 120)}`);
      }
    }
    for (const [k, id] of Object.entries(x.partIds)) {
      console.log(`  ${k.padEnd(14)} ${id.padEnd(42)} topic=${x.topics[k] || '—'}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'batches/ready/pool-verified',
    stock,
    capacity,
    bottleneck: bottlenecks[0],
    assembled: summaryRows.length,
    exams: summaryRows,
    nextSteps: [
      'Cuando haya más Hören T1 (u otra celda cuello de botella) en pool-verified, re-ejecutar: node scripts/assemble-from-pool-verified.mjs',
      'Publicar: node scripts/publish-verified-exams-local.mjs --slots N --level A2|B1 (GATE-1 + frescura + overlay)',
    ],
  };
  fs.writeFileSync(path.join(OUT_DIR, 'capacity-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const md = [
    '# Exámenes ensamblados desde pool-verified',
    '',
    `- Generado: ${report.generatedAt}`,
    `- Capacidad: **${capacity}** (cuello: \`${bottlenecks[0][0]}\` = ${bottlenecks[0][1]})`,
    `- Ensamblados ahora: **${summaryRows.length}**`,
    '',
    '## Stock',
    '',
    '| Celda | N |',
    '|---|---|',
    ...Object.entries(stock).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## Exámenes',
    '',
  ];
  for (const r of summaryRows) {
    md.push(`### ${r.examId}`);
    md.push(`- \`${r.file}\``);
    md.push(`- GATE-1: ${r.gate1 ? 'PASS' : 'FAIL'}`);
    md.push('');
  }
  md.push('## Re-ensamblar');
  md.push('');
  md.push('```bash');
  md.push('node scripts/assemble-from-pool-verified.mjs');
  md.push('node scripts/assemble-from-pool-verified.mjs --dry-run   # solo capacidad');
  md.push('```');
  md.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), `${md.join('\n')}\n`);
  console.log(`\nResumen: ${path.relative(ROOT, path.join(OUT_DIR, 'README.md'))}`);
  console.log(`Capacidad: ${path.relative(ROOT, path.join(OUT_DIR, 'capacity-report.json'))}`);

  try {
    const { maybeAutoPublishExams } = await import('./lib/autoPublishExamsLib.mjs');
    const auto = await maybeAutoPublishExams({
      lang: 'de',
      level: args.level,
      mode: args.mode,
      trigger: 'assemble-from-pool-verified',
      skipAssemble: true,
    });
    if (auto.published?.length) {
      console.log(`\n[auto-publish] Published slots: ${auto.published.join(', ')} (live=${auto.liveCount})`);
    } else if (!auto.skipped) {
      console.log(`\n[auto-publish] No new catalog slots (${auto.reason || 'ok'})`);
    }
  } catch (err) {
    console.warn('[auto-publish] skipped:', err?.message || err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
