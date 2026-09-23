/**
 * Load exam parts from pool-verified for assembled _meta (breaks circular imports).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './loadEnv.mjs';
import { poolVerifiedDir, normalizeLevel } from './batchPaths.mjs';
import { normalizeBatch } from './normalizeBatch.mjs';
import { buildLesenSeedRecordFromBatch } from './publishToPool.mjs';
import { oralTeilsForLevel } from './examLevelCells.mjs';
import { partRecordToExamPart } from '../audit-pass-2.mjs';

/**
 * Pool batch → part record, shared by the assembler, the freshness check and
 * the reassembler. It used to be copied in each of them; the copies here and in
 * reassemble-verified-from-pool had lost the A2 Hören T2 picture handling, so
 * every freshly assembled A2 exam was reported STALE on horen_2 (23 sep 2026)
 * and Marcos's August reassembly of e2–e4 came out without the 9 pictures.
 */
export function batchToRecord(batch, file, module, teil, level = 'B1') {
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
    parts.push({ cell: `${module}_${teil}`, id: rec.id, record: rec, part: partRecordToExamPart(rec) });
  }
  return parts;
}

export function loadPoolRecordForAssembledCell(meta, cell, partId, level) {
  const POOL = poolVerifiedDir(level);
  const srcFile = meta.sources?.[cell];
  if (!srcFile) return null;
  const fp = path.join(POOL, srcFile);
  if (!fs.existsSync(fp)) return null;
  let batch = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const [module, teilStr] = cell.split('_');
  const teil = Number(teilStr);
  if (module === 'schreiben' || module === 'sprechen') {
    const hit = oralBundleToParts(batch, srcFile, module, level).find((p) => p.id === partId);
    return hit?.record || null;
  }
  batch = normalizeBatch(batch, { module, teil, lang: 'de', level: normalizeLevel(level) });
  const rec = batchToRecord(batch, srcFile.replace(/\.json$/i, ''), module, teil, level);
  if (rec.id !== partId) rec.id = partId;
  return rec;
}

export function assembledExamPath(slot, level = 'B1') {
  const lv = String(level).toUpperCase();
  if (lv === 'B1') {
    return path.join(ROOT, 'batches/ready/assembled-from-verified', `assembled-exam-b1-verified-e${slot}.json`);
  }
  return path.join(
    ROOT,
    'batches/ready/assembled-from-verified',
    `assembled-exam-${String(level).toLowerCase()}-verified-e${slot}.json`,
  );
}
