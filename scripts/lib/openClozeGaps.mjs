/**
 * Reading Part 6 is an OPEN cloze: the candidate writes the word, with no options
 * to choose from. A gap whose answer is a content word therefore accepts every
 * synonym and cannot be marked — "we ___ a compromise" takes made, reached and
 * came to; "took ___ of photos" takes lots, plenty and loads. Cambridge gaps
 * function words precisely to avoid this, and the engine has no support for
 * alternative accepted answers, so a lexical gap here is unmarkable, not merely
 * untidy.
 *
 * The list below is what a Part 6 key is allowed to be. It is deliberately a
 * closed list rather than a part-of-speech guess: this must never pass something
 * "probably grammatical".
 */
export const FUNCTION_WORDS = new Set([
  // articles and determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'both',
  'either', 'neither', 'another', 'other', 'such', 'same', 'own', 'any', 'no',
  'some', 'much', 'many', 'more', 'most', 'few', 'little', 'less', 'least', 'enough',
  // pronouns
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours',
  'theirs', 'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves',
  'themselves', 'one', 'ones', 'there',
  // relatives and interrogatives
  'who', 'whom', 'whose', 'which', 'what', 'where', 'when', 'why', 'how',
  // prepositions
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'about', 'into',
  'onto', 'over', 'under', 'above', 'below', 'across', 'through', 'between',
  'among', 'against', 'towards', 'toward', 'during', 'before', 'after', 'until',
  'till', 'since', 'without', 'within', 'behind', 'beside', 'besides', 'beyond',
  'near', 'off', 'out', 'up', 'down', 'around', 'along', 'past', 'per', 'like',
  // conjunctions
  'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though', 'if',
  'unless', 'whether', 'while', 'whereas', 'as', 'than', 'once', 'whenever',
  'wherever', 'however',
  // auxiliaries and modals
  'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had',
  'having', 'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can',
  'could', 'may', 'might', 'must', 'ought', 'need', 'dare', 'used',
  // common adverbial function words
  'not', 'too', 'very', 'also', 'just', 'only', 'even', 'still', 'already',
  'ever', 'never', 'always', 'again', 'back', 'then', 'there', 'here', 'well',
  'rather', 'quite', 'almost', 'instead', 'otherwise', 'therefore', 'anyway',
]);

/**
 * Words that ARE function words but whose gap still takes more than one answer,
 * so they need a second look rather than a pass. `never` is the one that bit us:
 * "I had ___ worked in a shop before" takes `not` just as well.
 */
export const WEAK = new Set(['never', 'not', 'that', 'which', 'a', 'an', 'the']);

/** Is this Part 6 key a function word? */
export function isFunctionWord(key) {
  return FUNCTION_WORDS.has(String(key).trim().toLowerCase());
}

/** True for a part that is an open cloze (Reading Part 6). */
export function isOpenCloze(part) {
  const teil = Number(part?.teil ?? part?.part ?? NaN);
  const module = String(part?.module || '').toLowerCase();
  if (module === 'lesen' && teil === 6) return true;
  const slot = String(part?.blueprintSlot || part?.slotType || part?.type || '').toLowerCase();
  return /open_cloze/.test(slot);
}
