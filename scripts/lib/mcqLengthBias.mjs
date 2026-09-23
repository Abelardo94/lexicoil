/**

 * mcqLengthBias.mjs — deterministic MCQ length-bias check (same method as audit-answer-length-bias.mjs).

 *

 * AUDIT / cuarentena (stamp-length-bias-quarantine): `gate: false` — cualquier correcta

 * estrictamente más larga (medición del sesgo del 70–83% del pool).

 *

 * GENERATE-CLI gate (`gate: true`, default en collectMcqLengthBiasIssues):

 *   - Ignora empates y diferencias marginales (umbrales por nivel).

 *   - Falla batch si ≥1 pregunta severa O ≥2 significativas.

 * Calibración B1: batches/ready/gate-logs/mcq-length-threshold-calibration-2026-07-13.json

 * Calibración A2: batches/ready/gate-logs/mcq-length-threshold-calibration-a2-2026-07-15.json

 */



/** @typedef {{ minPct: number, minChars: number, severePct: number, severeChars: number, batchFailCount: number }} LengthBiasThresholds */



/** Gate B1 (calibrated 2026-07-13). */

export const LENGTH_BIAS_MIN_PCT = 20;

export const LENGTH_BIAS_MIN_CHARS = 12;

export const LENGTH_BIAS_SEVERE_PCT = 30;

export const LENGTH_BIAS_SEVERE_CHARS = 18;

export const LENGTH_BIAS_BATCH_FAIL_COUNT = 2;



/** Per-level thresholds — A2: mismo % que B1, chars más bajos (opciones más cortas; p25 chars=6, p50=12). */

export const LENGTH_BIAS_BY_LEVEL = Object.freeze({

  B1: Object.freeze({

    minPct: LENGTH_BIAS_MIN_PCT,

    minChars: LENGTH_BIAS_MIN_CHARS,

    severePct: LENGTH_BIAS_SEVERE_PCT,

    severeChars: LENGTH_BIAS_SEVERE_CHARS,

    batchFailCount: LENGTH_BIAS_BATCH_FAIL_COUNT,

  }),

  A2: Object.freeze({

    minPct: 20,

    minChars: 8,

    severePct: 30,

    severeChars: 14,

    batchFailCount: 2,

  }),

});



/**

 * @param {string|undefined|null} level

 * @returns {LengthBiasThresholds}

 */

export function resolveLengthBiasThresholds(level) {

  const lv = String(level || 'B1').trim().toUpperCase();

  return LENGTH_BIAS_BY_LEVEL[lv] || LENGTH_BIAS_BY_LEVEL.B1;

}


/**

 * Worked examples for the generation prompt. A unit test runs them through

 * checkMcqQuestionLengthBias, so the prompt can never show a "correct" example

 * that the gate would reject (a hand-written one did, on 23 sep 2026).

 */

export const MCQ_LENGTH_RULE_EXAMPLES = Object.freeze({

  bad: Object.freeze({

    id: 'example-bad',

    type: 'multiple_choice',

    options: Object.freeze(['a) Um 8 Uhr.', 'b) Am Montag.', 'c) Am Dienstag um 10 Uhr im Rathaus.']),

    correct: 'c',

  }),

  good: Object.freeze({

    id: 'example-good',

    type: 'multiple_choice',

    options: Object.freeze(['a) Am Montag um 9 Uhr.', 'b) Am Freitag um 14 Uhr.', 'c) Am Dienstag um 10 Uhr.']),

    correct: 'b',

  }),

});



/**

 * Prompt rule for the generator, built from the same thresholds the gate uses.

 * The hand-written version said «≥20% y ≥8 caracteres» while the gate fires on

 * either one, so the model was told a laxer rule than the one it was judged by.

 * @param {string} [level]

 * @returns {string} one checklist line (with examples), ending in a newline

 */

export function buildMcqLengthRulePrompt(level = 'B1') {

  const lv = String(level || 'B1').trim().toUpperCase();

  const th = resolveLengthBiasThresholds(lv);

  const show = (q) => q.options

    .map((o, i) => `«${mcqOptionBody(o)}»${String.fromCharCode(97 + i) === q.correct ? ' ← correcta' : ''}`)

    .join(' / ');

  return (

    `- LONGITUD MCQ (el gate ${lv} RECHAZA): en cada pregunta la opción correcta **NO debe ser la más larga**. ` +

    `El gate falla si la correcta supera la media de los distractores en ≥${th.minPct}% **o** en ≥${th.minChars} caracteres ` +

    `(basta una de las dos: con opciones de unas 15 letras, 3 de más ya son un ${th.minPct}%). ` +

    `Que la correcta sea la más corta o la del medio, variando entre preguntas; si necesita un dato más, ` +

    `da a los distractores un dato equivalente (otra hora, otro lugar, otro precio). ` +

    `CUENTA los caracteres de las tres opciones antes de responder.
` +

    `  Ejemplo INCORRECTO: ${show(MCQ_LENGTH_RULE_EXAMPLES.bad)} — se adivina sin leer ni escuchar.
` +

    `  Ejemplo CORRECTO: ${show(MCQ_LENGTH_RULE_EXAMPLES.good)}
`

  );

}



function inferBatchLevel(batch, opts = {}) {

  if (opts.level) return String(opts.level).toUpperCase();

  const fromQ = batch?.questions?.find((q) => q.level)?.level;

  if (fromQ) return String(fromQ).toUpperCase();

  const fromP = batch?.passages?.find((p) => p.level)?.level;

  if (fromP) return String(fromP).toUpperCase();

  return 'B1';

}



/** @returns {'a'|'b'|'c'|null} */

export function mcqCorrectLetter(q) {

  const raw = String(q.correct ?? q.correctAnswer ?? '').trim().toLowerCase();

  const m = raw.match(/^[abc]/);

  return m ? /** @type {'a'|'b'|'c'} */ (m[0]) : null;

}



/** @param {unknown} opt */

export function mcqOptionBody(opt) {

  const t = typeof opt === 'string' ? opt : opt?.text || '';

  return String(t).replace(/^\s*[a-cA-C]\)\s*/, '').trim();

}



export function isContentMcqQuestion(q) {

  if (String(q.type || '') !== 'multiple_choice') return false;

  const opts = q.options;

  if (!Array.isArray(opts) || opts.length < 3) return false;

  const letters = opts.slice(0, 3).map((o) => {

    const t = typeof o === 'string' ? o : o?.text || '';

    const m = String(t).trim().match(/^([a-cA-C])\)/);

    return m ? m[1].toLowerCase() : null;

  });

  return letters[0] === 'a' && letters[1] === 'b' && letters[2] === 'c';

}



/**

 * Raw measurement — correct strictly longer than both distractors (audit / quarantine stamp).

 * @returns {{ isLongest: boolean, diff?: number, diffPct?: number, lens?: number[], correct?: string }}

 */

export function measureMcqQuestionLengthBias(q) {

  if (!isContentMcqQuestion(q)) return { isLongest: false };

  const letter = mcqCorrectLetter(q);

  if (!letter) return { isLongest: false };



  const bodies = q.options.slice(0, 3).map(mcqOptionBody);

  const lens = bodies.map((t) => t.length);

  const idx = { a: 0, b: 1, c: 2 }[letter];

  const correctLen = lens[idx];

  const wrongLens = lens.filter((_, i) => i !== idx);

  const distractorMax = Math.max(...wrongLens);

  const wrongAvg = (wrongLens[0] + wrongLens[1]) / 2;

  const max = Math.max(...lens);

  const min = Math.min(...lens);



  if (max === min || correctLen <= distractorMax) {

    return { isLongest: false, lens, correct: letter };

  }



  const diff = correctLen - wrongAvg;

  const diffPct = wrongAvg > 0 ? Math.round((100 * diff) / wrongAvg) : 0;

  return {

    isLongest: correctLen === max,

    diff: Math.round(diff),

    diffPct,

    lens,

    correct: letter,

  };

}



function isSignificantWithThresholds(m, thresholds) {

  if (!m.isLongest) return false;

  if (m.diffPct >= thresholds.severePct || m.diff >= thresholds.severeChars) return true;

  return m.diffPct >= thresholds.minPct || m.diff >= thresholds.minChars;

}



function isSevereWithThresholds(m, thresholds) {

  if (!m.isLongest) return false;

  return m.diffPct >= thresholds.severePct || m.diff >= thresholds.severeChars;

}



/**

 * Significant exploitable skew for generation gate (not every +1 char).

 * @param {object} q

 * @param {{ level?: string }} [opts]

 */

export function isSignificantMcqLengthBias(q, opts = {}) {

  const thresholds = resolveLengthBiasThresholds(opts.level);

  return isSignificantWithThresholds(measureMcqQuestionLengthBias(q), thresholds);

}



export function isSevereMcqLengthBias(q, opts = {}) {

  const thresholds = resolveLengthBiasThresholds(opts.level);

  return isSevereWithThresholds(measureMcqQuestionLengthBias(q), thresholds);

}



/**

 * @returns {{ bad: boolean, significant?: boolean, severe?: boolean, detail?: string, lens?: number[], correct?: string, diffPct?: number, diff?: number }}

 */

export function checkMcqQuestionLengthBias(q, { gate = false, level } = {}) {

  const thresholds = resolveLengthBiasThresholds(level);

  const m = measureMcqQuestionLengthBias(q);

  if (!m.isLongest) return { bad: false, lens: m.lens, correct: m.correct };



  const significant = isSignificantWithThresholds(m, thresholds);

  const severe = isSevereWithThresholds(m, thresholds);

  const bad = gate ? significant : true;



  if (!bad) {

    return {

      bad: false,

      significant: false,

      severe: false,

      lens: m.lens,

      correct: m.correct,

      diffPct: m.diffPct,

      diff: m.diff,

    };

  }



  const idx = { a: 0, b: 1, c: 2 }[m.correct];

  const wrongLens = m.lens.filter((_, i) => i !== idx);

  const lv = String(level || 'B1').toUpperCase();

  return {

    bad: true,

    significant,

    severe,

    lens: m.lens,

    correct: m.correct,

    diffPct: m.diffPct,

    diff: m.diff,

    detail:

      `${q.id || '?'}: sesgo de longitud MCQ (${lv}) — opción correcta «${m.correct}» es la más larga ` +

      `(${m.lens[m.correct.charCodeAt(0) - 97]} vs ${wrongLens.join('/')}; ` +

      `Δ +${m.diff} chars, +${m.diffPct}% vs media distractores; umbral ${thresholds.minPct}%/${thresholds.minChars}ch). ` +

      `Parafrasea o alarga los distractores hasta longitud comparable.`,

  };

}



/**
 * Numeric repair target for MCQ length-bias prompts (repair + regen).
 * @param {object} q
 * @param {string} [level]
 */
export function buildLengthBiasRepairSpec(q, level = 'B1') {
  const m = measureMcqQuestionLengthBias(q);
  if (!m.isLongest) return { needsRepair: false };
  const letter = mcqCorrectLetter(q);
  const bodies = (q.options || []).slice(0, 3).map(mcqOptionBody);
  const lens = bodies.map((t) => t.length);
  const idx = { a: 0, b: 1, c: 2 }[letter];
  const correctLen = lens[idx];
  const wrongLens = lens.filter((_, i) => i !== idx);
  const wrongAvg = Math.round((wrongLens[0] + wrongLens[1]) / 2);
  const maxWrong = Math.max(...wrongLens);
  const th = resolveLengthBiasThresholds(level);
  const targetCorrectMax = maxWrong;
  const trimChars = Math.max(1, correctLen - targetCorrectMax);
  const targetViaDistractors = Math.ceil(wrongAvg * (1 + (th.minPct - 2) / 100));
  return {
    needsRepair: true,
    letter,
    bodies,
    lens,
    correctLen,
    wrongLens,
    wrongAvg,
    maxWrong,
    diffPct: m.diffPct ?? 0,
    diffChars: m.diff ?? 0,
    targetCorrectMax,
    trimChars,
    targetViaDistractors,
    thresholdPct: th.minPct,
    thresholdChars: th.minChars,
  };
}



/**

 * @param {object} batch

 * @param {{ gate?: boolean, level?: string }} [opts] gate=true → batch-level significant pattern (default for generate-cli)

 * @returns {string[]} issue messages

 */

export function collectMcqLengthBiasIssues(batch, { gate = true, level } = {}) {

  const lv = inferBatchLevel(batch, { level });

  const thresholds = resolveLengthBiasThresholds(lv);

  const flagged = [];

  for (const q of batch?.questions || []) {

    const r = checkMcqQuestionLengthBias(q, { gate: false, level: lv });

    if (!r.bad || !r.detail) continue;

    const significant = isSignificantWithThresholds(measureMcqQuestionLengthBias(q), thresholds);

    const severe = isSevereWithThresholds(measureMcqQuestionLengthBias(q), thresholds);

    flagged.push({ r, significant, severe });

  }



  if (!gate) {

    return flagged.map(({ r }) => r.detail);

  }



  const significantOnes = flagged.filter((x) => x.significant);

  const severeOnes = flagged.filter((x) => x.severe);

  const shouldFail =

    severeOnes.length >= 1 ||

    significantOnes.length >= thresholds.batchFailCount;



  if (!shouldFail) return [];



  return significantOnes.length

    ? significantOnes.map(({ r }) => r.detail)

    : severeOnes.map(({ r }) => r.detail);

}

