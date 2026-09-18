/**
 * mergeSeedBlobPayload.mjs
 *
 * Surgical merge for push-seed-to-blobs:
 *   SEED wins → question order, MCQ option order + letter keys (shuffle entropy)
 *   BLOB wins → passages, option/sign texts, transcripts, semantic correctness
 *   Validate → no text field is shortened vs blob; MCQ correct text unchanged
 */

import { answerKeySequence } from './balanceMcq.mjs';

export class MergeValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'MergeValidationError';
    this.details = details;
  }
}

export function normalizeCompareText(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function optionText(opt) {
  if (opt == null) return '';
  if (typeof opt === 'string') return opt.replace(/^[a-d]\)\s*/i, '').trim();
  if (typeof opt === 'object') return String(opt.text ?? opt.label ?? '').trim();
  return String(opt);
}

function optionKey(opt, fallbackIdx) {
  if (typeof opt === 'object' && opt.key) {
    return String(opt.key).toLowerCase().replace(/[^a-c]/g, '').slice(0, 1);
  }
  if (typeof opt === 'string') {
    const m = opt.match(/^([a-c])\)/i);
    if (m) return m[1].toLowerCase();
  }
  return String.fromCharCode(97 + fallbackIdx);
}

export function mcqCorrectText(q) {
  const letter = String(q.correct ?? q.correctAnswer ?? '')
    .toLowerCase().replace(/[^a-d]/g, '').slice(0, 1);
  const opts = q.options || [];
  for (let i = 0; i < opts.length; i++) {
    if (optionKey(opts[i], i) === letter) return optionText(opts[i]);
  }
  const idx = letter ? letter.charCodeAt(0) - 97 : -1;
  if (idx >= 0 && opts[idx]) return optionText(opts[idx]);
  return '';
}

function isMcqType(type) {
  const t = String(type || '').toLowerCase();
  return t === 'multiple_choice' || t === 'multiple' || t === 'mcq';
}

function isKeyedType(type) {
  const t = String(type || '').toLowerCase();
  return t === 'ja_nein' || t === 'richtig_falsch' || t === 'true_false';
}

function isMatchingType(type) {
  return String(type || '').toLowerCase() === 'matching';
}

function adBodyText(ad) {
  if (!ad || typeof ad !== 'object') return String(ad ?? '').trim();
  return String(ad.text ?? ad.body ?? '').trim();
}

function isBareAd(ad) {
  const key = String(ad?.key ?? '').toUpperCase();
  const body = adBodyText(ad);
  if (!body) return true;
  if (body.toUpperCase() === key) return true;
  return body.length < 8 && /^[a-j0k]$/i.test(body);
}

export function countRealAds(ads) {
  if (!Array.isArray(ads)) return 0;
  return ads.filter((a) => !isBareAd(a)).length;
}

/** Merge ads[]: seed fills empty blob; per-key richer text when both populated. */
export function mergeAdsArray(blobAds, seedAds) {
  const bArr = Array.isArray(blobAds) ? blobAds : [];
  const sArr = Array.isArray(seedAds) ? seedAds : [];

  const blobReal = countRealAds(bArr);
  const seedReal = countRealAds(sArr);

  if (seedReal >= 2 && blobReal < 2) return sArr;
  if (!sArr.length) return bArr;
  if (!bArr.length) return sArr;

  const blobByKey = new Map(
    bArr.filter((a) => a?.key).map((a) => [String(a.key).toUpperCase(), a]),
  );
  const seedByKey = new Map(
    sArr.filter((a) => a?.key).map((a) => [String(a.key).toUpperCase(), a]),
  );
  const allKeys = new Set([...blobByKey.keys(), ...seedByKey.keys()]);
  const merged = [];
  for (const key of [...allKeys].sort()) {
    const b = blobByKey.get(key);
    const s = seedByKey.get(key);
    if (!b) {
      merged.push(s);
      continue;
    }
    if (!s) {
      merged.push(b);
      continue;
    }
    merged.push({
      ...b,
      ...s,
      key,
      title: richerText(b.title, s.title),
      text: richerText(b.text, s.text),
    });
  }
  return merged.length ? merged : bArr;
}

function normBinaryCorrect(c, type) {
  const s = String(c ?? '').trim().toLowerCase();
  if (type === 'ja_nein') return /^j/.test(s) ? 'ja' : 'nein';
  if (type === 'richtig_falsch' || type === 'true_false') return /^r|t/.test(s) ? 'richtig' : 'falsch';
  return s;
}

function normalizeMcqLetter(c) {
  const s = String(c ?? '').trim();
  if (/^[A-Z]$/.test(s)) return s.toLowerCase();
  return s;
}

/** Prefer blob when it is longer / richer; never return a shorter string than blob. */
export function richerText(blobVal, seedVal) {
  const b = String(blobVal ?? '').trim();
  const s = String(seedVal ?? '').trim();
  if (!b) return s;
  if (!s) return b;
  // Same normalized text (e.g. capitalization-only fix in seed) → seed wins.
  if (normalizeCompareText(b) === normalizeCompareText(s)) return s;
  if (b.length >= s.length) return b;
  return s;
}

export function richerScalar(blobVal, seedVal) {
  if (blobVal != null && blobVal !== '') return blobVal;
  return seedVal ?? blobVal;
}

const QUESTION_TEXT_FIELDS = [
  'question', 'signText', 'explanation', 'hint', 'prompt', 'stem', 'statement',
];

function mergeQuestionTextFields(blobQ, seedQ, errors, qid) {
  const out = {};
  for (const field of QUESTION_TEXT_FIELDS) {
    if (blobQ[field] == null && seedQ[field] == null) continue;
    const merged = richerText(blobQ[field], seedQ[field]);
    const bLen = String(blobQ[field] ?? '').trim().length;
    const mLen = String(merged ?? '').trim().length;
    if (bLen > 0 && mLen < bLen) {
      errors.push(`${qid}.${field}: texto reducido (${mLen} < ${bLen})`);
    }
    out[field] = merged;
  }
  return out;
}

function formatMcqOption(blobOpt, seedOpt, letter, text) {
  const key = letter.toUpperCase();
  if (typeof blobOpt === 'object' && blobOpt !== null) {
    return { ...blobOpt, key, text };
  }
  if (typeof seedOpt === 'object' && seedOpt !== null) {
    return { ...seedOpt, key, text };
  }
  return `${letter}) ${text}`;
}

function mergeMcqOptions(seedQ, blobQ, errors) {
  const blobByText = new Map();
  for (let i = 0; i < (blobQ.options || []).length; i++) {
    const opt = blobQ.options[i];
    const norm = normalizeCompareText(optionText(opt));
    if (!blobByText.has(norm)) blobByText.set(norm, opt);
  }

  const merged = [];
  for (let i = 0; i < (seedQ.options || []).length; i++) {
    const seedOpt = seedQ.options[i];
    const seedText = optionText(seedOpt);
    const norm = normalizeCompareText(seedText);
    const blobOpt = blobByText.get(norm);
    if (!blobOpt) {
      errors.push(`${seedQ.id}: opción seed sin match en blob: "${seedText.slice(0, 60)}"`);
      merged.push(seedOpt);
      continue;
    }
    const text = richerText(optionText(blobOpt), seedText);
    const letter = String.fromCharCode(97 + i);
    merged.push(formatMcqOption(blobOpt, seedOpt, letter, text));
  }
  return merged;
}

function mergeOneQuestion(seedQ, blobQ, errors) {
  const type = String(blobQ.type || seedQ.type || '').toLowerCase();
  const textFields = mergeQuestionTextFields(blobQ, seedQ, errors, seedQ.id);

  if (isMcqType(type)) {
    const seedCorrectText = mcqCorrectText(seedQ);
    const blobCorrectText = mcqCorrectText(blobQ);
    if (normalizeCompareText(seedCorrectText) !== normalizeCompareText(blobCorrectText)) {
      errors.push(`${seedQ.id}: texto correcto MCQ difiere seed vs blob`);
    }
    const correct = normalizeMcqLetter(seedQ.correct ?? seedQ.correctAnswer);
    return {
      ...blobQ,
      ...textFields,
      options: mergeMcqOptions(seedQ, blobQ, errors),
      correct,
      correctAnswer: correct,
    };
  }

  if (isKeyedType(type)) {
    const bc = normBinaryCorrect(blobQ.correct ?? blobQ.correctAnswer, type);
    const sc = normBinaryCorrect(seedQ.correct ?? seedQ.correctAnswer, type);
    if (bc !== sc) {
      errors.push(`${seedQ.id}: clave ja_nein/RF difiere seed vs blob (${sc} vs ${bc})`);
    }
    return {
      ...blobQ,
      ...textFields,
      correct: blobQ.correct ?? blobQ.correctAnswer,
      correctAnswer: blobQ.correctAnswer ?? blobQ.correct,
    };
  }

  if (isMatchingType(type)) {
    const out = { ...blobQ, ...textFields };
    const blobOpts = blobQ.options || [];
    const seedOpts = seedQ.options || [];
    if (seedOpts.length > 0 && blobOpts.length === 0) out.options = seedOpts;
    return out;
  }

  return { ...blobQ, ...textFields };
}

export function mergeQuestions(blobQuestions, seedQuestions) {
  if (!Array.isArray(seedQuestions) || seedQuestions.length === 0) {
    return blobQuestions;
  }
  if (!Array.isArray(blobQuestions)) {
    throw new MergeValidationError('blob sin questions pero seed sí tiene');
  }

  const blobById = Object.fromEntries(blobQuestions.map((q) => [q.id, q]));
  const errors = [];

  const merged = seedQuestions.map((seedQ) => {
    const blobQ = blobById[seedQ.id];
    if (!blobQ) {
      errors.push(`pregunta ${seedQ.id} en seed, ausente en blob`);
      return seedQ;
    }
    return mergeOneQuestion(seedQ, blobQ, errors);
  });

  if (errors.length) {
    throw new MergeValidationError('mergeQuestions validation failed', errors);
  }
  return merged;
}

function mergePassageObject(blobP, seedP) {
  if (!blobP && !seedP) return blobP ?? seedP;
  if (!blobP) return seedP;
  if (!seedP) return blobP;
  return {
    ...blobP,
    text: richerText(blobP.text, seedP.text),
    title: richerText(blobP.title, seedP.title),
    transcript: richerText(blobP.transcript, seedP.transcript),
    ads: mergeAdsArray(blobP.ads, seedP.ads),
  };
}

function mergePassagesArray(blobArr, seedArr) {
  if (!Array.isArray(blobArr) || !blobArr.length) return blobArr ?? seedArr;
  if (!Array.isArray(seedArr) || !seedArr.length) return blobArr;
  const seedById = Object.fromEntries(seedArr.filter((p) => p.id).map((p) => [p.id, p]));
  return blobArr.map((bp) => mergePassageObject(bp, seedById[bp.id] || {}));
}

/**
 * Match seed segments to blob segments by id, falling back to position.
 *
 * Matching by id alone silently merged nothing for 35 horen-t1-gemini-* parts:
 * every one of their segments has `id: null`, so `filter((s) => s.id)` dropped
 * them all, the lookup missed, and each blob segment came back untouched. The
 * push then wrote the blob over itself and reported "✓ Actualizado" while the
 * content never converged — a write that says yes and changes nothing.
 *
 * The positional fallback only applies when both sides have the same number of
 * segments, which is what makes it safe: with a different count we cannot know
 * which segment is which, so the old behaviour (leave the blob alone) is right.
 */
function mergeSegments(blobSegs, seedSegs) {
  if (!Array.isArray(blobSegs) || !blobSegs.length) return blobSegs;
  if (!Array.isArray(seedSegs) || !seedSegs.length) return blobSegs;

  const seedById = Object.fromEntries(seedSegs.filter((s) => s.id).map((s) => [s.id, s]));
  const byPosition = blobSegs.length === seedSegs.length;

  return blobSegs.map((bSeg, i) => {
    const sSeg = (bSeg.id != null && seedById[bSeg.id]) || (byPosition ? seedSegs[i] : null);
    if (!sSeg || !Array.isArray(bSeg.questions) || !Array.isArray(sSeg.questions)) return bSeg;
    return {
      ...bSeg,
      questions: mergeQuestions(bSeg.questions, sSeg.questions),
    };
  });
}

function normalizeSeedPart(seedPart) {
  const out = { ...seedPart };
  if (Array.isArray(out.questions)) {
    out.questions = out.questions.map((q) => {
      const nq = { ...q };
      if (isMcqType(nq.type) && nq.correct != null) {
        nq.correct = normalizeMcqLetter(nq.correct);
        nq.correctAnswer = normalizeMcqLetter(nq.correctAnswer ?? nq.correct);
      }
      return nq;
    });
  }
  return out;
}

function normalizeCorrectOnly(q) {
  const type = String(q.type || '').toLowerCase();
  if (isMcqType(type) && q.correct != null) {
    const cs = String(q.correct);
    if (/^[A-Z]$/.test(cs)) {
      return { ...q, correct: cs.toLowerCase(), correctAnswer: cs.toLowerCase() };
    }
  }
  return q;
}

/**
 * Build production payload: blob richness + seed key entropy ordering.
 */
export function buildUpdatedPayload(blobPart, seedPart, { normalizeKeys = false } = {}) {
  if (normalizeKeys) {
    return {
      ...blobPart,
      questions: Array.isArray(blobPart.questions)
        ? blobPart.questions.map(normalizeCorrectOnly)
        : blobPart.questions,
      segments: Array.isArray(blobPart.segments)
        ? blobPart.segments.map((seg) => ({
          ...seg,
          questions: Array.isArray(seg.questions)
            ? seg.questions.map(normalizeCorrectOnly)
            : seg.questions,
        }))
        : blobPart.segments,
    };
  }

  const seed = normalizeSeedPart(seedPart);

  const out = {
    ...blobPart,
    text: richerText(blobPart.text, seed.text),
    passage: mergePassageObject(blobPart.passage, seed.passage),
    passages: mergePassagesArray(blobPart.passages, seed.passages),
    ads: mergeAdsArray(blobPart.ads, seed.ads),
    instruction: richerScalar(blobPart.instruction, seed.instruction),
    questions: mergeQuestions(blobPart.questions || [], seed.questions || []),
    segments: mergeSegments(blobPart.segments, seed.segments),
    complete: blobPart.complete ?? seed.complete,
    verified: blobPart.verified ?? seed.verified,
  };

  if (seed._deprecated != null) {
    out._deprecated = seed._deprecated;
    out._deprecatedReason = seed._deprecatedReason ?? out._deprecatedReason;
    out._deprecatedAt = seed._deprecatedAt ?? out._deprecatedAt;
    if (seed._deprecated) {
      out.verified = seed.verified ?? false;
      if (seed.complete === false) out.complete = false;
    }
  }

  // Pool index (topicTag + vocabIndex) — seed wins when present (post enrich-reusable-index).
  if (seed.topicTag != null) out.topicTag = seed.topicTag;
  if (seed.topicSlug != null) out.topicSlug = seed.topicSlug;
  if (seed.topic != null) out.topic = seed.topic;
  if (Array.isArray(seed.vocabIndex)) out.vocabIndex = seed.vocabIndex;
  if (seed.schemaVersion != null) out.schemaVersion = seed.schemaVersion;

  return out;
}

export function keySeqForPart(part) {
  const qs = part?.questions || [];
  if (!qs.length) return '';
  const t = String(qs[0]?.type || '').toLowerCase();
  if (isMcqType(t)) return answerKeySequence(qs, 'multiple_choice');
  if (t === 'ja_nein') return answerKeySequence(qs, 'ja_nein');
  if (isKeyedType(t)) return answerKeySequence(qs, 'richtig_falsch');
  return '';
}

export function passageTextLen(part) {
  const chunks = [];
  if (part?.text) chunks.push(String(part.text));
  if (part?.passage?.text) chunks.push(String(part.passage.text));
  for (const p of part?.passages || []) if (p?.text) chunks.push(String(p.text));
  return chunks.join('\n').length;
}

/** Human-readable preview for dry-run review. */
export function previewPayloadMerge(blobPart, seedPart, payload) {
  const lines = [];
  lines.push(`  secuencia claves  blob: ${keySeqForPart(blobPart) || '(n/a)'}`);
  lines.push(`  secuencia claves  OUT:  ${keySeqForPart(payload) || '(n/a)'}`);
  lines.push(`  secuencia claves  seed: ${keySeqForPart(seedPart) || '(n/a)'}`);
  lines.push(`  orden preguntas   blob: ${(blobPart.questions || []).map((q) => q.id).slice(0, 4).join(' → ')}…`);
  lines.push(`  orden preguntas   OUT:  ${(payload.questions || []).map((q) => q.id).slice(0, 4).join(' → ')}…`);
  lines.push(`  passage chars     blob: ${passageTextLen(blobPart)}  OUT: ${passageTextLen(payload)}  seed: ${passageTextLen(seedPart)}`);

  const blobAds = blobPart.passage?.ads ?? blobPart.ads ?? [];
  const outAds = payload.passage?.ads ?? payload.ads ?? [];
  const seedAds = seedPart.passage?.ads ?? seedPart.ads ?? [];
  lines.push(`  ads reales        blob: ${countRealAds(blobAds)}  OUT: ${countRealAds(outAds)}  seed: ${countRealAds(seedAds)}`);

  const bq = blobPart.questions?.[0];
  const pq = payload.questions?.[0];
  const sq = seedPart.questions?.[0];
  if (bq && pq) {
    const t = String(bq.type || '').toLowerCase();
    if (isMcqType(t)) {
      lines.push(`  Q1 claves blob: ${(bq.options || []).map((o, i) => optionKey(o, i)).join(',')} correct=${bq.correct}`);
      lines.push(`  Q1 claves OUT:  ${(pq.options || []).map((o, i) => optionKey(o, i)).join(',')} correct=${pq.correct}`);
      lines.push(`  Q1 texto correcto blob: "${mcqCorrectText(bq).slice(0, 55)}…"`);
      lines.push(`  Q1 texto correcto OUT:  "${mcqCorrectText(pq).slice(0, 55)}…" (match=${normalizeCompareText(mcqCorrectText(bq)) === normalizeCompareText(mcqCorrectText(pq))})`);
    } else if (t === 'ja_nein') {
      lines.push(`  Q1 blob pos0: ${bq.id} clave=${bq.correct} sign="${String(bq.signText).slice(0, 45)}…"`);
      const outPos = (payload.questions || []).findIndex((q) => q.id === bq.id);
      const outQ = payload.questions?.[outPos];
      lines.push(`  Q1 OUT  pos${outPos}: ${outQ?.id} clave=${outQ?.correct} sign="${String(outQ?.signText).slice(0, 45)}…"`);
      lines.push(`  orden cambió: ${(blobPart.questions || []).map((q) => q.id).join(',') !== (payload.questions || []).map((q) => q.id).join(',')}`);
    }
  }

  if (seedPart._deprecated) {
    lines.push(`  _deprecated OUT: ${payload._deprecated}  reason: ${String(payload._deprecatedReason || '').slice(0, 50)}…`);
  }

  return lines.join('\n');
}
