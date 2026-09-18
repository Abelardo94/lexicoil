/**
 * British ↔ American spelling forms for en/* content. Cambridge is a British
 * exam, so the British form is the correct one and the American form is a defect.
 *
 * Matching is by WHOLE WORD against this table, never by stem. Stem matching is
 * what makes a naive gate wrong: `\blabor` also hits "laboratory", `\bcenter`
 * turns "centered" into "centreed", and `\borganize` + `\borganizer` count
 * "organizers" twice. Listing the inflections costs a few lines and removes the
 * whole class of error.
 */

/** American form → British form. Whole words, lowercase. */
export const AMERICAN_TO_BRITISH = new Map(Object.entries({
  // -re
  center: 'centre', centers: 'centres', centered: 'centred', centering: 'centring',
  theater: 'theatre', theaters: 'theatres',
  meter: 'metre', meters: 'metres', // the unit; see AMBIGUOUS for the device
  // -our
  color: 'colour', colors: 'colours', colored: 'coloured', coloring: 'colouring',
  colorful: 'colourful', colorless: 'colourless',
  favorite: 'favourite', favorites: 'favourites',
  neighbor: 'neighbour', neighbors: 'neighbours', neighborhood: 'neighbourhood',
  neighborhoods: 'neighbourhoods',
  armor: 'armour', armors: 'armours', armored: 'armoured',
  behavior: 'behaviour', behaviors: 'behaviours',
  flavor: 'flavour', flavors: 'flavours', flavored: 'flavoured',
  harbor: 'harbour', harbors: 'harbours',
  humor: 'humour', humorless: 'humourless',
  labor: 'labour', labors: 'labours', labored: 'laboured',
  // NB: "laboratory"/"laboratories" are correct everywhere and are absent here on purpose.
  // -ise
  organize: 'organise', organizes: 'organises', organized: 'organised',
  organizing: 'organising', organizer: 'organiser', organizers: 'organisers',
  organization: 'organisation', organizations: 'organisations',
  realize: 'realise', realizes: 'realises', realized: 'realised', realizing: 'realising',
  recognize: 'recognise', recognizes: 'recognises', recognized: 'recognised',
  recognizing: 'recognising',
  apologize: 'apologise', apologizes: 'apologises', apologized: 'apologised',
  apologizing: 'apologising',
  specialize: 'specialise', specializes: 'specialises', specialized: 'specialised',
  specializing: 'specialising',
  // doubled consonant
  traveling: 'travelling', traveled: 'travelled', traveler: 'traveller',
  travelers: 'travellers',
  canceled: 'cancelled', canceling: 'cancelling',
  // misc
  gray: 'grey', jewelry: 'jewellery', pajamas: 'pyjamas', airplane: 'aeroplane',
}));

/**
 * Forms that are also correct British English in some sense, so a hit is a
 * prompt to look, never a defect on its own. Reported, never auto-changed,
 * never fails --strict.
 *
 *   practice — correct as the NOUN ("football practice"); only the verb is practise
 *   tire     — the verb (to tire) is fine; only the car part is tyre
 *   learned  — both learnt and learned are standard British
 *   program  — correct for computer programs; programme for TV and events
 *   meter    — the device (parking meter); metre is the unit
 */
export const AMBIGUOUS = new Map(Object.entries({
  practice: 'practise', tire: 'tyre', learned: 'learnt', program: 'programme',
}));

/** Copy the casing of `from` onto `to` ("Center" → "Centre", "GRAY" → "GREY"). */
export function matchCase(from, to) {
  if (from === from.toUpperCase() && from !== from.toLowerCase()) return to.toUpperCase();
  if (from[0] === from[0].toUpperCase()) return to[0].toUpperCase() + to.slice(1);
  return to;
}

/**
 * Replace every American form in `text`. Returns the new text and the list of
 * words changed; `hits` is empty when nothing matched.
 */
export function toBritish(text) {
  const hits = [];
  const out = text.replace(/[A-Za-z]+/g, (word) => {
    const brit = AMERICAN_TO_BRITISH.get(word.toLowerCase());
    if (!brit) return word;
    const replaced = matchCase(word, brit);
    hits.push({ from: word, to: replaced });
    return replaced;
  });
  return { text: out, hits };
}

/** Just find them, without rewriting. */
export function findAmerican(text) {
  const hits = [];
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    if (AMERICAN_TO_BRITISH.has(m[0].toLowerCase())) hits.push(m[0]);
  }
  return hits;
}

/** Ambiguous forms present in `text` — reported, never a defect. */
export function findAmbiguous(text) {
  const hits = [];
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    if (AMBIGUOUS.has(m[0].toLowerCase())) hits.push(m[0]);
  }
  return hits;
}

/** Keys whose values are identifiers or machine config, never learner-visible prose. */
export const DENY_KEYS = new Set([
  'id', 'ids', 'itemId', 'partId', 'passageId', 'segmentId', 'questionId', 'examId',
  'poolId', 'hash', 'contentHash', 'voice', 'voiceId', 'model', 'lang', 'level',
  'module', 'type', 'contributor', 'src', 'url', 'href', 'file', 'path',
]);

/** "notices-station-02" and friends: identifier-shaped, not prose. */
const IDENTIFIER_LIKE = /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+$/;

/**
 * Walk every learner-visible string in a parsed content file, calling
 * `fn(value, where, key)`. Returning a string replaces the value in place;
 * returning null or undefined leaves it alone — so the same walker serves the
 * gate (which only looks) and the fixer (which rewrites).
 *
 * `options` and `ads` are arrays OF STRINGS, and most of the defects here live
 * in them. Keeping one walker is the point: when the gate had its own copy that
 * recursed into arrays but dropped non-object elements, it inspected no answer
 * option at all and reported a clean tree — a green from not looking. See the
 * sabotage test in scripts/lib/__tests__/spellingGate.test.mjs.
 */
export function mapStrings(node, fn, trail = '', key = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      const where = `${trail}[${i}]`;
      if (typeof v === 'string') {
        if (DENY_KEYS.has(key) || IDENTIFIER_LIKE.test(v)) continue;
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
      if (DENY_KEYS.has(k) || IDENTIFIER_LIKE.test(v)) continue;
      const next = fn(v, where, k);
      if (typeof next === 'string') node[k] = next;
    } else if (v && typeof v === 'object') mapStrings(v, fn, where, k);
  }
  return node;
}
