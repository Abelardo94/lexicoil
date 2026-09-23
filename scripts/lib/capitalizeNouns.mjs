/**
 * capitalizeNouns.mjs — conservative German capitalization normalizer.
 * Stable with germanCapsNormalize v3.0-stable (see GERMAN-CAPS-NORMALIZE.md).
 *
 * UP:   capitalize only after article/possessive OR at clause start when noun is certain.
 * DOWN: decapitalize mid-sentence homographs only after pronoun/modal/particle triggers.
 * Everything else is left untouched (POS gate catches remaining errors).
 */

import {
  getGermanNounLexicon,
  isKnownGermanNoun,
  NOMINALIZED_INFINITIVE_GUARD,
} from './germanNounLexicon.mjs';

export { NOMINALIZED_INFINITIVE_GUARD, isKnownGermanNoun, getGermanNounLexicon };

// ── Shared sets (also used by pool audit scripts) ───────────────────────────

/** After these titles, the next capitalized token is a surname — never decap («Herr Lang», not «Herr lang»). */
export const HONORIFIC_SURNAME_PREV = new Set(['herr', 'herrn', 'frau']);

export const PURE_ADVERBS = new Set([
  'eher', 'gerne', 'gern', 'leider', 'vielleicht', 'bereits', 'sogar', 'wirklich',
  'natürlich', 'eigentlich', 'trotzdem', 'allerdings', 'außerdem', 'jedoch', 'dennoch',
  'deshalb', 'deswegen', 'gleich', 'oft', 'selten', 'bald', 'sofort', 'zusammen',
  'allein', 'darum', 'dann', 'dabei', 'damit', 'dazu', 'hier', 'dort', 'oben', 'unten',
  'vorn', 'hinten', 'fast', 'kaum', 'lieber', 'statt', 'stattdessen', 'online', 'automatisch',
  'spät', 'morgens', 'abends', 'ganz',
]);

export const ADJ_NEEDS_ARTICLE_GUARD = new Set([
  // Inflected quantifier-adjectives (tokenLemma is lowercasing only — not morphological).
  // Gap 2026-07-12: «Die Vielen Marketing-Kampagnen» kept Cap because only viele/viel were listed.
  'viele', 'viel', 'vielen', 'vieler', 'vieles', 'vielem',
  'wenige', 'wenig', 'wenigen', 'weniger', 'weniges', 'wenigem',
  'einige', 'einig', 'einigen', 'einiger', 'einiges', 'einigem',
  'gute', 'guten', 'gutes', 'gutem', 'guter', 'bessere', 'besseren', 'besseres', 'besserem', 'besserer',
  'neue', 'neuen', 'neues', 'neuem', 'neuer',
  'alte', 'alten', 'altes', 'altem',
  'kleine', 'kleinen', 'kleines', 'kleinem', 'kleiner',
  'große', 'großen', 'großes', 'großem', 'großer',
  'schöne', 'schönen', 'schönes', 'schönem', 'schöner',
  'beste', 'besten', 'bestes', 'bestem',
  'erste', 'ersten', 'erstes', 'erstem',
  'letzte', 'letzten', 'letzes', 'letztem',
  'nächste', 'nächsten', 'nächstes',
  'andere', 'anderen', 'anderes', 'anderem', 'anderer',
  'eigene', 'eigenen', 'eigenes', 'eigenem', 'eigener',
  'richtige', 'richtigen', 'richtiges', 'richtigem', 'richtiger',
  'falsche', 'falschen', 'falsches', 'falschem', 'falscher',
  'wichtige', 'wichtigen', 'wichtiges', 'wichtigem', 'wichtiger',
  'unwichtige', 'unwichtigen',
  'schlechte', 'schlechten', 'schlechtes', 'schlechtem',
  'schwierig', 'schwierige', 'schwierigen', 'schwieriges', 'schwierigem',
  'einfache', 'einfachen', 'einfaches', 'einfachem', 'einfacher',
  'möglich', 'mögliche', 'möglichen', 'mögliches', 'möglichem',
  'unmöglich', 'unmögliche', 'unmöglichen',
  'interessante', 'interessanten', 'interessantes', 'interessanter', 'interessantem',
  'langweilig', 'langweilige', 'langweiligen',
  'spannende', 'spannenden', 'spannendes',
  'hässliche', 'hässlichen',
  'lange', 'lang', 'langen', 'langer', 'langem', 'langes', 'kurze', 'kurz',
  'wichtig', 'persönlich', 'persönliche', 'persönlichen', 'persönliches', 'persönlichem', 'persönlicher',
  'deutlich', 'deutliche', 'deutlichen', 'deutliches', 'deutlichem', 'deutlicher',
  'nachhaltig', 'nachhaltige', 'nachhaltigen', 'nachhaltiges', 'nachhaltigem', 'nachhaltiger',
  'junge', 'jungen', 'junges', 'jungem', 'junger',
  'sicher', 'sichere', 'sicheren', 'sicheres', 'sicherem', 'sicherer',
  'nötig', 'nötige', 'nötigen', 'nötiges', 'nötigem', 'nötiger',
  'zugänglich', 'zugängliche', 'zugänglichen', 'zugängliches', 'zugänglichem', 'zugänglicher',
  'verantwortlich', 'verantwortliche', 'verantwortlichen', 'verantwortliches', 'verantwortlichem', 'verantwortlicher',
  'politisch', 'politische', 'politischen', 'politisches', 'politischem', 'politischer',
  'ganzen', 'ganzer', 'ganzes', 'ganzem', 'ganze',
  'freie', 'freien', 'freies', 'freiem', 'freier',
  'vielfältig', 'vielfältige', 'vielfältigen', 'vielfältiges', 'vielfältigem', 'vielfältiger',
  'effizient', 'effiziente', 'effizienten', 'effizientes', 'effizientem', 'effizienter',
  'öffentlich', 'öffentliche', 'öffentlichen', 'öffentliches', 'öffentlichem', 'öffentlicher',
  'schwer', 'schwere', 'schweren', 'schweres', 'schwerem', 'schwerer',
  'wichtigere', 'wichtigeres', 'wichtigerem',
  'teuer', 'teure', 'teuren', 'teures', 'teurem', 'teurer', 'teurere', 'teureres', 'teurerem',
  'gesellschaftlich', 'gesellschaftliche', 'gesellschaftlichen', 'gesellschaftliches', 'gesellschaftlichem', 'gesellschaftlicher',
  'beruflich', 'berufliche', 'beruflichen', 'beruflichem', 'beruflicher', 'berufliches',
  'zukünftig', 'zukünftige', 'zukünftigen', 'zukünftigem', 'zukünftiger', 'zukünftiges',
  'zusätzlich', 'zusätzliche', 'zusätzlichen', 'zusätzliches', 'zusätzlichem', 'zusätzlicher',
  // Wave Hören-T2 2026-07-10: comparatives / attributive participles / adj after article
  'größere', 'größeren', 'größeres', 'größerem', 'größerer',
  'täglich', 'tägliche', 'täglichen', 'tägliches', 'täglichem', 'täglicher',
  'angeboten', 'angebotene', 'angebotenen', 'angebotenes', 'angebotenem', 'angebotener',
  'breite', 'breiten', 'breites', 'breitem', 'breiter',
  'kontinuierlich', 'kontinuierliche', 'kontinuierlichen', 'kontinuierliches', 'kontinuierlichem', 'kontinuierlicher',
  'zentral', 'zentrale', 'zentralen', 'zentrales', 'zentralem', 'zentraler',
  'sogenannt', 'sogenannte', 'sogenannten', 'sogenanntes', 'sogenanntem', 'sogenannter',
  'gesprochen', 'gesprochene', 'gesprochenen', 'gesprochenes', 'gesprochenem', 'gesprochener',
  'rechtlich', 'rechtliche', 'rechtlichen', 'rechtliches', 'rechtlichem', 'rechtlicher',
  // Wave review e2/e3/e4 2026-07-10: attributive adj over-cap (documented, never wired)
  'sportlich', 'sportliche', 'sportlichen', 'sportliches', 'sportlichem', 'sportlicher',
  'ähnlich', 'ähnliche', 'ähnlichen', 'ähnliches', 'ähnlichem', 'ähnlicher',
  'ärztlich', 'ärztliche', 'ärztlichen', 'ärztliches', 'ärztlichem', 'ärztlicher',
  // pool-verified audit 2026-07-10: «eine Autofreie Innenstadt»
  'autofrei', 'autofreie', 'autofreien', 'autofreies', 'autofreiem', 'autofreier',
  // pool-verified deep-read 2026-07-10: attributive / predicative adj over-cap
  'örtlich', 'örtliche', 'örtlichen', 'örtliches', 'örtlichem', 'örtlicher',
  'erfolgreich', 'erfolgreiche', 'erfolgreichen', 'erfolgreiches', 'erfolgreichem', 'erfolgreicher',
  // «in der Frischen Luft» — frisch* was only in V2_ADV_VERB_TRIGGERS (verb after adv),
  // not in this adj-after-article guard; that gap left Frischen untouched.
  'frisch', 'frische', 'frischen', 'frisches', 'frischem', 'frischer',
  // audit 2026-07-24: attributive after article («die Technischen Fragen»)
  'technisch', 'technische', 'technischen', 'technisches', 'technischem', 'technischer',
]);

/** Predicative comparatives after «das/es/etwas» («wird das teurer») — not substantivized nouns. */
const COMPARATIVE_QUANTIFIER_LEMMAS = new Set([
  'weniger', 'mehr', 'wenige', 'viele', 'wenigen', 'vielen', 'vieles', 'vielem', 'weniges', 'wenigem',
]);
const PREDICATE_ADJ_AFTER_DAS_DENY = new Set([
  'teurer', 'teurere', 'teureres', 'teurerem',
  'wichtiger', 'wichtigere', 'wichtigeres', 'wichtigerem',
  'schwerer', 'schwerere', 'billiger', 'billigere', 'günstiger', 'günstigere',
  'schöner', 'schönere', 'schöneres', 'schönerem',
]);

const PREDICATE_COMPARATIVE_TRIGGERS = new Set(['das', 'es', 'etwas', 'nichts', 'die', 'der', 'den', 'dem']);
const PREDICATE_COMPARATIVE_NEXT = new Set(['als', 'wie']);

/** «das teurer», «die Schöner als ein Flug» — comparative, not «die Kleinen». */
function isPredicativeComparativeNotSubstantivized(prevLc, lc, nextWord) {
  const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
  if (
    COMPARATIVE_QUANTIFIER_LEMMAS.has(lc) &&
    PREDICATE_COMPARATIVE_TRIGGERS.has(prevLc) &&
    PREDICATE_COMPARATIVE_NEXT.has(nextLc)
  ) {
    return true;
  }
  if (!PREDICATE_ADJ_AFTER_DAS_DENY.has(lc)) return false;
  if (!PREDICATE_COMPARATIVE_TRIGGERS.has(prevLc)) return false;
  if (!nextLc) return ['das', 'es', 'etwas', 'nichts'].includes(prevLc);
  return PREDICATE_COMPARATIVE_NEXT.has(nextLc);
}

/** Infinitives G2 mis-tags as nouns (lexicon_override_tag) — never capitalize mid-clause. */
export const LEXICON_OVERRIDE_VERB_INFINITIVES = new Set([
  'besuchen', 'löschen', 'machen', 'mitmachen',
]);

/** Separable verb particles that must stay lowercase after their head verb. */
export const SEPARABLE_VERB_PARTICLES = new Set(['teil']);

/** Currency units — capitalized nouns; G2 verb_census FP on «X Euro». */
export const CURRENCY_UNITS = new Set(['euro', 'euros', 'cent', 'cents']);

const INFINITIVE_DECAP_PREV = new Set([
  'manchmal', 'sofort', 'öffentlich', 'regelmäßig', 'alle', 'können', 'kann', 'nehmen',
]);

const SUBSTANTIVIZED_ADJ_PREP_TRIGGERS = new Set([
  'für', 'mit', 'an', 'auf', 'in', 'von', 'über', 'um', 'gegen', 'ohne', 'zu',
]);

export const CARDINALS_NEEDS_ARTICLE_GUARD = new Set([
  'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn',
  'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn', 'zwanzig',
]);

export const NEVER_NOUN_WORDS = new Set([
  ...PURE_ADVERBS,
  ...ADJ_NEEDS_ARTICLE_GUARD,
  ...CARDINALS_NEEDS_ARTICLE_GUARD,
]);

/** Homographs that must not be capitalized mid-sentence after verb/pronoun triggers. */
export const HOMOGRAPH_RISK = new Set([
  'zahlen', 'kosten', 'arbeiten', 'erfolgen', 'verursachen', 'posten', 'spielen', 'wissen',
  'essen', 'folgen', 'stellen', 'raten', 'berichten', 'glauben', 'leben', 'lernen', 'kochen',
  'treffen', 'lesen', 'fahren', 'reisen', 'denken', 'sorgen', 'fragen',
  // Modal-infinitive guard (G2-mini gap): «Alle sollen Mitmachen können»
  'machen', 'mitmachen',
  'spät', 'morgens', 'abends', 'ganzen', 'ganzer', 'ganzes', 'ganzem', 'ganze',
  'bessere', 'besseren', 'besseres', 'besserem', 'besserer', 'oft',
]);

/**
 * Subset of HOMOGRAPH_RISK where adj. atributivo + modal / cap-noun signals genuine
 * nominalization in B1 Lesen (not verb infinitive). Full HOMOGRAPH_RISK would FP on
 * berichten, glauben, raten, verursachen, erfolgen (audit 2026-07-09).
 */
const HOMOGRAPH_NOMINAL_AFTER_ADJ = new Set([
  'reisen', 'kosten', 'fragen', 'treffen', 'sorgen',
  'zahlen', 'arbeiten', 'spielen', 'essen',
]);

/**
 * Verb/noun homographs (or lexicon gaps) that must capitalize after attributive adj
 * even when next token is not modal («für kleine unternehmen»).
 * Broader adj+lower-noun scan of 148 files found only this real miss.
 */
const NOUN_FORCE_AFTER_ATTR_ADJ = new Set([
  'unternehmen', 'kunde', 'kunden',
  'angebot', 'angebote', 'angeboten',
  'diskussion', 'diskussionen',
]);

/** Sustantivos deverbales que el guardián de adj/participio confunde con verbos. */
const DEVERBAL_NOUN_LEMMAS = new Set([
  'angebot', 'angebote', 'angeboten',
  'diskussion', 'diskussionen',
  'abbrüchen', 'abbruch', 'abbrüche',
  'medikament', 'medikamenten',
  'zugreise', 'zugreisen',
]);

/** Predicative adjectives after copula — never capitalize mid-sentence. */
const PREDICATIVE_ADJ_AFTER_COPULA = new Set([
  'billig', 'billige', 'billigen', 'billiger', 'billiges',
  'gleich', 'gleiche', 'gleichen', 'gleicher', 'gleiches',
]);

const PREP_NOMINAL_OBJECT = new Set(['von', 'mit', 'für', 'über', 'an', 'in', 'auf', 'aus', 'bei', 'nach', 'vor', 'zu']);

export const SUBSTANTIVISING_ARTICLES = new Set([
  'der', 'die', 'das', 'dem', 'den', 'des',
  'ein', 'eine', 'einem', 'einen', 'einer', 'eines',
  'kein', 'keine', 'keinem', 'keiner', 'keines', 'keinen',
  'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'dein', 'deine', 'deinen', 'deinem', 'deiner', 'deines',
  'sein', 'seine', 'seinen', 'seinem', 'seiner', 'seines',
  'ihr', 'ihre', 'ihren', 'ihrem', 'ihrer', 'ihres',
  'unser', 'unsere', 'unseren', 'unserem', 'unserer', 'unseres',
  'euer', 'eure', 'euren', 'eurem', 'eurer', 'eures',
  'im', 'am', 'beim', 'zum', 'zur', 'vom', 'ins', 'ans',
  'dieses', 'diese', 'diesem', 'diesen', 'jenes', 'jene', 'jenem', 'jenen',
  'welches', 'welche', 'welchem', 'welchen', 'manches', 'manche', 'manchem', 'manchen',
  'solches', 'solche', 'solchem', 'solchen', 'solcher',
  'als',
]);

/**
 * Bare prepositions that introduce attributive Adj+Noun («zu unterschiedlichen Zeiten»,
 * «mit großen Kindern»). Fused forms (zum/zur/im) already live in SUBSTANTIVISING_ARTICLES;
 * bare «zu» was missing — v3.11 only handled «zu»+noun (Kunden), not «zu»+Adj+Noun.
 */
export const ATTR_ADJ_PREP_TRIGGERS = new Set([
  'zu', 'für', 'mit', 'ohne', 'bei', 'nach', 'von', 'vor', 'über', 'unter',
  'durch', 'gegen', 'um', 'an', 'auf', 'in', 'neben', 'zwischen',
]);

/**
 * Phase 1 (2026-07-11): etwas/nichts/alles + substantivized adjective.
 * Allowlist of canonical forms only — never capitalize an arbitrary follower.
 * Evidence: pool-verified ROTO (gutes/neues/mögliche) + capitalized OK forms
 * (Gutes, Besonderes, Sinnvolles, Kreatives, Produktives). Wichtiges: unit-test
 * golden + B1-frequent. viel/wenig/genug = Phase 2 (out of scope).
 *
 * «was» is NOT in this set: free-relative/interrogative «was … Adj … Verb» needs a
 * verb-follower + lookback guard (see isWasClauseSubstantivizedAdj) so we do not
 * keep arbitrary CapWords after bare «was».
 */
export const INDEF_PRONOUN_SUBST_TRIGGERS = new Set(['etwas', 'nichts', 'alles']);

/** lowercase surface → canonical capitalized form (final spelling, no dynamic inflection). */
export const INDEF_PRONOUN_SUBST_ADJ_ALLOWLIST = new Map([
  ['gutes', 'Gutes'],
  ['neues', 'Neues'],
  ['mögliche', 'Mögliche'],
  ['besonderes', 'Besonderes'],
  ['sinnvolles', 'Sinnvolles'],
  ['kreatives', 'Kreatives'],
  ['produktives', 'Produktives'],
  ['wichtiges', 'Wichtiges'],
  // v3.15: was/etwas + Schönes (schreiben-005 regression 2026-07-12)
  ['schönes', 'Schönes'],
  ['interessantes', 'Interessantes'],
  ['richtiges', 'Richtiges'],
  ['falsches', 'Falsches'],
]);

/**
 * Attributive adjective wrongly capitalized before its noun head
 * («ein Interessanter Gedanke» → interessanter; «die Blaue Papiertonne» → blaue).
 * INVERSE of etwas+Schönes / die+Verantwortlichen (substantivized, keep capital).
 *
 * Proper-name bigrams (lowercase adj|noun) — never decap the adjective.
 * Evidence 2026-07-11: «Grünes/Grünen Viertel» is a named estate/project in
 * lesen-t5-022/026/027/033/037 titles + body — not a descriptive «green neighborhood».
 */
export const ATTR_ADJ_BEFORE_NOUN_PROPER_BIGRAMS = new Set([
  'grünes|viertel',
  'grünen|viertel',
  'grüne|viertel',
]);

/** Titles / address forms — never treat as attributive adjectives. */
const ATTR_ADJ_TITLE_WORDS = new Set([
  'frau', 'herr', 'dr', 'doktor', 'prof', 'professor',
]);

export const DECAP_TRIGGER_PREV = new Set([
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man', 'wer',
  'zu', 'nicht', 'auch', 'nur', 'noch', 'schon', 'sehr', 'ganz', 'oft', 'immer',
  'kann', 'könnte', 'könnten', 'können',
  'muss', 'müsste', 'müssten', 'müssen',
  'soll', 'sollte', 'sollten', 'sollen',
  'will', 'wollte', 'wollten', 'wollen',
  'darf', 'dürfte', 'dürften', 'dürfen',
  'möchte', 'möchten', 'mögen', 'mag',
]);

export const MODAL_VERBS = new Set([
  'könnte', 'könnten', 'kann', 'können',
  'will', 'wollen', 'soll', 'sollen', 'muss', 'müssen',
  'darf', 'dürfen', 'möchte', 'möchten', 'mögen', 'mag',
  'werde', 'wird', 'werden',
]);

/** Prepositions that typically introduce a nominal object after modal + homograph. */
export const MODAL_NOUN_OBJECT_PREPS = new Set([
  'für', 'mit', 'an', 'auf', 'in', 'von', 'über', 'unter', 'nach', 'bei',
  'gegen', 'ohne', 'um', 'durch', 'vor', 'hinter', 'neben', 'zwischen', 'zu',
]);

/** Genuine pair objects where «ein Paar» means a couple of items, not the quantifier. */
export const EIN_PAAR_PAIR_OBJECTS = new Set(['schuhe', 'handschuhe', 'socken', 'ohrringe']);

/** «Ein Paar möchte …» — couple as subject, not quantifier. */
const EIN_PAAR_COUPLE_NEXT = new Set([
  'möchte', 'moechte', 'will', 'wollen', 'wollte', 'wollten', 'mochte', 'mochten',
  'sucht', 'suchen', 'hat', 'haben', 'ist', 'sind', 'war', 'waren', 'kam', 'kommt', 'kommen',
  'lebt', 'leben', 'tanzt', 'tanzen', 'lernt', 'lernen', 'wohnt', 'wohnen', 'fährt', 'fahren',
]);

export const SENTENCE_END_RE =
  // After .!?: optional trailing quote (open or close). Standalone quote-as-boundary:
  // only German/French OPENERS („ « ‚) — NOT closers (“ »), else «… News“ Gesprochen»
  // is wrongly treated as sentence start (Hören T2 2026-07-10).
  /[.!?:]\s*['"„«»‚‘’“”\u2018\u2019\u201c\u201d\u00ab\u00bb]?\s*$|[\u2013\u2014–—]\s*$|[„«‚\u201e\u201a]\s*$|(?<!\w)['"]\s*$/;

export const MCQ_OPTION_PREFIX_RE = /^([a-jA-J]\))\s+(.*)$/s;

export const ZU_PREP_NOUN_WHITELIST = new Set([
  'hause', 'terminen', 'termine', 'termin', 'programmen', 'programme', 'programm',
  'menschen', 'kollegen', 'kollege', 'freunden', 'freunde', 'freund',
  'studenten', 'student', 'studentin', 'studentinnen', 'nachbarn', 'nachbar',
  'kindern', 'kind', 'kinder', 'eltern', 'bewohnern', 'bewohner', 'teilnehmern', 'teilnehmer',
  'veranstaltungen', 'veranstaltung', 'kursen', 'kurse', 'kurs',
  'orten', 'ort', 'orte', 'städten', 'stadt', 'städte',
  'tagen', 'tag', 'tage', 'wochen', 'woche', 'monaten', 'monat', 'monate',
  'jahren', 'jahr', 'jahre', 'stunden', 'stunde', 'schulen', 'schule',
  'bibliotheken', 'bibliothek', 'supermärkten', 'supermarkt', 'museen', 'museum',
  'verkehrsbehinderungen', 'verkehrsbehinderung',
  'sammelstellen', 'sammelstelle',
  // zu + plural noun (not zu-infinitive): spot-fix 2026-07-11
  'umweltfragen', 'umweltfrage',
  // -en noun plurals that must win over infinitive-morphology block (v3.12)
  'kunden', 'kunde', 'medien', 'medium', 'problemen', 'problem', 'themen', 'thema',
  'diskussion', 'diskussionen', 'angebot', 'angebote', 'angeboten',
]);

/**
 * Bare zu-infinitive verbs (and dual noun/verb lemmas where zu+X is almost always verbal).
 * Used so «zu Kunden» capitalizes (noun-only) while «zu machen» / «zu unternehmen» stay lower.
 * Pattern rule — not a noun allowlist: capitalize after zu when certain noun AND not in this set.
 */
const ZU_INFINITIVE_VERB_DENY = new Set([
  ...LEXICON_OVERRIDE_VERB_INFINITIVES,
  ...[...HOMOGRAPH_RISK].filter((w) => /(?:en|eln|ern)$/i.test(w)),
  'unternehmen', // dual: «etwas zu unternehmen» (verb) vs attr-adj rule for noun
  'machen', 'gehen', 'kommen', 'sehen', 'hören', 'sprechen', 'lernen', 'arbeiten',
  'wohnen', 'spielen', 'lesen', 'schreiben', 'fahren', 'laufen', 'essen', 'trinken',
  'kaufen', 'verkaufen', 'nehmen', 'geben', 'helfen', 'finden', 'suchen', 'bleiben',
  'werden', 'haben', 'können', 'müssen', 'wollen', 'dürfen', 'sollen', 'mögen',
  'verstehen', 'erklären', 'erzählen', 'versuchen', 'beginnen', 'öffnen', 'schließen',
  'anfangen', 'aufhören', 'mitbringen', 'mitnehmen', 'einladen', 'besuchen', 'beachten',
  'nutzen', 'sparen', 'vermeiden', 'verbessern', 'schaffen', 'reduzieren', 'fördern',
  'halten', 'schützen', 'verbringen', 'lassen', 'gestalten', 'gewährleisten', 'bekommen',
  'schonen', 'konzentrieren', 'gewinnen', 'senken', 'setzen', 'erweitern', 'verwenden',
  'unterstützen', 'bringen', 'wählen', 'minimieren', 'erreichen', 'knüpfen', 'erholen',
  'entspannen', 'integrieren', 'dokumentieren', 'sichern', 'zahlen', 'vertiefen',
  'informieren', 'genießen', 'behalten', 'treffen', 'vergessen', 'verfolgen', 'prüfen',
  'erwerben', 'entdecken', 'sammeln', 'bekämpfen', 'leisten', 'planen', 'trainieren',
  'stärken', 'vereinbaren', 'kündigen', 'verreisen', 'hinterfragen', 'erhöhen',
  'bereichern', 'verzichten', 'wahren', 'pflegen', 'unterscheiden', 'schöpfen',
  'steigern', 'fühlen', 'vernetzen', 'realisieren', 'finanzieren', 'benutzen',
  'engagieren', 'organisieren', 'erhalten', 'beobachten', 'erledigen', 'reparieren',
  'installieren', 'stören', 'verlegen', 'desinfizieren', 'gönnen',
  'ernten', 'feiern', 'wandern', 'schwimmen', 'tanzen', 'singen',
  'malen', 'zeichnen', 'backen', 'putzen', 'waschen', 'bügeln',
]);

function isLikelyZuInfinitiveVerb(lc) {
  return ZU_INFINITIVE_VERB_DENY.has(lc);
}

/**
 * Predicative / degree adjectives after bare «zu» («zu teuer», «zu klein» = too X).
 * Lexicon FPs treat teuer/klein as nouns; v3.11 reprocess wrongly capped them.
 * Not the attributive Adj+Noun pattern («zu unterschiedlichen Zeiten»).
 */
export const ZU_DEGREE_ADJ_DENY = new Set([
  'teuer', 'klein', 'groß', 'gross', 'spät', 'früh', 'laut', 'leise',
  'schwer', 'leicht', 'hoch', 'niedrig', 'alt', 'neu', 'lang', 'kurz',
  'weit', 'nah', 'warm', 'kalt', 'müde', 'schnell', 'langsam', 'stark',
  'schwach', 'eng', 'breit', 'tief', 'flach', 'voll', 'leer', 'dicht',
  'selten', 'oft', 'viel', 'wenig',
]);

/** «zu kunden» → Kunden when lexicon noun and not a zu-infinitive verb. */
function shouldCapitalizeNounAfterZu(lc) {
  if (!lc || lc.length < 3) return false;
  if (ZU_DEGREE_ADJ_DENY.has(lc)) return false;
  if (ZU_PREP_NOUN_WHITELIST.has(lc)) return true;
  if (/(?:ung|ungen|heit|keit|schaft|tion|tät)$/i.test(lc)) return true;
  if (isLikelyZuInfinitiveVerb(lc)) return false;
  // Inflected adjectives («unterschiedlichen») are not nouns after zu
  if (looksLikeAttributiveAdjective(lc)) return false;
  // Bare infinitive morphology after zu → verb reading (zu teilen / zu buchen).
  // Nominalized infinitives (das Teilen) are rare after bare zu in B1 exam text;
  // noun plurals in -en must be whitelist/suffix-hit above (Kunden, Schulen…).
  if (/(?:en|eln|ern)$/i.test(lc)) return false;
  return isCertainNounLemma(lc);
}

const NOMINAL_SUFFIX_RE = /(?:ung|heit|keit|schaft|tion|tät|nis|tum|chen|lein)$/i;
const ZU_INFINITIVE_RE = /\bzu\s+([A-ZÄÖÜ][a-zäöüß]*(?:en|eln|ern))\b/g;

let _safeNouns = null;

function getSafeNouns() {
  if (_safeNouns) return _safeNouns;
  _safeNouns = new Set(getGermanNounLexicon());
  return _safeNouns;
}

function capFirst(word) {
  if (!word) return word;
  return word[0].toUpperCase() + word.slice(1);
}

function tokenize(text) {
  const chunks = [];
  const RE = /([A-Za-zÄÖÜäöüß]+(?:-[A-Za-zÄÖÜäöüß]+)*)|([^A-Za-zÄÖÜäöüß]+)/g;
  let m;
  while ((m = RE.exec(text)) !== null) {
    chunks.push({ token: m[1] ?? m[2], isWord: m[1] !== undefined });
  }
  return chunks;
}

function stripTokenPunct(w) {
  return String(w || '').replace(/^[^A-Za-zÄÖÜäöüß]+|[^A-Za-zÄÖÜäöüß]+$/g, '');
}

function tokenLemma(w) {
  return stripTokenPunct(w).toLowerCase();
}

/** Single letter A–F in «(A–F) passt» — not a nominal head (Goethe Lesen matching). */
function isExamOptionKeyToken(word) {
  const t = stripTokenPunct(word || '');
  return /^[A-F]$/i.test(t);
}

function isCapitalizedWord(token) {
  const fc = token[0];
  return (fc >= 'A' && fc <= 'Z') || fc === 'Ä' || fc === 'Ö' || fc === 'Ü';
}

function isMcqOptionBodyStart(prevContent) {
  return /(?:^|\s)[a-d]\)\s*$/i.test(prevContent);
}

function isMidSentenceCapital(prevContent) {
  if (!prevContent.length) return false;
  if (isMcqOptionBodyStart(prevContent)) return false;
  return !SENTENCE_END_RE.test(prevContent);
}

function isClauseStart(prevContent) {
  return !prevContent.length || SENTENCE_END_RE.test(prevContent);
}

function nextWordFrom(chunks, idx) {
  for (let j = idx + 1; j < chunks.length; j++) {
    if (chunks[j].isWord) return chunks[j].token;
  }
  return '';
}

/** Like nextWordFrom but stops at sentence-final punctuation (so «die kleinen. Auch» → ''). */
function nextWordSameSentenceFrom(chunks, idx) {
  for (let j = idx + 1; j < chunks.length; j++) {
    if (!chunks[j].isWord) {
      if (/[.!?…]/.test(chunks[j].token)) return '';
      continue;
    }
    return chunks[j].token;
  }
  return '';
}

function isInfinitiveShape(lc) {
  return lc.length >= 4 && /(?:en|eln|ern)$/i.test(lc);
}

function hasNominalSuffix(lc) {
  return NOMINAL_SUFFIX_RE.test(lc);
}

function isCertainNounLemma(lc) {
  return getSafeNouns().has(lc) || isKnownGermanNoun(lc) || hasNominalSuffix(lc);
}

function nextWordIsCapitalizedNoun(nextWord) {
  if (!nextWord || !isCapitalizedWord(nextWord)) return false;
  const lc = tokenLemma(nextWord);
  return isCertainNounLemma(lc) && !HOMOGRAPH_RISK.has(lc);
}

/**
 * True when surface looks like an inflected German adjective / participle
 * (not a title, not a bare noun lemma).
 */
export function looksLikeAttributiveAdjective(word) {
  const lc = tokenLemma(word);
  if (!lc || lc.length < 4) return false;
  if (ATTR_ADJ_TITLE_WORDS.has(lc)) return false;
  // Pronouns / polite forms — never adj
  if (['ihnen', 'ihre', 'ihren', 'ihrem', 'ihrer', 'ihres', 'ihn', 'ihm'].includes(lc)) return false;
  // Noun-forming suffixes. Exclude -chen/-lein here: they false-positive on
  // «städtischen» / «monatlichen» (-ischen/-lichen). -schaft still blocks Gemeinschaft.
  if (/(?:ung|heit|keit|schaft|tion|tät|nis|tum)$/i.test(lc)) return false;
  if (ADJ_NEEDS_ARTICLE_GUARD.has(lc)) return true;
  if (SUBSTANTIVISING_ARTICLES.has(lc)) return true; // solchen/dieses… over-capped before noun
  // Colour adjectives commonly over-capped before bin/place nouns (Blaue Papiertonne)
  if (/^(?:blau|grün|gelb|grau|rot|schwarz|weiß|weiss)(?:e|en|er|es|em)?$/i.test(lc)) return true;
  // Present participles (zahlenden) — NOT nouns like Wochenende / Jahrzehnte
  if (/(?:wochen|monats|jahres|tages)?ende$/i.test(lc)) return false;
  if (lc.length >= 7 && /(?:end)(?:e|en|er|es|em)$/i.test(lc)) return true;
  // -isch/-lich/-iv/-är/-ös: require inflection so «Tisch»/«Fisch» (bare -isch nouns)
  // are not matched; bare forms only when not a known noun («praktisch» alone is rare mid-NP).
  if (/(?:isch|lich|iv|är|ös)(?:e|en|er|es|em)$/i.test(lc)) return true;
  if (/(?:isch|lich|iv|är|ös)$/i.test(lc) && !isCertainNounLemma(lc)) return true;
  // -bar/-sam/-haft/-ig: same pattern («Nachbar» blocked; «wunderbarer» OK)
  // -los inflected («einen kostenlosen Kurs»); bare «Los» is a noun, so no bare form.
  if (/(?:bar|sam|haft|ig|los)(?:e|en|er|es|em)$/i.test(lc)) return true;
  if (/(?:bar|sam|haft|ig)$/i.test(lc) && !isCertainNounLemma(lc)) return true;
  return false;
}

/** Attributive adjective before deverbal noun (angeboten/diskussionen), not full POS. */
function isLikelyAttributiveBeforeDeverbalNoun(prevWord) {
  const prevLc = tokenLemma(prevWord);
  if (!prevLc) return false;
  if (looksLikeAttributiveAdjective(prevWord)) return true;
  if (ADJ_NEEDS_ARTICLE_GUARD.has(prevLc)) return true;
  if (!/(?:en|em|er|es|e)$/i.test(prevLc) || prevLc.length < 5) return false;
  if (/(?:ionen|ationen|heiten|keiten|ungen|chen|lein|tum)$/i.test(prevLc)) return false;
  if (isCertainNounLemma(prevLc)) return false;
  if (/(?:isch|lich|bar|sam|haft|ig|end)(?:en|em|er|es|e)$/i.test(prevLc)) return true;
  if (
    /^(?:gesund|frisch|neu|gut|groß|gross|klein|wichtig|lang|offen|frei|aktuell|digital|ausgewogen|vielfältig|nachhaltig|öffentlich|technisch|täglich|ähnlich|verschieden|moderat|lecker|frisch)(?:en|em|er|es|e)?$/i.test(
      prevLc,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Article/prep/poss + CapAdj + CapNoun → lowercase the adjective.
 * @returns {string|null} lowercased fix or null
 */
export function shouldDecapitalizeAttributiveAdjBeforeNoun(token, lastWord, nextWord) {
  if (!isCapitalizedWord(token)) return null;
  // Hyphenated titles / compounds («Vier-Tage-Woche») — leave alone
  if (token.includes('-')) return null;
  const nextTok = stripTokenPunct(nextWord || '');
  if (!nextTok || !isCapitalizedWord(nextTok)) return null;

  const lc = tokenLemma(token);
  const nextLc = tokenLemma(nextTok);
  // «über Freiwillige. Sie helfen» — next capital is pronoun, not noun head
  if (nextTok === 'Sie' || (nextLc === 'sie' && isCapitalizedWord(nextTok))) return null;
  if (ATTR_ADJ_BEFORE_NOUN_PROPER_BIGRAMS.has(`${lc}|${nextLc}`)) return null;

  const prevLc = tokenLemma(lastWord);
  // etwas/nichts/alles + Schönes — substantivized, keep capital (Phase 1)
  if (INDEF_PRONOUN_SUBST_TRIGGERS.has(prevLc)) return null;
  // Determiner / fused prep (im/am/zum…) OR bare prep (zu/für/mit…) before CapAdj+CapNoun
  if (!SUBSTANTIVISING_ARTICLES.has(prevLc) && !ATTR_ADJ_PREP_TRIGGERS.has(prevLc)) {
    return null;
  }
  if (!looksLikeAttributiveAdjective(token)) return null;
  if (isKnownGermanNoun(token) && !looksLikeAttributiveAdjective(token)) return null;

  return token.toLowerCase();
}

function wordAfterImAmFreien(chunks, freienIdx) {
  for (let j = freienIdx + 1; j < chunks.length; j++) {
    if (!chunks[j].isWord) continue;
    const lc = tokenLemma(chunks[j].token);
    if (lc === 'zu') continue;
    return chunks[j].token;
  }
  return '';
}

/** «im/am freien» as substantivized outdoor idiom (not adj + noun). */
export function isImAmFreienSubstantivized(prevWord, nextWord, chunks = null, freienIdx = -1) {
  const prevLc = tokenLemma(prevWord);
  if (prevLc !== 'im' && prevLc !== 'am') return false;
  let effectiveNext = nextWord;
  if (chunks && freienIdx >= 0) {
    const nw = stripTokenPunct(nextWord || '');
    if (!nw || tokenLemma(nw) === 'zu') {
      effectiveNext = wordAfterImAmFreien(chunks, freienIdx);
    }
  }
  if (!effectiveNext) return true;
  const nw = stripTokenPunct(effectiveNext);
  if (!nw) return true;
  const nextLc = tokenLemma(nw);
  if (isInfinitiveShape(nextLc) && !isCapitalizedWord(nw)) return true;
  if (isCapitalizedWord(nw) || isCertainNounLemma(nextLc)) return false;
  return true;
}

/** «die Verantwortlichen für …» — substantivized adj. after definite article (not attributive). */
function shouldCapitalizeSubstantivizedAdjAfterDefArticle(token, prevWord, nextWord) {
  const lc = tokenLemma(token);
  const prevLc = tokenLemma(prevWord);
  if (!['die', 'den', 'der', 'das'].includes(prevLc)) return false;
  if (!ADJ_NEEDS_ARTICLE_GUARD.has(lc)) return false;
  const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
  return SUBSTANTIVIZED_ADJ_PREP_TRIGGERS.has(nextLc);
}

/**
 * «Aktivitäten für die kleinen.» / «die Kleinen schützen» — substantivized adjective
 * after definite article when no noun head follows.
 * Why v3.7 missed this: shouldCapitalizeSubstantivizedAdjAfterDefArticle only fires when
 * the *next* token is a prep (für/mit/…); sentence-final or verb-followed cases stayed
 * blocked by ADJ_NEEDS_ARTICLE_GUARD. Inverse of attributive «einen kleinen See».
 */
function shouldCapitalizeSubstantivizedAdjNoNounHead(token, prevWord, nextWord) {
  const lc = tokenLemma(token);
  if (!ADJ_NEEDS_ARTICLE_GUARD.has(lc)) return false;
  if (isCapitalizedWord(token)) return false;
  const prevLc = tokenLemma(prevWord);
  if (!['die', 'den', 'der', 'das', 'dem'].includes(prevLc)) return false;
  if (shouldCapitalizeSubstantivizedAdjAfterDefArticle(token, prevWord, nextWord)) return true;

  const nextTok = stripTokenPunct(nextWord || '');
  if (!nextTok) {
    if (isPredicativeComparativeNotSubstantivized(prevLc, lc, nextWord)) {
      return false;
    }
    return true; // «die kleinen.» (caller must pass same-sentence next)
  }
  if (isPredicativeComparativeNotSubstantivized(prevLc, lc, nextWord)) {
    return false;
  }
  // In-sentence capital follower = noun head / proper name («das nächste Fest», «die kleine Emma»)
  if (isCapitalizedWord(nextTok)) return false;
  const nextLc = tokenLemma(nextTok);
  if (CARDINALS_NEEDS_ARTICLE_GUARD.has(nextLc)) return false;
  if (isCertainNounLemma(nextLc)) return false;
  // Adj stack: «der neue deutsche Film», «die kleinen roten Schuhe»
  if (ADJ_NEEDS_ARTICLE_GUARD.has(nextLc) || looksLikeAttributiveAdjective(nextTok)) return false;
  // Loose inflected follower (nationality/colour adj not in allowlists): «neue deutsche …»
  if (
    nextLc.length >= 5 &&
    /(?:e|en|er|es|em)$/i.test(nextLc) &&
    !isInfinitiveShape(nextLc) &&
    !isCertainNounLemma(nextLc)
  ) {
    return false;
  }
  return true; // verb / conjunction / sentence end: «die kleinen schützen» / «die kleinen.»
}

/**
 * «einen Jungen und ein Mädchen» — weak noun Junge, not attributive adj («einen jungen Mann»).
 * junge/jungen sit in ADJ_NEEDS_ARTICLE_GUARD (blocks cap); override when no noun head follows.
 */
function shouldCapitalizeJungeAsNoun(token, prevWord, nextWord) {
  const lc = tokenLemma(token);
  if (lc !== 'junge' && lc !== 'jungen') return false;
  if (isCapitalizedWord(token)) return false;
  const prevLc = tokenLemma(prevWord);
  if (!SUBSTANTIVISING_ARTICLES.has(prevLc)) return false;
  const nextTok = stripTokenPunct(nextWord || '');
  const nextLc = tokenLemma(nextTok);
  if (!nextLc) return true;
  if (nextWordIsCapitalizedNoun(nextWord)) return false;
  if (isCertainNounLemma(nextLc) && isCapitalizedWord(nextTok)) return false;
  // Attributive stack: «einen jungen sportlichen …» (rare); keep adj
  if (ADJ_NEEDS_ARTICLE_GUARD.has(nextLc) && nextLc !== 'junge' && nextLc !== 'jungen') return false;
  return true;
}

/**
 * «Bedarf an solchen Angeboten» — dative plural of Angebot (noun), not participle «angeboten werden».
 * angeboten* is in ADJ_NEEDS_ARTICLE_GUARD (decap participle); override after solchen/diesen/….
 */
const ANGEBOTEN_NOUN_PREV = new Set([
  'solchen', 'solche', 'solchem', 'solches', 'solcher',
  'diesen', 'diese', 'diesem', 'dieses',
  'jenen', 'jene', 'jenem', 'jenes',
  'regional', 'regionalen', 'regionaler', 'regionales', 'regionale',
  'neue', 'neuen', 'neuer', 'neues',
]);
const ANGEBOTEN_PARTICIPLE_NEXT = new Set([
  'werden', 'worden', 'wurde', 'wurden',
]);

function isDeverbalNounLemma(lc) {
  return DEVERBAL_NOUN_LEMMAS.has(lc);
}

function prevIsAttributiveOrDemonstrative(prevWord) {
  const prevLc = tokenLemma(prevWord);
  if (!prevLc) return false;
  if (ANGEBOTEN_NOUN_PREV.has(prevLc)) return true;
  if (isLikelyAttributiveBeforeDeverbalNoun(prevWord)) return true;
  if (ADJ_NEEDS_ARTICLE_GUARD.has(prevLc) && prevLc !== 'angeboten' && prevLc !== 'angebotene') return true;
  return false;
}

function shouldCapitalizeAngebotenAsNoun(token, prevWord, nextWord) {
  const lc = tokenLemma(token);
  if (!isDeverbalNounLemma(lc)) return false;
  if (isCapitalizedWord(token)) return false;
  if (!prevIsAttributiveOrDemonstrative(prevWord)) return false;
  const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
  if (ANGEBOTEN_PARTICIPLE_NEXT.has(nextLc)) return false;
  return true;
}

function shouldKeepAngebotenAsNounCapitalized(token, prevWord, nextWord) {
  const lc = tokenLemma(token);
  if (!isDeverbalNounLemma(lc) || !isCapitalizedWord(token)) return false;
  if (!prevIsAttributiveOrDemonstrative(prevWord)) return false;
  const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
  return !ANGEBOTEN_PARTICIPLE_NEXT.has(nextLc);
}

function shouldCapitalizeDeverbalNounAfterPrep(token, prevWord, nextWord) {
  const lc = tokenLemma(token);
  if (!isDeverbalNounLemma(lc) || isCapitalizedWord(token)) return false;
  const prevLc = tokenLemma(prevWord);
  if (!PREP_NOMINAL_OBJECT.has(prevLc)) return false;
  const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
  if (ANGEBOTEN_PARTICIPLE_NEXT.has(nextLc)) return false;
  if (prevLc === 'von' && (lc === 'arbeiten' || lc === 'medikamenten' || lc === 'medikament')) return true;
  if (prevLc === 'zu' && (lc === 'abbrüchen' || lc === 'abbruch' || lc === 'abbrüche')) return true;
  return true;
}

function shouldDecapitalizeLexiconOverrideVerb(token, lastWord) {
  const lc = tokenLemma(token);
  if (!isCapitalizedWord(token)) return null;
  const prevLc = tokenLemma(lastWord);
  if (lc === 'teil' && prevLc === 'nehmen') return 'teil';
  if (LEXICON_OVERRIDE_VERB_INFINITIVES.has(lc) || SEPARABLE_VERB_PARTICLES.has(lc)) {
    if (INFINITIVE_DECAP_PREV.has(prevLc)) return lc;
  }
  return null;
}

/**
 * Finite V2 verbs Gemini capitalizes after subject — narrower than HOMOGRAPH_RISK.
 * Triggers: pronoun / plural subject / adv (frisch, bitte, zusammen, was) / inverted V2.
 */
export const V2_FINITE_VERB_LEMMAS = new Set([
  'essen', 'kochen', 'wissen', 'besuchen', 'unternehmen', 'spielen', 'berichten',
  'arbeiten', 'glauben', 'glaube', 'glaubst', 'glaubt',
  'folgen', 'stellen', 'raten', 'gärtnern', 'waschen', 'zahlen',
  'brauchen', 'braucht', 'brauchst',
  // «Dem Stimme ich zu» (V2 inverted) — noun «Stimme» stays after article (die Stimme)
  'stimme', 'stimmen', 'stimmt', 'stimmst',
]);

const V2_SUBJECT_PRONOUNS = new Set(['wir', 'sie', 'er', 'es', 'ihr', 'du', 'ich']);

const V2_SUBJECT_PLURAL_NOUNS = new Set([
  'parks', 'familien', 'menschen', 'zeitungen', 'redaktionen', 'experten', 'leute',
  'kinder', 'gemüse', 'obst', 'jahre',
]);

const V2_ADV_VERB_TRIGGERS = new Set(['was']);
/** «zusammen/frisch/bitte» decap fixes verb_census FP but v6.1 POS adds lexicon_after_adj — Phase 4 addedFindings guard. */

/**
 * Coordinating «und» + capitalized finite verb («und Brauchen einen…»).
 * Must NOT treat enumeration nouns («Kaffee und Kuchen», «Firmen und Unternehmen»).
 * Require a verbal complement after the verb (article / prep / light adverb).
 */
const V2_UND_VERBAL_NEXT = new Set([
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'den', 'die', 'das', 'dem', 'der', 'des',
  'kein', 'keine', 'keinen', 'keinem',
  'pro', 'mehr', 'auch', 'noch', 'nur', 'schon', 'sehr',
  'hier', 'dort', 'dann', 'jetzt', 'sofort', 'gerne', 'gern',
  'sich', 'mich', 'dich', 'uns', 'euch',
  'ihn', 'ihm', 'ihr', 'es',
  ...V2_SUBJECT_PRONOUNS,
]);

const V2_INVERTED_PRONOUN_NEXT = new Set(['wir', 'ich', 'sie', 'er']);

/** Prev tokens that signal a nominal object, not a finite verb (conservative block). */
const V2_NOUN_OBJECT_PREV_BLOCK = new Set([
  'nur', 'auch', 'beispiel', 'euro', 'nutzung', 'mitgebrachte', 'täglichen', 'selbst', 'tagen', 'man',
]);

function shouldDecapitalizeV2SubjectFiniteVerb(token, lastWord, nextWord) {
  const lc = tokenLemma(token);
  if (!isCapitalizedWord(token)) return null;
  if (!V2_FINITE_VERB_LEMMAS.has(lc)) return null;
  const prevLc = tokenLemma(lastWord);
  if (prevLc === 'bitte') return null;
  if (V2_NOUN_OBJECT_PREV_BLOCK.has(prevLc)) return null;
  const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
  if (V2_INVERTED_PRONOUN_NEXT.has(nextLc)) return lc;
  if (V2_SUBJECT_PRONOUNS.has(prevLc)) return lc;
  if (V2_ADV_VERB_TRIGGERS.has(prevLc)) return lc;
  if (V2_SUBJECT_PLURAL_NOUNS.has(prevLc)) return lc;
  // «und Brauchen einen Gästeausweis» / «und Zahlen pro Mahlzeit»
  // Guard: next must look like a verb complement — not «und Unternehmen.» / «und Kuchen»
  if (prevLc === 'und' || prevLc === 'oder') {
    if (!nextLc) return null;
    if (isCapitalizedWord(stripTokenPunct(nextWord || '')) && isCertainNounLemma(nextLc)) {
      return null;
    }
    // Only light verbal complements — NOT bare preps («Unternehmen in der Stadt»)
    if (V2_UND_VERBAL_NEXT.has(nextLc)) return lc;
    return null;
  }
  return null;
}

function isHomographNounAfterAttributiveAdj(prevWord, nextWord, token) {
  const prevLc = tokenLemma(prevWord);
  if (!ADJ_NEEDS_ARTICLE_GUARD.has(prevLc) || prevLc === 'freien') return false;
  const lc = tokenLemma(token);
  if (!HOMOGRAPH_NOMINAL_AFTER_ADJ.has(lc)) return false;
  if (!(isKnownGermanNoun(token) || getSafeNouns().has(lc))) return false;
  const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
  if (!nextLc) return false;
  // «… zukünftige Reisen möchte» — nominal object, not verb infinitive
  if (MODAL_VERBS.has(nextLc)) return true;
  if (isCapitalizedWord(nextWord) && isCertainNounLemma(nextLc) && !HOMOGRAPH_RISK.has(nextLc)) return true;
  return false;
}

/** «für kleine unternehmen» — noun after attributive adj (lexicon + force allowlist). */
function shouldCapitalizeNounAfterAttributiveAdj(token, prevWord) {
  const lc = tokenLemma(token);
  if (!lc || isCapitalizedWord(token)) return false;
  if (!NOUN_FORCE_AFTER_ATTR_ADJ.has(lc)) return false;
  const prevLc = tokenLemma(prevWord);
  if (ADJ_NEEDS_ARTICLE_GUARD.has(prevLc) || looksLikeAttributiveAdjective(prevWord)) return true;
  return isLikelyAttributiveBeforeDeverbalNoun(prevWord);
}

/**
 * @returns {string|null} canonical capitalized form, or null if not applicable
 */
export function canonicalIndefPronounSubstantivizedAdj(token, prevWord) {
  if (!token || isCapitalizedWord(token)) return null;
  if (!INDEF_PRONOUN_SUBST_TRIGGERS.has(tokenLemma(prevWord))) return null;
  return INDEF_PRONOUN_SUBST_ADJ_ALLOWLIST.get(tokenLemma(token)) || null;
}

/** Finite / participle / infinitive followers after substantivized adj («…Schönes unternommen»). */
const WAS_SUBST_VERB_FOLLOWERS = new Set([
  ...MODAL_VERBS,
  'hat', 'haben', 'hatte', 'hatten', 'hast',
  'ist', 'sind', 'war', 'waren', 'bin', 'bist',
  'wird', 'werden', 'wurde', 'wurden',
  'gibt', 'gab', 'machen', 'macht', 'gemacht',
  'tun', 'tut', 'getan', 'finden', 'findet', 'gefunden',
  'sehen', 'sieht', 'gesehen', 'hören', 'hört', 'gehört',
  'erzählen', 'erzählt', 'erleben', 'erlebt',
  'unternehmen', 'unternimmt', 'unternommen',
  'passieren', 'passiert', 'geschehen', 'geschieht',
]);

/**
 * Adj form eligible for was/etwas-style substantivization (neuter -es / allowlist).
 * @param {string} lc
 */
export function isSubstantivizedAdjLemma(lc) {
  if (!lc) return false;
  if (INDEF_PRONOUN_SUBST_ADJ_ALLOWLIST.has(lc)) return true;
  // Strong neuter substantivized adj in the attributive-adj guard («Schönes», «Neues»)
  return ADJ_NEEDS_ARTICLE_GUARD.has(lc) && /(?:es)$/i.test(lc);
}

/**
 * Next token looks like the verbal head of «was … Adj Verb» (not a noun head).
 * @param {string} nextWord
 */
export function looksLikeWasSubstVerbFollower(nextWord) {
  const nextTok = stripTokenPunct(nextWord || '');
  if (!nextTok) return false;
  if (isCapitalizedWord(nextTok) && isCertainNounLemma(tokenLemma(nextTok))) return false;
  const nextLc = tokenLemma(nextTok);
  if (WAS_SUBST_VERB_FOLLOWERS.has(nextLc)) return true;
  if (isInfinitiveShape(nextLc) && nextLc.length >= 5) return true;
  return false;
}

/**
 * Look back for interrogative/relative «was» in the same clause (before idx).
 * Caps lookback so «Was? … ein schönes Wochenende» in a later sentence is not linked.
 * @param {Array<{token:string,isWord:boolean}>} chunks
 * @param {number} idx
 */
export function findWasTriggerBefore(chunks, idx) {
  if (!chunks || idx <= 0) return false;
  let wordsSeen = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const { token, isWord } = chunks[i];
    if (!isWord) {
      if (/[.!?;:]/.test(token)) break;
      continue;
    }
    wordsSeen += 1;
    if (wordsSeen > 14) break;
    if (tokenLemma(token) === 'was') return true;
  }
  return false;
}

/**
 * Free-relative / interrogative: «was […intervening…] Schönes unternommen».
 * Requires (1) «was» earlier in the clause, (2) adj is substantivized form,
 * (3) next token is verbal — not «was für ein Schönes Auto» (noun head).
 *
 * @returns {boolean}
 */
export function isWasClauseSubstantivizedAdj(token, nextWord, chunks, idx) {
  const lc = tokenLemma(token);
  if (!isSubstantivizedAdjLemma(lc)) return false;
  if (!looksLikeWasSubstVerbFollower(nextWord)) return false;
  return findWasTriggerBefore(chunks, idx);
}

/**
 * Capitalize lowercase adj in was-clause substantivization.
 * @returns {string|null} canonical capital form
 */
export function canonicalWasClauseSubstantivizedAdj(token, nextWord, chunks, idx) {
  if (!token || isCapitalizedWord(token)) return null;
  if (!isWasClauseSubstantivizedAdj(token, nextWord, chunks, idx)) return null;
  const lc = tokenLemma(token);
  return INDEF_PRONOUN_SUBST_ADJ_ALLOWLIST.get(lc) || capFirst(token);
}

function shouldCapitalizeLowerNoun(token, prevWord, nextWord, atClauseStart) {
  const lc = tokenLemma(token);
  if (!lc || isCapitalizedWord(token)) return false;
  if (PURE_ADVERBS.has(lc)) return false;
  if (LEXICON_OVERRIDE_VERB_INFINITIVES.has(lc) || SEPARABLE_VERB_PARTICLES.has(lc)) return false;
  if (canonicalIndefPronounSubstantivizedAdj(token, prevWord)) return true;
  if (shouldCapitalizeSubstantivizedAdjAfterDefArticle(token, prevWord, nextWord)) return true;
  if (shouldCapitalizeSubstantivizedAdjNoNounHead(token, prevWord, nextWord)) return true;
  if (shouldCapitalizeJungeAsNoun(token, prevWord, nextWord)) return true;
  if (shouldCapitalizeAngebotenAsNoun(token, prevWord, nextWord)) return true;
  if (shouldCapitalizeDeverbalNounAfterPrep(token, prevWord, nextWord)) return true;
  if (shouldCapitalizeNounAfterAttributiveAdj(token, prevWord)) return true;
  if (ADJ_NEEDS_ARTICLE_GUARD.has(lc)) return false;
  // «Dem stimme ich zu» — V2 finite verb, not noun after article/dative
  if (V2_FINITE_VERB_LEMMAS.has(lc)) {
    const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
    const prevLc0 = tokenLemma(prevWord);
    if (V2_INVERTED_PRONOUN_NEXT.has(nextLc)) return false;
    if (V2_SUBJECT_PRONOUNS.has(prevLc0)) return false;
  }
  const prevLc = tokenLemma(prevWord);
  // Quantifier «ein paar» — decap leaves lowercase; block re-cap (not genuine pair / couple).
  if (prevLc === 'ein' && lc === 'paar') {
    const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
    if (EIN_PAAR_PAIR_OBJECTS.has(nextLc) || EIN_PAAR_COUPLE_NEXT.has(nextLc)) return true;
    return false;
  }
  // Prep «zu» + noun/infinitive — before HOMOGRAPH early-exit (kunden/medien are
  // homographs but whitelist nouns after zu must still capitalize).
  if (prevLc === 'zu' && isInfinitiveShape(lc)) {
    return shouldCapitalizeNounAfterZu(lc);
  }
  if (HOMOGRAPH_RISK.has(lc)) {
    if (isHomographNounAfterAttributiveAdj(prevWord, nextWord, token)) return true;
    if (!hasNominalSuffix(lc)) return false;
  }
  if (MODAL_VERBS.has(tokenLemma(prevWord)) && isInfinitiveShape(lc)) return false;

  // Phase 1: mirror decap ADJ_NEEDS_ARTICLE_GUARD — do not re-capitalize adj after article
  if (SUBSTANTIVISING_ARTICLES.has(prevLc) && ADJ_NEEDS_ARTICLE_GUARD.has(lc)) {
    if (shouldCapitalizeSubstantivizedAdjAfterDefArticle(token, prevWord, nextWord)) return true;
    if (shouldCapitalizeSubstantivizedAdjNoNounHead(token, prevWord, nextWord)) return true;
    return false;
  }

  if (!isCertainNounLemma(lc)) return false;

  if (SUBSTANTIVISING_ARTICLES.has(prevLc)) {
    const nextTok = stripTokenPunct(nextWord || '');
    if (isExamOptionKeyToken(nextTok) && (isKnownGermanNoun(token) || getSafeNouns().has(lc))) {
      return true;
    }
    if (nextWordIsCapitalizedNoun(nextWord)) return false;
    // Prevent re-cap of attributive adj after decap («unserem jährlichen Familienfest»)
    // when the noun head is capitalized but not in the safe-noun lexicon.
    if (nextTok && isCapitalizedWord(nextTok) && looksLikeAttributiveAdjective(token)) {
      return false;
    }
    return true;
  }
  // Prep «zu» + noun (whitelist / -ung / lexicon noun) — never bare zu-infinitives
  // and never attributive adjectives before a noun head («zu unterschiedlichen Zeiten»)
  if (prevLc === 'zu') {
    if (
      looksLikeAttributiveAdjective(token)
      && nextWordIsCapitalizedNoun(nextWord)
    ) {
      return false;
    }
    if (shouldCapitalizeNounAfterZu(lc)) return true;
    return false;
  }
  if (atClauseStart) return true;
  return false;
}

function capitalizeHyphenatedNoun(token, prevWord, nextWord, atClauseStart) {
  if (!token.includes('-')) return null;
  const parts = token.split('-');
  let changed = false;
  const capped = parts.map((part, i) => {
    if (!part || isCapitalizedWord(part)) return part;
    const pseudoPrev = i === 0 ? prevWord : parts[i - 1];
    const pseudoNext = i === parts.length - 1 ? nextWord : parts[i + 1];
    if (shouldCapitalizeLowerNoun(part, pseudoPrev, pseudoNext, atClauseStart)) {
      changed = true;
      return capFirst(part);
    }
    return part;
  });
  return changed ? capped.join('-') : null;
}

export function capitalizeNounsInText(text) {
  if (typeof text !== 'string' || !text) return { result: text, count: 0 };
  const chunks = tokenize(text);
  let count = 0;
  let prevContent = '';
  let lastWord = '';
  const parts = chunks.map(({ token, isWord }, idx) => {
    if (!isWord) {
      prevContent += token;
      return token;
    }
    const nextWord = nextWordSameSentenceFrom(chunks, idx);
    const atStart = isClauseStart(prevContent);
    if (isCapitalizedWord(token)) {
      prevContent += token;
      lastWord = token;
      return token;
    }
    const hyphenFixed = capitalizeHyphenatedNoun(token, lastWord, nextWord, atStart);
    if (hyphenFixed) {
      count++;
      prevContent += hyphenFixed;
      lastWord = hyphenFixed;
      return hyphenFixed;
    }
    const indefSubst = canonicalIndefPronounSubstantivizedAdj(token, lastWord);
    if (indefSubst) {
      count++;
      prevContent += indefSubst;
      lastWord = indefSubst;
      return indefSubst;
    }
    const wasSubst = canonicalWasClauseSubstantivizedAdj(token, nextWord, chunks, idx);
    if (wasSubst) {
      count++;
      prevContent += wasSubst;
      lastWord = wasSubst;
      return wasSubst;
    }
    if (
      tokenLemma(token) === 'freien'
      && isImAmFreienSubstantivized(lastWord, nextWord, chunks, idx)
    ) {
      const capped = capFirst(token);
      count++;
      prevContent += capped;
      lastWord = capped;
      return capped;
    }
    if (shouldCapitalizeLowerNoun(token, lastWord, nextWord, atStart)) {
      const capped = capFirst(token);
      count++;
      prevContent += capped;
      lastWord = capped;
      return capped;
    }
    prevContent += token;
    lastWord = token;
    return token;
  });
  return { result: parts.join(''), count };
}

/**
 * Decapitalize «ein Paar» → «ein paar» when Paar is a quantifier (ein paar Monate/Wochen/…).
 *
 * ACCEPTED RISK (AUD-3, 2026-07-09): mid-sentence couple-as-noun («Ich kenne ein Paar, das…»)
 * would be wrongly decapped because we only skip when lastWord is capital «Ein» (sentence start).
 * Corpus check (208-file holdout + generated): 0× «ein Paar,»; erroneous quantifier «ein Paar Monate»
 * is the only pattern seen in production. B1 Lesen T1–T5 rarely generates couple + relative clause;
 * Gemini almost always writes «ein paar» lowercase for the quantifier anyway. Revisit if T4 dialogue
 * prompts start producing «ein Paar, das/die» mid-sentence with capital P.
 */
function shouldDecapitalizeEinPaarQuantifier(token, lastWord, nextWord) {
  if (!isCapitalizedWord(token) || tokenLemma(token) !== 'paar') return null;
  if (tokenLemma(lastWord) !== 'ein') return null;
  const nextLc = tokenLemma(nextWord);
  if (!nextLc) return null;
  if (EIN_PAAR_PAIR_OBJECTS.has(nextLc)) return null;
  if (EIN_PAAR_COUPLE_NEXT.has(nextLc)) return null;
  return 'paar';
}

function shouldDecapitalizeMidSentenceToken(token, lastWord) {
  if (token === 'Sie') return null;
  const lc = tokenLemma(token);
  if (CURRENCY_UNITS.has(lc)) return null;
  if (NOMINALIZED_INFINITIVE_GUARD.has(lc)) return null;
  if (!isCapitalizedWord(token) || !HOMOGRAPH_RISK.has(lc)) return null;
  if (isKnownGermanNoun(token) || getSafeNouns().has(lc)) return null;
  const prevLc = tokenLemma(lastWord);
  if (!DECAP_TRIGGER_PREV.has(prevLc)) return null;
  if (SUBSTANTIVISING_ARTICLES.has(prevLc)) return null;
  return lc;
}

export function isZuInfinitiveOvercapitalized(word) {
  const lc = String(word || '').toLowerCase();
  if (!/(?:en|eln|ern)$/i.test(lc)) return false;
  if (ZU_PREP_NOUN_WHITELIST.has(lc)) return false;
  if (lc.endsWith('men')) return false;
  // Protect short noun-ish -ten plurals (Kosten, Daten) but not long verb stems
  // («unterrichten», «berichten», «einrichten»).
  if (lc.endsWith('ten') && lc.length <= 6) return false;
  return true;
}

export function fixZuInfinitiveCapitals(text) {
  if (typeof text !== 'string' || !text) return { result: text, count: 0 };
  let count = 0;
  const result = text.replace(ZU_INFINITIVE_RE, (full, word, offset, whole) => {
    if (!isZuInfinitiveOvercapitalized(word)) return full;
    // «zu Unterschiedlichen Zeiten» — CapAdj+CapNoun, not zu-infinitive
    const after = String(whole || '')
      .slice(offset + full.length)
      .match(/^\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]*)/);
    if (after && looksLikeAttributiveAdjective(word) && isCapitalizedWord(after[1])) {
      return full;
    }
    count++;
    return `zu ${word.toLowerCase()}`;
  });
  return { result, count };
}

/** «zu Teuer» / «zu Klein» → lowercase degree adjectives after bare zu. */
export function fixZuDegreeAdjCapitals(text) {
  if (typeof text !== 'string' || !text) return { result: text, count: 0 };
  let count = 0;
  const result = text.replace(/\bzu\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]*)\b/g, (full, word) => {
    const lc = tokenLemma(word);
    if (!ZU_DEGREE_ADJ_DENY.has(lc)) return full;
    count++;
    return `zu ${lc}`;
  });
  return { result, count };
}

export function fixModalInfinitiveCapitals(text) {
  if (typeof text !== 'string' || !text) return { result: text, count: 0 };
  let count = 0;
  const modalAlt = [...MODAL_VERBS].join('|');
  const inf = '([A-ZÄÖÜ][a-zäöüß]*(?:en|eln|ern))';
  const reInfModal = new RegExp(`\\b${inf}\\s+(?:${modalAlt})\\b`, 'g');
  const reModalInf = new RegExp(`\\b(?:${modalAlt})\\s+${inf}\\b`, 'g');
  let result = text.replace(reInfModal, (full, word) => {
    const lc = tokenLemma(word);
    if (!HOMOGRAPH_RISK.has(lc)) return full;
    if (isKnownGermanNoun(word) || getSafeNouns().has(lc)) return full;
    count++;
    return full.replace(word, word.toLowerCase());
  });
  result = result.replace(reModalInf, (full, word) => {
    const lc = tokenLemma(word);
    if (!HOMOGRAPH_RISK.has(lc)) return full;
    if (isKnownGermanNoun(word) || getSafeNouns().has(lc)) return full;
    count++;
    return full.replace(word, word.toLowerCase());
  });
  return { result, count };
}

export function decapitalizeMidSentence(text) {
  if (typeof text !== 'string' || !text) return { result: text, count: 0 };
  const chunks = tokenize(text);
  let count = 0;
  let prevContent = '';
  let lastWord = '';
  const parts = chunks.map(({ token, isWord }, idx) => {
    if (!isWord) {
      prevContent += token;
      return token;
    }
    if (isCapitalizedWord(token) && isMidSentenceCapital(prevContent)) {
      const nextWord = nextWordFrom(chunks, idx);
      let fix = null;
      // v3.7: article/prep + CapAdj + CapNoun (broader than ADJ_NEEDS_ARTICLE_GUARD allowlist)
      if ((fix = shouldDecapitalizeAttributiveAdjBeforeNoun(token, lastWord, nextWord))) {
        if (tokenLemma(token) === 'freien' && isImAmFreienSubstantivized(lastWord, nextWord, chunks, idx)) {
          fix = null;
        }
      } else if (SUBSTANTIVISING_ARTICLES.has(tokenLemma(lastWord)) && ADJ_NEEDS_ARTICLE_GUARD.has(tokenLemma(token))) {
        if (tokenLemma(token) === 'freien' && isImAmFreienSubstantivized(lastWord, nextWord, chunks, idx)) {
          fix = null;
        } else {
          const nextTok = stripTokenPunct(nextWord || '');
          const nextLc = tokenLemma(nextTok);
          const nextIsAttrHead =
            !isExamOptionKeyToken(nextTok) &&
            (isCapitalizedWord(nextTok) ||
            CARDINALS_NEEDS_ARTICLE_GUARD.has(nextLc) ||
            looksLikeAttributiveAdjective(nextTok) ||
            (nextLc.length >= 5 &&
              /(?:e|en|er|es|em)$/i.test(nextLc) &&
              !isInfinitiveShape(nextLc) &&
              !isCertainNounLemma(nextLc)));
          // Attributive adj when a noun/cardinal/adj-stack follows («das zentrale Thema»,
          // «den letzten fünf Jahren», «der Neue deutsche Film»).
          // Otherwise keep capital: noun («der Zentrale»), substantivized («die Kleinen», «das Richtige»).
          if (nextIsAttrHead) {
            fix = token.toLowerCase();
          } else if (PREDICATE_COMPARATIVE_NEXT.has(tokenLemma(stripTokenPunct(nextWord || '')))) {
            // «die Weniger als …», «der Mehr als …» — comparative, not substantivized NP
            fix = token.toLowerCase();
          } else if (isPredicativeComparativeNotSubstantivized(tokenLemma(lastWord), tokenLemma(token), nextWord)) {
            fix = token.toLowerCase();
          } else {
            fix = null;
          }
        }
      } else if ((fix = shouldDecapitalizeEinPaarQuantifier(token, lastWord, nextWord))) {
        // quantifier «ein paar», not «ein Paar» of shoes
      } else if ((fix = shouldDecapitalizeLexiconOverrideVerb(token, lastWord))) {
        // lexicon_override_tag infinitives / separable particles
      } else if ((fix = shouldDecapitalizeV2SubjectFiniteVerb(token, lastWord, nextWord))) {
        // V2 finite verb after subject (verb_census PROSE REAL)
      } else if (isModalInfinitiveOvercapitalized(token, lastWord, nextWord)) {
        fix = token.toLowerCase();
      } else if (
        isWasClauseSubstantivizedAdj(token, nextWord, chunks, idx)
      ) {
        // «was … Schönes unternommen» — keep capital (v3.15)
        fix = null;
      } else if (isHeuristicAdjAdvOvercapitalized(token, lastWord, nextWord)) {
        fix = token.toLowerCase();
      } else {
        fix = shouldDecapitalizeMidSentenceToken(token, lastWord);
      }
      if (fix && HONORIFIC_SURNAME_PREV.has(tokenLemma(lastWord))) {
        // Surname after Herr/Frau/Herrn — «Lang», «Kurz» stay capitalized even if homograph-adj.
        fix = null;
      }
      if (fix) {
        count++;
        prevContent += fix;
        lastWord = fix;
        return fix;
      }
    }
    prevContent += token;
    lastWord = token;
    return token;
  });
  let result = parts.join('');
  const zu = fixZuInfinitiveCapitals(result);
  const zuDeg = fixZuDegreeAdjCapitals(zu.result);
  const modal = fixModalInfinitiveCapitals(zuDeg.result);
  return { result: modal.result, count: count + zu.count + zuDeg.count + modal.count };
}

export function isMcqOptionLine(text) {
  return MCQ_OPTION_PREFIX_RE.test(String(text || ''));
}

export function splitMcqOptionLine(text) {
  const m = String(text || '').match(MCQ_OPTION_PREFIX_RE);
  if (!m) return null;
  return { prefix: m[1], body: m[2] };
}

function pushBlockViolation(out, type, word, fix) {
  out.push({ type, word, fix, severity: 'block' });
}

function pushAdvisoryViolation(out, word) {
  out.push({ type: 'unknown_capital', word, fix: null, severity: 'advisory' });
}

export function isModalInfinitiveOvercapitalized(word, prevWord = '', nextWord = '') {
  const lc = tokenLemma(word);
  if (!HOMOGRAPH_RISK.has(lc) || !isInfinitiveShape(lc)) return false;
  const prevLc = tokenLemma(prevWord);
  const nextLc = tokenLemma(nextWord);
  if (prevLc === 'zu' || SUBSTANTIVISING_ARTICLES.has(prevLc)) return false;
  if (V2_NOUN_OBJECT_PREV_BLOCK.has(prevLc)) return false;
  if (isKnownGermanNoun(word) && MODAL_NOUN_OBJECT_PREPS.has(nextLc)) return false;
  return MODAL_VERBS.has(nextLc) || MODAL_VERBS.has(prevLc);
}

export function isHeuristicAdjAdvOvercapitalized(word, prevWord = '', nextWord = '') {
  const lc = tokenLemma(word);
  const isCardinal = CARDINALS_NEEDS_ARTICLE_GUARD.has(lc);
  if (!PURE_ADVERBS.has(lc) && !ADJ_NEEDS_ARTICLE_GUARD.has(lc) && !isCardinal) return false;
  const prevLc = tokenLemma(prevWord);
  const nextLc = tokenLemma(stripTokenPunct(nextWord || ''));
  // «über Ihr Leben» — possessive + Leben = noun (Goethe A2 Sprechen T2)
  if (lc === 'leben' && /^(ihr|ihre|mein|meine|dein|deine|sein|seine)$/i.test(prevLc)) {
    return false;
  }
  // etwas/nichts/alles + Gutes/Neues/Schönes… — substantivized (Phase 1), never heuristic-decap
  if (INDEF_PRONOUN_SUBST_TRIGGERS.has(prevLc) && isSubstantivizedAdjLemma(lc)) {
    return false;
  }
  // Immediate «was Schönes unternommen» (no intervening NP) — verb follower required
  if (
    prevLc === 'was'
    && isSubstantivizedAdjLemma(lc)
    && looksLikeWasSubstVerbFollower(nextWord)
  ) {
    return false;
  }
  // «solchen Angeboten» — noun, not participle (ADJ guard would otherwise force decap)
  if (shouldKeepAngebotenAsNounCapitalized(word, prevWord, nextWord)) return false;
  if (
    PREDICATIVE_ADJ_AFTER_COPULA.has(lc) &&
    ['ist', 'sind', 'war', 'waren', 'wird', 'werden', 'bleibt', 'bleiben', 'blieb', 'blieben'].includes(prevLc)
  ) {
    return true;
  }
  // «des heutigen Abends» — capitalized time noun after attributive adj, not adverb
  if (
    (lc === 'abends' || lc === 'morgens') &&
    prevLc &&
    /(?:en|em|er|es|e)$/.test(prevLc) &&
    prevLc.length >= 5
  ) {
    return false;
  }
  if (SUBSTANTIVISING_ARTICLES.has(prevLc)) {
    // «die Weniger als zwei Stunden bleiben» — comparative in relative clause, not «die Wenigen»
    if (prevLc === 'die' && PURE_ADVERBS.has(lc) && (nextLc === 'als' || nextLc === 'wie')) return true;
    // «die Vielen …» — attributive quantifier after article
    if (
      prevLc === 'die' &&
      (lc === 'vielen' || lc === 'wenigen' || lc === 'viele' || lc === 'wenige') &&
      nextLc &&
      /^[a-zäöüß]/.test(stripTokenPunct(nextWord || ''))
    ) {
      return true;
    }
    // «die drei Monate» — attributive cardinal after article/possessive
    if (isCardinal) {
      const nextTok = stripTokenPunct(nextWord || '');
      return isCapitalizedWord(nextTok);
    }
    // «das ganz anders» — intensifier adverb after demonstrative, not a noun phrase
    if (PURE_ADVERBS.has(lc) && prevLc === 'das') return true;
    if (isPredicativeComparativeNotSubstantivized(prevLc, lc, nextWord)) return true;
    return false;
  }
  // Mid-sentence cardinal after ordinal/adj/adverb («die ersten drei», «voraussichtlich vier»)
  // or adj/adv not after article — same as prior adj/adv heuristic.
  return true;
}

/**
 * Homograph as the object noun of a later verb in the same clause: «wo man
 * Fragen stellen kann», «Sie können Fragen an den Arzt stellen». Only the
 * typical collocation verb counts, so «Sie können Fragen.» is still flagged.
 * Rejected de/A2 Lesen T1/T2 parts on 23 sep 2026.
 */
const HOMOGRAPH_NOUN_COLLOCATIONS = Object.freeze({
  fragen: /^(?:stellen|gestellt|stellt|beantworten|beantwortet|haben|hat|klären|geklärt)$/,
  kosten: /^(?:übernehmen|übernimmt|übernommen|sparen|tragen|senken|decken)$/,
  sorgen: /^(?:machen|gemacht)$/,
  reisen: /^(?:buchen|gebucht|planen|geplant|organisieren)$/,
  treffen: /^(?:organisieren|organisiert|planen|geplant|vereinbaren|vereinbart)$/,
});

function isHomographNounObject(token, chunks, idx) {
  const verbRe = HOMOGRAPH_NOUN_COLLOCATIONS[tokenLemma(token)];
  if (!verbRe) return false;
  for (let j = idx + 1; j < chunks.length; j++) {
    const { token: t, isWord } = chunks[j];
    if (!isWord) {
      if (/[.,;:!?]/.test(t)) return false; // clause ends before the verb
      continue;
    }
    if (verbRe.test(t.toLowerCase())) return true;
  }
  return false;
}

export function scanP2CapitalizationViolations(text) {
  if (typeof text !== 'string' || !text) return [];
  const violations = [];
  const chunks = tokenize(text);
  let prevContent = '';
  let lastWord = '';
  for (let idx = 0; idx < chunks.length; idx++) {
    const { token, isWord } = chunks[idx];
    if (!isWord) {
      prevContent += token;
      continue;
    }
    if (isCapitalizedWord(token) && isMidSentenceCapital(prevContent)) {
      const nextWord = nextWordFrom(chunks, idx);
      if (
        isModalInfinitiveOvercapitalized(token, lastWord, nextWord) &&
        !isHomographNounObject(token, chunks, idx)
      ) {
        pushBlockViolation(violations, 'modal_infinitive', token, token.toLowerCase());
      } else if (isWasClauseSubstantivizedAdj(token, nextWord, chunks, idx)) {
        // keep — not a violation
      } else if (isHeuristicAdjAdvOvercapitalized(token, lastWord, nextWord)) {
        pushBlockViolation(violations, 'adj_adv', token, token.toLowerCase());
      } else if (
        tokenLemma(token) === 'leben' &&
        /^(ihr|ihre|mein|meine|dein|deine|sein|seine)$/i.test(tokenLemma(lastWord))
      ) {
        // «über Ihr Leben» — noun, not homograph verb (A2 Sprechen T2)
      } else if (
        HOMOGRAPH_RISK.has(tokenLemma(token)) &&
        DECAP_TRIGGER_PREV.has(tokenLemma(lastWord)) &&
        !isHomographNounObject(token, chunks, idx)
      ) {
        pushBlockViolation(violations, 'homograph', token, token.toLowerCase());
      } else if (!isKnownGermanNoun(token) && !SUBSTANTIVISING_ARTICLES.has(tokenLemma(lastWord))) {
        pushAdvisoryViolation(violations, token);
      }
    }
    prevContent += token;
    lastWord = token;
  }
  ZU_INFINITIVE_RE.lastIndex = 0;
  let zm;
  while ((zm = ZU_INFINITIVE_RE.exec(text)) !== null) {
    const word = zm[1];
    if (isZuInfinitiveOvercapitalized(word)) {
      pushBlockViolation(violations, 'zu_infinitive', word, word.toLowerCase());
    }
  }
  return violations;
}

export function scanP2BlockingViolations(text) {
  return scanP2CapitalizationViolations(text).filter((v) => v.severity === 'block');
}

export function scanP2AdvisoryViolations(text) {
  return scanP2CapitalizationViolations(text).filter((v) => v.severity === 'advisory');
}

export function scanMcqOptionCapitalizationViolations(text) {
  return scanP2BlockingViolations(text);
}

function fixPassageTextFields(p, fixText) {
  const out = { ...p };
  if (out.text != null) out.text = fixText(out.text);
  if (out.title != null) out.title = fixText(out.title);
  if (out.transcript != null) out.transcript = fixText(out.transcript);
  if (Array.isArray(out.ads)) out.ads = out.ads.map((a) => fixText(a));
  if (Array.isArray(out.audio)) {
    out.audio = out.audio.map((turn) =>
      turn && typeof turn === 'object' && turn.text != null ? { ...turn, text: fixText(turn.text) } : turn,
    );
  }
  return out;
}

function fixQuestionTextFields(q, fixText) {
  const out = { ...q };
  if (out.question != null) out.question = fixText(out.question);
  if (out.signText != null) out.signText = fixText(out.signText);
  if (out.explanation != null) out.explanation = fixText(out.explanation);
  if (out.statement != null) out.statement = fixText(out.statement);
  if (Array.isArray(out.matchLabels)) out.matchLabels = out.matchLabels.map((l) => fixText(l));
  if (Array.isArray(out.options)) {
    out.options = out.options.map((o) => {
      if (typeof o === 'string') return fixText(o);
      if (o && typeof o === 'object' && o.text != null) return { ...o, text: fixText(o.text) };
      return o;
    });
  }
  return out;
}

export function decapitalizeBatchMidSentence(batch) {
  if (!batch || typeof batch !== 'object') return { batch, totalFixed: 0 };
  let totalFixed = 0;
  const fixText = (s) => {
    if (typeof s !== 'string') return s;
    const { result, count } = decapitalizeMidSentence(s);
    totalFixed += count;
    return result;
  };
  const passages = (batch.passages || []).map((p) => fixPassageTextFields(p, fixText));
  const questions = (batch.questions || []).map((q) => fixQuestionTextFields(q, fixText));
  return { batch: { ...batch, passages, questions }, totalFixed };
}

export function capitalizeBatchNouns(batch) {
  if (!batch || typeof batch !== 'object') return { batch, totalFixed: 0 };
  let totalFixed = 0;
  const fixText = (s) => {
    if (typeof s !== 'string') return s;
    const { result, count } = capitalizeNounsInText(s);
    totalFixed += count;
    return result;
  };
  const passages = (batch.passages || []).map((p) => fixPassageTextFields(p, fixText));
  const questions = (batch.questions || []).map((q) => fixQuestionTextFields(q, fixText));
  return { batch: { ...batch, passages, questions }, totalFixed };
}

/** Full normalize pass used in diagnostics: decap then cap. */
export function normalizeGermanCapsInText(text) {
  const d = decapitalizeMidSentence(text);
  const c = capitalizeNounsInText(d.result);
  return { result: c.result, decapCount: d.count, capCount: c.count };
}
