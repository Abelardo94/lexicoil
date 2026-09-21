/**
 * enrichBatchMetadata.mjs — Backfill determinista de topic / vocabularyTags / grammarTags.
 *
 * Vocab: mismo pipeline que enrich-bank-vocab-tags.mjs (lemmatizer + B1 whitelist).
 * Grammar: heurísticas sobre texto (IDs de GEMINI_API_COMPACT_de_B1.md) — sin LLM.
 * Topic: detectTopic + tagBatchWithTopic (ya validado en Schreiben/Sprechen).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { detectTopic, tagBatchWithTopic, alignQuestionTopicTagsToRequestedTopic } from './topicRotation.mjs';
import { LEGACY_TOPIC_SLUGS } from './qualityGates/topicFamilies.mjs';
import { normalizeB1Topic, isValidB1Topic } from './b1Topics.mjs';
import { checkPassageContentTopic } from './qualityGates/contentTopicCheck.mjs';
import { NEVER_NOUN_WORDS } from './capitalizeNouns.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const Lemmatizer = require(path.join(ROOT, 'js/engine/validation/lemmatizer.js'));

/** Function words + low search-value particles (never emit as vocabularyTags). */
const STOP = new Set([
  'sein', 'haben', 'werden', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem',
  'einen', 'und', 'oder', 'aber', 'nicht', 'auch', 'sie', 'er', 'es', 'wir', 'ihr', 'ich', 'du', 'man', 'mit', 'von',
  'zu', 'auf', 'in', 'an', 'für', 'bei', 'nach', 'vor', 'über', 'unter', 'durch', 'als', 'wenn', 'weil', 'dass',
  'ob', 'so', 'noch', 'nur', 'schon', 'sehr', 'mehr', 'kann', 'können', 'muss', 'müssen', 'soll', 'sollen',
  'will', 'wollen', 'wird', 'wurde', 'worden', 'hat', 'hatte', 'sind', 'war', 'waren', 'wurden', 'könnte',
  'müsste', 'dieser', 'diese', 'dieses', 'jeder', 'jede', 'alle', 'viel', 'wenig', 'gut', 'neu', 'alt',
  // Pronouns / possessives / particles that leaked into tags
  'sich', 'mein', 'meine', 'meiner', 'meinen', 'meinem', 'dein', 'dein', 'seine', 'unser', 'euer',
  'mich', 'dich', 'ihm', 'ihn', 'uns', 'euch', 'ihnen', 'mir', 'dir',
  'statt', 'teil', 'punkt', 'thema', 'grund', 'weiter', 'selbst', 'lieb', 'national', 'sofort', 'zuerst',
  'gross', 'groß', 'ganz', 'etwas', 'nichts', 'jemand', 'niemand', 'hier', 'dort', 'dann', 'denn',
  'immer', 'oft', 'mal', 'wieder', 'etwa', 'fast', 'kaum', 'doch', 'wohl', 'eben', 'halt',
  'inform', // stub from over-stripping
  // Exam UI / rubric labels (Sprechen Beispielfragen: …) — never learning tags
  'beispielfragen', 'beispielfrage',
  'wann', 'was', 'wer', 'wie', 'wo', 'warum', 'wieso', 'weshalb',
  'dies', 'diese', 'dieser', 'dieses', 'jene', 'jener',
  'erst', 'also', 'denn', 'doch', 'wohl', 'eigen', 'eigenen', 'eigene',
  'weit', 'nahe', 'bald', 'lange', 'kurz', 'heute', 'morgen', 'gestern',
  // Function / low-value (ChatGPT audit 2026-07-10)
  'jedoch', 'trotzdem', 'außerdem', 'deshalb', 'deswegen', 'dennoch', 'allerdings',
  'bestimmt', 'bestimmte', 'bestimmten', 'bestimmtes', 'bestimmter', 'bestimmtem',
  'zweit', 'zweite', 'zweiten', 'zweites', 'zweiter', 'zweitem',
  'erst', 'erste', 'ersten', 'erstes', 'erster',
  'dritte', 'dritten', 'nächste', 'nächsten', 'letzte', 'letzten',
  'vorgesehen', 'vorgesehene', 'vorgesehenen', 'vorgesehenes', 'vorgesehener',
  'darauf', 'dafür', 'davon', 'dazu', 'dabei', 'darum', 'worauf', 'wofür',
  'bitte', 'mal', 'gar',
  // Exam rubric imperatives / possessives (Schreiben «Schreib zu drei Punkten», «deinen Chef»)
  'schreiben', 'schreibt', 'deinen', 'deinem', 'deiner', 'deines',
  // v2.3.1 — ranking leaks (light-verb demote fillers)
  'vielleicht',
  'musst', 'musste', 'mussten', 'müssten', // müssen already STOP; finite/past/subj. forms
  'diesen', 'diesem', // dieser/diese/dieses already STOP; missing case forms
  'hätte', 'hätten', 'hättest', 'hättet', // haben already STOP; Konjunktiv II surface forms
]);

/** Finite / participle → infinitive (extends weak lemmatizer for search tags). */
/** Broken/truncated lemmas → canonical form (ground truth cluster F). */
const LEMMA_GROUND_TRUTH = {
  interessanen: 'interessieren',
  kaputen: 'kaputt',
  direken: 'direkt',
  hingegangen: 'hingehen',
  handelen: 'handeln',
  behandelen: 'behandeln',
  weiterhi: 'weiterhin',
  anstaten: 'anstatt',
  änderen: 'ändern',
  prägnanen: 'prägnant',
  sophi: 'Sophie',
  podcaen: 'podcast',
  kunen: 'Kunst',
  zukunfen: 'Zukunft',
  zeitschrifen: 'Zeitschrift',
  informationsflün: 'Informationsflut',
  möcht: 'möchten',
  moecht: 'möchten',
  unternehm: 'unternehmen',
};

// Shape check, not a taxonomy check: `g-<lang>-<level>-<slug>`. The language segment used to
// be hardcoded to `de`, so every English tag (`g-en-b1-modals`) was reported as "categoría
// gramatical no reconocida" — 97 findings on a single English batch set. There is no curated
// English taxonomy yet (docs/ has only A2/B2 German ones), so English tags are validated by
// shape alone; `sanitizeGrammarTags` still filters German tags against their id list.
const VALID_GRAMMAR_TAG_RE = /^g-(de|en)-(b1|b2|a2)-[a-z0-9-]+$/;

/** @param {string} tag @param {string} [level] B1|B2|A2 — when set, tag prefix must match level */
export function isValidGrammarTag(tag, level = null) {
  const s = String(tag || '').trim();
  const m = VALID_GRAMMAR_TAG_RE.exec(s);
  if (!m) return false;
  if (!level) return true;
  const lv = String(level).trim().toUpperCase();
  return s.startsWith(`g-${m[1]}-${lv.toLowerCase()}-`);
}

export function sanitizeGrammarTags(tags, level = null) {
  const lv = level ? String(level).trim().toUpperCase() : null;
  const allowed = lv ? new Set(grammarIdsForLevel(lv)) : null;
  return (tags || []).filter((t) => {
    if (!isValidGrammarTag(t, level)) return false;
    if (allowed && !allowed.has(String(t).trim())) return false;
    return true;
  });
}

const FINITE_TO_INF = {
  findet: 'finden', findest: 'finden', finde: 'finden', fand: 'finden', fanden: 'finden', gefunden: 'finden',
  braucht: 'brauchen', brauchst: 'brauchen', brauche: 'brauchen', gebraucht: 'brauchen',
  hilft: 'helfen', hilfst: 'helfen', helfe: 'helfen', half: 'helfen', geholfen: 'helfen',
  macht: 'machen', machst: 'machen', mache: 'machen', gemacht: 'machen',
  geht: 'gehen', gehst: 'gehen', gehe: 'gehen', ging: 'gehen', gingen: 'gehen', gegangen: 'gehen', hingegangen: 'hingehen',
  kommt: 'kommen', kommst: 'kommen', komme: 'kommen', kam: 'kommen', kamen: 'kommen', gekommen: 'kommen',
  nimmt: 'nehmen', nimmst: 'nehmen', nehme: 'nehmen', nahm: 'nehmen', genommen: 'nehmen',
  gibt: 'geben', gibst: 'geben', gebe: 'geben', gab: 'geben', gegeben: 'geben',
  sieht: 'sehen', siehst: 'sehen', sehe: 'sehen', sah: 'sehen', gesehen: 'sehen',
  spricht: 'sprechen', sprichst: 'sprechen', spreche: 'sprechen', sprach: 'sprechen', gesprochen: 'sprechen',
  schreibt: 'schreiben', schreibst: 'schreiben', schrieb: 'schreiben', geschrieben: 'schreiben',
  liest: 'lesen', lese: 'lesen', las: 'lesen', gelesen: 'lesen',
  fährt: 'fahren', fährst: 'fahren', fahre: 'fahren', fuhr: 'fahren', gefahren: 'fahren',
  läuft: 'laufen', läufst: 'laufen', laufe: 'laufen', lief: 'laufen', gelaufen: 'laufen',
  steht: 'stehen', stehst: 'stehen', stehe: 'stehen', stand: 'stehen', gestanden: 'stehen',
  liegt: 'liegen', liegst: 'liegen', liege: 'liegen', lag: 'liegen', gelegen: 'liegen',
  wohnt: 'wohnen', wohnst: 'wohnen', wohne: 'wohnen', gewohnt: 'wohnen',
  arbeitet: 'arbeiten', arbeitest: 'arbeiten', arbeite: 'arbeiten', gearbeitet: 'arbeiten',
  lernt: 'lernen', lernst: 'lernen', lerne: 'lernen', gelernt: 'lernen',
  kauft: 'kaufen', kaufst: 'kaufen', kaufe: 'kaufen', gekauft: 'kaufen',
  verkauft: 'verkaufen', verkaufst: 'verkaufen', verkaufe: 'verkaufen',
  denkt: 'denken', denkst: 'denken', denke: 'denken', dachte: 'denken', gedacht: 'denken',
  glaubt: 'glauben', glaubst: 'glauben', glaube: 'glauben', geglaubt: 'glauben',
  weiß: 'wissen', weiss: 'wissen', weißt: 'wissen', wusste: 'wissen', gewusst: 'wissen',
  kennt: 'kennen', kennst: 'kennen', kenne: 'kennen', kannte: 'kennen', gekannt: 'kennen',
  // Strong verb present Ablaut (2sg/3sg) — no mechanical -st/-t rule can derive these
  // 1sg included to block adj-strip garbage (treffe↛treff, esse↛ess, …)
  vergisst: 'vergessen',
  isst: 'essen', esse: 'essen',
  trifft: 'treffen', triffst: 'treffen', treffe: 'treffen',
  wirft: 'werfen', wirfst: 'werfen', werfe: 'werfen',
  bricht: 'brechen', brichst: 'brechen', breche: 'brechen',
  misst: 'messen', messe: 'messen',
  frisst: 'fressen', fresse: 'fressen',
  gilt: 'gelten', giltst: 'gelten', gelte: 'gelten',
  schläft: 'schlafen', schläfst: 'schlafen', schlafe: 'schlafen',
  trägt: 'tragen', trägst: 'tragen', trage: 'tragen',
  fällt: 'fallen', fällst: 'fallen', falle: 'fallen',
  hält: 'halten', hältst: 'halten', halte: 'halten',
  lässt: 'lassen', lasse: 'lassen',
  hinterlässt: 'hinterlassen', hinterlaesst: 'hinterlassen',
  wächst: 'wachsen', wachse: 'wachsen',
  wäscht: 'waschen', wäschst: 'waschen', wasche: 'waschen',
  bäckt: 'backen', bäckst: 'backen', backe: 'backen',
  gräbt: 'graben', gräbst: 'graben', grabe: 'graben',
  schlägt: 'schlagen', schlägst: 'schlagen', schlage: 'schlagen',
  kündigt: 'kündigen', kuendigt: 'kündigen', kündigst: 'kündigen', kuendigst: 'kündigen',
  kündige: 'kündigen', kuendige: 'kündigen', gekündigt: 'kündigen', gekuendigt: 'kündigen',
  spielt: 'spielen', spielst: 'spielen', spiele: 'spielen', spielte: 'spielen', gespielt: 'spielen',
  startet: 'starten', startest: 'starten', starte: 'starten', gestartet: 'starten',
  schaltet: 'schalten', schaltest: 'schalten', geschaltet: 'schalten',
  empfiehlt: 'empfehlen', empfiehlst: 'empfehlen', empfohlen: 'empfehlen',
  empfand: 'empfinden', empfunden: 'empfinden',
  unterstützt: 'unterstützen', unterstuetzt: 'unterstützen',
  verändert: 'verändern', veraendert: 'verändern',
  informiert: 'informieren',
  konsumiert: 'konsumieren',
  wünscht: 'wünschen', wuenscht: 'wünschen',
  erwartet: 'erwarten',
  bearbeitet: 'bearbeiten',
  dokumentiert: 'dokumentieren',
  notiert: 'notieren',
  respektiert: 'respektieren',
  angefangen: 'anfangen',
  gegessen: 'essen', getrunken: 'trinken',
  abgestellt: 'abstellen',
  fördert: 'fördern', foerdert: 'fördern', gefördert: 'fördern',
  erweitert: 'erweitern', erweiterst: 'erweitern',
  verhindert: 'verhindern', verhinderst: 'verhindern',
};

/** Comparatives → base (then often STOP-filtered as too generic). */
const COMPARATIVE_TO_BASE = {
  besser: 'gut', beste: 'gut', besten: 'gut', bestes: 'gut',
  größer: 'groß', groesser: 'groß', größte: 'groß', groesste: 'groß',
  kleiner: 'klein', kleinste: 'klein',
  mehr: 'viel', weniger: 'wenig',
  hohen: 'hoch', hohe: 'hoch', hohem: 'hoch', hohes: 'hoch',
  besonderen: 'besonders', besondere: 'besonders', besonderem: 'besonders', besonderes: 'besonders',
  persönlichen: 'persönlich', persönliche: 'persönlich', persönlichem: 'persönlich', persönliches: 'persönlich',
};

/** Lemmas that are nouns for display/search (capitalize). */
const NOUN_LEMMAS = new Set([
  'alltag', 'urlaub', 'umzug', 'arbeit', 'familie', 'freund', 'schule', 'stadt', 'land', 'haus',
  'auto', 'zug', 'bus', 'bahn', 'geld', 'zeit', 'mensch', 'kind', 'frau', 'mann', 'problem',
  'punkt', 'thema', 'firma', 'eltern', 'frage',
  'angebot', 'termin', 'arzt', 'krankenhaus', 'umwelt', 'verkehr', 'freizeit', 'gesundheit',
  'bildung', 'wohnen', 'lebensstil', 'engagement', 'organisation', 'nachbar', 'erfahrung',
  'entscheidung', 'umstellung', 'bewegung', 'luft', 'lärm', 'laerm', 'radweg', 'innenstadt',
  'bewohner', 'straße', 'strasse', 'kurs', 'mobilität', 'mobilitaet', 'leben', 'tipp', 'weg',
  'verkehrsmittel', 'spaziergang', 'beispiel', 'bildschirm', 'verzicht', 'wortschatz', 'grammatik',
  'hobby', 'reiseplan', 'wunsch', 'partner', 'aspekt', 'detail', 'mitglied', 'fortschritt',
  'inhalt', 'abschnitt', 'zitat', 'akzent', 'respekt', 'konzept', 'entwurf', 'design', 'stil',
  'mode', 'idee', 'inspiration', 'kreativität', 'kreativitaet', 'begabung', 'talent', 'schwäche',
  'schwaeche',   'unterkunft', 'urlaub', 'umzug', 'verein',
]);

const NOUN_SUFFIX =
  /(ung|heit|keit|schaft|tum|nis|ion|tion|tät|taet|ment|ismus|ling|chen|lein|heit)$/i;

/** Adjective comparative/superlative → base (default; keep comparative only if listed). */
const KEEP_COMPARATIVE = new Set([
  // empty by default — product wants base forms for search
]);

/**
 * Adjective bases that must never go through toVerbInfinitive.
 * -st heuristic would turn bewusst→bewusen / robust→robuen; compounds (*bewusst) share the trap.
 * Matched as exact lemma or any form whose toAdjectiveBase() ends with one of these.
 */
const KNOWN_ADJECTIVE_LEMMAS = new Set([
  'bewusst',
  'unbewusst',
  'robust',
]);

/**
 * Adverbs that must never go through stripSuffix (-s) or -st finite heuristics.
 * mindestens→mindesten via Lemmatizer stripSuffix; keep full adverb as tag.
 */
const KNOWN_ADVERB_LEMMAS = new Set([
  'mindestens',
  'meistens',
  'wenigstens',
  'höchstens',
  'hoechstens',
  'zumindest',
  'spätestens',
  'spaetestens',
  'frühestens',
  'fruehestens',
  'bestens',
  'weiterhin',
  'anstatt',
  'direkt',
]);

const ADVERB_CANON = new Map([
  ['hoechstens', 'höchstens'],
  ['spaetestens', 'spätestens'],
  ['fruehestens', 'frühestens'],
]);

export const VOCAB_TAGS_NORMALIZE_VERSION = 'v2.3.18-paso3-vocab-plural-rubric-strip-2026-08-02';

/** Spurious «-eren» / «-chen» style artifacts from blind -t→-en heuristics. */
export function isVocabLemmaCorruption(original, lemma, b1Set) {
  const o = String(original || '').toLowerCase();
  const l = String(lemma || '').toLowerCase();
  if (!l || l === o) return false;
  if (b1Set?.has(o) && !b1Set.has(l)) return true;
  if (/eren$/.test(l) && b1Set?.has(`${l.slice(0, -1)}n`)) return true;
  if (o.endsWith('t') && l === `${o.slice(0, -1)}en` && !b1Set?.has(l)) return true;
  if (o.endsWith('t') && l === `${o.slice(0, -1)}en` && !b1Set?.has(l) && looksLikeUninflectedAdjective(o)) return true;
  if (/een$/.test(l) && !b1Set?.has(l)) return true;
  return false;
}

/**
 * High-frequency light / support verbs — demoted in ranking.
 * Only fill remaining tag slots after more specific lemmas are exhausted.
 * `haben` / `sein` already blocked via STOP.
 */
export const LIGHT_VERBS = new Set(['machen', 'gehen', 'nehmen', 'geben', 'tun']);

/** Separable verb prefixes (B1-frequent). Keep in sync with js/engine/separableResolve.js. */
export const SEPARABLE_PREFIXES = [
  'mit', 'auf', 'an', 'aus', 'ein', 'zu', 'vor', 'nach', 'bei', 'los', 'weg',
  'zurück', 'weiter', 'fest', 'teil', 'statt', 'heran', 'herum', 'hin', 'her',
  'herunter', 'fort',
  'ab', 'durch', 'über', 'um', 'unter', 'zusammen',
];

/**
 * Fixed collocations → single vocabularyTag (learning value is the phrase).
 * `tag: null` = suppress only (exam boilerplate — not a learning tag).
 * `strip: true` = remove match from text before token extraction.
 */
export const VOCAB_COLLOCATIONS = [
  { re: /\beine?\s+(?:wichtige\s+|große\s+|grosse\s+)?rolle\s+spiel(?:en|t|st|te|ten)?\b/i, tag: 'eine Rolle spielen', suppress: ['spielen', 'rolle', 'Rolle'] },
  { re: /\bspiel(?:en|t|st|te|ten)?\b[\s\S]{0,50}\beine?\s+(?:wichtige\s+|große\s+|grosse\s+)?rolle\b/i, tag: 'eine Rolle spielen', suppress: ['spielen', 'rolle', 'Rolle'] },
  { re: /\bes\s+geht\s+um\b/i, tag: 'es geht um', suppress: ['gehen'] },
  { re: /\bes\s+geht\s+darum\b/i, tag: 'es geht darum', suppress: ['gehen'] },
  { re: /\bgeht\s+es\s+darum\b/i, tag: 'es geht darum', suppress: ['gehen'] },
  // Exam-item formula (Hören/Lesen T2 etc.) — suppress gehen; do not emit as vocab
  { re: /\bworum\s+geht(?:[''\u2019]s|\s+es)\b/i, tag: null, suppress: ['gehen'], strip: true },
  { re: /\brücksicht\s+(?:zu\s+)?nehm(?:en|t|st|e)?\b/i, tag: 'Rücksicht nehmen', suppress: ['nehmen', 'rücksicht', 'Ruecksicht'] },
  { re: /\bin\s+anspruch\s+(?:zu\s+)?nehm(?:en|t|st|e)?\b/i, tag: 'in Anspruch nehmen', suppress: ['nehmen', 'anspruch', 'Anspruch'] },
  { re: /\bzur\s+verfügung\s+(?:zu\s+)?stell(?:en|t|st|e)?\b/i, tag: 'zur Verfügung stellen', suppress: ['stellen', 'verfügung', 'Verfuegung'] },
  { re: /\bteil\s+(?:zu\s+)?nehm(?:en|t|st|e)?\b/i, tag: 'teilnehmen', suppress: ['nehmen', 'teil'] },
  { re: /\bstatt\s+(?:zu\s+)?find(?:en|et|est|e)?\b/i, tag: 'stattfinden', suppress: ['finden', 'statt'] },
];

/**
 * Strip full exam-stem questions so boilerplate words (Vortrag, hauptsächlich, …)
 * do not become vocabularyTags. Incremental (c); fuller per-Teil template catalog → VOCAB-EXAM-STEM.
 */
export const EXAM_STEM_STRIP = [
  /\bworum\s+geht(?:[''\u2019]s|\s+es)\b[^?]{0,160}\?/gi,
  // Schreiben rubric boilerplate (Punkten / Schreiben imperative — never learning tags)
  /\bschreib(?:en|t)\s+(?:sie\s+)?zu\s+drei\s+punkten\s*:?\b/gi,
  // Sprechen T3 boilerplate header (never a learning tag)
  /\bbeispielfragen\s*:/gi,
  // Examiner feedback checklist embedded in Sprechen T3 prompts
  /\b(?:nicht\s+nur\s+auf\s+den\s+inhalt,?\s+sondern\s+auch\s+auf\s+)?die\s+struktur,?\s+die\s+grammatik,?\s+den\s+wortschatz(?:\s+und\s+die\s+prosodie)?\b/gi,
];

/** Keep in sync with js/engine/separableResolve.js */
export const INSEPARABLE_INFINITIVES = new Set([
  // Prefix looks separable but verb is consistently untrennbar (exam/register B1–B2).
  'durchführen', 'unterschreiben', 'übernehmen', 'überweisen',
  // Other common false positives (morph scan / DWDS heuristic noise).
  'übersetzen', 'unterhalten', 'unternehmen', 'unterstützen', 'untersuchen', 'beistehen',
  'übersteigen', 'überleben', 'überzeugen', 'verstehen', 'bekommen', 'besuchen', 'verreisen',
  'versuchen', 'beschweren', 'erreichen', 'erklären', 'erzählen', 'empfehlen', 'entdecken',
]);

/** Known separable infinitives (keep full form). Keep in sync with js/engine/separableResolve.js. */
export const SEPARABLE_INFINITIVES = new Set([
  // mit-
  'mitbringen', 'mithelfen', 'mitkommen', 'mitmachen', 'mitnehmen', 'mitschreiben',
  'mitspielen', 'mitteilen',
  // auf-
  'aufatmen', 'aufbauen', 'aufbewahren', 'aufbrechen', 'aufdecken', 'aufdrehen',
  'auffallen', 'auffangen', 'auffordern', 'aufgeben', 'aufhalten', 'aufhängen',
  'aufheben', 'aufhören', 'aufklären', 'aufladen', 'auflaufen', 'auflegen',
  'auflesen', 'auflösen', 'aufmachen', 'aufnehmen', 'aufpassen', 'aufräumen',
  'aufregen', 'aufreizen', 'aufrufen', 'aufschreiben', 'aufstehen', 'aufsteigen',
  'auftauchen', 'aufteilen', 'auftreten', 'aufwachen', 'aufwachsen', 'aufzählen',
  'aufzeigen', 'aufziehen',
  // an-
  'anbauen', 'anbeißen', 'anbieten', 'anbinden', 'anbrechen', 'anbrennen',
  'anfangen', 'anfassen', 'anfragen', 'anfühlen', 'angeben', 'angreifen',
  'anhaben', 'anhalten', 'anklicken', 'ankommen', 'ankreuzen', 'ankündigen',
  'anlaufen', 'anlegen', 'anleuchten', 'anmachen', 'anmelden', 'annehmen',
  'anpassen', 'anprobieren', 'anrufen', 'anschauen', 'anschließen', 'ansehen',
  'ansprechen', 'anstehen', 'anstellen', 'anstrengen', 'antreffen', 'anwenden',
  'anziehen',
  // aus-
  'ausarbeiten', 'ausatmen', 'ausbauen', 'ausbilden', 'ausbleiben', 'ausbrechen',
  'ausbreiten', 'ausdehnen', 'ausdenken', 'ausdrucken', 'ausdrücken', 'ausfahren',
  'ausfallen', 'ausfüllen', 'ausgeben', 'ausgehen', 'ausgleichen', 'aushalten',
  'aushelfen', 'auskennen', 'ausladen', 'auslaufen', 'auslegen', 'ausleihen',
  'auslösen', 'ausmachen', 'ausnutzen', 'auspacken', 'ausprobieren', 'ausreden',
  'ausreichen', 'ausruhen', 'ausschalten', 'ausschließen', 'ausschneiden', 'aussehen',
  'aussprechen', 'aussteigen', 'aussuchen', 'austauschen', 'austragen', 'austreten', 'ausüben',
  'auswählen', 'auswandern', 'ausweichen', 'ausziehen',
  // ein-
  'einatmen', 'einbauen', 'einbilden', 'einbrechen', 'einbringen', 'einchecken',
  'eindringen', 'einfallen', 'einfangen', 'einfärben', 'einfordern', 'einfrieren',
  'eingeben', 'eingehen', 'eingießen', 'eingreifen', 'einhalten', 'einhängen',
  'einholen', 'einkaufen', 'einladen', 'einlassen', 'einlaufen', 'einlegen',
  'einleiten', 'einlesen', 'einlösen', 'einnehmen', 'einpacken', 'einpassen',
  'einprägen', 'einräumen', 'einreichen', 'einrichten', 'einsammeln', 'einschalten',
  'einschlafen', 'einschließen', 'einschreiben', 'einsetzen', 'einsparen', 'einsteigen',
  'einstellen', 'einstimmen', 'eintauchen', 'einteilen', 'eintippen', 'eintragen',
  'eintreten', 'einüben', 'einzahlen', 'einziehen',
  // zu-
  'zubereiten', 'zugeben', 'zuhören', 'zumachen', 'zunehmen', 'zustimmen',
  // vor-
  'vorbereiten', 'vorhaben', 'vorkommen', 'vorlesen', 'vorschlagen', 'vorstellen',
  // nach-
  'nachdenken', 'nachfragen', 'nachschauen', 'nachweisen',
  // bei-
  'beibringen', 'beitragen',
  // los-
  'losfahren', 'losgehen',
  // fort-
  'fortsetzen',
  // weg-
  'wegfahren', 'weggehen',
  // zurück-
  'zurückfahren', 'zurückgeben', 'zurückgehen', 'zurückkommen', 'zurücklaufen', 'zurückrufen',
  // weiter-
  'weitergeben', 'weitergehen', 'weitermachen',
  // fest-
  'festhalten', 'festlegen', 'feststellen',
  // teil-
  'teilnehmen',
  // statt-
  'stattfinden',
  // ab-
  'abbiegen', 'abbrechen', 'abbringen', 'abdanken', 'abfahren', 'abfallen',
  'abfertigen', 'abfliegen', 'abgeben', 'abgleichen', 'abgreifen', 'abhalten',
  'abhängen', 'abheben', 'abholen', 'abkühlen', 'ablegen', 'ablehnen',
  'abmelden', 'abnehmen', 'abraten', 'abreisen', 'abrufen', 'absagen',
  'abschließen', 'abschneiden', 'absehen', 'absteigen', 'abstellen', 'abstimmen',
  'abwarten', 'abwickeln', 'abwenden', 'abziehen',
  // her-
  'herkommen', 'herunterladen', 'herstellen',
  // um-
  'umsetzen', 'umsteigen', 'umziehen',
  // unter-
  'untergehen',
  // zusammen-
  'zusammenarbeiten', 'zusammenfassen',
  // aner-
  'anerkennen',
  // other-
  'hingehen', 'kennenlernen',
]);

/**
 * Roots implied by SEPARABLE_INFINITIVES (longest matching SEPARABLE_PREFIXES win).
 * Single source of truth — do not maintain a parallel hardcoded roots map.
 * e.g. vorschlagen → schlagen, stattfinden → finden, ankündigen → kündigen.
 */
export function separableRootsFromAllowlist() {
  const roots = new Set();
  const prefixes = [...SEPARABLE_PREFIXES].sort((a, b) => b.length - a.length);
  for (const full of SEPARABLE_INFINITIVES) {
    const low = String(full || '').toLowerCase();
    for (const p of prefixes) {
      if (low.startsWith(p) && low.length > p.length + 2) {
        roots.add(low.slice(p.length));
        break;
      }
    }
  }
  return roots;
}

/**
 * Verbs where leading "ge-" is lexical (part of the stem), not a participle prefix.
 * Used to block the ge- strip fallback in toVerbInfinitive (gewährleistet↛währleisten).
 * Keep entries long enough that stem-prefix match won't collide with true participles (gestartet).
 */
export const LEXICAL_GE_VERBS = new Set([
  'gewährleisten', 'gewaehrleisten',
  'gefährden', 'gefaehrden',
  'genießen', 'geniessen',
  'gehören', 'gehoeren',
  'geschehen',
  'gelingen',
  'gefallen',
  'gehorchen',
  'genehmigen',
  'gebrauchen',
  'gedenken',
  'gestehen',
  'gewinnen',
  'gebären', 'gebaeren',
  'gedeihen',
  'geraten',
  'genügen', 'genuegen',
  'gestalten',
  'gewöhnen', 'gewoehnen',
]);

/**
 * If conjugated form w derives from a LEXICAL_GE_VERBS infinitive, return that infinitive.
 * Matches stem + common finite endings (…t / …et / …st / …te…).
 */
function matchLexicalGeVerb(w) {
  const low = String(w || '').toLowerCase();
  if (!low.startsWith('ge') || low.length < 6) return null;
  for (const v of LEXICAL_GE_VERBS) {
    if (low === v) return v;
    // strip -en / -n (genießen→genieß, gewährleisten→gewährleist)
    const stem = v.endsWith('en') ? v.slice(0, -2) : v.endsWith('n') ? v.slice(0, -1) : v;
    if (stem.length < 5) continue;
    if (!low.startsWith(stem)) continue;
    const rest = low.slice(stem.length);
    if (!rest || /^(?:e?t|st|te|ten|test|tet|e)$/.test(rest)) return v;
  }
  return null;
}

/** Allowed B1 grammar IDs (generation contract). */
export const B1_GRAMMAR_IDS = [
  'g-de-b1-perfekt',
  'g-de-b1-passiv',
  'g-de-b1-nebensatz',
  'g-de-b1-modalverben',
  'g-de-b1-relativ',
  'g-de-b1-konjunktiv',
  'g-de-b1-adjektivdeklination',
  'g-de-b1-komparativ',
  'g-de-b1-futur',
  'g-de-b1-genitiv',
  'g-de-b1-dativ',
];

const DEFAULT_GRAMMAR_BY_TEIL = {
  1: ['g-de-b1-nebensatz', 'g-de-b1-perfekt'],
  2: ['g-de-b1-perfekt', 'g-de-b1-nebensatz'],
  3: ['g-de-b1-modalverben', 'g-de-b1-dativ'],
  4: ['g-de-b1-nebensatz', 'g-de-b1-konjunktiv'],
  5: ['g-de-b1-passiv', 'g-de-b1-nebensatz'],
};

/** Goethe A2 — contract aligned with batches/GEMINI_API_COMPACT_de_A2.md */
export const A2_GRAMMAR_IDS = [
  'g-de-a2-praesens',
  'g-de-a2-perfekt',
  'g-de-a2-modal',
  'g-de-a2-trennbar',
  'g-de-a2-dat-akk',
  'g-de-a2-nebensatz',
  'g-de-a2-komparativ',
];

/** Goethe B2 — contract aligned with batches/GEMINI_API_COMPACT_de_B2.md */
export const B2_GRAMMAR_IDS = [
  'g-de-b2-konj1',
  'g-de-b2-konj2',
  'g-de-b2-nominal',
  'g-de-b2-passiv',
  'g-de-b2-modus',
  'g-de-b2-relativ',
];

const DEFAULT_GRAMMAR_BY_TEIL_B2 = {
  1: ['g-de-b2-nominal', 'g-de-b2-konj1'],
  2: ['g-de-b2-modus', 'g-de-b2-konj2'],
};

const DEFAULT_GRAMMAR_BY_TEIL_A2 = {
  1: ['g-de-a2-praesens', 'g-de-a2-modal'],
  2: ['g-de-a2-perfekt', 'g-de-a2-nebensatz'],
  3: ['g-de-a2-modal', 'g-de-a2-nebensatz'],
  4: ['g-de-a2-praesens', 'g-de-a2-dat-akk'],
};

export function grammarIdsForLevel(level = 'B1') {
  const lv = String(level || 'B1').trim().toUpperCase();
  if (lv === 'B2') return B2_GRAMMAR_IDS;
  if (lv === 'A2') return A2_GRAMMAR_IDS;
  return B1_GRAMMAR_IDS;
}

export function defaultGrammarTagsForTeil(teil, level = 'B1') {
  const t = Number(teil) || 1;
  const lv = String(level || 'B1').trim().toUpperCase();
  if (lv === 'B2') return [...(DEFAULT_GRAMMAR_BY_TEIL_B2[t] || DEFAULT_GRAMMAR_BY_TEIL_B2[1])];
  if (lv === 'A2') return [...(DEFAULT_GRAMMAR_BY_TEIL_A2[t] || DEFAULT_GRAMMAR_BY_TEIL_A2[1])];
  return [...(DEFAULT_GRAMMAR_BY_TEIL[t] || DEFAULT_GRAMMAR_BY_TEIL[1])];
}

/**
 * Grammar-tag relevance v2.0 — GRAMMAR-FOCUS + flexible cupo.
 *
 * Primary signals: question + explanation + correct option (item-specific).
 * Passage is reinforcement only — never the sole source of a tag.
 * No fixed cupo of 2: each category that meets its own threshold is included
 * (soft max GRAMMAR_TAG_SOFT_MAX). Empty arrays are allowed when the item
 * has no relevant grammar.
 */
export const GRAMMAR_TAGS_NORMALIZE_VERSION = 'v2.2-a2-b2-level-tags-2026-07-27';

/** Soft safety cap (not a target cupo). Ranked by priority when truncating. */
export const GRAMMAR_TAG_SOFT_MAX = 4;

/** Higher = preferred when soft-max truncates. */
export const GRAMMAR_TAG_PRIORITY_B2 = {
  'g-de-b2-passiv': 100,
  'g-de-b2-konj2': 95,
  'g-de-b2-konj1': 90,
  'g-de-b2-modus': 85,
  'g-de-b2-relativ': 80,
  'g-de-b2-nominal': 70,
};

export const GRAMMAR_TAG_MIN_COUNT_B2 = {
  'g-de-b2-konj1': 1,
  'g-de-b2-konj2': 1,
  'g-de-b2-nominal': 2,
  'g-de-b2-passiv': 1,
  'g-de-b2-modus': 1,
  'g-de-b2-relativ': 1,
};

function grammarPriority(id, level) {
  const lv = String(level || 'B1').trim().toUpperCase();
  if (lv === 'B2') return GRAMMAR_TAG_PRIORITY_B2[id] ?? 0;
  if (lv === 'A2') return GRAMMAR_TAG_PRIORITY_A2[id] ?? 0;
  return GRAMMAR_TAG_PRIORITY[id] ?? 0;
}

function grammarMinCountForLevel(tagId, level, opts = {}) {
  const lv = String(level || 'B1').trim().toUpperCase();
  if (lv === 'B2') return GRAMMAR_TAG_MIN_COUNT_B2[tagId] ?? 1;
  if (lv === 'A2') {
    if (opts.a2Matching && GRAMMAR_TAG_MIN_COUNT_A2_MATCHING[tagId] != null) {
      return GRAMMAR_TAG_MIN_COUNT_A2_MATCHING[tagId];
    }
    return GRAMMAR_TAG_MIN_COUNT_A2[tagId] ?? 1;
  }
  return grammarMinCount(tagId, opts);
}

export const GRAMMAR_TAG_PRIORITY = {
  'g-de-b1-passiv': 100,
  'g-de-b1-konjunktiv': 95,
  'g-de-b1-modalverben': 90,
  'g-de-b1-dativ': 85,
  'g-de-b1-adjektivdeklination': 80,
  'g-de-b1-komparativ': 75,
  'g-de-b1-futur': 70,
  'g-de-b1-genitiv': 65,
  'g-de-b1-perfekt': 55,
  'g-de-b1-nebensatz': 20,
  'g-de-b1-relativ': 15,
};

/**
 * Minimum match count in the PRIMARY (item) blob before a tag is eligible.
 * modal/adj hardened after v1.0.1 over-coverage (52%/41%).
 */
export const GRAMMAR_TAG_MIN_COUNT = {
  'g-de-b1-nebensatz': 2,
  'g-de-b1-relativ': 2,
  'g-de-b1-modalverben': 2, // only modal+infinitive counts (see countGrammarSignals)
  'g-de-b1-passiv': 1,
  'g-de-b1-konjunktiv': 1,
  'g-de-b1-perfekt': 1, // detector now requires ge-/‑iert; keep min 1
  'g-de-b1-futur': 1,
  'g-de-b1-komparativ': 1,
  'g-de-b1-genitiv': 1,
  'g-de-b1-dativ': 2,
  'g-de-b1-adjektivdeklination': 3, // single article+adj is noise
};

export const GRAMMAR_TAG_PRIORITY_A2 = {
  'g-de-a2-nebensatz': 90,
  'g-de-a2-modal': 85,
  'g-de-a2-perfekt': 80,
  'g-de-a2-trennbar': 75,
  'g-de-a2-dat-akk': 70,
  'g-de-a2-komparativ': 65,
  'g-de-a2-praesens': 50,
};

export const GRAMMAR_TAG_MIN_COUNT_A2 = {
  'g-de-a2-nebensatz': 1,
  'g-de-a2-modal': 1,
  'g-de-a2-perfekt': 1,
  'g-de-a2-trennbar': 1,
  'g-de-a2-dat-akk': 1,
  'g-de-a2-komparativ': 1,
  'g-de-a2-praesens': 2,
};

/** Hören A2 T2 matching — single-sentence explanations (Cause E gap). */
export const GRAMMAR_TAG_MIN_COUNT_A2_MATCHING = {
  'g-de-a2-nebensatz': 1,
  'g-de-a2-modal': 1,
  'g-de-a2-dat-akk': 1,
  'g-de-a2-perfekt': 1,
  'g-de-a2-praesens': 1,
};

export function isA2MatchingQuestion(q, batchLevel = 'B1') {
  const level = String(q?.level || batchLevel || 'B1').toUpperCase();
  if (level !== 'A2') return false;
  const type = String(q?.type || '').toLowerCase();
  const letter = String(q?.correctAnswer ?? q?.correct ?? '').trim();
  return (
    type === 'matching' ||
    q?._keyOnlyMatch === true ||
    (!(q?.options || []).length && /^[a-i]$/i.test(letter))
  );
}

function grammarMinCount(tagId, opts = {}) {
  return GRAMMAR_TAG_MIN_COUNT[tagId] ?? 1;
}

let _b1Set = null;
function loadB1LemmaSet() {
  if (_b1Set) return _b1Set;
  const file = path.join(ROOT, 'library/vocab/de/B1.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  _b1Set = new Set((data.lemmas || []).map((w) => String(w).toLowerCase()));
  return _b1Set;
}

/** Nouns seen capitalized in source text (German orthography signal). */
function collectCapitalizedHints(text) {
  const hints = new Set();
  for (const m of String(text || '').matchAll(/\b[A-ZÄÖÜ][a-zäöüß\-]{2,}\b/g)) {
    hints.add(m[0].toLowerCase());
  }
  return hints;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zäöüß\-]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Weak plural / dative -en (Punkten, Kindern, Themen…) → singular for tag repair. */
const PLURAL_TO_SINGULAR = {
  punkten: 'punkt',
  themen: 'thema',
  kindern: 'kind',
  firmen: 'firma',
};

function resolvePluralNounLemma(w) {
  const low = String(w || '').toLowerCase();
  if (PLURAL_TO_SINGULAR[low]) return PLURAL_TO_SINGULAR[low];
  const sing = lightSingularizeNoun(low);
  if (sing !== low && (NOUN_LEMMAS.has(sing) || STOP.has(sing))) return sing;
  return null;
}

function looksLikePluralNounLemma(w) {
  const low = String(w || '').toLowerCase();
  return (
    Boolean(PLURAL_TO_SINGULAR[low]) ||
    /(?:ungen|heiten|keiten|schaften|ionen|täten|schriften|nahmen|fristen|werte|stellen|leute|firmen|mittel|stunden|methoden|punkten|themen|kindern|eltern)$/i.test(
      low,
    ) ||
    (low.length >= 9 && /(?:unternehmen|entscheidungen)$/i.test(low))
  );
}

function looksLikeInfinitive(w) {
  if (!/(?:en|eln|ern)$/.test(w) || w.length < 4) return false;
  // Adjective weak endings mistaken for infinitives (lokalen, aktuellen, wichtigen).
  // Do NOT bare-match /igen$/ — that false-negatives zeigen/neigen/steigen (len 6–7).
  if (/(?:isch|lich|iv|al|är|ell|sam|bar|os)en$/i.test(w)) return false;
  if (w.length >= 9 && /igen$/i.test(w)) return false; // wichtigen, bisherigen, …
  // Common plural nouns (incl. -en plurals mistaken for infinitives: Maßnahmen, Vorschriften, …)
  if (
    /(?:ungen|heiten|keiten|schaften|ionen|täten|schriften|nahmen|fristen|werte|stellen|leute|firmen|mittel|stunden|methoden|punkten|themen|kindern|eltern)$/i.test(
      w,
    )
  ) {
    return false;
  }
  if (PLURAL_TO_SINGULAR[w]) return false;
  // Nominal -en (Unternehmen, Ereignissen…) — not separable infinitives
  if (w.length >= 9 && /(?:men|nen|den|gen|ten|sen|len|ren)$/i.test(w) && !SEPARABLE_INFINITIVES.has(w)) {
    if (/(?:unternehmen|ereignissen|entscheidungen)$/i.test(w)) return false;
  }
  // Past participles / weak adj participles ending in -en (vorgesehenen, abgestellt is -t)
  // Exception: lexical ge- stems (gewährleisten, genießen) are true infinitives.
  if (/^(?:ge).+(?:en)$/i.test(w) && !SEPARABLE_INFINITIVES.has(w) && !LEXICAL_GE_VERBS.has(w)) return false;
  if (/(?:sehen|geben|kommen|halten|lassen|rufen)en$/i.test(w)) return false; // vorgesehenen
  if (/nehmen$/i.test(w) && !/nahmen$/i.test(w) && !/unternehmen$/i.test(w)) return false;
  // zu-infinitive of separable (auszuschalten) — normalize elsewhere, not a lemma
  if (isZuSeparableInfinitive(w)) return false;
  return true;
}

/** auszuschalten → true; mitmachen → false */
function isZuSeparableInfinitive(w) {
  const low = String(w || '').toLowerCase();
  return SEPARABLE_PREFIXES.some(
    (p) => low.startsWith(`${p}zu`) && low.length > p.length + 4 && /(?:en|eln|ern)$/.test(low),
  );
}

/** auszuschalten → ausschalten; mitzumachen → mitmachen */
export function normalizeZuSeparable(w) {
  const low = String(w || '').toLowerCase();
  for (const p of SEPARABLE_PREFIXES) {
    if (low.startsWith(`${p}zu`) && /(?:en|eln|ern)$/.test(low)) {
      return `${p}${low.slice(p.length + 2)}`;
    }
  }
  return low;
}

/** Light plural → singular for common compound heads. */
function lightSingularizeNoun(n) {
  let w = n;
  if (PLURAL_TO_SINGULAR[w]) return PLURAL_TO_SINGULAR[w];
  const rules = [
    [/pflanzen$/, 'pflanze'],
    [/ständer(?:n)?$/, 'ständer'],
    [/behälter(?:n)?$/, 'behälter'],
    [/geräte$/, 'gerät'],
    [/regeln$/, 'regel'],
    [/zeiten$/, 'zeit'],
    [/stellen$/, 'stelle'],
  ];
  for (const [re, rep] of rules) {
    if (re.test(w)) return w.replace(re, rep);
  }
  if (w.endsWith('en') && w.length > 6) {
    const sing = w.slice(0, -2);
    if (NOUN_LEMMAS.has(sing)) return sing;
  } else if (w.endsWith('e') && w.length > 5) {
    const sing = w.slice(0, -1);
    if (NOUN_LEMMAS.has(sing)) return sing;
  }
  return w;
}

function looksLikeNounMorphology(w) {
  if (NOUN_LEMMAS.has(w)) return true;
  if (NOUN_SUFFIX.test(w) && w.length >= 5) return true;
  return false;
}

function looksLikeUninflectedAdjective(w) {
  const low = String(w || '').toLowerCase();
  if (!low || low.length < 4) return false;
  if (KNOWN_ADJECTIVE_LEMMAS.has(low) || KNOWN_ADVERB_LEMMAS.has(low)) return true;
  if (matchKnownAdjective(low)) return true;
  if (looksLikeInfinitive(low)) return false;
  if (looksLikeNounMorphology(low)) return false;
  // Predicative / base adjectives and participles used adjectivally (schlecht, bekannt, …)
  if (/(?:lich|ig|sam|bar|ant|ent|isch|los|frei|voll|leer|fertig|kaputt|schlecht|recht|falsch|schnell|wichtig|möglich|bekannt|entspannt|interessant|echt|icht|angt|ucht|cht|igt|rot|blau|grün|weiß|schwarz|gelb|hart|weich|neu|alt|groß|klein|lang|kurz|hoch|tief|gut|besser|best|direkt|robust|bewusst)t$/i.test(low)) {
    return true;
  }
  if (/^(?:schlecht|schlecht|direkt|wichtig|möglich|falsch|richtig|bekannt|kaputt)$/i.test(low)) return true;
  return false;
}

/**
 * Map 3sg/2sg finite surface → infinitive ONLY when validated against B1 lemma list.
 */
function resolveFiniteVerbToInfinitive(w, b1Set) {
  const low = String(w || '').toLowerCase();
  if (!low || looksLikeInfinitive(low)) return looksLikeInfinitive(low) ? low : null;
  if (FINITE_TO_INF[low]) return FINITE_TO_INF[low];
  if (looksLikeUninflectedAdjective(low)) return null;

  if (low.endsWith('st') && !low.endsWith('est') && !low.endsWith('ist') && low.length >= 5) {
    const isSstOrSzt = low.endsWith('ßt') || (low.length >= 6 && low[low.length - 3] === 's');
    const cand = isSstOrSzt ? `${low.slice(0, -1)}en` : `${low.slice(0, -2)}en`;
    return b1Set.has(cand) ? cand : null;
  }

  if (!low.endsWith('t') || low.length < 5) return null;
  if (looksLikeNounMorphology(low)) return null;
  if (/[nlr]t$/i.test(low) && looksLikeUninflectedAdjective(low)) return null;

  if (low.startsWith('ge') && low.length >= 6) {
    const lexical = matchLexicalGeVerb(low);
    if (lexical) return lexical;
    let stem = low.slice(2, -1);
    if (stem.endsWith('e') && stem.length >= 4) stem = stem.slice(0, -1);
    const cand = `${stem}en`;
    return b1Set.has(cand) ? cand : null;
  }

  const stem = low.slice(0, -1);
  const candErn = `${stem}n`;
  const candEn = `${stem}en`;
  if (b1Set.has(candErn)) return candErn;
  if (b1Set.has(candEn)) return candEn;
  const lexical = matchLexicalGeVerb(low);
  if (lexical) return lexical;
  return null;
}

function toVerbInfinitive(raw, b1Set) {
  const w = String(raw || '').toLowerCase();
  if (!w) return null;
  if (w.endsWith('lässt') && w.length >= 5) {
    const cand = `${w.slice(0, -5)}lassen`;
    return b1Set.has(cand) ? cand : (FINITE_TO_INF[w] || null);
  }
  if (w.endsWith('laesst') && w.length >= 6) {
    const cand = `${w.slice(0, -6)}lassen`;
    return b1Set.has(cand) ? cand : null;
  }
  return resolveFiniteVerbToInfinitive(w, b1Set);
}

/**
 * Adjective inflection → base (entspanntere → entspannt).
 * Iterates endings; does not strip noun -er when morphology says noun.
 */
function toAdjectiveBase(raw) {
  let w = String(raw || '').toLowerCase();
  if (!w || w.length < 4) return w;
  if (KEEP_COMPARATIVE.has(w)) return w;
  if (looksLikeNounMorphology(w) || looksLikeInfinitive(w)) return w;

  for (let i = 0; i < 3; i++) {
    const before = w;
    if (w.endsWith('sten') && w.length > 6) w = w.slice(0, -4);
    else if (w.endsWith('ste') && w.length > 5 && !w.endsWith('iste')) w = w.slice(0, -3);
    else if (w.endsWith('ere') && w.length > 5) w = w.slice(0, -3); // entspanntere → entspannt
    else {
      let stripped = false;
      for (const suf of ['erem', 'eren', 'erer', 'eres', 'em', 'en', 'er', 'es', 'e']) {
        if (w.length > suf.length + 3 && w.endsWith(suf)) {
          const stem = w.slice(0, -suf.length);
          if (looksLikeNounMorphology(stem) && suf === 'er') break;
          if (stem.length >= 4) {
            w = stem;
            stripped = true;
            break;
          }
        }
      }
      if (!stripped) break;
    }
    if (w === before) break;
    if (looksLikeNounMorphology(w) || looksLikeInfinitive(w)) break;
  }
  return w;
}

/**
 * Known adjectives (and *bewusst compounds / inflections) before any verb heuristic.
 * Returns base form to emit as tag, or null.
 */
function matchKnownAdjective(raw) {
  const low = String(raw || '').toLowerCase();
  if (!low) return null;
  if (KNOWN_ADJECTIVE_LEMMAS.has(low)) return low;
  const base = toAdjectiveBase(low);
  if (KNOWN_ADJECTIVE_LEMMAS.has(base)) return base;
  // Compounds: selbstbewusst, verantwortungsbewusst, …
  for (const adj of KNOWN_ADJECTIVE_LEMMAS) {
    if (base.endsWith(adj) && base.length > adj.length) return base;
    if (low.endsWith(adj) && low.length > adj.length) return low;
  }
  return null;
}

/**
 * Known adverbs before Lemmatizer stripSuffix (mindestens↛mindesten).
 */
function matchKnownAdverb(raw) {
  const low = String(raw || '').toLowerCase();
  if (!low || !KNOWN_ADVERB_LEMMAS.has(low)) return null;
  return ADVERB_CANON.get(low) || low;
}

/**
 * Core lemma for search: irregular table → verb infinitive → adj base.
 * Avoids aggressive lemmatizer suffix-stripping on nouns/infinitives (lösung→loes).
 */
function lemmaOf(token, b1Set, nounHints) {
  let low = String(token || '').toLowerCase();
  if (!low || STOP.has(low)) return null;
  if (low.length < 3) return null;
  if (LEMMA_GROUND_TRUTH[low]) {
    const canon = LEMMA_GROUND_TRUTH[low];
    return STOP.has(canon) ? null : canon;
  }

  const pluralSing = resolvePluralNounLemma(low);
  if (pluralSing) return STOP.has(pluralSing) ? null : pluralSing;

  // Finite forms listed in B1 must still map to infinitive for vocab tags (findet→finden).
  if (FINITE_TO_INF[low]) {
    const inf = FINITE_TO_INF[low];
    if (!STOP.has(inf)) return inf;
  }

  if (b1Set.has(low)) {
    return low;
  }

  // zu-separable before anything else (auszuschalten → ausschalten)
  if (isZuSeparableInfinitive(low)) {
    low = normalizeZuSeparable(low);
  }
  if (COMPARATIVE_TO_BASE[low]) {
    const base = COMPARATIVE_TO_BASE[low];
    return STOP.has(base) ? null : base;
  }

  // Hyphen compounds before verb / -st heuristics (Yoga-Kurs↛yoga-kur, Streaming-Dienst↛streaming-dienen)
  if (low.includes('-')) {
    const hyphenLem = Lemmatizer.normalizeLemma(low, 'de');
    if (hyphenLem && !STOP.has(hyphenLem)) return hyphenLem;
  }

  // Known adjectives BEFORE verb heuristics (bewusst↛bewusen / schlecht↛schlechen)
  const knownAdj = matchKnownAdjective(low);
  if (knownAdj && !STOP.has(knownAdj)) return knownAdj;
  if (looksLikeUninflectedAdjective(low)) {
    const base = toAdjectiveBase(low) || low;
    if (!STOP.has(base) && !isVocabLemmaCorruption(low, base, b1Set)) return base;
  }

  // Known adverbs BEFORE Lemmatizer strip (mindestens↛mindesten)
  const knownAdv = matchKnownAdverb(low);
  if (knownAdv && !STOP.has(knownAdv)) return knownAdv;

  // Known separable infinitive — keep full form
  if (SEPARABLE_INFINITIVES.has(low)) {
    return low;
  }

  // Nouns FIRST (before -en infinitive heuristic): Gartenpflanzen, Fahrradständern
  const nounish =
    looksLikeNounMorphology(low) ||
    (nounHints && nounHints.has(low));
  if (nounish) {
    const n = lightSingularizeNoun(low);
    return STOP.has(n) ? null : n;
  }

  // Already infinitive — keep (lemmatizer would turn gehen→geh)
  if (looksLikeInfinitive(low)) {
    return STOP.has(low) ? null : low;
  }

  // Finite verb → infinitive (B1-validated only)
  const asVerb = toVerbInfinitive(low, b1Set);
  if (asVerb && asVerb !== low && !STOP.has(asVerb) && b1Set.has(asVerb)) {
    if (!isVocabLemmaCorruption(low, asVerb, b1Set)) return asVerb;
  }

  // Adjective base from surface form first (vorgesehenen → vorgesehen → STOP)
  const adj = toAdjectiveBase(low);
  if (adj && adj !== low && adj.length >= 4) {
    if (STOP.has(adj)) return null;
    if (!looksLikeInfinitive(adj) || b1Set.has(adj)) return adj;
    return adj;
  }

  // Lemmatizer as last resort — never trust output unless whitelisted (B1 list / finite map / separable)
  let lem = Lemmatizer.normalizeLemma(low, 'de');
  if (!lem || STOP.has(lem)) {
    if (FINITE_TO_INF[low]) return FINITE_TO_INF[low];
    if (looksLikeUninflectedAdjective(low)) return toAdjectiveBase(low) || low;
    if (looksLikeInfinitive(low)) return low;
    return null;
  }
  if (looksLikeInfinitive(low) && lem !== low) return low;

  const lemTrusted =
    b1Set.has(lem) ||
    SEPARABLE_INFINITIVES.has(lem) ||
    LEXICAL_GE_VERBS.has(lem) ||
    Object.values(FINITE_TO_INF).includes(lem) ||
    FINITE_TO_INF[low] === lem;

  if (!lemTrusted) {
    if (isVocabLemmaCorruption(low, lem, b1Set) || /(?:eren|chen|anen|elen)$/.test(lem)) {
      if (FINITE_TO_INF[low]) return FINITE_TO_INF[low];
      if (looksLikeUninflectedAdjective(low)) return toAdjectiveBase(low) || low;
      return null;
    }
    // Unknown lemmatizer guess — keep safe surface forms only
    if (looksLikeUninflectedAdjective(low)) return toAdjectiveBase(low) || low;
    if (looksLikeInfinitive(low)) return low;
    if (low.length >= 4 && !/(?:st|t)$/.test(low)) return low;
    return null;
  }

  // Reject catastrophic strips (lösung→loes, familie→famili)
  if (lem.length + 2 < low.length && !FINITE_TO_INF[low]) {
    if (adj && adj.length >= 4 && !STOP.has(adj)) return adj;
    if (low.length >= 4 && !/(?:st|t)$/.test(low)) return low;
  }

  const again = toVerbInfinitive(lem, b1Set);
  if (again && again !== lem && b1Set.has(again)) {
    lem = again;
  }

  if (STOP.has(lem)) return null;
  if (/een$/.test(lem) && !b1Set.has(lem)) return null;
  if (isVocabLemmaCorruption(low, lem, b1Set)) {
    if (FINITE_TO_INF[low]) return FINITE_TO_INF[low];
    if (looksLikeUninflectedAdjective(low)) return toAdjectiveBase(low) || low;
    return null;
  }
  return lem;
}

function scoreLemma(lemma, b1Set) {
  if (!lemma || lemma.length < 3) return -1;
  if (STOP.has(lemma)) return -1;
  if (lemma.length < 4 && !['essen', 'lesen', 'fahren', 'stehen'].includes(lemma)) return -1;
  if (['sich', 'mein', 'teil', 'statt'].includes(lemma)) return -1;
  if (/een$/.test(lemma) && !b1Set.has(lemma)) return -1;
  // Reject lemmatizer stubs
  if (lemma.length <= 4 && !b1Set.has(lemma) && !looksLikeNounMorphology(lemma) && !looksLikeInfinitive(lemma)) {
    return -1;
  }
  let score = lemma.length >= 6 ? 2 : 1;
  if (b1Set.has(lemma)) score += 3;
  if (SEPARABLE_INFINITIVES.has(lemma)) score += 2;
  if (looksLikeInfinitive(lemma)) score += 1;
  if (looksLikeNounMorphology(lemma)) score += 1;
  if (b1Set.has(lemma) && /t$/.test(lemma) && b1Set.has(`${lemma.slice(0, -1)}en`)) score -= 2;
  // Light verbs: keep scorable but always rank below specific lemmas
  if (LIGHT_VERBS.has(lemma)) score = Math.min(score, 0.5);
  return score;
}

/** Prefer full separable over bare light/root verb in the same candidate set. */
function suppressRootsOfSeparables(scored, suppress) {
  for (const key of [...scored.keys()]) {
    if (!SEPARABLE_INFINITIVES.has(key)) continue;
    for (const p of SEPARABLE_PREFIXES) {
      if (key.startsWith(p) && key.length > p.length + 2) {
        const root = key.slice(p.length);
        suppress.add(root);
        scored.delete(root);
        break;
      }
    }
  }
}

/** Display/search form: capitalize German nouns; keep verbs/adjectives lowercase. */
export function formatVocabTag(lemma, nounHints = null) {
  const w = String(lemma || '').toLowerCase();
  if (!w) return w;
  // Collocation phrases keep mixed case from VOCAB_COLLOCATIONS
  if (w.includes(' ')) return lemma;
  // Quantifiers / attributive adjectives — never noun-case in tags (Viele→viele)
  if (NEVER_NOUN_WORDS.has(w) || w === 'paar') return w;
  // Verbs / separables before noun heuristic (…en nouns like Gartenpflanzen handled via hints)
  if (SEPARABLE_INFINITIVES.has(w) || looksLikeInfinitive(w)) return w;
  if (looksLikePluralNounLemma(w)) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  const hintHit =
    nounHints &&
    (nounHints.has(w) ||
      [...nounHints].some((h) => lightSingularizeNoun(h) === w || h === w));
  const isNoun = hintHit || looksLikeNounMorphology(w) || NOUN_LEMMAS.has(w);
  if (isNoun) {
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  return w;
}

/**
 * True if lemma (or a close surface form) appears in source text — drops parse artifacts.
 * @param {string} [surface] token that produced the lemma (needed for strong verbs: vergisst→vergessen)
 */
function lemmaAttestedInText(lemma, textLower, surface = '') {
  const w = String(lemma || '').toLowerCase();
  if (!w || w.includes(' ')) return true; // collocations already matched
  if (textLower.includes(w)) return true;
  const surf = String(surface || '').toLowerCase();
  // Irregular finite → infinitive (vowel change): stem of lemma ≠ stem of surface
  if (surf && FINITE_TO_INF[surf] === w && textLower.includes(surf)) return true;
  // Allow zu-separable / finite variants
  if (SEPARABLE_INFINITIVES.has(w)) {
    const p = SEPARABLE_PREFIXES.find((pref) => w.startsWith(pref) && w.length > pref.length + 2);
    if (p) {
      const stem = w.slice(p.length);
      if (textLower.includes(`${p}zu${stem}`) || textLower.includes(`${stem}`) && textLower.includes(p)) {
        return true;
      }
    }
  }
  // Weak: stem without final -en
  if (w.endsWith('en') && textLower.includes(w.slice(0, -2))) return true;
  return false;
}

/** Determiners that mean the preceding token is a preposition, not a separable particle. */
const SEPARABLE_ARTICLE_AFTER = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
]);

/**
 * Sentence / subordinate-clause boundaries between root and particle.
 * Coordinating und/oder/aber are NOT breaks (often mid-clause: «sieht A oder B aus»).
 */
const SEPARABLE_CLAUSE_BREAK = new Set([
  '__sb__',
  // Note: 'als' intentionally omitted — comparative «schlägt X als Y … vor» is common;
  // temporal «als» subordinators are rarer between separable root and particle in B1 items.
  'weil', 'dass', 'daß', 'wenn', 'während', 'waehrend',
  'obwohl', 'nachdem', 'bevor', 'sowie', 'indem', 'falls',
]);

/** Soft words allowed after a true clause-final particle («Tür zu bitte»). */
const SEPARABLE_AFTER_PARTICLE_OK = new Set([
  '__sb__',
  '__cb__', // comma/semicolon after particle: «schlägt vor, …» / «kündigt an, dass»
  'und', 'oder', 'aber', 'denn', 'sondern', 'doch',
  'bitte', 'mal', 'einfach', 'gleich', 'noch',
  // common continuations after separable particle before embedded clause
  'dass', 'daß', 'weil', 'wenn', 'ob', 'als', 'indem',
]);

/**
 * Like tokenize(), but keeps sentence-final punctuation as `__sb__` and
 * commas/semicolons as `__cb__` so findSplitSeparables can:
 *  - refuse cross-clause particle↔root pairs across `.!?`
 *  - still accept genuine particles before a comma («schlägt vor, …» / «kündigt an, dass»)
 */
function tokenizeKeepingSentenceBreaks(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.!?…]+/g, ' __sb__ ')
    .replace(/[,;:]+/g, ' __cb__ ')
    .replace(/[^a-zäöüß\-_]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function clauseBreakBetween(tokens, a, b) {
  const lo = Math.min(a, b) + 1;
  const hi = Math.max(a, b);
  for (let k = lo; k < hi; k++) {
    if (SEPARABLE_CLAUSE_BREAK.has(tokens[k])) return true;
  }
  return false;
}

/** True particle is (near) clause-final — not «auf niedriger Stufe» / «mit Kindern». */
function particleLooksFinal(tokens, j) {
  for (let k = j + 1; k < tokens.length; k++) {
    const tok = tokens[k];
    if (SEPARABLE_AFTER_PARTICLE_OK.has(tok)) return true;
    if (SEPARABLE_ARTICLE_AFTER.has(tok)) return false;
    return false;
  }
  return true;
}

/**
 * Detect separable verb when particle is split: «schlägt … vor» / «findet … statt».
 * Roots are derived from SEPARABLE_INFINITIVES (longest SEPARABLE_PREFIXES match).
 * Only emits verbs in SEPARABLE_INFINITIVES (no mit/auf/ein/aus auto-accept).
 * Skips preposition uses and cross-clause pairs.
 * Window ±8 (was ±6): catches «schlägt … vor» / «findet … statt» with short
 * mid-field arguments while article/zu/clause guards still block prep FPs.
 */
/** @param {string} text */
export function findSplitSeparablesInText(text) {
  return [...findSplitSeparables(tokenizeKeepingSentenceBreaks(text))];
}

function findSplitSeparables(tokens) {
  const found = new Set();
  const roots = separableRootsFromAllowlist();
  // Infinitive/noun collision: «Räumen» (rooms) lowercases to räumen ≠ finite räumt
  const finiteOnlyRoots = {
    räumen: new Set(['räumt', 'raeumt', 'räumst', 'raeumst', 'räume', 'raeume', 'räumte', 'raeumte']),
  };
  const WINDOW = 10;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '__sb__') continue;
    const root = roots.has(t) ? t : (FINITE_TO_INF[t] && roots.has(FINITE_TO_INF[t]) ? FINITE_TO_INF[t] : null);
    if (!root) continue;
    if (finiteOnlyRoots[root] && !finiteOnlyRoots[root].has(t)) continue;
    // look nearby for particle
    for (let j = Math.max(0, i - WINDOW); j < Math.min(tokens.length, i + WINDOW + 1); j++) {
      if (j === i) continue;
      const p = tokens[j];
      if (!SEPARABLE_PREFIXES.includes(p)) continue;

      // Particle follows finite verb («kommt … mit»). Reject «mit Kindern kommen».
      if (j < i) continue;

      const next = j + 1 < tokens.length ? tokens[j + 1] : '';
      if (next && SEPARABLE_ARTICLE_AFTER.has(next)) continue;
      if (!particleLooksFinal(tokens, j)) continue;
      if (clauseBreakBetween(tokens, i, j)) continue;

      // "zu" is both separable particle (macht … zu) and infinitive marker (Urlaub zu machen).
      if (p === 'zu') {
        const prev = j > 0 ? tokens[j - 1] : '';
        if (prev === 'um') continue; // um … zu + Infinitiv
        if (next && /(?:en|eln|ern)$/.test(next) && next.length >= 4) continue;
      }

      const full = `${p}${root}`;
      if (SEPARABLE_INFINITIVES.has(full)) {
        found.add(full);
      }
    }
  }
  return found;
}

/**
 * Extract search-ready vocabulary tags from German text.
 * Verbs → infinitive, nouns → Capitalized, adjectives → base form.
 */
export function extractVocabularyFromText(text, max = 6) {
  const b1Set = loadB1LemmaSet();
  const nounHints = collectCapitalizedHints(text);
  const scored = new Map();
  const suppress = new Set();
  const source = String(text || '');

  // Collocations / exam-stem suppress first (match on original text)
  const collocTags = [];
  let working = source;
  for (const c of VOCAB_COLLOCATIONS) {
    c.re.lastIndex = 0;
    if (!c.re.test(source)) {
      c.re.lastIndex = 0;
      continue;
    }
    c.re.lastIndex = 0;
    if (c.tag) collocTags.push(c.tag);
    for (const s of c.suppress || []) suppress.add(String(s).toLowerCase());
  }
  // Full exam-stem strip before short colloc strips (short match would break the longer regex)
  for (const re of EXAM_STEM_STRIP) {
    re.lastIndex = 0;
    working = working.replace(re, ' ');
    re.lastIndex = 0;
  }
  for (const c of VOCAB_COLLOCATIONS) {
    if (!c.strip) continue;
    c.re.lastIndex = 0;
    if (!c.re.test(working) && !c.re.test(source)) {
      c.re.lastIndex = 0;
      continue;
    }
    c.re.lastIndex = 0;
    const flags = c.re.flags.includes('g') ? c.re.flags : `${c.re.flags}g`;
    working = working.replace(new RegExp(c.re.source, flags), ' ');
  }

  const textLower = working.toLowerCase();
  const tokens = tokenize(working);
  const splitTokens = tokenizeKeepingSentenceBreaks(working);
  for (const full of findSplitSeparables(splitTokens)) {
    const s = scoreLemma(full, b1Set) + 3;
    scored.set(full, Math.max(scored.get(full) || 0, s));
    // Prefer full separable over bare root
    const root = SEPARABLE_PREFIXES.reduce((acc, p) => {
      if (full.startsWith(p) && full.length > p.length) return full.slice(p.length);
      return acc;
    }, '');
    if (root) suppress.add(root);
  }

  for (const tok of tokens) {
    const lemma = lemmaOf(tok, b1Set, nounHints);
    if (!lemma) continue;
    if (suppress.has(lemma)) continue;
    if (!lemmaAttestedInText(lemma, textLower, tok) && !SEPARABLE_INFINITIVES.has(lemma)) continue;
    const s = scoreLemma(lemma, b1Set);
    if (s < 0) continue;
    const prev = scored.get(lemma) || 0;
    if (s > prev) scored.set(lemma, s);
  }

  // Solid separables (mitmachen) also suppress bare root (machen)
  suppressRootsOfSeparables(scored, suppress);
  for (const s of suppress) scored.delete(s);

  // Dedup: if both ausschalten and auszuschalten somehow present, keep base
  for (const key of [...scored.keys()]) {
    if (isZuSeparableInfinitive(key)) {
      const base = normalizeZuSeparable(key);
      scored.delete(key);
      if (!scored.has(base)) scored.set(base, 3);
    }
  }

  const ranked = [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => w)
    .filter((w) => w.length >= 4 || ['essen', 'lesen'].includes(w));

  // Demote light verbs: fill leftover slots only after more specific candidates
  const nonLight = ranked.filter((w) => !LIGHT_VERBS.has(w));
  const light = ranked.filter((w) => LIGHT_VERBS.has(w));

  const out = [];
  for (const tag of collocTags) {
    if (out.length >= max) break;
    if (!out.includes(tag)) out.push(tag);
  }
  for (const w of nonLight) {
    if (out.length >= max) break;
    if (suppress.has(w)) continue;
    const formatted = formatVocabTag(w, nounHints);
    if (!out.some((t) => t.toLowerCase() === formatted.toLowerCase())) out.push(formatted);
  }
  if (out.length < max) {
    for (const w of light) {
      if (out.length >= max) break;
      if (suppress.has(w)) continue;
      const formatted = formatVocabTag(w, nounHints);
      if (!out.some((t) => t.toLowerCase() === formatted.toLowerCase())) out.push(formatted);
    }
  }
  return out.slice(0, max);
}

/** Repair tags that are known corrupt lemma outputs (förderen→fördern, schlechen→schlecht). */
function repairCorruptVocabTagSurface(tag) {
  const low = String(tag || '').toLowerCase();
  if (LEMMA_GROUND_TRUTH[low]) return LEMMA_GROUND_TRUTH[low];
  if (low === 'schlechen') return 'schlecht';
  if (low === 'leut') return 'Leute';
  if (low === 'täglicht' || low === 'täglichen') return 'täglich';
  if (low === 'beruflicht' || low === 'beruflichen') return 'beruflich';
  if (low === 'alltäglicht' || low === 'alltäglichen') return 'alltäglich';
  if (low === 'technischen') return 'technisch';
  if (low === 'langen') return 'lang';
  if (low.endsWith('ieren') && looksLikeInfinitive(low)) return low;
  // Adjective inflection in tags (täglichen→täglich) — before bogus -chen strip (→täglicht)
  if (low.endsWith('lichen') && low.length >= 7) {
    const base = low.slice(0, -2);
    if (looksLikeUninflectedAdjective(base) || looksLikeUninflectedAdjective(`${base}t`)) return base;
  }
  if (/eren$/.test(low) && low.length >= 6 && !low.endsWith('ieren')) {
    const cand = `${low.slice(0, -2)}n`;
    if (looksLikeInfinitive(cand)) return cand;
  }
  if (/chen$/.test(low) && !/lichen$/.test(low) && low.length >= 6) {
    const cand = `${low.slice(0, -2)}t`;
    if (looksLikeUninflectedAdjective(cand)) return cand;
    const cand2 = `${low.slice(0, -4)}t`;
    if (looksLikeUninflectedAdjective(cand2)) return cand2;
  }
  return null;
}

/** Re-canonicalize existing vocabularyTags — ground truth + corrupt-surface repair only. */
function repairQuestionVocabularyTags(q, b1Set, nounHints) {
  if (!Array.isArray(q.vocabularyTags) || !q.vocabularyTags.length) return false;
  const next = [];
  let changed = false;
  for (const tag of q.vocabularyTags) {
    const low = String(tag || '').toLowerCase();
    const repaired =
      repairCorruptVocabTagSurface(tag) ||
      (LEMMA_GROUND_TRUTH[low] ? LEMMA_GROUND_TRUTH[low] : null);
    const reLemma = lemmaOf(low, b1Set, nounHints);
    let out = repaired || reLemma;
    if (!out) {
      const pluralSing = resolvePluralNounLemma(low);
      if (pluralSing && STOP.has(pluralSing)) {
        changed = true;
        continue;
      }
      out = tag;
    }
    if (!out || STOP.has(String(out).toLowerCase())) {
      changed = true;
      continue;
    }
    const formatted = formatVocabTag(out, nounHints);
    if (!formatted || STOP.has(formatted.toLowerCase())) {
      changed = true;
      continue;
    }
    if (formatted !== String(tag || '').trim()) changed = true;
    if (!next.some((t) => t.toLowerCase() === formatted.toLowerCase())) next.push(formatted);
  }
  if (!next.length) return false;
  if (!changed && next.length === q.vocabularyTags.length) {
    const same = next.every((t, i) => t.toLowerCase() === String(q.vocabularyTags[i]).toLowerCase());
    if (same) return false;
  }
  q.vocabularyTags = next.slice(0, 6);
  return true;
}

/**
 * Count regex matches (always global).
 */
function countRe(re, text) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return [...String(text || '').matchAll(new RegExp(re.source, flags))].length;
}

/**
 * Per-category hit counts (same detectors as before, but counted — not binary).
 */
export function countGrammarSignals(text) {
  const t = String(text || '');
  const counts = Object.fromEntries(B1_GRAMMAR_IDS.map((id) => [id, 0]));

  // 1) Nebensatz — subordinating conjunctions
  counts['g-de-b1-nebensatz'] = countRe(
    /\b(weil|dass|obwohl|damit|während|sobald|bevor|nachdem|falls)\b/gi,
    t,
  );

  // 2) Relativ — relative pronoun + finite-ish verb nearby (count pronoun hits in clause-like pattern)
  counts['g-de-b1-relativ'] = countRe(
    /\b(der|die|das|den|dem|dessen|deren)\s+\w{2,}\s+\w*(?:t|en|te|ten)\b/gi,
    t,
  );

  // 3) Passiv — werden/wurde + participle; prefer agent (von/durch) or past wurde/wurden
  {
    let n = 0;
    for (const m of t.matchAll(/\b(wird|werden|wurde|wurden)\b([\s\S]{0,45})/gi)) {
      const tail = m[2] || '';
      if (!/\b\w+(?:iert|t|en)\b/i.test(tail)) continue;
      if (/\bwerden\s+wir\b/i.test(m[0] + tail.slice(0, 12))) continue;
      const window = `${m[0]}${tail}`;
      if (/\b(von|durch)\b/i.test(window) || /^(wurde|wurden)$/i.test(m[1])) n += 1;
      else if (/\b(?:ge)\w+(?:t|en)\b|\b\w+iert\b/i.test(tail)) n += 1; // ge- participle / -iert
    }
    counts['g-de-b1-passiv'] = n;
  }

  // 4) Konjunktiv II
  counts['g-de-b1-konjunktiv'] = countRe(
    /\b(hätte|hätten|hättest|hättet|würde|würden|würdest|würdet|könnte|könnten|müsste|müssten|sollte|sollten)\b/gi,
    t,
  );

  // 5) Modalverben — ONLY modal + infinitive (non-trivial). Bare «kann/muss» never counts.
  // Non-greedy window so each modal pairs with its nearest infinitive (not one span across two modals).
  counts['g-de-b1-modalverben'] = countRe(
    /\b(muss|müssen|musst|musste|mussten|kann|können|kannst|soll|sollen|sollst|darf|dürfen|will|wollen|möchte|möchten)\b[\s\S]{0,40}?\b[a-zäöüß]+(?:en|eln|ern)\b/gi,
    t,
  );

  // 6) Perfekt — haben/sein + clear past participle (ge-… / -iert). Avoid «ist gut» noise.
  {
    const withHaben = countRe(
      /\b(habe|hast|hat|haben|habt|hatte|hatten)\b[\s\S]{0,40}?\b(?:ge[a-zäöüß]+(?:t|en)|[a-zäöüß]+iert)\b/gi,
      t,
    );
    const withSein = countRe(
      /\b(bin|bist|ist|sind|war|waren)\b[\s\S]{0,40}?\bge[a-zäöüß]+(?:t|en)\b/gi,
      t,
    );
    counts['g-de-b1-perfekt'] = withHaben + withSein;
  }

  // 7) Futur — werden + infinitive, only if passiv not already dominant signal
  const futurHits = countRe(/\b(werde|wirst|wird|werden)\b[\s\S]{0,25}\b\w+en\b/gi, t);
  counts['g-de-b1-futur'] = counts['g-de-b1-passiv'] > 0 ? 0 : futurHits;

  // 8) Komparativ / superlative
  counts['g-de-b1-komparativ'] = countRe(
    /\b(besser|größer|kleiner|mehr|weniger|am\s+\w+sten|\w+er\s+als)\b/gi,
    t,
  );

  // 9) Genitiv
  counts['g-de-b1-genitiv'] =
    countRe(/\b(des|der)\s+[A-ZÄÖÜ][a-zäöüß]+(?:s|es)\b/g, t) +
    countRe(/\bwegen\s+des\b/gi, t);

  // 10) Dativ — prep + dative article
  counts['g-de-b1-dativ'] = countRe(/\b(mit|bei|von|zu|nach|aus)\s+(dem|der|den)\b/gi, t);

  // 11) Adjektivdeklination — article + inflected adj + capitalized noun
  counts['g-de-b1-adjektivdeklination'] = countRe(
    /\b(ein|eine|einen|einem|einer|der|die|das|den|dem)\s+\w+(?:e|en|em|er|es)\s+[A-ZÄÖÜ]/gu,
    t,
  );

  return counts;
}

/**
 * B2 grammar detectors (Goethe B2 Modellsatz — más allá de B1).
 * IDs: konj1 (würde/könnte), konj2 (hätte/wäre), nominal, passiv+Modal, modus, Relativ+Präp.
 */
export function countGrammarSignalsB2(text) {
  const t = String(text || '');
  const counts = Object.fromEntries(B2_GRAMMAR_IDS.map((id) => [id, 0]));

  counts['g-de-b2-konj1'] = countRe(
    /\b(würde|würden|würdest|würdet|könnte|könnten|könntest|sollte|sollten|müsste|müssten|dürfte|dürften)\b/gi,
    t,
  );

  counts['g-de-b2-konj2'] = countRe(
    /\b(hätte|hätten|hättest|hättet|wäre|wären|wärest|ginge|gingen|käme|kämen|ließe|ließen|wüsste|wüssten)\b/gi,
    t,
  );

  counts['g-de-b2-nominal'] =
    countRe(/\b\w+(ung|heit|keit|schaft|tion|ismus|ment|ität|taet)\b/gi, t) +
    countRe(/\b(die|das|der)\s+[A-ZÄÖÜ][a-zäöüß]+(?:ung|heit|keit)\b/g, t);

  {
    let n = 0;
    for (const m of t.matchAll(/\b(wird|werden|wurde|wurden|worden)\b([\s\S]{0,50})/gi)) {
      const tail = m[2] || '';
      if (/\b\w+(?:iert|t|en)\b/i.test(tail)) n += 1;
    }
    n += countRe(
      /\b(muss|müssen|kann|können|soll|sollen|darf|dürfen|wird)\s+\w+\s+(?:werden|worden)\b/gi,
      t,
    );
    counts['g-de-b2-passiv'] = n;
  }

  counts['g-de-b2-modus'] = countRe(
    /\b(muss|müssen|musst|musste|mussten|kann|können|kannst|soll|sollen|sollst|darf|dürfen|will|wollen|möchte|möchten)\b[\s\S]{0,45}?\b[a-zäöüß]+(?:en|eln|ern)\b/gi,
    t,
  );

  counts['g-de-b2-relativ'] =
    countRe(/\b(worauf|womit|wovon|wofür|worüber|wobei|wodurch)\b/gi, t) +
    countRe(/\b(dessen|deren|denen)\s+\w+/gi, t) +
    countRe(/\b(mit|an|in|von|zu|bei|nach|über|unter)\s+(?:dem|der|den)\s*,?\s*(?:der|die|das|den|dem)\b/gi, t);

  return counts;
}

/** A2 grammar detectors — mapped from A2 compact taxonomy (GEMINI_API_COMPACT_de_A2.md). */
export function countGrammarSignalsA2(text) {
  const t = String(text || '');
  const b1 = countGrammarSignals(text);
  const counts = Object.fromEntries(A2_GRAMMAR_IDS.map((id) => [id, 0]));

  counts['g-de-a2-nebensatz'] =
    countRe(/\b(dass|weil|wenn|ob)\b/gi, t) + Math.min(b1['g-de-b1-nebensatz'] || 0, 4);
  counts['g-de-a2-modal'] = b1['g-de-b1-modalverben'] || 0;
  counts['g-de-a2-perfekt'] = b1['g-de-b1-perfekt'] || 0;
  counts['g-de-a2-komparativ'] = b1['g-de-b1-komparativ'] || 0;
  counts['g-de-a2-dat-akk'] =
    (b1['g-de-b1-dativ'] || 0) +
    countRe(/\b(den|die|das|einen|eine|ein|dem|der)\s+[A-ZÄÖÜ]/g, t);

  let trenn = 0;
  for (const p of SEPARABLE_PREFIXES) {
    const escP = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    trenn += countRe(new RegExp(`\\b${escP}\\w+(?:t|en|st|e)\\b`, 'gi'), t);
    trenn += countRe(new RegExp(`\\b\\w+\\s+${escP}\\w+(?:t|en)?\\b`, 'gi'), t);
  }
  counts['g-de-a2-trennbar'] = Math.min(trenn, 6);

  const praesensHits = countRe(
    /\b(ich|du|er|sie|es|wir|ihr|man|Sie)\s+\w+(?:e|st|t)\b/gi,
    t,
  );
  counts['g-de-a2-praesens'] =
    counts['g-de-a2-perfekt'] > 0 ? Math.max(0, praesensHits - 1) : praesensHits;

  return counts;
}

/** @param {string} text @param {string} [level] */
export function countGrammarSignalsForLevel(text, level = 'B1') {
  const lv = String(level || 'B1').trim().toUpperCase();
  if (lv === 'B2') return countGrammarSignalsB2(text);
  if (lv === 'A2') return countGrammarSignalsA2(text);
  return countGrammarSignals(text);
}

/**
 * Item-specific grammar blob (PRIMARY): question + explanation + correct option.
 * Does NOT include the shared passage.
 */
export function questionSpecificGrammarBlob(q) {
  const parts = [q?.question, q?.explanation, q?.statement, q?.signText, q?.transcript];
  const matched = matchingOptionText(q);
  if (matched) parts.push(matched);
  return parts.filter(Boolean).join(' ');
}

/** Passage-only blob (SECONDARY reinforcement). */
export function passageGrammarBlob(passage) {
  return [passage?.title, passage?.text].filter(Boolean).join(' ');
}

/**
 * Infer grammar tags with GRAMMAR-FOCUS + flexible cupo.
 *
 * @param {string} primaryText — item blob (question/explanation/correct)
 * @param {number} [teil=1]
 * @param {{ secondaryText?: string }} [opts] — passage reinforcement only
 * @returns {string[]} 0…GRAMMAR_TAG_SOFT_MAX tags (empty allowed)
 */
export function inferGrammarTagsFromText(primaryText, teil = 1, opts = {}) {
  const level = String(opts.level || 'B1').trim().toUpperCase();
  const ids = grammarIdsForLevel(level);
  const primaryCounts = countGrammarSignalsForLevel(primaryText, level);
  const secondaryText = opts.secondaryText || opts.passageText || '';
  const secondaryCounts = secondaryText ? countGrammarSignalsForLevel(secondaryText, level) : null;

  const eligible = [];
  for (const id of ids) {
    const p = primaryCounts[id] || 0;
    const min = grammarMinCountForLevel(id, level, { ...opts, level });
    if (p < min) continue;
    const s = secondaryCounts ? secondaryCounts[id] || 0 : 0;
    eligible.push({
      id,
      count: p,
      reinforced: s > 0,
      priority: grammarPriority(id, level),
    });
  }

  eligible.sort(
    (a, b) =>
      b.priority - a.priority ||
      Number(b.reinforced) - Number(a.reinforced) ||
      b.count - a.count ||
      a.id.localeCompare(b.id),
  );

  // Flexible cupo: keep all that qualify, soft-cap only
  const out = eligible.slice(0, GRAMMAR_TAG_SOFT_MAX).map((c) => c.id);

  // No DEFAULT_GRAMMAR_BY_TEIL fill — empty is valid when the item has no relevant grammar
  void teil;
  return out;
}

/**
 * Retrieval gate safety net: Hören A2 T2 matching batches where every explanation
 * is a bare factual sentence (no dass/muss/…). Assigns passage-derived tags to
 * Q1 only — never blind-clones to all 5 (Cause E gap, batch 083).
 */
export function ensureBatchGrammarRetrievalMinimum(batch) {
  const qs = batch.questions || [];
  if (!qs.length) return batch;
  if (qs.some((q) => (q.grammarTags || []).length > 0)) return batch;
  const level = String(batch.level || qs[0]?.level || 'B1').toUpperCase();
  if (level !== 'A2') return batch;
  if (!qs.every((q) => isA2MatchingQuestion(q, level))) return batch;

  const passage = batch.passages?.[0];
  const passageTags = inferGrammarTagsFromText(passageGrammarBlob(passage), 2, {
    a2Matching: true,
    level: 'A2',
  });
  if (passageTags.length) {
    qs[0].grammarTags = passageTags.slice(0, GRAMMAR_TAG_SOFT_MAX);
    batch._grammarRetrievalFallback = 'a2-t2-passage-q1';
  }
  return batch;
}

function questionBlob(q, passage) {
  // Legacy blob (grammar / topic) — may include shared passage
  return [
    q.question,
    q.explanation,
    q.signText,
    q.transcript,
    q.statement,
    passage?.text,
    passage?.title,
    ...(q.options || []),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Resolve correct MCQ/matching option text for letter key (a–j), or null. */
export function matchingOptionText(q, passage = null) {
  const letter = String(q.correctAnswer ?? q.correct ?? '')
    .trim()
    .toLowerCase();
  if (!letter || letter === '0' || letter === 'x' || letter === '-' || letter === 'none') {
    return null;
  }
  const opts = q.options || [];
  const re = new RegExp(`^${letter}[).:\\s]`, 'i');
  const hit = opts.find((o) => re.test(String(o).trim()));
  if (hit) return String(hit);
  const pics = passage?.pictures || [];
  const pic = pics.find((p) => String(p.key || '').toLowerCase() === letter);
  if (pic?.label) return String(pic.label);
  return null;
}

/**
 * Text used for vocabularyTags — content fields only (R7).
 * MCQ: question stem + correct option + explanation (never full passage or distractors).
 * Matching/picture bank: question + explanation + matched picture label (never shared dialogue).
 */
export function questionSpecificVocabBlob(q, passage, opts = {}) {
  const type = String(q.type || '').toLowerCase();
  const optsArr = q.options || [];
  const isMatching =
    type === 'matching' ||
    (optsArr.length === 0 && /^[a-i]$/i.test(String(q.correctAnswer ?? q.correct ?? '').trim()));

  const parts = [q.question, q.signText, q.transcript, q.statement];
  if (isMatching) parts.push(q.explanation);

  const matched = matchingOptionText(q, passage);
  if (matched) parts.push(matched);

  // Never push full passage — shared dialogue/passage caused cross-question tag recycling (A2 audit D).
  let blob = parts.filter(Boolean).join(' ');
  if (opts.includePassageTitle && passage?.title) {
    blob = `${passage.title} ${blob}`.trim();
  }
  return blob;
}

function tagAppearsInVocabBlob(tag, blob) {
  const t = String(tag).toLowerCase();
  const b = String(blob).toLowerCase();
  if (b.includes(t)) return true;
  if (t.length >= 5 && b.split(/\s+/).some((w) => w.startsWith(t.slice(0, 5)))) return true;
  return false;
}

/** Keep vocabularyTags ⊆ content extractable from questionSpecificVocabBlob (audit A2-D). */
export function sanitizeVocabularyTagsToBlob(q, passage) {
  const blob = questionSpecificVocabBlob(q, passage);
  let tags = (q.vocabularyTags || []).filter((t) => tagAppearsInVocabBlob(t, blob));
  if (tags.length < 1) {
    tags = extractVocabularyFromText(blob, 6);
  }
  if (tags.length < 1 && q.explanation) {
    tags = extractVocabularyFromText(String(q.explanation), 4);
  }
  const uniq = [];
  for (const t of tags) {
    const s = String(t).trim();
    if (!s) continue;
    if (uniq.some((u) => u.toLowerCase() === s.toLowerCase())) continue;
    uniq.push(s);
  }
  q.vocabularyTags = uniq.slice(0, 6);
  if (!q.vocabularyTags.length) q.vocabularyTags = ['Alltag'];
}

function vocabSignature(tags) {
  return [...(tags || [])]
    .map((t) => String(t).toLowerCase())
    .sort()
    .join('\0');
}

/**
 * Ensure no two questions in the same batch share an identical vocabularyTags set.
 * Re-picks from a larger candidate pool biased to question/options content (no explanation).
 */
export function ensureDistinctQuestionVocabTags(questions, getLocalBlob) {
  const qs = questions || [];
  const sigToFirst = new Map();

  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    let tags = [...(q.vocabularyTags || [])];
    let sig = vocabSignature(tags);
    if (!sig) continue;

    if (!sigToFirst.has(sig)) {
      sigToFirst.set(sig, i);
      continue;
    }

    // Collision — rebuild from local blob with more candidates, prefer unused lemmas
    const local = getLocalBlob(q);
    const pool = extractVocabularyFromText(local, 16);
    const firstTags = qs[sigToFirst.get(sig)].vocabularyTags || [];
    const firstSet = new Set(firstTags.map((t) => String(t).toLowerCase()));

    const preferred = pool.filter((t) => !firstSet.has(String(t).toLowerCase()));
    const rest = pool.filter((t) => firstSet.has(String(t).toLowerCase()));
    let next = [...preferred, ...rest]
      .filter((t, idx, arr) => arr.findIndex((x) => String(x).toLowerCase() === String(t).toLowerCase()) === idx)
      .slice(0, Math.max(4, tags.length || 4));

    // Last resort: pull distinctive content words from the question surface
    if (vocabSignature(next) === sig) {
      const surface = String(q.question || '')
        .split(/[^a-zA-ZäöüÄÖÜß\-]+/)
        .filter((w) => w.length >= 5);
      for (const tok of surface) {
        const low = tok.toLowerCase();
        if (next.some((t) => String(t).toLowerCase() === low)) continue;
        const form = /^[A-ZÄÖÜ]/.test(tok) ? tok : tok;
        next = [...next.slice(0, 5), form];
        if (vocabSignature(next) !== sig) break;
      }
    }

    q.vocabularyTags = next.slice(0, 6);
    sig = vocabSignature(q.vocabularyTags);
    let guard = 0;
    while (
      [...sigToFirst.entries()].some(([s, idx]) => s === sig && idx !== i) &&
      guard < 8
    ) {
      const extra = String(q.question || '')
        .split(/[^a-zA-ZäöüÄÖÜß\-]+/)
        .filter((w) => w.length >= 4)[guard];
      if (extra) {
        q.vocabularyTags = [...(q.vocabularyTags || []).slice(0, 5), extra];
      } else {
        // Extremely rare: differentiate with option / signText token (never explanation)
        const surface = [q.signText, matchingOptionText(q)]
          .filter(Boolean)
          .filter(Boolean)
          .join(' ')
          .split(/[^a-zA-ZäöüÄÖÜß\-]+/)
          .filter((w) => w.length >= 5)[guard];
        if (surface) q.vocabularyTags = [...(q.vocabularyTags || []).slice(0, 5), surface];
      }
      sig = vocabSignature(q.vocabularyTags);
      guard++;
    }
    sigToFirst.set(sig, i);
  }
  return qs;
}

function collectBatchText(batch) {
  const chunks = [];
  for (const p of batch.passages || []) {
    if (p.title) chunks.push(p.title);
    if (p.text) chunks.push(p.text);
    if (p.transcript) chunks.push(p.transcript);
  }
  for (const q of batch.questions || []) {
    if (q.question) chunks.push(q.question);
    if (q.signText) chunks.push(q.signText);
    if (q.explanation) chunks.push(q.explanation);
    for (const opt of q.options || []) chunks.push(String(opt));
  }
  return chunks.join('\n');
}

/** Content-only batch text for vocab fallbacks (R7: never explanation). */
function collectBatchContentText(batch) {
  const chunks = [];
  for (const p of batch.passages || []) {
    if (p.title) chunks.push(p.title);
    if (p.text) chunks.push(p.text);
    if (p.transcript) chunks.push(p.transcript);
  }
  for (const q of batch.questions || []) {
    if (q.question) chunks.push(q.question);
    if (q.signText) chunks.push(q.signText);
    if (q.transcript) chunks.push(q.transcript);
    if (q.statement) chunks.push(q.statement);
    const matched = matchingOptionText(q);
    if (matched) chunks.push(matched);
  }
  return chunks.join('\n');
}

function needsTopicBackfill(batch) {
  const tags = [];
  if (batch.topicTag) tags.push(String(batch.topicTag));
  if (batch._requestedTopic) tags.push(String(batch._requestedTopic));
  for (const p of batch.passages || []) {
    if (p.topicTag) tags.push(String(p.topicTag));
  }
  for (const q of batch.questions || []) {
    for (const t of q.topicTags || []) tags.push(String(t));
  }
  if (!tags.length) return true;
  const hasLegacy = tags.some(
    (t) => LEGACY_TOPIC_SLUGS.has(String(t).toLowerCase()) || String(t).toLowerCase() === 'daily_life',
  );
  // Mixed canonical + daily_life still needs a forced unify via tagBatchWithTopic
  if (hasLegacy) return true;
  const root = normalizeB1Topic(batch.topicTag || batch._requestedTopic);
  if (!root || !isValidB1Topic(root)) return true;
  return false;
}

/**
 * @returns {{ batch, stats: { topic: boolean, vocab: number, grammar: number } }}
 */
export function enrichBatchMetadata(batch, opts = {}) {
  const stats = { topic: false, vocab: 0, grammar: 0 };
  let current = { ...batch, questions: (batch.questions || []).map((q) => ({ ...q })) };
  if (current.passages) current.passages = current.passages.map((p) => ({ ...p }));

  // Topic — unify root + questions (wipes mixed daily_life)
  if (opts.topic !== false && needsTopicBackfill(current)) {
    const text = collectBatchText(current);
    // Prefer existing canonical root if present and no legacy mix on root only
    const existingRoot = normalizeB1Topic(current.topicTag || current._requestedTopic);
    const topic =
      (existingRoot && isValidB1Topic(existingRoot) && !LEGACY_TOPIC_SLUGS.has(String(current.topicTag || '').toLowerCase())
        ? existingRoot
        : null) ||
      detectTopic(text) ||
      opts.fallbackTopic ||
      'Freizeit';
    current = tagBatchWithTopic(current, topic);
    current._topicTagInferred = true;
    current._topicTagInferredAt = new Date().toISOString();
    stats.topic = true;
  }

  const passagesById = new Map((current.passages || []).map((p) => [p.id, p]));
  const b1Set = loadB1LemmaSet();

  function nounHintsForQuestion(q) {
    const passage = passagesById.get(q.passageId);
    return collectCapitalizedHints(questionSpecificVocabBlob(q, passage));
  }

  /** Pool artifact repair: fix tags in place — no re-extract / ensureDistinct (avoids new lemma stubs). */
  if (opts.vocabRepairOnly) {
    for (const q of current.questions || []) {
      if (opts.vocab !== false && Array.isArray(q.vocabularyTags) && q.vocabularyTags.length) {
        if (repairQuestionVocabularyTags(q, b1Set, nounHintsForQuestion(q))) stats.vocab++;
      }
    }
    current._metadataEnrichedAt = new Date().toISOString();
    current._metadataEnrichNote = 'vocabRepairOnly: repairQuestionVocabularyTags (pool artifact repair)';
    current._vocabTagsNormalizeVersion = VOCAB_TAGS_NORMALIZE_VERSION;
    return { batch: current, stats };
  }

  for (const q of current.questions || []) {
    if (opts.vocab !== false && Array.isArray(q.vocabularyTags) && q.vocabularyTags.length) {
      if (repairQuestionVocabularyTags(q, b1Set, nounHintsForQuestion(q))) stats.vocab++;
    }
  }

  for (const q of current.questions || []) {
    const passage = passagesById.get(q.passageId);
    const vocabBlob = questionSpecificVocabBlob(q, passage);
    const teil = Number(q.teil ?? current.teil ?? 1);

    if (
      opts.vocab !== false &&
      (opts.forceVocab || !(Array.isArray(q.vocabularyTags) && q.vocabularyTags.length >= 3))
    ) {
      let words = extractVocabularyFromText(vocabBlob, 6);
      if (words.length < 3) {
        const matched = matchingOptionText(q, passage);
        words = extractVocabularyFromText(
          [q.question, q.signText, q.transcript, q.statement, passage?.title, matched]
            .filter(Boolean)
            .join(' '),
          6,
        );
      }
      if (words.length >= 1) {
        q.vocabularyTags = words.slice(0, 6);
        stats.vocab++;
      }
    }

    const batchLevel = String(q.level || current.level || passage?.level || 'B1').toUpperCase();
    const rawGrammar = Array.isArray(q.grammarTags) ? q.grammarTags : [];
    const existingGrammar = sanitizeGrammarTags(rawGrammar, batchLevel);
    const strippedInvalidGrammar =
      rawGrammar.length > 0 && existingGrammar.length < rawGrammar.length;
    const a2Matching = isA2MatchingQuestion(q, batchLevel);
    const grammarInferOpts = {
      secondaryText: passageGrammarBlob(passage),
      a2Matching,
      level: batchLevel,
    };
    if (
      opts.grammar !== false &&
      (opts.forceGrammar || !existingGrammar.length || strippedInvalidGrammar)
    ) {
      const primary = questionSpecificGrammarBlob(q);
      q.grammarTags = inferGrammarTagsFromText(primary, teil, grammarInferOpts);
      stats.grammar++;
    } else if (existingGrammar.length) {
      q.grammarTags = existingGrammar;
    } else if ((q.grammarTags || []).length) {
      // topicTag leaked into grammarTags (e.g. «Arbeit») — strip and re-infer
      const primary = questionSpecificGrammarBlob(q);
      q.grammarTags = inferGrammarTagsFromText(primary, teil, grammarInferOpts);
      stats.grammar++;
    }
  }

  // Per-file uniqueness: never leave two questions with identical vocabularyTags
  if (opts.vocab !== false) {
    ensureDistinctQuestionVocabTags(current.questions || [], (q) =>
      questionSpecificVocabBlob(q, passagesById.get(q.passageId)),
    );
  }

  // Ensure every question has at least one tag after pass (fallback)
  for (const q of current.questions || []) {
    if (!(q.vocabularyTags || []).length) {
      const words = extractVocabularyFromText(
        [q.question, q.signText, q.transcript, q.statement].filter(Boolean).join(' ') ||
          collectBatchContentText(current),
        4,
      );
      q.vocabularyTags = words.length ? words : ['Alltag', 'Mensch', 'Zeit'];
      stats.vocab++;
    }
    // grammarTags: empty is allowed under GRAMMAR-FOCUS (no relevant structure in the item).
    // Optional legacy fill only when explicitly requested.
    if (!(q.grammarTags || []).length && opts.fillGrammarDefaults) {
      const teil = Number(q.teil ?? current.teil ?? 1);
      const lv = String(q.level || current.level || 'B1').trim().toUpperCase();
      q.grammarTags = defaultGrammarTagsForTeil(teil, lv);
      stats.grammar++;
    } else if (!Array.isArray(q.grammarTags)) {
      q.grammarTags = [];
    }
  }

  // Re-run distinctness after fallbacks
  if (opts.vocab !== false) {
    ensureDistinctQuestionVocabTags(current.questions || [], (q) =>
      questionSpecificVocabBlob(q, passagesById.get(q.passageId)),
    );
    for (const q of current.questions || []) {
      sanitizeVocabularyTagsToBlob(q, passagesById.get(q.passageId));
    }
  }

  // Hören A2 T2: requested topic may not match week-plan content (Sport/Freizeit mix) — prefer detected topic
  const mod = String(
    current.module || current.questions?.[0]?.module || current.passages?.[0]?.module || '',
  ).toLowerCase();
  const teilN = Number(current.teil ?? current.questions?.[0]?.teil ?? current.passages?.[0]?.teil);
  if (mod === 'horen' && teilN === 2 && current.passages?.[0]) {
    const p = current.passages[0];
    const ct = checkPassageContentTopic({ ...p, topicTag: current.topicTag || p.topicTag });
    if (ct.mismatch && ct.detected) {
      const detected = normalizeB1Topic(ct.detected);
      if (detected && isValidB1Topic(detected)) {
        current = tagBatchWithTopic(current, detected);
        current._requestedTopic = detected;
        stats.topic = true;
      }
    }
  }

  if (mod === 'horen' && teilN === 2) {
    ensureBatchGrammarRetrievalMinimum(current);
  }

  current = alignQuestionTopicTagsToRequestedTopic(current);

  current._metadataEnrichedAt = new Date().toISOString();
  current._metadataEnrichNote =
    'deterministic: detectTopic + per-question lemma vocab + grammar heuristics';
  if (opts.forceVocab || opts.vocab !== false) {
    current._vocabTagsNormalizeVersion = VOCAB_TAGS_NORMALIZE_VERSION;
  }
  if (opts.forceGrammar || opts.grammar !== false) {
    current._grammarTagsNormalizeVersion = GRAMMAR_TAGS_NORMALIZE_VERSION;
  }
  return { batch: current, stats };
}

export { needsTopicBackfill };
