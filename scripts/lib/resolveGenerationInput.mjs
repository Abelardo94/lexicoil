import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './loadEnv.mjs';
import { isValidB1Topic, normalizeB1Topic, B1_TOPICS } from './b1Topics.mjs';
import { topicsForLevel, normalizeTopicForLevel } from './levelPlanner.mjs';
import { classifyUserVocab } from './vocabPrefilter.mjs';
import { pickTargetWords } from './lesenTemplatePrompt.mjs';
import { pickNextTopic } from './topicRotation.mjs';
import { filterPromptTargetWords, isBlacklistedLemma } from './lexicalCheck.mjs';
import { loadVocabBankLemmaSet, foldLemma } from './vocabBank.mjs';
import { pickTopicAlignedWeakWords, vocabPickContext } from './coverageRegistry.mjs';

const GENERATED_DIR = path.join(ROOT, 'batches', 'generated');

/** Léxico B1 seguro — derivado de plantillas lesen-teil*.md y TOPIC_KEYWORDS. */
const TEMPLATE_SAFE_B1_WORDS = Object.freeze([
  'stadt', 'transport', 'auto', 'nachhaltigkeit', 'kinder', 'besucher', 'organisation',
  'nachbar', 'familie', 'erfahrung', 'meinung', 'problem', 'vorteil', 'plan', 'regel',
  'bewohner', 'termin', 'kurs', 'projekt', 'freizeit', 'bericht', 'arbeit', 'firma',
  'kollege', 'programm', 'anmeldung', 'gebühr', 'ruhe', 'raum', 'parkplatz', 'müll',
  'reparieren', 'hausbesuch', 'wohnung', 'schule', 'unterricht', 'urlaub', 'reise',
  'gesundheit', 'sport', 'hobby', 'wochenende', 'freund', 'bus', 'bahn', 'fahrrad',
]);

const require = createRequire(import.meta.url);
const { TOPIC_KEYWORDS } = require(path.join(ROOT, 'js/engine/partTopicDetect.js'));

function safePoolForTopic(topicTag, lang = 'de', level = 'B1') {
  const bank = loadVocabBankLemmaSet(lang, level);
  const topic = normalizeB1Topic(topicTag);
  const topicWords = (topic && TOPIC_KEYWORDS[topic] ? TOPIC_KEYWORDS[topic] : []).map((w) =>
    foldLemma(w),
  );
  const merged = [...new Set([...topicWords, ...TEMPLATE_SAFE_B1_WORDS.map(foldLemma)])];
  return merged.filter((w) => bank.has(w) && !isBlacklistedLemma(w) && w.length >= 4);
}

/**
 * Filtra por whitelist banco B1 (+ blacklist C1/C2) y rellena desde pool seguro si quedan <goal.
 * @param {string[]} words
 * @param {string|null} topicTag
 * @param {number} [targetCount]
 * @param {{ lang?: string, level?: string }} [opts]
 */
export function sanitizePromptTargetWords(words, topicTag, targetCount = 8, opts = {}) {
  const lang = opts.lang || 'de';
  const level = opts.level || 'B1';
  const context = opts.context === 'narrative' ? 'narrative' : 'debate';
  const goal = Math.max(3, Number(targetCount) || 8);
  let filtered = filterPromptTargetWords(words, { lang, level, requireBank: true });
  if (filtered.length >= goal) return filtered.slice(0, goal);

  const pool =
    context === 'narrative'
      ? pickTopicAlignedWeakWords({
          lang,
          level,
          topic: topicTag,
          count: Math.max(goal, 12),
          cursor: opts.coverageCursor ?? 0,
          context: 'narrative',
        }).words
      : safePoolForTopic(topicTag, lang, level);
  const used = new Set(filtered.map((w) => w.toLowerCase()));
  const candidates = pool.filter((w) => !used.has(w.toLowerCase()));

  while (filtered.length < goal && candidates.length) {
    const i = Math.floor(Math.random() * candidates.length);
    const pick = candidates.splice(i, 1)[0];
    filtered.push(pick);
    used.add(pick.toLowerCase());
  }

  if (filtered.length < 3) {
    throw new Error(
      `Tras filtro whitelist banco ${level} (+ blacklist) quedan ${filtered.length} palabras objetivo (<3). ` +
        `Revisa library/vocab/${lang}/${level}.json o el topicTag «${normalizeB1Topic(topicTag) || '—'}».`,
    );
  }
  return filtered;
}

/**
 * Resolve closed B1 topic: explicit --topic or rotation fallback.
 */
export function resolveGenerationTopic(args, { module = 'lesen', teil = 1 } = {}) {
  const level = String(args.level || 'B1').toUpperCase();
  if (args.topic) {
    const lang = String(args.lang || 'de').toLowerCase();
    const t = normalizeTopicForLevel(level, args.topic, lang);
    const allowed = topicsForLevel(level, { scope: 'gap', lang });
    if (!t || !allowed.includes(t)) {
      throw new Error(
        `Tema inválido para ${level}: "${args.topic}". Usa uno de: ${allowed.join(', ')}`,
      );
    }
    return t;
  }
  return pickNextTopic(GENERATED_DIR, { module, teil, level });
}

/**
 * User-provided vocab with CEFR pre-filter, or pool/coverage fallback.
 * @returns {{ words: string[], userVocab: object|null, topic: string }}
 */
export function resolveGenerationVocab(args, topicCtx = {}) {
  const topic = resolveGenerationTopic(args, topicCtx);

  if (args.words?.length) {
    const cap = Math.max(1, Number(args.wordCount) || 20);
    const raw = args.words.slice(0, cap);
    const userVocab = classifyUserVocab(raw, { lang: args.lang, level: args.level });
    for (const w of userVocab.warnings) {
      console.warn(`  ⚠ vocab "${w.word}": ${w.message}`);
    }
    for (const ex of userVocab.excluded) {
      console.warn(`  ⊘ vocab excluida (${ex.band}): ${ex.word} — ${ex.reason}`);
    }
    if (!userVocab.prompted.length) {
      throw new Error(
        'Tras el filtro CEFR no quedan palabras para el generador. Elige palabras B1 o corrige la lista.',
      );
    }
    return { words: userVocab.prompted, userVocab, topic };
  }

  let words;
  if (args.fromBank) {
    words = pickTargetWords({
      lang: args.lang,
      level: args.level,
      count: args.wordCount,
      source: 'bank',
    });
  } else if (args.fromCoverage) {
    const pick = pickTopicAlignedWeakWords({
      lang: args.lang,
      level: args.level,
      topic,
      count: args.wordCount,
      cursor: args.coverageCursor ?? 0,
      context: vocabPickContext(topicCtx.module || args.module || 'lesen', topicCtx.teil ?? args.teil ?? 1),
    });
    words = pick.words;
    args._coverageCursor = pick.nextCursor;
    args._coverageTopicAlignedCount = pick.topicAlignedCount;
    if (!words.length) throw new Error('No se pudieron elegir palabras del reporte de cobertura');
  } else {
    throw new Error('Pasa --words a,b,c, --from-bank o --from-coverage');
  }

  return { words, userVocab: null, topic };
}

/**
 * Mutates args with _resolvedTopic / _userVocab and returns prompted words.
 */
export function resolveTargetWordsForArgs(args, topicCtx = {}) {
  const resolved = resolveGenerationVocab(args, topicCtx);
  args._resolvedTopic = resolved.topic;
  args._userVocab = resolved.userVocab;
  const teilNum = Number(topicCtx.teil ?? args.teil ?? 1);
  let targetCount = Math.max(1, Number(args.wordCount) || 10);
  if (teilNum === 5) {
    targetCount = Math.min(6, targetCount);
  }
  const context =
    args.vocabContext ||
    vocabPickContext(topicCtx.module || args.module || 'lesen', teilNum);
  return sanitizePromptTargetWords(resolved.words, resolved.topic, targetCount, {
    lang: args.lang || 'de',
    level: args.level || 'B1',
    context,
    coverageCursor: args.coverageCursor ?? 0,
  });
}

export { isValidB1Topic, B1_TOPICS };
