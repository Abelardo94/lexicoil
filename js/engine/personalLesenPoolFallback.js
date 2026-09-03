/**

 * Personal exam generation — pool fallback helpers (runtime only).

 * Lesen + Hören.

 */



function blueprintModuleTeils(blueprint, moduleId, fallback) {

  const mod = (blueprint?.modules || []).find((m) => String(m.id).toLowerCase() === moduleId);

  if (mod?.parts?.length) {

    return [...mod.parts.map((p) => Number(p.teil ?? p.aufgabe)).filter(Number.isFinite)].sort(

      (a, b) => a - b,

    );

  }

  return fallback;

}



function lesenBlueprintTeils(blueprint) {

  return blueprintModuleTeils(blueprint, 'lesen', [1, 2, 3, 4, 5]);

}



function horenBlueprintTeils(blueprint) {

  return blueprintModuleTeils(blueprint, 'horen', [1, 2, 3, 4]);

}



function horenExpectedItemCount(teil, blueprint) {

  const mod = (blueprint?.modules || []).find((m) => String(m.id).toLowerCase() === 'horen');

  const bp = (mod?.parts || []).find((p) => Number(p.teil) === Number(teil));

  if (bp?.itemsTotal != null) return Number(bp.itemsTotal);

  const qt = bp?.questionsTotal;

  if (qt?.min != null && qt?.max != null && qt.min === qt.max) return Number(qt.min);

  return ({ 1: 10, 2: 5, 3: 7, 4: 8 })[Number(teil)] ?? null;

}



const LESEN_DEFAULT_COUNTS = Object.freeze({ 1: 6, 2: 6, 3: 7, 4: 7, 5: 4 });

const HOREN_DEFAULT_COUNTS = Object.freeze({ 1: 10, 2: 5, 3: 7, 4: 8 });

/**
 * Pool-first Teile per language. A Teil listed here is served from the reusable
 * pool instead of being generated, which is what makes it free.
 *
 * de (Goethe): Hören T1/T4 for cost + reliability; Lesen T2 because the
 * dual-passage split is flaky.
 * en (Cambridge): every Reading and Listening Part — each is self-contained, so
 * there is no structural reason to keep any of them on the AI path.
 *
 * A Teil listed here is only *skipped* by the AI planner once the pool has
 * actually served it (see filterPersonalAiChunks); a pool miss falls back to
 * generation rather than leaving a hole in the exam.
 */
const POOL_FIRST_TEILS_BY_LANG = Object.freeze({
  de: Object.freeze({ horen: Object.freeze([1, 4]), lesen: Object.freeze([2]) }),
  en: Object.freeze({
    horen: Object.freeze([1, 2, 3, 4]),
    lesen: Object.freeze([1, 2, 3, 4, 5, 6]),
  }),
});

const NO_POOL_FIRST_TEILS = Object.freeze([]);

/** spec.language carries names ('german'), subject codes carry 'de'. Accept both. */
const LANG_ALIASES = Object.freeze({
  de: 'de', german: 'de', deutsch: 'de',
  en: 'en', english: 'en',
  es: 'es', spanish: 'es',
});

function normalizePoolLang(lang) {
  return LANG_ALIASES[String(lang || '').toLowerCase()] || null;
}

/** Unknown lang → no pool-first Teile, never the Goethe map. */
function poolFirstTeils(lang, module) {
  const l = normalizePoolLang(lang);
  if (!l) return NO_POOL_FIRST_TEILS;
  const m = /horen|listening/i.test(String(module || '')) ? 'horen' : 'lesen';
  return POOL_FIRST_TEILS_BY_LANG[l]?.[m] || NO_POOL_FIRST_TEILS;
}

function horenPoolFirstTeils(lang) {
  return poolFirstTeils(lang, 'horen');
}

function lesenPoolFirstTeils(lang) {
  return poolFirstTeils(lang, 'lesen');
}

/** Legacy flat exports — the Goethe lists, kept for callers that predate the lang axis. */
const HOREN_POOL_FIRST_TEILS = POOL_FIRST_TEILS_BY_LANG.de.horen;
const LESEN_POOL_FIRST_TEILS = POOL_FIRST_TEILS_BY_LANG.de.lesen;



function lesenExpectedItemCount(teil, blueprint) {

  const mod = (blueprint?.modules || []).find((m) => String(m.id).toLowerCase() === 'lesen');

  const bp = (mod?.parts || []).find((p) => Number(p.teil) === Number(teil));

  if (bp?.itemsTotal != null) return Number(bp.itemsTotal);

  const qt = bp?.questionsTotal;

  if (qt?.min != null && qt?.max != null && qt.min === qt.max) return Number(qt.min);

  return LESEN_DEFAULT_COUNTS[Number(teil)] ?? null;

}



function countLesenPartItems(part) {

  if (!part) return 0;

  let n = (part.questions || []).length;

  n += (part.items || []).filter(

    (it) => it.signText || it.text || it.question || it.correct != null,

  ).length;

  return n;

}



function optionListKeys(options) {

  return (options || [])

    .map((o) => {

      if (typeof o === 'string') {

        const m = o.match(/^([A-Za-z0-9]+)\)/);

        return (m ? m[1] : o).trim().toUpperCase();

      }

      return String(o?.key ?? '').trim().toUpperCase();

    })

    .filter(Boolean);

}



function speakerKeysFromOptions(options) {

  const keys = new Set();

  for (const o of options || []) {

    if (typeof o === 'string') {

      const m = o.match(/^\s*[a-d]\)\s*([A-Z0])\s*$/i);

      if (m) {

        keys.add(m[1].toUpperCase());

        continue;

      }

      const m2 = o.match(/^([MAB0])\s*$/i);

      if (m2) keys.add(m2[1].toUpperCase());

      continue;

    }

    const key = String(o?.key ?? '').trim().toUpperCase();

    const text = String(o?.text ?? o?.label ?? '').trim().toUpperCase();

    if (/^[MAB0]$/.test(key)) keys.add(key);

    else if (/^[MAB0]$/.test(text)) keys.add(text);

  }

  return [...keys];

}



function horenTeil4SpeakerCoherent(part) {

  if (!part || Number(part.teil) !== 4) return true;

  const seg = part.segments?.[0];

  const questions = seg?.questions || part.questions || [];

  if (questions.length !== 8) return false;

  const allKeys = new Set();

  for (const q of questions) {

    const keys = speakerKeysFromOptions(q.options);

    if (!keys.length) return false;

    if (!keys.every((k) => /^[MAB0]$/.test(k))) return false;

    keys.forEach((k) => allKeys.add(k));

  }

  const guests = [...allKeys].filter((k) => k !== 'M' && k !== '0');

  if (guests.some((k) => k !== 'A' && k !== 'B')) return false;

  if (guests.length > 2) return false;

  const sp = seg?.speakers || part.speakers;

  if (Array.isArray(sp) && sp.length > 3) return false;

  if (seg?.speakerLegend?.length) {

    for (const line of seg.speakerLegend) {

      const m = String(line).match(/^([MAB0])\s*=/i);

      if (m && !allKeys.has(m[1].toUpperCase()) && m[1].toUpperCase() !== '0') return false;

    }

  }

  return true;

}



function horenTeil1StructureValid(part) {

  if (!part || Number(part.teil) !== 1) return true;

  const segs = part.segments || [];

  if (segs.length !== 5) return false;

  return segs.every((s) => (s.questions || []).length === 2 && String(s.transcript || '').trim());

}



function partMeetsItemCount(part, module, teil, blueprint) {

  if (!part) return false;

  const mod = String(module).toLowerCase();

  const t = Number(teil);

  if (mod === 'lesen') {

    const expected = lesenExpectedItemCount(t, blueprint);

    if (expected == null) return true;

    return countLesenPartItems(part) === expected;

  }

  if (mod === 'horen') {

    const expected = horenExpectedItemCount(t, blueprint);

    if (expected == null) return true;

    if (countHorenPartItems(part) !== expected) return false;

    if (t === 1 && !horenTeil1StructureValid(part)) return false;

    if (t === 4 && !horenTeil4SpeakerCoherent(part)) return false;

    return true;

  }

  return true;

}



function isHorenPoolFirstTeil(teil, lang = 'de') {

  return horenPoolFirstTeils(lang).includes(Number(teil));

}



function isLesenPoolFirstTeil(teil, lang = 'de') {

  return lesenPoolFirstTeils(lang).includes(Number(teil));

}



/**
 * Remove pool-first Teile from the AI chunk plan — those come from the pool.
 *
 * When `spec.poolServedTeils` is present it is authoritative: only Teile the
 * pool actually served are dropped, so a pool miss falls back to generation
 * instead of leaving the Teil missing from the exam. Without it (legacy
 * callers) the static per-language list decides, as before.
 */

function filterPersonalAiChunks(chunks, spec) {

  const skills = (spec?.skills || ['lesen']).map((s) => String(s).toLowerCase());

  const horenSelected = skills.some((s) => s === 'horen' || s === 'listening');

  const lesenSelected = skills.some((s) => s === 'lesen' || s === 'reading');

  if (!horenSelected && !lesenSelected) return chunks;

  const lang = spec?.language || spec?.lang || 'de';

  const served = spec?.poolServedTeils || null;

  const servedHoren = served ? (served.horen || []).map(Number) : null;

  const servedLesen = served ? (served.lesen || []).map(Number) : null;

  const filter = spec?.personalTeilFilter;

  const filterNums = filter == null || filter === 'all'

    ? null

    : (Array.isArray(filter) ? filter : [filter]).map(Number).filter(Number.isFinite);

  return (chunks || []).filter((ctx) => {

    const expectKey = String(ctx.expectKey || '');

    const teil = Number(ctx.teil ?? ctx.blueprintPart?.teil);

    const isHoren = /horen|listening/i.test(expectKey);

    if (horenSelected && isHoren && isHorenPoolFirstTeil(teil, lang)) {

      if (filterNums?.length === 1 && filterNums[0] === teil) return true;

      if (servedHoren && !servedHoren.includes(teil)) return true;

      return false;

    }

    const isLesen = /lesen|reading/i.test(expectKey);

    if (lesenSelected && isLesen && isLesenPoolFirstTeil(teil, lang)) {

      if (filterNums?.length === 1 && filterNums[0] === teil) return true;

      if (servedLesen && !servedLesen.includes(teil)) return true;

      return false;

    }

    return true;

  });

}



function countHorenPartItems(part) {

  if (!part) return 0;

  let n = 0;

  if (Array.isArray(part.segments)) {

    for (const seg of part.segments) n += (seg.questions || []).length;

  }

  n += (part.questions || []).length;

  return n;

}



function groupQuestionsForHorenT1(questions) {

  const byKey = new Map();

  for (const q of questions) {

    const key = q.passageId || q.segmentLabel || q.segmentId || 'default';

    if (!byKey.has(key)) byKey.set(key, []);

    byKey.get(key).push(q);

  }

  if (byKey.size >= 5) {

    return [...byKey.values()].slice(0, 5);

  }

  const chunks = [];

  for (let i = 0; i < questions.length; i += 2) {

    chunks.push(questions.slice(i, i + 2));

  }

  return chunks;

}



function splitTranscriptChunks(text, count) {

  const parts = String(text || '')

    .split(/\n\n+/)

    .map((s) => s.trim())

    .filter(Boolean);

  if (parts.length >= count) return parts.slice(0, count);

  const out = [...parts];

  while (out.length < count) {

    out.push(out[out.length - 1] || 'Kurzer Hörtext.');

  }

  return out;

}



function ensureLesenT3Example(part) {
  if (!part || Number(part.teil) !== 3) return part;
  const slot = String(part.slotType || part.blueprintSlot || '').toLowerCase();
  const adsLike = slot.includes('ads_matching') || slot.includes('matching_ads') || (part.ads?.length >= 10);
  if (!adsLike) return part;
  const ex = part.example || part.solvedExample;
  if (ex && String(ex.situation || ex.question || ex.text || '').trim()) return part;
  let template;
  if (typeof require !== 'undefined') {
    try {
      ({ GOETHE_B1_LESEN_T3_EXAMPLE: template } = require('../library/goetheB1Constants.js'));
    } catch (_) {
      /* optional */
    }
  }
  if (!template && typeof window !== 'undefined' && window.GoetheB1Constants) {
    template = window.GoetheB1Constants.GOETHE_B1_LESEN_T3_EXAMPLE;
  }
  if (template) part.example = { ...template };
  return part;
}

/** Build part.ads[] from embedded A–J option lines (make-t3 / bank format). Idempotent. */
function coalesceLesenAdsMatchingPart(part) {
  if (!part || typeof part !== 'object') return part;
  const teil = Number(part.teil ?? 0);
  const slot = String(part.slotType || part.blueprintSlot || '').toLowerCase();
  // Mirror of the blueprint guard in examGeneration.isLesenAdsMatchingPart. Teil 3 is the
  // ads-matching task in Goethe but not in Cambridge, where Reading Part 3 is a long text
  // with multiple choice. Without this, `teil === 3` alone was enough: the five questions
  // were copied into items, retyped as matching and stripped of their options, while the
  // originals stayed in part.questions because the cleanup below only drops matching-typed
  // ones. The part then rendered twice — once as stemless A–D/0 radios, once correctly.
  if (/mcq|multiple_choice|long_text|open_cloze/.test(slot) && !/matching|ads/.test(slot)) return part;
  const matchingLike =
    teil === 3 ||
    slot.includes('ads_matching') ||
    slot.includes('matching_ads') ||
    (part.ads?.length >= 3) ||
    (part.items || []).some((it) => String(it.type || '').toLowerCase() === 'matching') ||
    (part.questions || []).some((q) => String(q.type || '').toLowerCase() === 'matching');
  if (!matchingLike) return part;

  part.blueprintSlot = part.blueprintSlot || 'ads_matching';
  part.slotType = part.slotType || 'ads_matching';

  let AdsMatching;
  if (typeof require !== 'undefined') {
    try {
      AdsMatching = require('../library/adsMatching.js');
    } catch (_) {
      /* optional */
    }
  }
  if (!AdsMatching && typeof window !== 'undefined') AdsMatching = window.AdsMatching;

  if (!part.items?.length && part.questions?.length) {
    part.items = part.questions
      .map((q) => ({
        id: q.id,
        signText: q.signText || q.statement || q.question || q.text,
        type: q.type || 'matching',
        correct: q.correct ?? q.correctAnswer,
        options: q.options,
      }))
      .filter((it) => (it.signText && String(it.signText).trim()) || it.correct != null);
  }

  if (!part.ads?.length && AdsMatching?.buildAdsFromBankQuestions) {
    const pool = [...(part.questions || []), ...(part.items || [])];
    const built = AdsMatching.buildAdsFromBankQuestions(pool);
    if (built.length >= 3) part.ads = built;
  }

  const ADS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (part.ads?.length) {
    part.ads = part.ads
      .map((a, i) => ({
        key: String(a.key || ADS[i] || i + 1).toUpperCase(),
        title: a.title || '',
        text: a.text || a.title || '',
      }))
      .filter((a) => a.text || a.title)
      .map((a, i) => ({ ...a, key: ADS[i] || String(i + 1) }));
  }

  const startNum = teil === 3 ? 13 : 1;
  (part.items || []).forEach((item, i) => {
    if (!item.signText && item.text) item.signText = item.text;
    if (!item.signText && item.question) item.signText = item.question;
    if (!item.id || /^l\d/i.test(String(item.id)) || teil === 3) item.id = String(startNum + i);
    if (!item.type || item.type === 'multiple' || item.type === 'multiple_choice') item.type = 'matching';
    if (part.ads?.length) delete item.options;
  });

  if (part.items?.length) {
    part.questions = (part.questions || []).filter((q) => {
      const t = String(q?.type || '').toLowerCase();
      return !['matching', 'match', 'abcd'].includes(t);
    });
  }

  if ((part.items || []).some((it) => String(it.correct ?? it.correctAnswer ?? '').trim().toUpperCase() === '0')) {
    part._t3HasNoMatch = true;
  }

  if (teil === 3) ensureLesenT3Example(part);
  return part;
}

function repairLesenPartsForValidation(exam) {
  if (!exam || !Array.isArray(exam.lesenParts)) return exam;
  for (const part of exam.lesenParts) coalesceLesenAdsMatchingPart(part);
  return exam;
}

/**
 * Resolve stable passage/transcript locator for assembled exam parts.
 * Prefer explicit passage.id / passage.passageId; else first question.passageId.
 * Does not invent IDs — returns null if none exist.
 */
function resolvePassageIdFromPool(poolPart, passage, questions) {
  const p = passage && typeof passage === 'object' ? passage : {};
  if (p.id != null && String(p.id).trim() !== '') return String(p.id);
  if (p.passageId != null && String(p.passageId).trim() !== '') return String(p.passageId);
  const qs = Array.isArray(questions) ? questions : [];
  for (const q of qs) {
    if (q && q.passageId != null && String(q.passageId).trim() !== '') return String(q.passageId);
  }
  if (Array.isArray(poolPart?.passages)) {
    for (const pp of poolPart.passages) {
      if (!pp || typeof pp !== 'object') continue;
      if (pp.id != null && String(pp.id).trim() !== '') return String(pp.id);
      if (pp.passageId != null && String(pp.passageId).trim() !== '') return String(pp.passageId);
    }
  }
  return null;
}

/**
 * Lesen/Hören pool only: force DifficultyScorer recompute (ignore persisted 4/5).
 * Schreiben/Sprechen converters must NOT call this.
 */
function applyRuntimeDifficultyToLesenHorenPoolPart(part, poolPart) {
  if (!part) return part;
  let Scorer = typeof DifficultyScorer !== 'undefined' ? DifficultyScorer : null;
  if (!Scorer) {
    try {
      Scorer = require('./validation/difficultyScorer.js');
    } catch (_) {
      Scorer = null;
    }
  }
  if (!Scorer || typeof Scorer.applyRuntimeDifficultyToPoolPart !== 'function') return part;
  return Scorer.applyRuntimeDifficultyToPoolPart(part, {
    lang: poolPart?.lang || poolPart?.language || 'de',
    level: poolPart?.level || 'B1',
  });
}

function reusablePartToLesenPart(poolPart) {

  if (!poolPart) return null;

  const teil = Number(poolPart.teil ?? 1);

  const passage = poolPart.passage || {};

  const questions = Array.isArray(poolPart.questions) ? poolPart.questions : [];

  const passageId = resolvePassageIdFromPool(poolPart, passage, questions);

  const part = {

    teil,

    instruction: poolPart.instruction || '',

    _fromPool: true,

    _poolPartId: poolPart.id || null,

  };

  if (poolPart.bgGenerated) {
    part.bgGenerated = true;
    part.bgVocabLemmas = Array.isArray(poolPart.bgVocabLemmas) ? poolPart.bgVocabLemmas : [];
  }

  if (passageId) {

    part.passageId = passageId;

    part.id = passageId;

  }



  const ads = poolPart.ads || passage.ads;

  if (Array.isArray(ads) && ads.length) part.ads = ads.map((a) => ({ ...a }));



  const matchingLike =

    teil === 3 ||

    (ads?.length >= 3) ||

    questions.some((q) => {

      const t = String(q.type || q.questionType || '').toLowerCase();

      return t === 'matching' || t === 'match' || !!(q.signText && q.correct != null);

    });



  if (matchingLike) {

    part.blueprintSlot = part.blueprintSlot || 'ads_matching';

    part.slotType = 'ads_matching';

    part.items = questions

      .map((q) => ({

        id: q.id,

        signText: q.signText || q.statement || q.question || q.text,

        type: q.type || 'matching',

        correct: q.correct ?? q.correctAnswer,

        options: q.options,

      }))

      .filter((it) => (it.signText && String(it.signText).trim()) || it.correct != null);

    if (poolPart.example) part.example = poolPart.example;
    else if (poolPart.solvedExample) part.example = poolPart.solvedExample;

  } else if (

    teil === 4 ||

    questions.some((q) => /^(J|N|Ja|Nein)$/i.test(String(q.correct ?? '').trim()))

  ) {

    part.blueprintSlot = 'forum_opinions';

    part.items = questions.map((q) => ({

      id: q.id,

      signText: q.signText || q.text || q.question,

      type: 'ja_nein',

      correct: q.correct ?? q.correctAnswer,

    }));

    part.textTitle = passage.title || passage.textTitle || '';

  } else {

    part.questions = questions.map((q) => ({ ...q }));

    part.text = passage.text || '';

    part.textTitle = passage.title || passage.textTitle || '';

    if (teil === 2) {

      if (Array.isArray(passage.passages) && passage.passages.length >= 2) {

        part.passages = passage.passages.map((p) => ({

          passageId: p.passageId || p.id,

          textTitle: p.textTitle || p.title,

          text: p.text || '',

        }));

      } else if (passage.textB || passage.text2) {

        part.passages = [

          { passageId: 'A', textTitle: part.textTitle || 'Text A', text: part.text },

          {

            passageId: 'B',

            textTitle: passage.textTitleB || 'Text B',

            text: String(passage.textB || passage.text2).trim(),

          },

        ];

      }

    }

  }

  const lesenOut = ensureLesenT3Example(coalesceLesenAdsMatchingPart(part));
  return applyRuntimeDifficultyToLesenHorenPoolPart(lesenOut, poolPart);

}



function reusablePartToHorenPart(poolPart, blueprint) {

  if (!poolPart) return null;

  const teil = Number(poolPart.teil ?? 1);

  const passage = poolPart.passage || {};

  const questions = Array.isArray(poolPart.questions) ? poolPart.questions.map((q) => ({ ...q })) : [];

  const storedSegments = poolPart.segments || passage.segments;

  const passageId = resolvePassageIdFromPool(poolPart, passage, questions);

  const part = {

    teil,

    instruction: poolPart.instruction || '',

    plays: teil === 1 || teil === 4 ? 2 : 1,

    _fromPool: true,

    _poolPartId: poolPart.id || null,

  };

  if (poolPart.bgGenerated) {
    part.bgGenerated = true;
    part.bgVocabLemmas = Array.isArray(poolPart.bgVocabLemmas) ? poolPart.bgVocabLemmas : [];
  }

  if (passageId) {

    part.passageId = passageId;

    part.id = passageId;

  }



  if (teil === 1) part.blueprintSlot = 'short_texts_twice';

  if (teil === 2 && String(poolPart.level || blueprint?.level || '').toUpperCase() === 'A2') {
    part.blueprintSlot = 'picture_matching';
    part.plays = 1;
  }

  if (teil === 4) part.blueprintSlot = 'discussion_twice';



  if (Array.isArray(storedSegments) && storedSegments.length) {

    part.segments = storedSegments.map((seg, i) => ({

      id: seg.id || `seg_pool_${i}`,

      label: seg.label || `Aufnahme ${i + 1}`,

      transcript: seg.transcript || seg.text || '',

      passageId: seg.passageId || seg.id || passageId || null,

      pictures: seg.pictures || passage.pictures || poolPart.pictures || undefined,

      questions: (seg.questions || []).map((q) => ({ ...q })),

    }));

    return applyRuntimeDifficultyToLesenHorenPoolPart(part, poolPart);

  }



  const transcriptText = passage.text || passage.transcript || poolPart.transcript || '';



  if (teil === 1) {

    const groups = groupQuestionsForHorenT1(questions);

    const transcripts = splitTranscriptChunks(transcriptText, Math.max(5, groups.length));

    part.segments = groups.slice(0, 5).map((qs, i) => {

      const segPassageId =

        (qs || []).map((q) => q && q.passageId).find((pid) => pid != null && String(pid).trim() !== '') ||

        (groups.length === 1 ? passageId : null) ||

        null;

      return {

        id: segPassageId ? String(segPassageId) : `seg_pool_${i}`,

        label: `Aufnahme ${i + 1}`,

        transcript: transcripts[i] || transcripts[0] || 'Kurzer Hörtext.',

        passageId: segPassageId ? String(segPassageId) : passageId || null,

        questions: qs,

      };

    });

    while (part.segments.length < 5) {

      part.segments.push({

        id: `seg_pool_${part.segments.length}`,

        label: `Aufnahme ${part.segments.length + 1}`,

        transcript: 'Kurzer Hörtext.',

        passageId: null,

        questions: [],

      });

    }

  } else {

    part.segments = [

      {

        id: passageId || 'seg_pool_0',

        label: 'Aufnahme 1',

        transcript: transcriptText,

        passageId: passageId || null,

        questions,

      },

    ];

  }



  return applyRuntimeDifficultyToLesenHorenPoolPart(part, poolPart);

}



function stripPoolPartsForIngest(exam) {

  if (!exam || typeof exam !== 'object') return exam;

  const copy = JSON.parse(JSON.stringify(exam));

  for (const key of ['lesenParts', 'horenParts', 'listeningParts', 'schreibenParts', 'writingParts']) {

    if (!Array.isArray(copy[key])) continue;

    copy[key] = copy[key].filter((p) => !p._fromPool);

    if (!copy[key].length) delete copy[key];

  }

  delete copy._teilFromPool;

  delete copy._poolPartIds;

  return copy;

}



function insertModuleTeil(exam, part, module, teil) {

  if (!exam || !part) return exam;

  const mod = String(module).toLowerCase();

  const key = mod === 'listening' ? 'listeningParts' : `${mod}Parts`;

  const t = Number(teil);

  exam[key] = (exam[key] || []).filter((p) => Number(p.teil) !== t);

  exam[key].push({ ...part, teil: t });

  exam[key].sort((a, b) => Number(a.teil) - Number(b.teil));

  return exam;

}



function insertLesenTeil(exam, lesenPart, teil) {

  return insertModuleTeil(exam, lesenPart, 'lesen', teil);

}



function insertHorenTeil(exam, horenPart, teil) {

  return insertModuleTeil(exam, horenPart, 'horen', teil);

}



function schreibenBlueprintTeils(blueprint) {

  return blueprintModuleTeils(blueprint, 'schreiben', [1, 2, 3]);

}



function schreibenExpectedMinWords(teil, blueprint) {

  const mod = (blueprint?.modules || []).find((m) => String(m.id).toLowerCase() === 'schreiben');

  const bp = (mod?.parts || []).find((p) => Number(p.teil) === Number(teil));

  if (bp?.wordsTarget?.min != null) return Number(bp.wordsTarget.min);

  return Number(teil) === 3 ? 40 : 80;

}



function schreibenTeilIsValid(part, teil, blueprint) {

  if (!part) return false;

  const task = String(part.task || part.instruction || part.prompt || '').trim();

  if (task.length < 40) return false;

  const expected = schreibenExpectedMinWords(teil, blueprint);

  const minW = Number(part.minWords) || expected;

  return minW === expected;

}



function reusablePartToSchreibenPart(poolPart, blueprint) {

  if (!poolPart) return null;

  const teil = Number(poolPart.teil ?? 1);

  const task = String(

    poolPart.task || poolPart.passage?.text || poolPart.questions?.[0]?.question || '',

  ).trim();

  const minWords = Number(poolPart.minWords) || schreibenExpectedMinWords(teil, blueprint);

  return {

    teil,

    aufgabe: teil,

    fieldId: poolPart.fieldId || `write_bp_${teil}`,

    task,

    minWords,

    maxWords: Number(poolPart.maxWords) || minWords,

    criteria: Array.isArray(poolPart.criteria) ? [...poolPart.criteria] : [],

    taskFormat: poolPart.taskFormat || null,

    _fromPool: true,

    _poolPartId: poolPart.id || null,

  };

  if (poolPart.bgGenerated) {
    part.bgGenerated = true;
    part.bgVocabLemmas = Array.isArray(poolPart.bgVocabLemmas) ? poolPart.bgVocabLemmas : [];
  }

}



function insertSchreibenTeil(exam, schreibenPart, teil) {

  if (!exam || !schreibenPart) return exam;

  const t = Number(teil);

  exam.schreibenParts = (exam.schreibenParts || []).filter(

    (p) => Number(p.teil ?? p.aufgabe) !== t,

  );

  exam.schreibenParts.push({ ...schreibenPart, teil: t, aufgabe: t });

  exam.schreibenParts.sort(

    (a, b) => Number(a.teil ?? a.aufgabe) - Number(b.teil ?? b.aufgabe),

  );

  return exam;

}



function sprechenBlueprintTeils(blueprint) {

  return blueprintModuleTeils(blueprint, 'sprechen', [1, 2, 3]);

}



function sprechenTeilIsValid(part, teil, blueprint) {

  if (!part) return false;

  const situation = String(

    part.situation || part.task || part.instruction || part.prompt || '',

  ).trim();

  return situation.length >= 40;

}



function reusablePartToSprechenPart(poolPart, blueprint) {

  if (!poolPart) return null;

  const teil = Number(poolPart.teil ?? 1);

  const situation = String(

    poolPart.task ||

      poolPart.situation ||

      poolPart.passage?.text ||

      poolPart.questions?.[0]?.question ||

      '',

  ).trim();

  const q0 = poolPart.questions?.[0] || {};

  const part = {

    teil,

    title: poolPart.title || q0.type || `Teil ${teil}`,

    fieldId: poolPart.fieldId || `speak_bp_${teil}`,

    situation,

    points: Array.isArray(poolPart.points) ? [...poolPart.points] : [],

    prompts: Array.isArray(poolPart.prompts) ? [...poolPart.prompts] : [],

    grammarTags: Array.isArray(q0.grammarTags) ? [...q0.grammarTags] : [],

    topicTags: Array.isArray(poolPart.topicTags || q0.topicTags)

      ? [...(poolPart.topicTags || q0.topicTags)]

      : [],

    _fromPool: true,

    _poolPartId: poolPart.id || null,

  };

  if (poolPart.bgGenerated) {
    part.bgGenerated = true;
    part.bgVocabLemmas = Array.isArray(poolPart.bgVocabLemmas) ? poolPart.bgVocabLemmas : [];
  }

  if (Number(teil) === 2 && Array.isArray(poolPart.slides) && poolPart.slides.length) {

    part.slides = poolPart.slides.map((s) => ({ ...s }));

  }

  if (!part.points.length && typeof SprechenBriefing !== 'undefined') {
    const bullets = SprechenBriefing.parseSprechenBriefing(situation, teil).bullets;
    if (bullets.length) {
      part.points = bullets;
      part.prompts = bullets;
    }
  }

  return part;

}



function insertSprechenTeil(exam, sprechenPart, teil) {

  if (!exam || !sprechenPart) return exam;

  const t = Number(teil);

  exam.sprechenParts = (exam.sprechenParts || []).filter((p) => Number(p.teil) !== t);

  exam.sprechenParts.push({ ...sprechenPart, teil: t });

  exam.sprechenParts.sort((a, b) => Number(a.teil) - Number(b.teil));

  return exam;

}



const PersonalLesenPoolFallback = Object.freeze({

  lesenBlueprintTeils,

  horenBlueprintTeils,

  lesenExpectedItemCount,

  horenExpectedItemCount,

  countLesenPartItems,

  countHorenPartItems,

  partMeetsItemCount,

  horenTeil4SpeakerCoherent,

  horenTeil1StructureValid,

  HOREN_POOL_FIRST_TEILS,

  LESEN_POOL_FIRST_TEILS,

  POOL_FIRST_TEILS_BY_LANG,

  horenPoolFirstTeils,

  lesenPoolFirstTeils,

  isHorenPoolFirstTeil,

  isLesenPoolFirstTeil,

  filterPersonalAiChunks,

  ensureLesenT3Example,

  coalesceLesenAdsMatchingPart,

  repairLesenPartsForValidation,

  reusablePartToLesenPart,

  reusablePartToHorenPart,

  stripPoolPartsForIngest,

  insertLesenTeil,

  insertHorenTeil,

  insertModuleTeil,

  schreibenBlueprintTeils,

  schreibenExpectedMinWords,

  schreibenTeilIsValid,

  reusablePartToSchreibenPart,

  insertSchreibenTeil,

  sprechenBlueprintTeils,

  sprechenTeilIsValid,

  reusablePartToSprechenPart,

  insertSprechenTeil,

});



if (typeof window !== 'undefined') window.PersonalLesenPoolFallback = PersonalLesenPoolFallback;

if (typeof module !== 'undefined') module.exports = PersonalLesenPoolFallback;


