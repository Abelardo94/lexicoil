/**
 * publishToPool.mjs — Append gate-passed parts to library/reusable-seed (POOL-2 + SEM-1 stamped).
 *
 * Only call after isPartPoolReady(..., { semantic: true }) succeeds.
 * Replaces the legacy seed-reusable-from-bank path for new publishes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ROOT } from './loadEnv.mjs';
import { buildLesenT3SeedRecord } from './buildLesenT3SeedRecord.mjs';
import { inferTeilFromBatch } from './extractJson.mjs';
import { detectT5Subtype, detectT4DebateTopic } from './lesenSubtypeRotation.mjs';

const require = createRequire(import.meta.url);
const { normalizeB1Topic } = require(path.join(ROOT, 'js/data/b1Topics.js'));
const { applyPartIndex } = require(path.join(ROOT, 'netlify/functions/lib/partIndex.js'));
const { partPassesPublishGate } = require(path.join(ROOT, 'netlify/functions/lib/partPublishGate.js'));
import { tokenize, jaccardSimilarity } from './semanticDedup.mjs';
import { withPoolPublishLock } from './poolPublishLock.mjs';

/** Same-cell passage similarity block (topicTag × teil). Override: POOL_CELL_DEDUP_THRESHOLD */
export const POOL_CELL_DEDUP_THRESHOLD = Number(process.env.POOL_CELL_DEDUP_THRESHOLD || 0.55);

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
}

function normOptions(opts) {
  return (opts || []).map((o) => {
    if (typeof o === 'string') {
      const m = o.match(/^([a-d])\)\s*(.*)$/i);
      return m ? { key: m[1].toUpperCase(), text: m[2] } : { key: 'A', text: o };
    }
    return {
      key: String(o.key || o.label || 'A').toUpperCase(),
      text: o.text || o.body || '',
    };
  });
}

function resolveTopicTag(batch, explicit) {
  const fromBatch = batch.topicTag;
  const fromRequested = batch._requestedTopic;
  const fromPassage = batch.passages?.[0]?.topicTag;
  const fromQ = batch.questions?.[0]?.topicTags?.[0];
  const raw = explicit || fromBatch || fromRequested || fromPassage || fromQ || null;
  return raw ? normalizeB1Topic(raw) : null;
}

function contentFingerprint(batch, teil) {
  const passages = batch.passages || [];
  const qs = batch.questions || [];
  if (Number(teil) === 2) {
    return passages.map((p) => p.text || '').join('|');
  }
  if (Number(teil) === 4) {
    return (passages[0]?.title || '') + qs.map((q) => q.signText || q.question).join('|');
  }
  return (passages[0]?.text || passages[0]?.title || '') + qs.map((q) => q.id).join('|');
}

function buildLesenT1Record(batch, { lang, level, topicTag, idPrefix }) {
  const teil = 1;
  const lv = String(level || batch?.level || 'B1').toUpperCase();
  const qs = batch.questions || [];
  const hash = shortHash(contentFingerprint(batch, teil));
  const isA2Mcq = lv === 'A2' || Number(batch.teil) === 3;

  if (isForumMatchingLesenBatch(batch, lv)) {
    const passages = (batch.passages || []).map((p, i) => ({
      id: p.id || `gen-l1-${hash}-${String.fromCharCode(97 + i)}`,
      module: 'lesen',
      teil: 1,
      level: lv,
      title: p.title || '',
      text: p.text || '',
      personKey: p.personKey,
    }));
    const first = passages[0] || {};
    return {
      id: `${idPrefix}-${lang}-${lv}-lesen-t1-${hash}`,
      lang,
      level: lv,
      module: 'lesen',
      teil: 1,
      instruction: batch.instruction || '',
      passages,
      passage: {
        title: first.title || '',
        text: first.text || '',
        passages: passages.map((p) => ({
          passageId: p.id,
          textTitle: p.title || '',
          text: p.text || '',
        })),
      },
      questions: qs.map((q) => {
        const passageIds = new Set(passages.map((p) => p.id));
        const pid = q.passageId && passageIds.has(q.passageId) ? q.passageId : undefined;
        return {
          id: q.id,
          module: 'lesen',
          teil: 1,
          level: lv,
          type: q.type || 'matching',
          question: q.question || '',
          ...(q.options?.length ? { options: q.options } : {}),
          correct: q.correct ?? q.correctAnswer ?? '',
          correctAnswer: q.correctAnswer ?? q.correct ?? '',
          explanation: q.explanation || '',
          ...(pid ? { passageId: pid } : {}),
        };
      }),
      itemCount: qs.length,
      targetCount: qs.length,
    };
  }

  const passage = batch.passages?.[0] || {};
  return {
    id: `${idPrefix}-${lang}-${level}-lesen-t${Number(batch.teil) || teil}-${hash}`,
    lang,
    level,
    module: 'lesen',
    teil: Number(batch.teil) || teil,
    instruction: batch.instruction || '',
    passage: {
      title: passage.title || '',
      text: passage.text || '',
      transcript: passage.transcript || '',
      id: passage.id || qs[0]?.passageId,
      passageId: passage.id || qs[0]?.passageId,
    },
    questions: qs.map((q) => {
      const mcq = isA2Mcq || q.type === 'multiple' || q.type === 'multiple_choice';
      return {
        id: q.id,
        module: 'lesen',
        teil: Number(batch.teil) || teil,
        level,
        type: mcq ? 'multiple_choice' : (q.type || 'richtig_falsch'),
        question: q.question || '',
        ...(mcq && q.options?.length ? { options: normOptions(q.options) } : {}),
        correct: q.correct ?? q.correctAnswer ?? '',
        correctAnswer: q.correctAnswer ?? q.correct ?? '',
        explanation: q.explanation || '',
        passageId: q.passageId || passage.id,
      };
    }),
    itemCount: qs.length,
    targetCount: qs.length,
  };
}

function buildLesenT2Record(batch, { lang, level, topicTag, idPrefix }) {
  const teil = 2;
  const passages = batch.passages || [];
  const qs = batch.questions || [];
  const hash = shortHash(contentFingerprint(batch, teil));
  return {
    id: `${idPrefix}-${lang}-${level}-lesen-t2-${hash}`,
    lang,
    level,
    module: 'lesen',
    teil,
    instruction: batch.instruction || '',
    passage: {
      title: passages[0]?.title || '',
      passages: passages.map((p, i) => ({
        passageId: p.id || `gen-l2-${hash}-${i ? 'b' : 'a'}`,
        textTitle: p.title || '',
        text: p.text || '',
      })),
      text: passages[0]?.text || '',
      transcript: '',
    },
    questions: qs.map((q) => ({
      id: q.id,
      module: 'lesen',
      teil: 2,
      level: q.level || level,
      type: q.type || 'multiple',
      question: q.question || '',
      options: normOptions(q.options),
      correct: String(q.correct || q.correctAnswer || '').toLowerCase(),
      correctAnswer: String(q.correctAnswer || q.correct || '').toLowerCase(),
      explanation: q.explanation || '',
      passageId: q.passageId,
    })),
    itemCount: qs.length,
    targetCount: qs.length,
  };
}

/**
 * Ad key for matching (a–f). The old rule, `id.replace(/^ad-/, '')`, only
 * worked when passages were literally named ad-a…ad-f: curated parts
 * (…-cur-society-s1) and every generated part (gen-l4-…-a) kept the whole id
 * as key, and GATE-2 rejected the exam (ads_keys_mismatch, expected ABCDEF).
 * That blocked A2 exams e2–e4 on 23 sep 2026. An explicit letter in the id
 * wins; otherwise the position decides, which is what the questions' a–f
 * answers already refer to.
 */
function adLetterKey(id, index) {
  const m = String(id || '').toLowerCase().match(/(?:^ad-|-)([a-j])$/);
  return m ? m[1] : String.fromCharCode(97 + index);
}

function isForumMatchingLesenBatch(batch, level) {
  const lv = String(level || batch?.level || 'B1').toUpperCase();
  if (lv !== 'A2' && lv !== 'B2') return false;
  const qs = batch?.questions || [];
  if (qs.some((q) => q?.type === 'matching')) return true;
  return (batch?.passages?.length || 0) > 1;
}

/** @deprecated use isForumMatchingLesenBatch */
function isA2LesenMatchingBatch(batch, level) {
  return isForumMatchingLesenBatch(batch, level);
}

function buildLesenT4Record(batch, { lang, level, topicTag, idPrefix }) {
  const teil = 4;
  const qs = batch.questions || [];
  const hash = shortHash(contentFingerprint(batch, teil));
  const lv = String(level || 'B1').toUpperCase();

  if (isForumMatchingLesenBatch(batch, lv)) {
    const passages = (batch.passages || []).map((p, i) => ({
      id: p.id || `ad-${String.fromCharCode(97 + i)}`,
      module: 'lesen',
      teil: 4,
      level: lv,
      title: p.title || '',
      text: p.text || '',
    }));
    let adKeys = passages.map((p, i) => adLetterKey(p.id, i));
    if (new Set(adKeys).size !== adKeys.length) adKeys = passages.map((_, i) => String.fromCharCode(97 + i));
    const ads = passages.map((p, i) => ({
      key: adKeys[i],
      title: p.title || '',
      text: p.text || '',
      textTitle: p.title || '',
      passageId: p.id,
    }));
    const first = passages[0] || {};
    return {
      id: `${idPrefix}-${lang}-${lv}-lesen-t4-${hash}`,
      lang,
      level: lv,
      module: 'lesen',
      teil,
      instruction: batch.instruction || '',
      passages,
      ads,
      passage: { title: first.title || '', text: first.text || '' },
      questions: qs.map((q) => {
        const passageIds = new Set(passages.map((p) => p.id));
        const pid = q.passageId && passageIds.has(q.passageId) ? q.passageId : undefined;
        return {
          id: q.id,
          module: 'lesen',
          teil: 4,
          level: lv,
          type: q.type || 'matching',
          question: q.question || '',
          signText: q.signText || '',
          correct: q.correct ?? q.correctAnswer ?? '',
          correctAnswer: q.correctAnswer ?? q.correct ?? '',
          explanation: q.explanation || '',
          options: q.options || [],
          ...(pid ? { passageId: pid } : {}),
        };
      }),
      itemCount: qs.length,
      targetCount: qs.length,
    };
  }

  const passage = batch.passages?.[0] || {};
  return {
    id: `${idPrefix}-${lang}-${level}-lesen-t4-${hash}`,
    lang,
    level,
    module: 'lesen',
    teil,
    instruction: batch.instruction || '',
    passage: { title: passage.title || '', text: passage.text || '' },
    questions: qs.map((q) => ({
      id: q.id,
      module: 'lesen',
      teil: 4,
      level: q.level || level,
      type: q.type || 'richtig_falsch',
      question: q.question || '',
      signText: q.signText || '',
      correct: q.correct ?? q.correctAnswer ?? '',
      correctAnswer: q.correctAnswer ?? q.correct ?? '',
      explanation: q.explanation || '',
      options: q.options || [],
    })),
    itemCount: qs.length,
    targetCount: qs.length,
  };
}

function buildLesenT5Record(batch, { lang, level, topicTag, idPrefix }) {
  const teil = 5;
  const passage = batch.passages?.[0] || {};
  const qs = batch.questions || [];
  const hash = shortHash(contentFingerprint(batch, teil));
  return {
    id: `${idPrefix}-${lang}-${level}-lesen-t5-${hash}`,
    lang,
    level,
    module: 'lesen',
    teil,
    instruction: batch.instruction || '',
    passage: {
      title: passage.title || '',
      text: passage.text || '',
      transcript: passage.transcript || '',
    },
    questions: qs.map((q) => ({
      id: q.id,
      module: 'lesen',
      teil: 5,
      level: q.level || level,
      type: q.type || 'multiple_choice',
      question: q.question || '',
      options: normOptions(q.options),
      correct: String(q.correct || q.correctAnswer || '').toLowerCase(),
      correctAnswer: String(q.correctAnswer || q.correct || '').toLowerCase(),
      explanation: q.explanation || '',
      passageId: q.passageId || passage.id,
    })),
    itemCount: qs.length,
    targetCount: qs.length,
  };
}

/**
 * Build reusable-seed record from a validated Lesen batch.
 */
export function buildLesenSeedRecordFromBatch(batch, opts = {}) {
  const lang = String(opts.lang || 'de').toLowerCase();
  const level = String(opts.level || 'B1').toUpperCase();
  const teil = Number(opts.teil ?? inferTeilFromBatch(batch) ?? batch.questions?.[0]?.teil ?? 1);
  const topicTag = resolveTopicTag(batch, opts.topicTag);
  const idPrefix = opts.idPrefix || 'pub';

  let base;
  if (teil === 3 && (level === 'A2' || level === 'B2')) {
    // A2/B2 T3 = passage + MCQ (not B1 ads matching A–J).
    base = buildLesenT1Record({ ...batch, teil: 3 }, { lang, level, topicTag, idPrefix });
  } else if (teil === 3) {
    base = buildLesenT3SeedRecord(batch, {
      lang,
      level,
      idPrefix,
      contributorPrefix: 'publish',
    });
  } else if (teil === 2) {
    base = buildLesenT2Record(batch, { lang, level, topicTag, idPrefix });
  } else if (teil === 4) {
    base = buildLesenT4Record(batch, { lang, level, topicTag, idPrefix });
  } else if (teil === 5) {
    base = buildLesenT5Record(batch, { lang, level, topicTag, idPrefix });
  } else {
    base = buildLesenT1Record(batch, { lang, level, topicTag, idPrefix });
  }

  base.lang = lang;
  base.level = level;
  base.module = 'lesen';
  base.teil = teil;
  if (topicTag) base.topicTag = topicTag;
  if (teil === 5) {
    base.textSubtype = batch._textSubtype || batch.textSubtype || detectT5Subtype(base);
  }
  if (teil === 4) {
    if (batch._debateSeed || batch.debateSeed) {
      base.debateSeed = batch._debateSeed || batch.debateSeed;
    }
    base.debateTopic = batch._debateTopic || batch.debateTopic || detectT4DebateTopic(base);
  }
  return base;
}

export function defaultPoolFile(lang, level) {
  return path.join(ROOT, 'library', 'reusable-seed', `${String(lang).toLowerCase()}_${String(level).toUpperCase()}.json`);
}

function loadPoolFile(poolFile) {
  if (!fs.existsSync(poolFile)) {
    return { records: [], _source: 'publish-pipeline', _count: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
  if (Array.isArray(raw)) return { records: raw };
  if (Array.isArray(raw.records)) return raw;
  return { records: [] };
}

function writePoolFile(poolFile, pool) {
  fs.mkdirSync(path.dirname(poolFile), { recursive: true });
  pool._count = pool.records.length;
  pool._updatedAt = new Date().toISOString();
  fs.writeFileSync(poolFile, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
}

/** Build reusable-seed record from any exam module batch (lesen / horen / …). */
export function buildExamSeedRecordFromBatch(batch, opts = {}) {
  const lang = String(opts.lang || batch.lang || 'de').toLowerCase();
  const level = String(opts.level || batch.level || 'B1').toUpperCase();
  const mod = String(opts.module || batch.module || batch.passages?.[0]?.module || 'lesen').toLowerCase();
  const teil = Number(opts.teil ?? inferTeilFromBatch(batch) ?? batch.questions?.[0]?.teil ?? 1);
  const topicTag = resolveTopicTag(batch, opts.topicTag);
  const idPrefix = opts.idPrefix || 'pub';

  if (mod === 'lesen') {
    return buildLesenSeedRecordFromBatch(batch, { lang, level, teil, topicTag, idPrefix });
  }

  const passages = batch.passages || [];
  const hash = shortHash(contentFingerprint(batch, teil));
  const recordId = opts.id || `${idPrefix}-${mod}-t${teil}-${hash}`;

  if (mod === 'horen') {
    const rec = {
      id: recordId,
      module: 'horen',
      teil,
      lang,
      level,
      questions: batch.questions || [],
      topicTag: topicTag ? normalizeB1Topic(topicTag) : null,
      instruction: batch.instruction || '',
    };
    const p0 = passages[0];
    const pictures = p0?.pictures || batch.pictures;
    const isPictureT2 = level === 'A2' && teil === 2 && Array.isArray(pictures) && pictures.length >= 9;
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
    return rec;
  }

  const qs = (batch.questions || []).filter((q) => Number(q.teil) === teil);
  return {
    id: recordId,
    module: mod,
    teil,
    lang,
    level,
    questions: qs.length ? qs : batch.questions || [],
    instruction: batch.instruction || qs[0]?.question || '',
    task: qs[0]?.question || '',
    topicTag: topicTag ? normalizeB1Topic(topicTag) : null,
  };
}

export function appendRecordToPoolUnlocked(record, opts = {}) {
  const lang = String(record.lang || opts.lang || 'de').toLowerCase();
  const level = String(record.level || opts.level || 'B1').toUpperCase();
  const poolFile = opts.poolFile || defaultPoolFile(lang, level);
  const now = opts.sem1VerifiedAt || new Date().toISOString();

  const stamped = {
    ...record,
    lang,
    level,
    complete: true,
    verified: true,
    disabled: false,
    sem1Ok: true,
    sem1VerifiedAt: now,
    publishedAt: now,
    contributor: record.contributor || 'publish-pipeline',
    createdAt: record.createdAt || Date.now(),
  };

  if (opts.bgGenerated) {
    stamped.bgGenerated = true;
    stamped.bgVocabLemmas = Array.isArray(opts.bgVocabLemmas) ? opts.bgVocabLemmas : [];
    stamped.bgGenAt = opts.bgGenAt || now;
  }

  applyPartIndex(stamped, {
    lang,
    level,
    topicTag: stamped.topicTag,
    force: opts.forceTopic === true,
  });

  if (!partPassesPublishGate(stamped)) {
    return { ok: false, error: 'record fails partPassesPublishGate after stamp' };
  }

  const pool = loadPoolFile(poolFile);

  const dedup = checkPoolCellDedup(stamped, pool.records, {
    lang,
    level,
    module: stamped.module,
    teil: stamped.teil,
    topicTag: stamped.topicTag,
    threshold: opts.dedupThreshold,
    excludeId: stamped.id,
  });
  if (!dedup.ok) {
    return {
      ok: false,
      reason: dedup.reason,
      error: dedup.message,
      similarTo: dedup.similarTo,
      similarity: dedup.similarity,
      regenerate: true,
    };
  }

  const existing = pool.records.find((r) => r.id === stamped.id);
  if (existing) {
    if (partPassesPublishGate(existing)) {
      return { ok: true, id: existing.id, record: existing, duplicate: true };
    }
    const idx = pool.records.findIndex((r) => r.id === stamped.id);
    pool.records[idx] = { ...existing, ...stamped };
    writePoolFile(poolFile, pool);
    return { ok: true, id: stamped.id, record: stamped, replaced: true };
  }

  pool.records.push(stamped);
  writePoolFile(poolFile, pool);
  return { ok: true, id: stamped.id, record: stamped, duplicate: false };
}

/** Collect readable passage text from a seed/batch record. */
export function extractRecordPassageText(record) {
  const chunks = [];
  const p = record?.passage;
  if (p?.title) chunks.push(String(p.title));
  if (p?.text) chunks.push(String(p.text));
  if (Array.isArray(p?.passages)) {
    for (const pp of p.passages) {
      if (pp?.textTitle) chunks.push(String(pp.textTitle));
      if (pp?.text) chunks.push(String(pp.text));
    }
  }
  if (Array.isArray(record?.passages)) {
    for (const pp of record.passages) {
      if (pp?.title) chunks.push(String(pp.title));
      if (pp?.text) chunks.push(String(pp.text));
    }
  }
  return chunks.join('\n').trim();
}

function passageTokens(text) {
  return tokenize(text).slice(0, 80);
}

/**
 * Block if new record is too similar to an existing pool part in the same cell.
 * @returns {{ ok: true } | { ok: false, reason: 'pool_dedup', similarTo, similarity, message }}
 */
export function checkPoolCellDedup(record, poolRecords, opts = {}) {
  const threshold = Number(opts.threshold ?? POOL_CELL_DEDUP_THRESHOLD);
  const lang = String(record.lang || opts.lang || 'de').toLowerCase();
  const level = String(record.level || opts.level || 'B1').toUpperCase();
  const module = String(record.module || opts.module || 'lesen').toLowerCase();
  const teil = Number(record.teil ?? opts.teil);
  const topicTag = normalizeB1Topic(record.topicTag || opts.topicTag);
  const excludeId = opts.excludeId !== undefined ? opts.excludeId : null;

  if (!topicTag || !Number.isFinite(teil)) {
    return { ok: true, skipped: 'missing_cell' };
  }

  const newText = extractRecordPassageText(record);
  const newTokens = passageTokens(newText);
  if (newTokens.length < 8) return { ok: true, skipped: 'short_passage' };

  let best = null;
  for (const existing of poolRecords || []) {
    if (existing.id === excludeId) continue;
    if (existing.disabled === true) continue;
    if (String(existing.lang || '').toLowerCase() !== lang) continue;
    if (String(existing.level || '').toUpperCase() !== level) continue;
    if (String(existing.module || '').toLowerCase() !== module) continue;
    if (Number(existing.teil) !== teil) continue;
    if (normalizeB1Topic(existing.topicTag) !== topicTag) continue;
    if (existing.verified !== true && existing.complete !== true) continue;

    const sim = jaccardSimilarity(newTokens, passageTokens(extractRecordPassageText(existing)));
    if (!best || sim > best.similarity) {
      best = { similarTo: existing.id, similarity: sim, title: existing.passage?.title || existing.id };
    }
  }

  if (best && best.similarity >= threshold) {
    return {
      ok: false,
      reason: 'pool_dedup',
      similarTo: best.similarTo,
      similarity: best.similarity,
      regenerate: true,
      message:
        `POOL-DEDUP: pasaje demasiado similar (${(best.similarity * 100).toFixed(0)}% Jaccard ≥ ${(threshold * 100).toFixed(0)}%) ` +
        `a ${best.similarTo} en celda ${topicTag}×T${teil}. Regenera con otro tipo de texto.`,
    };
  }

  return { ok: true, bestSimilarity: best?.similarity ?? 0 };
}

/**
 * Stamp publish metadata and append to local reusable-seed.
 * @returns {{ ok: boolean, id?: string, record?: object, duplicate?: boolean, error?: string }}
 */
export async function appendLesenRecordToPool(record, opts = {}) {
  const lang = String(record.lang || opts.lang || 'de').toLowerCase();
  const level = String(record.level || opts.level || 'B1').toUpperCase();
  const poolFile = opts.poolFile || defaultPoolFile(lang, level);
  const store = opts.store || null;

  const run = () => appendRecordToPoolUnlocked(record, { ...opts, poolFile, lang, level });

  if (opts.skipLock) return run();

  return withPoolPublishLock(run, {
    store,
    poolFile,
    lang,
    level,
    jobType: 'append_record',
    jobPayload: {
      recordId: record.id,
      record,
      publishOpts: {
        sem1VerifiedAt: opts.sem1VerifiedAt,
        forceTopic: opts.forceTopic,
        bgGenerated: opts.bgGenerated,
        bgVocabLemmas: opts.bgVocabLemmas,
        bgGenAt: opts.bgGenAt,
        dedupThreshold: opts.dedupThreshold,
      },
    },
  });
}

/**
 * Publish any module batch to local reusable-seed (with lock).
 */
export async function publishExamBatchToPool(batch, opts = {}) {
  const lang = String(opts.lang || 'de').toLowerCase();
  const level = String(opts.level || 'B1').toUpperCase();
  const mod = String(opts.module || batch.module || batch.passages?.[0]?.module || 'lesen').toLowerCase();
  const teil = Number(opts.teil ?? inferTeilFromBatch(batch));
  const topicTag = resolveTopicTag(batch, opts.topicTag);

  const record = buildExamSeedRecordFromBatch(batch, {
    lang,
    level,
    module: mod,
    teil,
    topicTag,
    idPrefix: opts.idPrefix || 'pub',
    id: opts.recordId,
  });

  const { verifyPartVocabIndexForPool } = await import('./personalPoolPublishVocabGate.mjs');
  const vocabIndexCheck = verifyPartVocabIndexForPool(record.part || batch, {
    module: mod,
    minKeys: opts.minVocabKeys,
  });
  if (!vocabIndexCheck.ok && !vocabIndexCheck.skipped && opts.skipVocabIndexGate !== true) {
    return {
      ok: false,
      error: vocabIndexCheck.reason || 'pool_vocab_index_sparse',
      vocabIndex: vocabIndexCheck,
    };
  }

  if (opts.sourceFile) record.sourceFile = opts.sourceFile;
  if (opts.contributor) record.contributor = opts.contributor;
  if (opts.bgGenerated) {
    record.contributor = 'vocab-bg-pipeline';
  }

  const result = await appendLesenRecordToPool(record, {
    lang,
    level,
    poolFile: opts.poolFile,
    store: opts.store,
    sem1VerifiedAt: opts.sem1VerifiedAt,
    forceTopic: !!opts.forceTopicTag,
    bgGenerated: opts.bgGenerated,
    bgVocabLemmas: opts.bgVocabLemmas,
    bgGenAt: opts.bgGenAt,
  });

  if (result?.queued) return result;

  if (result.ok) {
    console.log(
      `\n✅ Pool local: ${result.id}${result.duplicate ? ' (ya existía)' : ''} → ${path.relative(ROOT, opts.poolFile || defaultPoolFile(lang, level))}`,
    );
  } else if (result.reason === 'pool_dedup') {
    console.error(`\n⛔ ${result.error}`);
  } else if (result.error) {
    console.error(`\n❌ Pool local: ${result.error}`);
  }

  return result;
}

/**
 * Build + append Lesen batch that already passed POOL-2 + SEM-1 at publish time.
 */
export async function publishLesenBatchToPool(batch, opts = {}) {
  const lang = String(opts.lang || 'de').toLowerCase();
  const level = String(opts.level || 'B1').toUpperCase();
  const teil = Number(opts.teil ?? inferTeilFromBatch(batch));
  const forcedTopic = opts.forceTopicTag ? normalizeB1Topic(opts.forceTopicTag) : null;
  const topicTag = forcedTopic || resolveTopicTag(batch, opts.topicTag);

  const record = buildLesenSeedRecordFromBatch(batch, {
    lang,
    level,
    teil,
    topicTag,
    idPrefix: opts.idPrefix || 'pub',
  });

  if (opts.sourceFile) record.sourceFile = opts.sourceFile;

  const result = await appendLesenRecordToPool(record, {
    lang,
    level,
    poolFile: opts.poolFile,
    sem1VerifiedAt: opts.sem1VerifiedAt,
    forceTopic: !!forcedTopic,
  });

  if (result.ok) {
    console.log(
      `\n✅ Pool local: ${result.id}${result.duplicate ? ' (ya existía)' : ''} → ${path.relative(ROOT, opts.poolFile || defaultPoolFile(lang, level))}`,
    );
  } else if (result.reason === 'pool_dedup') {
    console.error(`\n⛔ ${result.error}`);
  } else {
    console.error(`\n❌ Pool local: ${result.error}`);
  }

  return result;
}

/**
 * Verify a record id is servable from the local seed file.
 */
export function verifyPoolRecordServable(id, opts = {}) {
  const lang = String(opts.lang || 'de').toLowerCase();
  const level = String(opts.level || 'B1').toUpperCase();
  const pool = loadPoolFile(opts.poolFile || defaultPoolFile(lang, level));
  const rec = pool.records.find((r) => r.id === id);
  if (!rec) return { servable: false, reason: 'not_in_pool' };
  if (!partPassesPublishGate(rec)) return { servable: false, reason: 'gate_fail', record: rec };
  return { servable: true, record: rec };
}
