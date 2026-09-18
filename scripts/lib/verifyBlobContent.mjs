/**
 * verifyBlobContent.mjs — comparación semántica seed-merge vs blob live.
 * Ignora ruido estructural (ads:[] vs ausente, transcript:"" vs undefined, etc.).
 */
import {
  normalizeCompareText,
  countRealAds,
  mcqCorrectText,
} from './mergeSeedBlobPayload.mjs';

export function isEmptyish(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** null = ausente / vacío equivalente */
export function emptyEquiv(v) {
  return isEmptyish(v) ? null : v;
}

export function normalizeInstructionText(t) {
  return String(t ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
    .toLowerCase();
}

function instructionEqual(a, b) {
  return normalizeInstructionText(a) === normalizeInstructionText(b);
}

function adContentKey(ad) {
  if (!ad || typeof ad !== 'object') return normalizeCompareText(String(ad ?? ''));
  const key = String(ad.key ?? '').toUpperCase();
  const text = normalizeCompareText(ad.text ?? ad.body ?? '');
  const title = normalizeCompareText(ad.title ?? '');
  return `${key}|${title}|${text}`;
}

/** Compare ads arrays by semantic content (ignores [] vs absent). */
export function adsContentEqual(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (countRealAds(aa) !== countRealAds(bb)) return false;
  if (countRealAds(aa) === 0) return true;
  const aKeys = aa.map(adContentKey).sort();
  const bKeys = bb.map(adContentKey).sort();
  return JSON.stringify(aKeys) === JSON.stringify(bKeys);
}

function normalizePassageContent(passage) {
  if (!passage || typeof passage !== 'object') return null;
  const out = {};
  if (passage.title != null && String(passage.title).trim()) {
    out.title = normalizeCompareText(passage.title);
  }
  if (passage.text != null && String(passage.text).trim()) {
    out.text = normalizeCompareText(passage.text);
  }
  const tr = String(passage.transcript ?? '').trim();
  if (tr) out.transcript = normalizeCompareText(tr);
  const ads = Array.isArray(passage.ads) ? passage.ads : [];
  if (countRealAds(ads) > 0) {
    out.ads = [...ads].map(adContentKey).sort();
  }
  return Object.keys(out).length ? out : null;
}

export function passageContentEqual(a, b) {
  return JSON.stringify(normalizePassageContent(a)) === JSON.stringify(normalizePassageContent(b));
}

function optionText(opt) {
  if (opt == null) return '';
  if (typeof opt === 'string') return opt.replace(/^[a-d]\)\s*/i, '').trim();
  if (typeof opt === 'object') return String(opt.text ?? opt.label ?? '').trim();
  return String(opt);
}

function isMcqType(type) {
  const t = String(type || '').toLowerCase();
  return t === 'multiple_choice' || t === 'multiple' || t === 'mcq';
}

function isKeyedType(type) {
  const t = String(type || '').toLowerCase();
  return t === 'ja_nein' || t === 'richtig_falsch' || t === 'true_false';
}

function questionContentEqual(eq, bq) {
  if (!eq || !bq) return false;
  const type = String(eq.type || bq.type || '').toLowerCase();

  const textFields = ['question', 'signText', 'explanation', 'hint', 'prompt', 'stem', 'statement'];
  for (const f of textFields) {
    const ev = eq[f];
    const bv = bq[f];
    if (isEmptyish(ev) && isEmptyish(bv)) continue;
    if (normalizeCompareText(ev) !== normalizeCompareText(bv)) return false;
  }

  if (isMcqType(type)) {
    if (normalizeCompareText(mcqCorrectText(eq)) !== normalizeCompareText(mcqCorrectText(bq))) {
      return false;
    }
    const eOpts = (eq.options || []).map((o) => normalizeCompareText(optionText(o))).sort();
    const bOpts = (bq.options || []).map((o) => normalizeCompareText(optionText(o))).sort();
    if (JSON.stringify(eOpts) !== JSON.stringify(bOpts)) return false;
    const ec = String(eq.correct ?? eq.correctAnswer ?? '').toLowerCase();
    const bc = String(bq.correct ?? bq.correctAnswer ?? '').toLowerCase();
    if (ec.replace(/[^a-d]/g, '') !== bc.replace(/[^a-d]/g, '')) return false;
    return true;
  }

  if (isKeyedType(type)) {
    const norm = (c) => {
      const s = String(c ?? '').trim().toLowerCase();
      if (type === 'ja_nein') return /^j/.test(s) ? 'ja' : 'nein';
      return /^r|t/.test(s) ? 'richtig' : 'falsch';
    };
    return norm(eq.correct ?? eq.correctAnswer) === norm(bq.correct ?? bq.correctAnswer);
  }

  const ec = String(eq.correct ?? eq.correctAnswer ?? '').trim();
  const bc = String(bq.correct ?? bq.correctAnswer ?? '').trim();
  if (ec && bc && normalizeCompareText(ec) !== normalizeCompareText(bc)) return false;

  return true;
}

export function questionsContentEqual(expectedQs, blobQs) {
  const eqs = expectedQs || [];
  const bqs = blobQs || [];
  const bMap = Object.fromEntries(bqs.map((q) => [q.id, q]));
  if (eqs.length !== bqs.length) {
    const eIds = new Set(eqs.map((q) => q.id));
    const bIds = new Set(bqs.map((q) => q.id));
    if (eIds.size !== bIds.size || [...eIds].some((id) => !bIds.has(id))) return false;
  }
  for (const eq of eqs) {
    if (!questionContentEqual(eq, bMap[eq.id])) return false;
  }
  return true;
}

/**
 * Match segments by id, falling back to position when ids are absent.
 *
 * Matching by id alone reported 35 horen-t1-gemini-* parts as a REAL content
 * divergence against payloads that were byte-for-byte identical: every one of
 * their segments has `id: null`, so `filter((s) => s.id)` emptied the map, the
 * lookup missed and this returned false. The divergence survived every push
 * because there was nothing to push — the verifier was crying wolf, and 35
 * permanent false alarms are how a real one goes unnoticed.
 *
 * The arrays are already known to be the same length here, which is what makes
 * comparing by position sound. Same rule as mergeSegments in
 * mergeSeedBlobPayload.mjs — these two must agree or the verifier and the
 * pusher disagree about what "equal" means.
 */
function segmentsContentEqual(expectedSegs, blobSegs) {
  const es = expectedSegs || [];
  const bs = blobSegs || [];
  if (!es.length && !bs.length) return true;
  if (es.length !== bs.length) return false;
  const bMap = Object.fromEntries(bs.filter((s) => s.id).map((s) => [s.id, s]));
  for (let i = 0; i < es.length; i++) {
    const seg = es[i];
    const bSeg = (seg.id != null && bMap[seg.id]) || bs[i];
    if (!bSeg) return false;
    if (!questionsContentEqual(seg.questions, bSeg.questions)) return false;
  }
  return true;
}

function structuralJsonDiff(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Compare merged expected payload vs live blob.
 * @returns {{ hasRealDiff: boolean, realFields: string[], cosmeticFields: string[] }}
 */
export function comparePayloadSemantic(expected, blob) {
  const realFields = [];
  const cosmeticFields = [];

  if (!passageContentEqual(expected.passage, blob.passage)) {
    realFields.push('passage');
  } else if (structuralJsonDiff(expected.passage, blob.passage)) {
    cosmeticFields.push('passage');
  }

  if (!adsContentEqual(expected.ads, blob.ads)) {
    realFields.push('ads');
  } else if (JSON.stringify(expected.ads) !== JSON.stringify(blob.ads)) {
    cosmeticFields.push('ads');
  }

  if (!instructionEqual(expected.instruction, blob.instruction)) {
    realFields.push('instruction');
  } else if (structuralJsonDiff(expected.instruction, blob.instruction)) {
    cosmeticFields.push('instruction');
  }

  if (expected.schemaVersion !== blob.schemaVersion) {
    cosmeticFields.push('schemaVersion');
  }

  if (!questionsContentEqual(expected.questions, blob.questions)) {
    realFields.push('questions');
  } else {
    const eOrder = (expected.questions || []).map((q) => q.id).join(',');
    const bOrder = (blob.questions || []).map((q) => q.id).join(',');
    if (eOrder !== bOrder) cosmeticFields.push('questions-order');
  }

  if (!segmentsContentEqual(expected.segments, blob.segments)) {
    realFields.push('segments');
  } else if (structuralJsonDiff(expected.segments, blob.segments)) {
    cosmeticFields.push('segments');
  }

  if (expected.complete !== blob.complete && expected.complete != null && blob.complete != null) {
    cosmeticFields.push('complete');
  }
  if (expected.verified !== blob.verified && expected.verified != null && blob.verified != null) {
    cosmeticFields.push('verified');
  }
  if (expected._deprecated !== blob._deprecated) cosmeticFields.push('_deprecated');
  if (expected._deprecatedReason !== blob._deprecatedReason) cosmeticFields.push('_deprecatedReason');

  return {
    hasRealDiff: realFields.length > 0,
    realFields,
    cosmeticFields,
  };
}
