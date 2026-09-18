/**
 * Single source for picking a question's `vocabularyTags`.
 *
 * This lived duplicated in enrich-bank-vocab-tags.mjs and enrich-served-vocab-tags.mjs,
 * with the same defect in both and a different stopword list in each, which produced
 * tags that did not match between the bank and the served exams.
 *
 * The rule, in one line: tags come from what makes THIS question distinct; the
 * passage only joins in when that alone does not reach the minimum.
 */
import { extractVocabularyFromText } from './enrichBatchMetadata.mjs';

export const MIN_TAGS = 3;
export const MAX_TAGS = 6;

const OPTION_KEY_RE = /^\s*([A-Za-z])\s*[).\-:\]]/;

const optionText = (o) => (typeof o === 'string' ? o : o?.text);

/**
 * In matching (Teil 3) the options are the adverts of the WHOLE block: all eight
 * or ten are identical for every question in it, so feeding them to the extractor
 * gives all those questions the same tags. Only the correct one belongs here.
 */
export function matchingAnswerText(q) {
  const key = String(q?.correct ?? q?.correctAnswer ?? '').trim().toUpperCase();
  if (!key) return null;
  for (const opt of q?.options || []) {
    const text = optionText(opt);
    if (!text) continue;
    const m = OPTION_KEY_RE.exec(text);
    if (m && m[1].toUpperCase() === key) return text;
  }
  return null;
}

export function isMatching(q) {
  return String(q?.type || '').toLowerCase().startsWith('match');
}

/** The question's own text: stem plus options (in matching, only the correct one). */
export function ownText(q) {
  const parts = [q?.question, q?.statement, q?.transcript, q?.signText, q?.text];
  if (isMatching(q)) {
    const answer = matchingAnswerText(q);
    if (answer) parts.push(answer);
  } else {
    (q?.options || []).forEach((o) => parts.push(optionText(o)));
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * @param {object} q the question
 * @param {string} context passage/part text — used only as a tie-breaker
 * @param {(text: string, max: number) => string[]} [extract] injectable for tests
 * @returns {string[]} tags, or [] when the minimum is not reached
 */
export function tagsForQuestion(q, context = '', extract = extractVocabularyFromText) {
  const tags = extract(ownText(q), 8).map((w) => String(w));
  if (tags.length < MIN_TAGS && context) {
    for (const w of extract(context, 8).map((x) => String(x))) {
      if (tags.length >= MIN_TAGS) break;
      if (!tags.includes(w)) tags.push(w);
    }
  }
  return tags.length >= MIN_TAGS ? tags.slice(0, MAX_TAGS) : [];
}
