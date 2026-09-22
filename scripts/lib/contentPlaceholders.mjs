/**
 * Generator debris that must never reach a learner.
 *
 * Found in library/de/B1/questions.json: 175 Teil 3 ads ending in
 * "Stichworte: <lemas flojos>." — a Spanish template slot ("weak lemmas") left
 * unfilled inside German exam content. The served exams were clean, so nothing
 * caught it: it only shows up in exams ASSEMBLED FROM THE BANK, which is the
 * personalised path.
 *
 * Deterministic, so it belongs in a gate rather than in a semantic reviewer.
 */

/**
 * [name, pattern]. Each match is debris unless a filter below clears it.
 *
 * The angle-bracket pattern requires the slot to begin with a letter and end
 * with a letter, digit or underscore, so no whitespace touches the brackets.
 * Matching anything between < and > flags ordinary prose: "5 < 7 y 9 > 3" reads
 * as the slot "< 7 y 9 >", and a gate that fires on arithmetic gets switched off.
 */
export const PATTERNS = [
  ['angulares', /<[A-Za-zÀ-ÿ][^<>]{0,58}[A-Za-zÀ-ÿ0-9_]>/g],
  ['llaves', /\{\{[^}]{1,60}\}\}/g],
  ['todo', /\b(TODO|FIXME|XXX|PLACEHOLDER)\b/gi],
  ['lorem', /\blorem ipsum\b/gi],
];

/** Markup that is legitimately allowed to look like an angle-bracket slot. */
const REAL_MARKUP = /^<\/?(b|i|u|br|em|strong|span|p|div|sub|sup)\b[^>]*>$/i;

/** Keys whose values are identifiers or machine config, never learner-visible prose. */
export const DENY_KEYS = new Set([
  'id', 'ids', 'itemId', 'partId', 'passageId', 'segmentId', 'questionId', 'examId',
  'poolId', 'hash', 'contentHash', 'voice', 'voiceId', 'model', 'src', 'url', 'href',
  'file', 'path',
]);

/** Debris found in one string, as {kind, text} entries. */
export function findDebris(value) {
  const out = [];
  for (const [kind, re] of PATTERNS) {
    const matches = String(value).match(re);
    if (!matches) continue;
    for (const m of matches) {
      if (kind === 'angulares' && REAL_MARKUP.test(m)) continue;
      out.push({ kind, text: m });
    }
  }
  return out;
}

/**
 * Walk every learner-visible string, calling fn(value, where, key). Returning a
 * string replaces it in place. Arrays of strings are walked explicitly: the ads
 * of a Teil 3 part live in `options`, which is exactly where the debris was.
 */
export function mapStrings(node, fn, trail = '', key = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      const where = `${trail}[${i}]`;
      if (typeof v === 'string') {
        if (DENY_KEYS.has(key)) continue;
        const next = fn(v, where, key);
        if (typeof next === 'string') node[i] = next;
      } else if (v && typeof v === 'object') mapStrings(v, fn, where, key);
    }
    return node;
  }
  if (!node || typeof node !== 'object') return node;
  for (const [k, v] of Object.entries(node)) {
    const where = trail ? `${trail}.${k}` : k;
    if (typeof v === 'string') {
      if (DENY_KEYS.has(k)) continue;
      const next = fn(v, where, k);
      if (typeof next === 'string') node[k] = next;
    } else if (v && typeof v === 'object') mapStrings(v, fn, where, k);
  }
  return node;
}

/**
 * Strip the one debris shape seen in the wild: a trailing "Stichworte: <...>"
 * sentence glued to an otherwise well-formed ad. Anything else is reported and
 * left alone — a placeholder in the middle of a sentence means the sentence was
 * never written, and a script cannot invent it.
 */
export function stripTrailingSlot(value) {
  return String(value).replace(/\s*Stichworte:\s*<[^>]*>\.?\s*$/u, '');
}
