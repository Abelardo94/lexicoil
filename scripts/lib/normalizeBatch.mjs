/**
 * Fix common Gemini output mistakes before validate/merge.
 */
import { applyGermanCapsNormalize } from './germanCapsNormalize.mjs';
import { stripMarkdownLeakInText } from './stripMarkdownLeak.mjs';
import {
  balanceMcqGroup,
  antiRuns,
  derivePartShuffleSeed,
  shuffleKeyedQuestionOrder,
  BALANCE_MCQ_VERSION,
} from './balanceMcq.mjs';
import { normalizeT3 } from './normalizeT3.mjs';
import { dedupSkillsArray } from './dedupSkills.mjs';
import {
  normalizeSchreibenCorrectFields,
  normalizeSchreibenRubric,
} from './normalizeSchreibenRubric.mjs';
import { canonicalSchreibenExplanation } from './schreibenDisplayRubric.mjs';
import { canonicalSprechenExplanation } from './sprechenDisplayRubric.mjs';
import { backfillCanonicalQuestion } from './questionStemAliases.mjs';
import {
  backfillLesenA2T4PassageTitles,
  isLesenA2T4PassageContext,
} from './lesenA2T4Passages.mjs';
import {
  canonicalSprechenType,
  normalizeSprechenTopicTags,
} from './sprechenTaxonomy.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT_NORM = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HorenPictureMatching = require(path.join(ROOT_NORM, 'js/engine/horenPictureMatching.js'));
const SKILL_MAP = {
  listening: 'listening',
  listening_comprehension: 'listening',
  hörverstehen: 'listening',
  hörverstehen: 'listening',
  horverstehen: 'listening',
  reading: 'reading',
  reading_comprehension: 'reading',
  leseverstehen: 'reading',
  writing: 'writing',
  schreiben: 'writing',
  speaking: 'speaking',
  sprechen: 'speaking',
  grammar: 'grammar',
};

const DIFFICULTY_WORDS = {
  leicht: 3,
  easy: 3,
  mittel: 5,
  medium: 5,
  schwer: 7,
  hard: 7,
  b1: 5,
  a2: 3,
  b2: 6,
  c1: 7,
};

function moduleDefaultSkill(module) {
  if (module === 'horen') return 'listening';
  if (module === 'lesen') return 'reading';
  if (module === 'schreiben') return 'writing';
  if (module === 'sprechen') return 'speaking';
  if (module === 'grammatik') return 'grammar';
  return 'reading';
}

function normalizeDifficulty(value, module, level = 'B1') {
  const lv = String(level || 'B1').trim().toUpperCase();
  if (typeof value === 'number' && value >= 1 && value <= 10) {
    if (module === 'horen' && lv === 'A2' && value >= 2 && value <= 4) return value;
    if (!(module === 'horen' && lv === 'A2')) return value;
  }
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (DIFFICULTY_WORDS[lower] != null) {
      const w = DIFFICULTY_WORDS[lower];
      if (module === 'horen' && lv === 'A2') return Math.min(4, Math.max(2, w <= 4 ? w : 3));
      return w;
    }
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 10) {
      if (module === 'horen' && lv === 'A2') return n >= 2 && n <= 4 ? n : 3;
      return n;
    }
  }
  if (module === 'horen') return lv === 'A2' ? 3 : 5;
  if (module === 'sprechen') return 5; // SP-2: fixed B1 Sprechen difficulty
  if (module === 'schreiben') return 6;
  return 4;
}

function normalizeSkills(value, module) {
  const fallback = moduleDefaultSkill(module);
  const mapOne = (s) => {
    const key = String(s).toLowerCase().trim();
    return SKILL_MAP[key] || (['listening', 'reading', 'writing', 'speaking', 'grammar'].includes(key) ? key : fallback);
  };
  if (Array.isArray(value) && value.length) {
    // Map synonyms then dedup: ["writing","schreiben","writing"] → ["writing"]
    // (shared with backlog reprocessors via dedupSkillsArray)
    const mapped = value.map(mapOne).filter(Boolean);
    return dedupSkillsArray(mapped).skills;
  }
  if (typeof value === 'string' && value.trim()) {
    return [mapOne(value)];
  }
  return [fallback];
}

function normalizeTopicTags(value, rootTopicTag = null) {
  if (Array.isArray(value) && value.length) {
    const tag = value.length > 1 ? value[0] : value[0];
    if (tag === 'daily_life' && rootTopicTag) return [rootTopicTag];
    return [tag];
  }
  if (typeof value === 'string' && value.trim()) {
    const tag = value.trim();
    if (tag === 'daily_life' && rootTopicTag) return [rootTopicTag];
    return [tag];
  }
  return null;
}

/**
 * Elimina metadatos legacy estampados por normalizeBatch (pool Lesen B1).
 *
 * difficulty (Opción B, 2026-07-10): se calcula exclusivamente en runtime vía
 * ExamBuilder.applyExamDifficulty → DifficultyScorer.deriveExamDifficulty /
 * scoreQuestion al ensamblar el examen. El pool NO guarda un valor fijo, para
 * evitar el short-circuit de DifficultyScorer (~L67–70: si q.difficulty ∈ [1,10]
 * se reutiliza sin recalcular). Así un scorer mejorado no queda bloqueado por
 * JSON antiguo. Revisitar solo si surge necesidad real de filtrar el pool por
 * dificultad (entonces: función de solo lectura sobre CefrGate/DifficultyScorer,
 * nunca persistir el score en el JSON). Ver BACKLOG.md → DIFF-SCORE / DIFF-POOL-RO.
 */
export function stripPoolLegacyQuestionFields(q, ctx = {}) {
  const out = { ...q };
  const lang = ctx.lang || 'de';
  const rootTopicTag = ctx.rootTopicTag || ctx.topicTag || null;

  delete out.difficulty;
  delete out.skills;
  delete out.examType;
  delete out.topicTags;
  // Redundant only for German, the implied default. For any other language this is the batch's
  // sole language marker: without it inferAuditLang and build-level treat the batch as German.
  if (!out.language || (out.language === lang && lang === 'de')) delete out.language;
  if (out.topicTag && rootTopicTag && out.topicTag === rootTopicTag) delete out.topicTag;

  return out;
}

function isPoolStripLegacyQuestionFields(ctx) {
  if (ctx?.stripPoolLegacy === false) return false;
  const mod = String(ctx?.module || '').toLowerCase();
  const lv = String(ctx?.level || 'B1').trim().toUpperCase();
  return mod === 'lesen' || (mod === 'horen' && lv === 'A2');
}

/** @deprecated use isPoolStripLegacyQuestionFields */
function isLesenPoolNormalize(ctx) {
  return isPoolStripLegacyQuestionFields(ctx);
}

/**
 * Fallback explanation when the generator left none. The German strings are Goethe wording;
 * an English Cambridge batch used to receive them too ("Bewertung: Inhalt vollständig…").
 */
function defaultExplanation(q, lang = 'de') {
  const productive = q.module === 'schreiben' || q.module === 'sprechen';
  if (lang !== 'de') {
    if (productive) {
      return 'Assessed on content, organisation, language and communicative achievement.';
    }
    return q.explanation || 'See the text or recording.';
  }
  if (productive) {
    return 'Bewertung: Inhalt vollständig; passende Struktur und Register; verständliche Sprache auf B1-Niveau.';
  }
  return q.explanation || 'Siehe Text/Transkript.';
}

/** Gemini sometimes returns { value, text } objects instead of "a) …" strings. */
export function normalizeOptions(options, type) {
  if (!Array.isArray(options)) return [];
  if (type === 'richtig_falsch') return [];
  return options.map((opt, i) => {
    if (typeof opt === 'string') {
      const t = opt.trim();
      if (/^[a-z]\)\s/i.test(t)) return opt;
      const letter = String.fromCharCode(97 + i);
      return `${letter}) ${t}`;
    }
    if (opt && typeof opt === 'object') {
      const letter = String(opt.value ?? opt.id ?? opt.key ?? String.fromCharCode(97 + i))
        .replace(/[^a-z]/gi, '')
        .toLowerCase()
        .slice(0, 1) || String.fromCharCode(97 + i);
      const text = opt.text ?? opt.label ?? opt.content ?? '';
      return text ? `${letter}) ${text}` : letter;
    }
    return String(opt);
  });
}

function normalizeQuestionType(raw) {
  const t = String(raw || '').toLowerCase().trim();
  // Normalize all MC variants → multiple_choice
  if (['mcq', 'mc', 'multiple', 'multiple_choice', 'mc_question', 'multiple-choice'].includes(t)) return 'multiple_choice';
  if (['match', 'zuordnung', 'zuordnen'].includes(t)) return 'matching';
  // Keep richtig_falsch/ja_nein as canonical internal types (display logic uses correct value)
  if (['rf', 'richtig_falsch', 'richtig-falsch', 'true_false', 'wahr_falsch'].includes(t)) return 'richtig_falsch';
  if (['jn', 'ja_nein', 'ja-nein', 'ja_nein_frage'].includes(t)) return 'ja_nein';
  return t;
}

function normalizeQuestion(q, ctx = {}) {
  const out = { ...q };
  const poolStripLegacy = isPoolStripLegacyQuestionFields(ctx);
  const rootTopicTag = ctx.rootTopicTag || ctx.topicTag || null;
  const lang = ctx.lang || 'de';
  if (typeof out.teil === 'string') out.teil = Number(out.teil);
  // If teil is still missing, try to extract it from the question ID
  // Patterns: gen-q-sp-t1-..., gen-q-s-t2-..., gen-q-h1-...-s1-q1
  if (out.teil == null && out.id) {
    const mTeil = String(out.id).match(/[_-]t(\d)[_-]/i);
    if (mTeil) out.teil = Number(mTeil[1]);
  }
  if (out.type) out.type = normalizeQuestionType(out.type);
  if (out.questionType) out.questionType = normalizeQuestionType(out.questionType);
  backfillCanonicalQuestion(out);
  // `correct` is canonical. Backfill from correctAnswer only when correct is absent.
  if (out.correct == null && out.correctAnswer != null) {
    out.correct = out.correctAnswer;
  }
  // Canonical key normalization: multiple_choice correct must be lowercase letter (a/b/c/d).
  // Gemini sometimes returns uppercase "A", "B", "C" — normalize here before POOL-2.
  if (out.type === 'multiple_choice' && out.correct != null) {
    const cs = String(out.correct);
    if (/^[A-Z]$/.test(cs)) out.correct = cs.toLowerCase();
  }
  if (out.module === 'schreiben') {
    if (
      out.type === 'rubric' ||
      out.type === 'schreiben' ||
      out.type === 'writing_task' ||
      out.type === 'writing' ||
      !out.type
    ) {
      out.type = 'short_answer';
    }
  }
  // Sprechen: canonical types by Teil (B1 SP-2 / A2 official). Goethe taxonomy and German
  // rubric text: on Cambridge it retyped short_answer as planungsaufgabe/praesentation and
  // replaced the English part guidance with "In diesem Teil des Sprechens…".
  if (out.module === 'sprechen' && lang === 'de') {
    const level = String(ctx.level || out.level || 'B1').trim().toUpperCase();
    out.type = canonicalSprechenType(out.type, out.teil, level);
    const canonExpl = canonicalSprechenExplanation(out.teil, level);
    if (canonExpl) out.explanation = canonExpl;
  } else if (out.module === 'sprechen') {
    // Cambridge Speaking is stored as short_answer (the served en/B1 bank); Gemini writes
    // type "rubric", which audit CHK-1 rejects as non-canonical.
    if (!out.type || out.type === 'rubric' || out.type === 'speaking' || out.type === 'sprechen') {
      out.type = 'short_answer';
    }
  }
  // Schreiben: B1 convention correct/correctAnswer = "rubric"; examples live in explanation.
  // Rubric object normalized to fixed English keys (shared with A2 backlog reprocessor).
  if (out.module === 'schreiben') {
    Object.assign(out, normalizeSchreibenCorrectFields(out));
    if (out.rubric != null) {
      const normalizedRubric = normalizeSchreibenRubric(out.rubric);
      if (normalizedRubric) out.rubric = normalizedRubric;
      else delete out.rubric;
    }
    // German Goethe rubric ("Bewertung (Goethe-offiziell)…"); Cambridge keeps its own guidance.
    const canonExpl = lang === 'de' ? canonicalSchreibenExplanation(out.teil, ctx.level || out.level || 'B1') : null;
    if (canonExpl) out.explanation = canonExpl;
  }
  if (poolStripLegacy) {
    // Opción B (2026-07-10): no persistir difficulty — ver stripPoolLegacyQuestionFields.
    delete out.difficulty;
    delete out.skills;
    delete out.examType;
    delete out.topicTags;
    if (!out.language || (out.language === lang && lang === 'de')) delete out.language;
    if (out.topicTag && rootTopicTag && out.topicTag === rootTopicTag) delete out.topicTag;
  } else {
    const qLevel = ctx.level || out.level || 'B1';
    out.difficulty =
      out.module === 'sprechen'
        ? String(qLevel).trim().toUpperCase() === 'A2'
          ? 3
          : 5
        : normalizeDifficulty(out.difficulty, out.module, qLevel);
    out.skills = normalizeSkills(out.skills, out.module);
    // Goethe B1 topic taxonomy with a German fallback: English Speaking tags such as
    // t-en-b1-socializing-and-relationships came out as 'Medien' / 'Freizeit'.
    if (out.module === 'sprechen' && lang === 'de') {
      const mapped = normalizeSprechenTopicTags(out.topicTags, rootTopicTag);
      out.topicTags = mapped || (rootTopicTag ? [rootTopicTag] : ['Freizeit']);
    } else {
      const mapped = normalizeTopicTags(out.topicTags, rootTopicTag);
      out.topicTags = mapped || ['daily_life'];
    }
  }
  out.options = normalizeOptions(out.options, out.type);
  if (out.type === 'richtig_falsch' && Array.isArray(out.options) && out.options.length) {
    out.options = [];
  }
  if (!out.explanation || String(out.explanation).toLowerCase() === 'rubric') {
    out.explanation = defaultExplanation(out, lang);
  }
  if (out.passageId === null) delete out.passageId;
  if (Array.isArray(out.passageId)) delete out.passageId;
  // `correct` always wins. Mirror to correctAnswer so both are always identical.
  if (out.correct != null) {
    out.correctAnswer = out.correct;
  }
  return out;
}

/** Extract teil from gen-q-sp-t2-… / gen-q-s-t3-… style IDs. */
export function inferTeilFromQuestionId(id) {
  if (!id) return null;
  const m = String(id).match(/[_-]t(\d)[_-]/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

/**
 * Sprechen/Schreiben batches ship 3 questions (Teile 1–3) in one JSON.
 * Never inherit the CLI cell teil (sprechen-t2) onto every question.
 * Cambridge B1 has 4 Speaking parts and 2 Writing parts, so the Goethe cap of 3 folded
 * Speaking Part 4 into Part 3.
 */
const MULTI_TEIL_MAX_BY_LANG = { en: { sprechen: 4, schreiben: 2 } };

// Stamped when absent. Every question in library/en/B1/questions.json says 'cambridge';
// the hard-coded 'goethe' labelled Cambridge Listening/Writing/Speaking as Goethe.
const EXAM_TYPE_BY_LANG = { de: 'goethe', en: 'cambridge', es: 'dele' };

export function assignMultiTeilQuestions(questions, module, lang = 'de') {
  const mod = String(module || '').toLowerCase();
  if (mod !== 'sprechen' && mod !== 'schreiben') return questions;
  if (!Array.isArray(questions) || !questions.length) return questions;
  const maxTeil = MULTI_TEIL_MAX_BY_LANG[String(lang || 'de').toLowerCase()]?.[mod] ?? 3;

  const tagged = questions.map((q, origIdx) => {
    let teil = q.teil != null && q.teil !== '' ? Number(q.teil) : null;
    if (!Number.isFinite(teil)) teil = null;
    const fromId = inferTeilFromQuestionId(q.id);
    return { q, origIdx, teil, fromId };
  });

  const validTeils = tagged.map((x) => x.teil).filter((t) => t >= 1 && t <= maxTeil);
  if (
    validTeils.length === questions.length &&
    new Set(validTeils).size === questions.length
  ) {
    return questions;
  }

  const sorted = [...tagged].sort((a, b) => {
    if (a.fromId != null && b.fromId != null) return a.fromId - b.fromId;
    if (a.fromId != null) return -1;
    if (b.fromId != null) return 1;
    return a.origIdx - b.origIdx;
  });

  return sorted.map((item, idx) => ({
    ...item.q,
    teil: Math.min(idx + 1, maxTeil),
  }));
}

/**
 * Inject module/teil/lang/level and link passageId when Gemini omits bank fields.
 */
export function enrichBatchMetadata(batch, ctx = {}) {
  const mod = ctx.module ? String(ctx.module).toLowerCase() : null;
  const teilNum = ctx.teil != null && Number.isFinite(Number(ctx.teil)) ? Number(ctx.teil) : null;
  const lang = ctx.lang || 'de';
  const level = ctx.level || 'B1';
  const lv = String(level).trim().toUpperCase();
  const multiTeilSet =
    (mod === 'schreiben' && lv !== 'A2' && lv !== 'B2') ||
    (mod === 'sprechen' && lv !== 'A2');

  const passages = (batch.passages || []).map((p) => {
    const out = { ...p };
    if (mod && !out.module) out.module = mod;
    return out;
  });

  const passageIds = passages.map((p) => p.id).filter(Boolean);
  const solePassageId = passageIds.length === 1 ? passageIds[0] : null;

  const questions = (batch.questions || []).map((q, idx) => {
    const out = { ...q };
    if (mod && !out.module) out.module = mod;
    if (
      teilNum != null &&
      (out.teil == null || out.teil === '') &&
      (!multiTeilSet || (mod === 'sprechen' && level === 'A2'))
    ) {
      out.teil = teilNum;
    }
    if (!out.level) out.level = level;
    if (!isLesenPoolNormalize(ctx)) {
      if (!out.language) out.language = lang;
      if (!out.examType) out.examType = EXAM_TYPE_BY_LANG[lang] || 'goethe';
    } else if (lang !== 'de' && !out.language) {
      // Lesen pool records drop language as redundant — true only for German. Every English
      // bank question carries language 'en'; without it the batch reads as German downstream.
      out.language = lang;
    }
    // `correct` is canonical; backfill only when correct is absent.
    if (out.correct == null && out.correctAnswer != null) out.correct = out.correctAnswer;
    // Mirror correct → correctAnswer, but never clobber a prose model answer with
    // boolean `true` (legacy Schreiben A2: correct:true + example in correctAnswer).
    if (out.correct != null) {
      const ca = out.correctAnswer;
      const preserveProseExample =
        out.correct === true &&
        typeof ca === 'string' &&
        ca.trim() !== '' &&
        ca.trim().toLowerCase() !== 'rubric';
      if (!preserveProseExample) out.correctAnswer = out.correct;
    }
    if ((mod === 'horen' || mod === 'lesen') && !out.passageId && solePassageId) {
      out.passageId = solePassageId;
    }
    if (mod === 'horen' && Number(out.teil) === 1 && !out.segmentLabel && passageIds.length > 1) {
      const pid = out.passageId || passageIds[idx % passageIds.length];
      if (pid) {
        out.passageId = pid;
        const segIdx = passageIds.indexOf(pid);
        if (segIdx >= 0) out.segmentLabel = `Aufnahme ${segIdx + 1}`;
      }
    }
    return out;
  });

  return { passages, questions };
}

/** Remove internal LLM markup backticks: `word` → word */
function stripBackticks(obj) {
  if (typeof obj === 'string') return obj.replace(/`([^`]+)`/g, '$1');
  if (Array.isArray(obj)) return obj.map(stripBackticks);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = stripBackticks(v);
    return out;
  }
  return obj;
}

/** Remove markdown bold/italic/list-bullets from question text fields (not explanation). */
const QUESTION_TEXT_FIELDS = new Set(['question', 'signText', 'title']);
function stripMarkdownBold(q) {
  const out = { ...q };
  for (const field of QUESTION_TEXT_FIELDS) {
    if (typeof out[field] === 'string') {
      // Bold/italic legacy + AUD-4b line-start * / - bullets (Sprechen consignas)
      let t = out[field].replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');
      t = stripMarkdownLeakInText(t).result;
      out[field] = t;
    }
  }
  if (Array.isArray(out.options)) {
    out.options = out.options.map((o) => {
      if (typeof o !== 'string') return o;
      let t = o.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');
      return stripMarkdownLeakInText(t).result;
    });
  }
  return out;
}

/** Strip LLM artifact "Stichworte: Wort." from options/matchLabels in Lesen T3. */
const STICHWORTE_RE = /\s*Stichworte:\s*\S+\.?/gi;
function stripStichworte(q) {
  if (q.module !== 'lesen' || q.teil !== 3) return q;
  const out = { ...q };
  if (Array.isArray(out.options)) {
    out.options = out.options.map(o =>
      typeof o === 'string' ? o.replace(STICHWORTE_RE, '').trim() : o,
    );
  }
  if (Array.isArray(out.matchLabels)) {
    out.matchLabels = out.matchLabels.map(o =>
      typeof o === 'string' ? o.replace(STICHWORTE_RE, '').trim() : o,
    );
  }
  return out;
}

/** Derive audio turns from passage text when LLM didn't include the "audio" field.
 *  Splits on lines matching "Name: text" pattern, assigns rotating voices.
 */
const HOREN_VOICES = ['de-DE-KatjaNeural', 'de-DE-ConradNeural', 'de-DE-BerndNeural'];
function deriveAudioFallback(passage, module, teil) {
  if (!passage.text) return null;
  const lines = passage.text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const turns = [];
  const speakerVoice = {};
  let voiceIdx = 0;
  for (const line of lines) {
    const m = line.match(/^([A-ZÄÖÜa-zäöü][^\s:]{0,20}):\s+(.+)$/);
    if (!m) continue;
    const speaker = m[1];
    const text = m[2].trim();
    if (!speakerVoice[speaker]) {
      speakerVoice[speaker] = HOREN_VOICES[voiceIdx % HOREN_VOICES.length];
      voiceIdx++;
    }
    turns.push({ speaker, voiceId: speakerVoice[speaker], text });
  }
  return turns.length >= 2 ? turns : null;
}

/** Collapse duplicate passages with identical text (Gemini T2 sometimes emits
 *  base id + `-s1` clone). Keeps the passage referenced by questions when possible. */
export function collapseIdenticalPassages(batch) {
  const passages = batch?.passages;
  if (!Array.isArray(passages) || passages.length < 2) return batch;

  const kept = [];
  const dropIds = new Set();
  const textToKeeper = new Map();

  for (const p of passages) {
    const key = String(p?.text || '').trim();
    if (!key) {
      kept.push(p);
      continue;
    }
    const existing = textToKeeper.get(key);
    if (!existing) {
      textToKeeper.set(key, p);
      kept.push(p);
      continue;
    }
    // Prefer id without -sN suffix as canonical; drop the clone.
    const existingIsSeg = /-(s\d+)$/i.test(String(existing.id || ''));
    const curIsSeg = /-(s\d+)$/i.test(String(p.id || ''));
    if (existingIsSeg && !curIsSeg) {
      // replace keeper with non-segment id
      const idx = kept.indexOf(existing);
      if (idx >= 0) kept[idx] = p;
      dropIds.add(existing.id);
      textToKeeper.set(key, p);
    } else {
      dropIds.add(p.id);
    }
  }

  if (!dropIds.size) return batch;

  const keepIds = new Set(kept.map((p) => p.id).filter(Boolean));
  const soleId = keepIds.size === 1 ? [...keepIds][0] : null;
  const questions = (batch.questions || []).map((q) => {
    if (!q?.passageId || keepIds.has(q.passageId)) return q;
    if (soleId) return { ...q, passageId: soleId };
    return q;
  });

  return { ...batch, passages: kept, questions };
}

export function normalizeBatch(batch, ctx) {
  const cleaned = stripBackticks(batch);
  const baseRaw = ctx ? enrichBatchMetadata(cleaned, ctx) : cleaned;
  const mod = String(ctx?.module || '').toLowerCase();
  const teil = ctx?.teil;
  const batchLevel = String(ctx?.level || 'B1').trim().toUpperCase();
  const base =
    mod === 'sprechen' && batchLevel === 'A2'
      ? baseRaw
      : mod === 'sprechen' || mod === 'schreiben'
        ? {
            ...baseRaw,
            questions: assignMultiTeilQuestions(baseRaw.questions || [], mod, ctx?.lang),
          }
        : baseRaw;

  let passages = (base.passages || []).map((p) => {
    const out = { ...p };
    // Add audio fallback for Hören T3 / T4 if not already present
    if (mod === 'horen' && (teil === 3 || teil === 4) && !out.audio) {
      const derived = deriveAudioFallback(out, mod, teil);
      if (derived) out.audio = derived;
    }
    return out;
  });

  if (isLesenA2T4PassageContext({ module: mod, level: batchLevel, teil })) {
    passages = backfillLesenA2T4PassageTitles(passages);
  }

  // Balance MCQ letter distribution and break consecutive runs (all MCQ teils:
  // lesen T2/T5, horen T1/T2).  richtig_falsch, ja_nein and matching untouched.
  const rawQuestions = (base.questions || []).map((q) =>
    normalizeQuestion(stripStichworte(stripMarkdownBold(q)), ctx),
  );
  const shuffleSeed = derivePartShuffleSeed(rawQuestions);
  const balancedQuestions = shuffleKeyedQuestionOrder(
    antiRuns(balanceMcqGroup(rawQuestions, { seed: shuffleSeed })),
    { seed: shuffleSeed },
  );

  let normalized = {
    ...base,
    passages,
    questions: balancedQuestions,
  };

  // Hören: collapse Gemini duplicate passages (identical text, e.g. id + id-s1).
  // Safe for T1 (distinct texts kept); only removes exact text clones.
  if (mod === 'horen') {
    const before = (normalized.passages || []).length;
    normalized = collapseIdenticalPassages(normalized);
    const after = (normalized.passages || []).length;
    if (after < before) {
      console.log(`  [normalizeBatch] collapsed ${before - after} duplicate passage(s) (identical text)`);
    }
  }

  // Lesen T3 B1: canonicalize matching format (A-J ads). A2 T3 = email MCQ, skip.
  if (mod === 'lesen' && teil === 3 && batchLevel !== 'A2') {
    normalized = normalizeT3(normalized);
  }

  // Hören A2 T2: picture_matching — banco compartido a–i, preguntas sin options.
  if (HorenPictureMatching.isPictureMatchingCtx({ module: mod, teil, level: ctx?.level })) {
    normalized = HorenPictureMatching.normalizePictureMatchingBatch(normalized, {
      module: mod,
      teil,
      level: ctx?.level,
    });
  }

  // Post-gen caps normalization (decap adj/adv → cap nouns → MCQ option caps).
  // `lang` gates the two German-orthography steps; without it English text came out with
  // German noun capitalization. See risk #1 in docs/audit/gates-en-applicability.md.
  let { batch: withMcqCaps, stats: capsStats } = applyGermanCapsNormalize(normalized, { lang: ctx?.lang });
  if (capsStats.decapFixed > 0) {
    console.log(`  [normalizeNouns] ${capsStats.decapFixed} adjetivo(s)/adverbio(s) en mayúscula errónea corregido(s)`);
  }
  if (capsStats.capFixed > 0) {
    console.log(`  [normalizeNouns] ${capsStats.capFixed} sustantivo(s) capitalizados automáticamente`);
  }

  if (isPoolStripLegacyQuestionFields(ctx)) {
    withMcqCaps = {
      ...withMcqCaps,
      questions: (withMcqCaps.questions || []).map((q) => stripPoolLegacyQuestionFields(q, ctx)),
    };
  }
  return {
    ...withMcqCaps,
    _balanceMcqVersion: BALANCE_MCQ_VERSION,
    _balanceMcqNormalizedAt: new Date().toISOString(),
  };
}

/** Tras generación LLM: fuerza module/teil/lang/type del slot objetivo (B1). */
const TEIL_QUESTION_TYPE_B1 = {
  1: 'richtig_falsch',
  2: 'multiple_choice',
  3: 'matching',
  4: 'ja_nein',
  5: 'multiple_choice',
};

/** Goethe A2 Lesen — alineado a library/blueprints/goethe_A2.json (sin T5). */
const TEIL_QUESTION_TYPE_A2 = {
  1: 'multiple_choice',
  2: 'multiple_choice',
  3: 'multiple_choice',
  4: 'matching',
};

/** Goethe B2 Lesen — alineado a library/blueprints/goethe_B2.json */
const TEIL_QUESTION_TYPE_B2 = {
  1: 'matching',
  2: 'matching',
  3: 'multiple_choice',
  4: 'matching',
  5: 'matching',
};

// Cambridge B1 Preliminary Reading: Teil->questionType (see library/blueprints/cambridge_B1.json)
// T1 signs/notices MCQ, T2 person-text matching, T3 long-text MCQ, T4 gapped text (matching),
// T5 4-option cloze MCQ, T6 open cloze (gap_fill).
const TEIL_QUESTION_TYPE_CAMBRIDGE_B1 = {
  1: 'multiple_choice',
  2: 'matching',
  3: 'multiple_choice',
  4: 'matching',
  5: 'multiple_choice',
  6: 'gap_fill',
};

/** @returns {string|null} canonical question type for post-gen coerce */
export function lesenSlotQuestionType(teil, level = 'B1', lang = 'de') {
  const t = Number(teil);
  if (!Number.isFinite(t)) return null;
  const lv = String(level || 'B1').trim().toUpperCase();
  // The A2/B1/B2 maps above are Goethe's. The Teil->type mapping differs per exam board, so
  // anything that is not German must not be forced through them — an unknown lang returns null
  // and leaves the generated/blueprint type untouched.
  // See docs/audit/gates-en-applicability.md (riesgo activo #2).
  const lg = String(lang || 'de').trim().toLowerCase();
  if (lg === 'en') return TEIL_QUESTION_TYPE_CAMBRIDGE_B1[t] ?? null;
  if (lg !== 'de') return null;
  const map =
    lv === 'A2' ? TEIL_QUESTION_TYPE_A2 : lv === 'B2' ? TEIL_QUESTION_TYPE_B2 : TEIL_QUESTION_TYPE_B1;
  return map[t] ?? null;
}

function normalizeRichtigFalschAnswer(q) {
  const raw = String(q.correctAnswer ?? q.correct ?? '').trim().toLowerCase();
  if (['richtig', 'true', 'wahr', 'r', 'yes', 'ja'].includes(raw)) {
    return { correct: 'Richtig', correctAnswer: 'Richtig' };
  }
  if (['falsch', 'false', 'unwahr', 'f', 'no', 'nein'].includes(raw)) {
    return { correct: 'Falsch', correctAnswer: 'Falsch' };
  }
  return {};
}

function normalizeJaNeinAnswer(q) {
  const raw = String(q.correctAnswer ?? q.correct ?? '').trim().toLowerCase();
  if (raw === 'ja' || raw === 'yes' || raw === 'true') {
    return { correct: 'Ja', correctAnswer: 'Ja' };
  }
  if (raw === 'nein' || raw === 'no' || raw === 'false') {
    return { correct: 'Nein', correctAnswer: 'Nein' };
  }
  return {};
}

export function coerceGeneratedLesenPart(batch, ctx = {}) {
  const teil = Number(ctx.teil);
  const lang = ctx.lang || 'de';
  const level = ctx.level || 'B1';
  const normalized = normalizeBatch(batch, {
    module: 'lesen',
    teil: Number.isFinite(teil) ? teil : ctx.teil,
    lang,
    level,
    rootTopicTag: ctx.rootTopicTag || batch.topicTag || batch._requestedTopic || null,
    stripPoolLegacy: ctx.stripPoolLegacy !== false,
  });
  const teilNum = Number.isFinite(teil) ? teil : null;
  const slotType = teilNum != null ? lesenSlotQuestionType(teilNum, level, lang) : null;
  const passageIds = (normalized.passages || []).map((p) => p.id).filter(Boolean);
  const solePassageId = passageIds.length === 1 ? passageIds[0] : null;

  const passages = (normalized.passages || []).map((p) => ({
      ...p,
      module: 'lesen',
      ...(teilNum != null ? { teil: teilNum } : {}),
      lang: p.lang || lang,
      level: p.level || level,
    }));

  const questions = (normalized.questions || []).map((q, qIdx) => {
      let out = {
        ...q,
        module: 'lesen',
        ...(teilNum != null ? { teil: teilNum } : {}),
        lang: q.lang || lang,
        level: q.level || level,
      };
      if (slotType) {
        out.type = slotType;
        if (slotType === 'richtig_falsch') {
          out.options = [];
          out = { ...out, ...normalizeRichtigFalschAnswer(out) };
        } else if (slotType === 'ja_nein') {
          out.options = out.options || [];
          out = { ...out, ...normalizeJaNeinAnswer(out) };
        } else if (slotType === 'multiple_choice') {
          out.options = normalizeOptions(out.options, slotType);
        } else if (slotType === 'matching' && String(level).toUpperCase() === 'B2' && teilNum === 1) {
          const ans = String(out.correctAnswer ?? out.correct ?? '')
            .trim()
            .replace(/^([abcd])[).:\s].*$/i, '$1')
            .toUpperCase();
          if (/^[ABCD]$/.test(ans)) {
            out.correct = ans;
            out.correctAnswer = ans;
          }
          out.options = ['A', 'B', 'C', 'D'];
        } else if (slotType === 'matching' && String(level).toUpperCase() === 'B2' && teilNum === 2) {
          const ans = String(out.correctAnswer ?? out.correct ?? '')
            .trim()
            .replace(/^([a-h])[).:\s].*$/i, '$1')
            .toUpperCase();
          if (/^[A-H]$/.test(ans)) {
            out.correct = ans;
            out.correctAnswer = ans;
          }
          if (Array.isArray(out.options) && out.options.length >= 8) {
            out.options = out.options.slice(0, 8).map((o, i) => {
              const letter = String.fromCharCode(65 + i);
              const s = String(o || '').trim();
              if (/^[A-H][).:\s]/i.test(s)) return s.replace(/^[A-H]/i, letter);
              return `${letter}) ${s.replace(/^[a-h][).:\s]\s*/i, '')}`;
            });
          }
        } else if (slotType === 'matching' && String(level).toUpperCase() === 'B2' && teilNum === 4) {
          const ans = String(out.correctAnswer ?? out.correct ?? '')
            .trim()
            .replace(/^([a-h])[).:\s].*$/i, '$1')
            .toUpperCase();
          if (/^[A-H]$/.test(ans)) {
            out.correct = ans;
            out.correctAnswer = ans;
          }
          if (Array.isArray(out.options) && out.options.length >= 8) {
            out.options = out.options.slice(0, 8).map((o, i) => {
              const letter = String.fromCharCode(65 + i);
              const s = String(o || '').trim();
              if (/^[A-H][).:\s]/i.test(s)) return s.replace(/^[A-H]/i, letter);
              return `${letter}) ${s.replace(/^[a-h][).:\s]\s*/i, '')}`;
            });
          }
        } else if (slotType === 'matching' && String(level).toUpperCase() === 'B2' && teilNum === 5) {
          const ans = String(out.correctAnswer ?? out.correct ?? '')
            .trim()
            .replace(/^([a-g])[).:\s].*$/i, '$1')
            .toUpperCase();
          if (/^[A-G]$/.test(ans)) {
            out.correct = ans;
            out.correctAnswer = ans;
          }
          if (Array.isArray(out.options) && out.options.length >= 7) {
            out.options = out.options.slice(0, 7).map((o, i) => {
              const letter = String.fromCharCode(65 + i);
              const s = String(o || '').trim();
              if (/^[A-G][).:\s]/i.test(s)) return s.replace(/^[A-G]/i, letter);
              return `${letter}) ${s.replace(/^[a-g][).:\s]\s*/i, '')}`;
            });
          }
        }
      }
      if ((out.module === 'lesen' || !out.passageId) && solePassageId && !out.passageId) {
        out.passageId = solePassageId;
      }
      return out;
    });

  // Preserve normalizeBatch stamps/metadata (_balanceMcqVersion, caps, enrich, …).
  return {
    ...normalized,
    passages,
    questions,
  };
}
