/**
 * CHK-34 — explanation ↔ quoted option text alignment.
 *
 * Severity (2 levels):
 *   CRITICAL / blocking issues — keyword-proximate quote equals another option's body,
 *   or quote is present but ≠ correct option body (stale/manual drift).
 *   WARN / non-blocking — keywords present but no proximate quote of the correct answer
 *   (paraphrase-only is allowed until graduation promotes this to blocking).
 *
 * Graduation: see EXPL_OPTION_TEXT_ALIGN_GRADUATION (missing-quote warn → block after date).
 */

export const CHK34_ID = 'CHK-34';

/** Inclusive last day for warn-only on "missing correct quote" (paraphrase). */
export const EXPL_OPTION_TEXT_ALIGN_WARN_ONLY_UNTIL = '2026-08-10';

/**
 * Graduation plan (documented; flip missing-quote to IMPORTANT/blocking after review):
 * - 14 calendar days from activation (2026-07-27 → 2026-08-10).
 * - Before promoting: scan gate-logs + pool-verified for CHK-34 MINOR on missing-quote;
 *   require 0 false positives on Lesen T4/T5 paraphrase items in pool-verified B1/B2/A2.
 * - Secondary: ≥40 generator runs with module lesen/horen without new MINOR FP.
 */
export const EXPL_OPTION_TEXT_ALIGN_GRADUATION = Object.freeze({
  warnOnlyUntil: EXPL_OPTION_TEXT_ALIGN_WARN_ONLY_UNTIL,
  observationDays: 14,
  minGeneratorRunsToReview: 40,
  promoteAction:
    'Move CHK-34 missing-quote from MINOR → IMPORTANT and add CHK-34-missing to GATE_BLOCK_CHECKS',
});

const KEYWORDS_STRICT = ['Überschrift', 'überschrift', 'Option', 'Antwort', 'Alternative'];
const KEYWORDS_LOOSE = ['Satz'];
// English explanations trigger on their own words. `Option`/`Alternative` already overlap, which
// is why English items reached the strict branch at all — and then died on exact equality.
const KEYWORDS_STRICT_EN = ['Option', 'option', 'Answer', 'answer', 'Heading', 'heading', 'Choice', 'choice'];
const KEYWORDS_LOOSE_EN = ['Sentence', 'sentence'];

/**
 * How a quoted fragment relates to the correct option body.
 *
 * German content follows the Goethe convention of quoting the option verbatim, so `de` keeps
 * strict equality and its findings do not move. Cambridge explanations quote a fragment of the
 * option ("Most of them" for "Most of them were local farmers who had produced the food
 * themselves."), which is legitimate, so containment counts as a match there. A difference that
 * is only casing is reported, but as a warning: that is capitalization drift, not a wrong key.
 *
 * @returns {'exact'|'partial'|'case'|'no'}
 */
function quoteBodyRelation(quote, body) {
  const q = normalizeAlignText(quote);
  const b = normalizeAlignText(body);
  if (!q || !b) return 'no';
  if (q === b) return 'exact';
  if (b.includes(q) || q.includes(b)) return 'partial';
  const ql = q.toLowerCase();
  const bl = b.toLowerCase();
  if (ql === bl || bl.includes(ql) || ql.includes(bl)) return 'case';
  return 'no';
}
const QUOTE_RE = /['\u201e\u201c]([^'\u201d\u201c]{3,220})['\u201d\u201c]/g;
const PROXIMITY_CHARS = 120;

function normalizeAlignText(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function optionStr(o) {
  if (typeof o === 'string') return o.trim();
  if (o && typeof o === 'object') return String(o.text ?? o.label ?? o.value ?? '').trim();
  return String(o ?? '').trim();
}

function optionBodyFromStr(optStr) {
  return normalizeAlignText(optStr.replace(/^[A-Ha-h][).:\s]+/, ''));
}

function correctLetter(q) {
  const s = String(q.correctAnswer ?? q.correct ?? '').trim();
  const m = s.match(/^([A-Ha-h])/i);
  return m ? m[1].toUpperCase() : '';
}

function optionBodiesByLetter(q) {
  const map = new Map();
  for (const o of q.options || []) {
    const str = optionStr(o);
    const m = str.match(/^([A-Ha-h])[).:\s]/);
    if (m) map.set(m[1].toUpperCase(), optionBodyFromStr(str));
  }
  return map;
}

function keywordIndices(expl, keywordList) {
  const idx = [];
  const text = String(expl || '');
  for (const kw of keywordList) {
    let pos = 0;
    while ((pos = text.indexOf(kw, pos)) !== -1) {
      idx.push(pos);
      pos += kw.length;
    }
  }
  return idx;
}

function isProximate(quoteStart, quoteEnd, keyIndices) {
  return keyIndices.some(
    (ki) =>
      Math.abs(ki - quoteStart) <= PROXIMITY_CHARS ||
      Math.abs(ki - quoteEnd) <= PROXIMITY_CHARS ||
      (ki >= quoteStart && ki <= quoteEnd),
  );
}

/**
 * Quoted spans near strict keywords (Überschrift/Option/Antwort) or loose (Satz).
 * @returns {{ text: string, index: number, mode: 'strict'|'loose'|'both' }[]}
 */
export function extractKeywordProximateQuotes(explanation, lang = 'de') {
  const expl = String(explanation || '');
  if (!expl.trim()) return [];
  const isEn = String(lang || 'de').trim().toLowerCase() === 'en';
  const strictKeys = keywordIndices(expl, isEn ? KEYWORDS_STRICT_EN : KEYWORDS_STRICT);
  const looseKeys = keywordIndices(expl, isEn ? KEYWORDS_LOOSE_EN : KEYWORDS_LOOSE);
  if (!strictKeys.length && !looseKeys.length) return [];

  const out = [];
  QUOTE_RE.lastIndex = 0;
  let m;
  while ((m = QUOTE_RE.exec(expl))) {
    const start = m.index;
    const end = start + m[0].length;
    const nearStrict = isProximate(start, end, strictKeys);
    const nearLoose = isProximate(start, end, looseKeys);
    if (!nearStrict && !nearLoose) continue;
    let mode = 'strict';
    if (nearStrict && nearLoose) mode = 'both';
    else if (nearLoose) mode = 'loose';
    out.push({ text: normalizeAlignText(m[1]), index: start, mode });
  }
  return out;
}

function letterForBody(map, body) {
  for (const [L, b] of map) {
    if (b === body) return L;
  }
  return null;
}

function missingQuoteSeverity() {
  const until = EXPL_OPTION_TEXT_ALIGN_WARN_ONLY_UNTIL;
  const today = new Date().toISOString().slice(0, 10);
  return today <= until ? 'warn' : 'block';
}

/**
 * @param {object} q — question with options, correct, explanation
 * @returns {{ blocking: object[], warnings: object[] }}
 */
export function checkExplanationOptionTextAlignQuestion(q) {
  const blocking = [];
  const warnings = [];
  const mod = String(q.module || '').toLowerCase();
  if (['schreiben', 'sprechen'].includes(mod)) {
    return { blocking, warnings };
  }
  const opts = q.options || [];
  if (opts.length < 2) return { blocking, warnings };

  const expl = String(q.explanation || '').trim();
  if (!expl) return { blocking, warnings };

  const correctL = correctLetter(q);
  const bodies = optionBodiesByLetter(q);
  if (!correctL || !bodies.has(correctL)) return { blocking, warnings };

  const correctBody = bodies.get(correctL);
  const lang = String(q.lang || q.language || 'de').trim().toLowerCase();
  const strictConvention = lang === 'de'; // Goethe quotes the option verbatim; Cambridge does not
  const proxQuotes = extractKeywordProximateQuotes(expl, lang);
  const hasStrictKeywords =
    keywordIndices(expl, lang === 'en' ? KEYWORDS_STRICT_EN : KEYWORDS_STRICT).length > 0;

  const strictQuotes = proxQuotes.filter((q) => q.mode === 'strict' || q.mode === 'both');
  const looseQuotes = proxQuotes.filter((q) => q.mode === 'loose' || q.mode === 'both');

  for (const { text } of looseQuotes) {
    const asLetter = letterForBody(bodies, text);
    if (asLetter && asLetter !== correctL) {
      blocking.push({
        kind: 'quote_wrong_option',
        itemId: q.id,
        message:
          `${q.id || 'question'}: CHK-34 — la explicación cita textualmente la opción ${asLetter}) «${text}» pero la clave es ${correctL}).`,
      });
    }
  }

  if (!strictQuotes.length) {
    if (hasStrictKeywords && missingQuoteSeverity() === 'block') {
      blocking.push({
        kind: 'missing_correct_quote',
        itemId: q.id,
        message:
          `${q.id || 'question'}: CHK-34 — hay referencia a Überschrift/Option pero ninguna cita entre comillas coincide con la opción correcta (${correctL}).`,
      });
    } else if (hasStrictKeywords) {
      warnings.push({
        kind: 'missing_correct_quote',
        itemId: q.id,
        message:
          `${q.id || 'question'}: CHK-34 (aviso) — cita textual de la opción ${correctL} ausente; revisar tras edición manual de options.`,
      });
    }
    return { blocking, warnings };
  }

  let matchedCorrect = false;
  for (const { text } of strictQuotes) {
    if (strictConvention) {
      if (text === correctBody) {
        matchedCorrect = true;
        continue;
      }
    } else {
      const rel = quoteBodyRelation(text, correctBody);
      if (rel === 'exact' || rel === 'partial') {
        matchedCorrect = true;
        continue;
      }
      if (rel === 'case') {
        // The quote is the right option, spelled with different casing — capitalization drift,
        // not a wrong answer key. Worth reporting, not worth blocking.
        matchedCorrect = true;
        warnings.push({
          kind: 'quote_case_drift',
          itemId: q.id,
          message:
            `${q.id || 'question'}: CHK-34 — la cita «${text}» coincide con la opción correcta ${correctL}) «${correctBody}» salvo en mayúsculas.`,
        });
        continue;
      }
    }
    const asLetter = letterForBody(bodies, text);
    if (asLetter && asLetter !== correctL) {
      blocking.push({
        kind: 'quote_wrong_option',
        itemId: q.id,
        message:
          `${q.id || 'question'}: CHK-34 — la explicación cita «${text}» (opción ${asLetter}) pero la clave es ${correctL}) «${correctBody}».`,
      });
      continue;
    }
    blocking.push({
      kind: 'quote_not_correct',
      itemId: q.id,
      message:
        `${q.id || 'question'}: CHK-34 — cita en explicación «${text}» no coincide con la opción correcta ${correctL}) «${correctBody}».`,
    });
  }

  if (
    !matchedCorrect &&
    !blocking.some((b) => b.kind === 'quote_wrong_option' || b.kind === 'quote_not_correct')
  ) {
    const sev = missingQuoteSeverity();
    const msg = `${q.id || 'question'}: CHK-34 — ninguna cita entre comillas coincide con la opción correcta ${correctL}).`;
    if (sev === 'block') blocking.push({ kind: 'missing_correct_quote', itemId: q.id, message: msg });
    else warnings.push({ kind: 'missing_correct_quote', itemId: q.id, message: msg });
  }

  return { blocking, warnings };
}

/**
 * @param {object} batch
 * @returns {{ blocking: object[], warnings: object[] }}
 */
export function collectExplanationOptionTextAlign(batch) {
  const blocking = [];
  const warnings = [];
  for (const q of batch?.questions || []) {
    const r = checkExplanationOptionTextAlignQuestion(q);
    blocking.push(...r.blocking);
    warnings.push(...r.warnings);
  }
  return { blocking, warnings };
}

/**
 * Audit findings for chk34().
 * @returns {{ severity: 'CRITICAL'|'IMPORTANT'|'MINOR', itemId: string, message: string }[]}
 */
export function findExplanationOptionTextAlignFindings(batch) {
  const { blocking, warnings } = collectExplanationOptionTextAlign(batch);
  const findings = [];
  for (const b of blocking) {
    findings.push({
      severity: b.kind === 'quote_wrong_option' ? 'CRITICAL' : 'CRITICAL',
      itemId: b.itemId,
      message: b.message,
    });
  }
  for (const w of warnings) {
    findings.push({
      severity: 'MINOR',
      itemId: w.itemId,
      message: w.message,
    });
  }
  return findings;
}
