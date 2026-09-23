#!/usr/bin/env node
/**
 * Genera partes de Lesen B1 con Gemini (Flash/Flash-Lite) o T3 sin API (make-t3).
 * Guarda en batches/generated/ tras pasar formato (validate-batch) + calidad (checkLesenBatchQuality).
 *
 * Proveedores:
 *   --provider gemini  → tier gratuito (--pause-ms 6000, --max-api-calls)
 *   T3 → scripts/make-t3.mjs (0 llamadas)
 *
 * Uso:
 *   node scripts/generate-lesen-part-gemini.mjs --teil 1 --from-coverage
 *   node scripts/generate-lesen-part-gemini.mjs --all-teile --count 2 --from-coverage
 *   node scripts/factory-lesen.mjs --count 3
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, ROOT } from './lib/loadEnv.mjs';
import { generateContent as generateGemini, DailyQuotaError } from './lib/geminiClient.mjs';
import {
  trackGenerationCostPending,
  flushGenerationCostLog,
} from './lib/generationCostLog.mjs';
import {
  incrementPartFileFixIteration,
  initPartFileTracker,
  recordPartFileApiCall,
  assertPartFileBrake,
  formatPartFileCostLabel,
  logPartFileOutcome,
  PartFileBrakeError,
  DEFAULT_MAX_ATTEMPTS_PER_FILE,
  DEFAULT_MAX_COST_PER_FILE_USD,
} from './lib/partFileBrake.mjs';
import { extractJson } from './lib/extractJson.mjs';
import { resolveMaxOutputTokens, isLikelyTruncated } from './lib/genOutputTokens.mjs';
import {
  buildLesenPrompt,
  loadWeakLemmas,
  nextOutputBasename,
  pickRandomWords,
  pickTargetWords,
} from './lib/lesenTemplatePrompt.mjs';
import { resolveGenerationFeedbackRules } from './lib/resolveGenerationFeedback.mjs';
import {
  usesB1LesenT3MakeT3,
  usesB1LesenT4DebateSeeds,
} from './lib/a2LesenGeneration.mjs';
import {
  checkLesenBatchQuality,
  formatQualityReport,
  tokenize,
} from './lib/lesenBatchQuality.mjs';
import { checkLesenBatchIngest, formatIngestReport, logCefrCoverageThreshold } from './lib/lesenBatchIngestCheck.mjs';
import { coerceGeneratedLesenPart } from './lib/normalizeBatch.mjs';
import { checkLexical, formatLexicalReport } from './lib/lexicalCheck.mjs';
import {
  collectCalidadLexicoIssues,
  combinedCalidadLexicoGateResult,
  COMBINED_CALIDAD_LEXICO_ISSUE_LIMIT,
} from './lib/calidadLexicoCombinedGate.mjs';
import { validatePart, buildDedupCorpusFromDir } from './lib/partGate.mjs';
import { tagBatchWithTopic, alignQuestionTopicTagsToRequestedTopic } from './lib/topicRotation.mjs';
import { finalizePoolReady } from './lib/finalizePoolReady.mjs';
import { relPathAfterPoolReady } from './lib/resolvePublishFile.mjs';
import { resolveLesenGenerationMolds } from './lib/lesenSubtypeRotation.mjs';
import { extractStructuralMold, structuralMoldKey } from './lib/structuralMoldDedup.mjs';
import { buildPersistedStructuralCorpus } from './lib/persistedCellPool.mjs';
import { checkLesenT5BatchTopic } from './lib/lesenT5TopicFilter.mjs';
import { applyDeterministicExplanationFixes } from './lib/keyExplanationGate.mjs';
import { assessT4TopicAlignment, formatT4TopicAlignmentFailure } from './lib/t4TopicAlign.mjs';
import { checkPassageContentTopic } from './lib/qualityGates/contentTopicCheck.mjs';
import { assertLesenT5NotBankDuplicate } from './lib/lesenT5BankBlocklist.mjs';
import { buildT5BankDuplicateEscalationBlock } from './lib/lesenT5InstitutionSeeds.mjs';
import { checkMcqDistinctIssues } from './lib/mcqDistinctCheck.mjs';
import { classifyAndRepair } from './lib/repairTriage.mjs';
import { applyGermanCapsNormalize } from './lib/germanCapsNormalize.mjs';
import {
  runQ4PipelineGate,
  runQ1ShadowGate,
  runQ3PipelineGate,
  runLanguageToolPipelineAdvisory,
} from './lib/qualityGates/pipelineIntegration.mjs';
import { buildWordCopyFixHint, hasWordMatchSignal } from './lib/wordMatchRepair.mjs';
import { germanExamRepairOutputRulesBlock } from './lib/germanExplanationPromptRules.mjs';
import {
  pickNextNames,
  pushSessionNameExclude,
  extractLesenT4ForumNames,
  injectLesenT4ForumNames,
  TEMPLATE_DEFAULT_NAMES,
} from './lib/nameRotation.mjs';
import {
  pickLesenT4ForumCast,
  recordLesenT4ForumCastFromGeneration,
  enforceLesenT4PlannedForumNames,
} from './lib/dialogueNamesBank.mjs';
import { pickNextLesenT2Opening } from './lib/lesenT2OpeningsBank.mjs';
import {
  buildLesenT2LengthFixHint,
  combinedPassageWordCount,
} from './lib/passageLengthRepair.mjs';
import { runSurgicalRepair, surgicalRepairLabel } from './lib/surgicalRepairRouter.mjs';
import { pushSessionMoldExclude, pushSessionStructuralCorpus } from './lib/poolFillSessionExclude.mjs';
import { resolveGenerationVocab, resolveTargetWordsForArgs, resolveGenerationTopic } from './lib/resolveGenerationInput.mjs';
import {
  loadB2ForumTextBank,
  mergeB2ForumQuestions,
  saveB2ForumTextBank,
  validateB2ForumPassageBank,
} from './lib/lesenB2ForumBank.mjs';
import { attachVocabFeedback, formatVocabFeedbackSummary } from './lib/generationFeedback.mjs';
import { vocabNarrativeCoherenceGate } from './lib/vocabNarrativeCoherence.mjs';
import {
  preflightTopicMoldGeneration,
  countRemainingMolds,
  TopicMoldIncompatibleError,
} from './lib/topicMoldCompatibility.mjs';
import {
  assertTopicMoldCircuitClosed,
  recordTopicMoldAttempt,
  vocabRatioFromBatch,
  TopicMoldCircuitBreakerError,
  excludeTopicMoldForSession,
} from './lib/topicMoldCircuitBreaker.mjs';
import { buildValidatedT3Part } from './make-t3.mjs';
import { isT3BlueprintExhaustedError, listT3BlueprintStockForTopic } from './lib/lesenT3BlueprintStock.mjs';
import {
  GENERATED_DIR,
  generatedDir,
  ensureLevelStagingDirs,
} from './lib/batchPaths.mjs';

loadEnvFile();

function genDirFor(args) {
  const d = generatedDir(args?.level || 'B1');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const EXIT_DAILY_QUOTA = 2;
const EXIT_RATE_LIMIT = 3;
const EXIT_API_BUDGET = 4;
const MIN_PAUSE_MS = 6000;
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_WORD_COUNT = 5;
const RATE_LIMIT_WAIT_MS = 60_000;

function usesApiBudget(provider) {
  return provider === 'gemini';
}

export class ApiBudgetStopError extends Error {
  constructor() {
    super('Presupuesto --max-api-calls alcanzado');
    this.name = 'ApiBudgetStopError';
  }
}

export class RateLimitStopError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitStopError';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function is429Error(err) {
  return /429|rate limit|Resource exhausted|Quota exceeded/i.test(String(err?.message || err));
}

function isProModel(model) {
  const m = String(model || '').toLowerCase();
  return /(?:^|[-_/])pro(?:$|[-_/])/.test(m) || m.includes('gemini-pro');
}

export function resolveLesenModel(modelArg, opts = {}) {
  const model = (modelArg || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  const allowPro =
    opts.allowPro === true ||
    process.env.ALLOW_PRO_MODEL === '1' ||
    process.env.ALLOW_PRO_MODEL === 'true';
  if (isProModel(model) && !allowPro) {
    throw new Error(
      `Modelo Pro no permitido en tier gratuito (${model}). ` +
        'Usa --model gemini-2.5-flash o export ALLOW_PRO_MODEL=1 para experimentos pagados.',
    );
  }
  return model;
}

export function resolveProviderModel(provider, modelArg, opts = {}) {
  return resolveLesenModel(modelArg, opts);
}

export async function resolveLesenProvider(providerArg) {
  if (providerArg) {
    const p = String(providerArg).toLowerCase();
    if (p !== 'gemini') {
      throw new Error('--provider debe ser gemini');
    }
    return p;
  }
  return 'gemini';
}

export function parseArgs(argv) {
  const out = {
    lang: 'de',
    level: 'B1',
    teil: null,
    teileList: null,
    allTeile: false,
    count: 1,
    words: null,
    fromCoverage: false,
    fromBank: false,
    wordCount: DEFAULT_WORD_COUNT,
    refreshCoverage: false,
    dryRun: false,
    skipValidate: false,
    skipQuality: false,
    skipIngest: false,
    apiRetries: 1,
    fixRetries: null,
    pauseMs: Math.max(MIN_PAUSE_MS, Number(process.env.GEMINI_BATCH_PAUSE_MS || MIN_PAUSE_MS)),
    model: null,
    provider: null,
    maxApiCalls: 200,
    maxAttemptsPerFile: DEFAULT_MAX_ATTEMPTS_PER_FILE,
    maxCostPerFileUsd: DEFAULT_MAX_COST_PER_FILE_USD,
    keepFailed: false,
    saveRaw: false,
    topic: null,
    semantic: false,
    skipPoolReady: false,
    forumPhase: null,
    textBankFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') out.lang = String(argv[++i]).toLowerCase();
    else if (a === '--level') out.level = String(argv[++i]).toUpperCase();
    else if (a === '--teil') out.teil = Number(argv[++i]);
    else if (a === '--teile') {
      out.teileList = String(argv[++i] || '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
    } else if (a === '--all-teile') out.allTeile = true;
    else if (a === '--count') out.count = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--words') {
      out.words = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--from-coverage') out.fromCoverage = true;
    else if (a === '--from-bank') out.fromBank = true;
    else if (a === '--word-count') out.wordCount = Math.max(1, Number(argv[++i]) || DEFAULT_WORD_COUNT);
    else if (a === '--refresh-coverage') out.refreshCoverage = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-validate') out.skipValidate = true;
    else if (a === '--skip-quality') out.skipQuality = true;
    else if (a === '--skip-ingest') out.skipIngest = true;
    else if (a === '--skip-pool-ready') out.skipPoolReady = true;
    else if (a === '--api-retries') out.apiRetries = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--fix-retries') out.fixRetries = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--provider') out.provider = String(argv[++i] || '').toLowerCase();
    else if (a === '--pause-ms') out.pauseMs = Math.max(MIN_PAUSE_MS, Number(argv[++i]) || MIN_PAUSE_MS);
    else if (a === '--model') out.model = String(argv[++i] || '').trim();
    else if (a === '--max-api-calls') out.maxApiCalls = Math.max(1, Number(argv[++i]) || 200);
    else if (a === '--max-attempts-per-file') {
      out.maxAttemptsPerFile = Math.max(1, Number(argv[++i]) || DEFAULT_MAX_ATTEMPTS_PER_FILE);
    } else if (a === '--max-cost-per-file') {
      out.maxCostPerFileUsd = Math.max(0.01, Number(argv[++i]) || DEFAULT_MAX_COST_PER_FILE_USD);
    } else if (a === '--keep-failed') out.keepFailed = true;
    else if (a === '--save-raw') out.saveRaw = true;
    else if (a === '--topic') out.topic = String(argv[++i] || '').trim();
    else if (a === '--semantic') out.semantic = true;
    else if (a === '--forum-phase') out.forumPhase = String(argv[++i] || '').toLowerCase();
    else if (a === '--text-bank') out.textBankFile = String(argv[++i] || '').trim();
  }
  out.pauseMs = Math.max(MIN_PAUSE_MS, out.pauseMs);
  return out;
}

function createSession(args) {
  const byTeil = {};
  for (const t of [1, 2, 3, 4, 5]) {
    byTeil[t] = { generated: 0, discarded: 0, attempts: 0 };
  }
  return {
    provider: args.provider,
    model: resolveProviderModel(args.provider, args.model, { allowPro: args.allowProModel }),
    maxApiCalls: args.maxApiCalls,
    minPauseMs: args.pauseMs,
    apiCallsUsed: 0,
    totalAttempts: 0,
    lastApiCallAt: 0,
    stopped: false,
    stopReason: null,
    byTeil,
    geminiUsage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

function trackGeminiUsage(session, usage, args = {}) {
  if (!usage || !session) return;
  session.geminiUsage = session.geminiUsage || { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
  session.geminiUsage.promptTokens += Number(usage.promptTokenCount || usage.input_tokens || 0);
  session.geminiUsage.outputTokens += Number(usage.candidatesTokenCount || usage.output_tokens || 0);
  session.geminiUsage.totalTokens += Number(usage.totalTokenCount || 0);
  // Persistent JSONL (flushed when part attempt resolves — see flushCostForPart).
  const entry = trackGenerationCostPending(session, usage, {
    module: args.module || 'lesen',
    teil: args.teil ?? null,
    topic: args._resolvedTopic || args.topic || null,
    model: session.model,
  });
  if (entry?.costUsd != null) recordPartFileApiCall(session, entry.costUsd);
}

/** Write pending API cost rows with part-level success/fail. */
export function flushCostForPart(session, args, outcome = {}) {
  return flushGenerationCostLog(session, {
    ok: outcome.ok === true,
    file: outcome.file || null,
    failReason: outcome.failReason || null,
    failGate: outcome.failGate || null,
    module: outcome.module || args?.module || 'lesen',
    teil: outcome.teil ?? args?.teil ?? null,
    topic: outcome.topic || args?._resolvedTopic || args?.topic || null,
  });
}

function teileToRun(args) {
  if (args.teileList?.length) return [...new Set(args.teileList)].sort((a, b) => a - b);
  if (args.allTeile) return [1, 2, 3, 4, 5];
  if (!Number.isFinite(args.teil) || args.teil < 1 || args.teil > 5) {
    throw new Error('Indica --teil 1..5, --teile 1,2,5 o --all-teile');
  }
  return [args.teil];
}

function refreshCoverageReport(lang, level) {
  console.log('Actualizando reporte de cobertura…');
  execSync(`node scripts/vocab-coverage-report.mjs --lang ${lang} --level ${level}`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function resolveTargetWords(args) {
  return resolveTargetWordsForArgs(args, { module: 'lesen', teil: args.teil ?? 1 });
}

function validateBatchFile(lang, level, relFile) {
  const res = spawnSync(
    process.execPath,
    ['scripts/validate-batch.mjs', '--lang', lang, '--level', level, '--file', relFile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, output };
}

const LESEN_COMBINED_CALIDAD_LEXICO_TEILE = new Set([3, 4]);

function isLesenCombinedCalidadLexicoTeil(teil) {
  return LESEN_COMBINED_CALIDAD_LEXICO_TEILE.has(Number(teil));
}

function buildFixNote(issues, gate = 'checker', opts = {}) {
  const teilN = Number(opts.teil);
  const combinedTeil = isLesenCombinedCalidadLexicoTeil(teilN);
  const limit = combinedTeil ? COMBINED_CALIDAD_LEXICO_ISSUE_LIMIT : 5;
  const list = (Array.isArray(issues) ? issues : [issues]).filter(Boolean).slice(0, limit);
  const level = String(opts.level || 'B1').trim().toUpperCase();
  let extra = '';
  if (list.some((i) => /slot_not_in_blueprint/i.test(String(i)))) {
    extra =
      '\nCada pregunta y pasaje DEBE incluir `"module":"lesen"` y `"teil":N (número).';
  }
  if (list.some((i) => /type_not_allowed/i.test(String(i)))) {
    if (level === 'A2' && Number(opts.teil) === 1) {
      extra +=
        '\nT1 A2→type "multiple_choice" con options a/b/c (exactamente 5 preguntas). ' +
        'Pasaje: Medientext en 3ª persona (NO ich-Blog B1). PROHIBIDO richtig_falsch. level:"A2".';
    } else if (level === 'A2') {
      extra +=
        '\nA2 Lesen→types según plantilla: T1/T2/T3 MCQ a/b/c · T4 matching · T5 según subtipo. ' +
        'PROHIBIDO richtig_falsch salvo que el blueprint lo permita (A2 no).';
    } else {
      extra +=
        '\nT1→type "richtig_falsch" · T2/T5→"multiple_choice" con options a/b/c · T4→"ja_nein".';
    }
  }
  if (hasWordMatchSignal(list)) {
    if (opts.wordCopyDetail) {
      extra += buildWordCopyFixHint(list, opts.teil ?? 2);
    } else {
      extra +=
        '\nANTI WORD-MATCHING: reescribe cada afirmación/pregunta SIN repetir palabras del pasaje ' +
        '(máx. 2 palabras de contenido iguales). Usa sinónimos.';
    }
  }
  if (list.some((i) => /sesgo de longitud MCQ/i.test(String(i)))) {
    extra +=
      '\nANTI-ATAJO LONGITUD: la opción correcta NO puede ser la más larga. ' +
      'Acorta la correcta o alarga los distractores hasta longitud comparable (mismo nivel de detalle B1).';
  }
  if (list.some((i) => /cefr_gate:length_above_max|length_above_max:wordCount/i.test(String(i)))) {
    extra += buildLesenT2LengthFixHint(opts.combinedWc ?? null);
  }
  if (list.some((i) => /^vocabulario forzado:/i.test(String(i)))) {
    extra +=
      '\nVOCABULARIO FORZADO: las palabras sugeridas son OPCIONALES. Borra la frase citada o ' +
      'reescríbela para que cuente algo del mismo asunto que el resto del texto; si la palabra no ' +
      'encaja en esta noticia/este texto, NO la uses. No añadas frases aisladas para meter vocabulario.';
  }
  // Scope-trap hint eliminado: CHK-10 del auditor gestiona la correlación; no forzamos
  // ningún requisito de absolute-word aquí para evitar el patrón "absoluta→Falsch".
  return (
    `\n\n--- CORRECCIÓN REQUERIDA ---\n` +
    `El checker de ${gate} detectó (${list.length} problema(s)):\n${list.map((i) => `- ${i}`).join('\n')}${extra}\n` +
    (combinedTeil
      ? `Corrige TODOS los problemas listados en una sola respuesta (calidad pedagógica y vocabulario B1).\n`
      : '') +
    `Corrige SOLO esos problemas. Devuelve el JSON completo corregido, sin markdown ni comentarios.` +
    `\n\n${germanExamRepairOutputRulesBlock()}`
  );
}

const INTERNAL_BATCH_PROMPT_KEYS = [
  '_requestedTopic',
  '_debateTopic',
  '_debateSeed',
  '_textSubtype',
  'userVocabFeedback',
];

function cleanBatchForPrompt(batch) {
  if (!batch || typeof batch !== 'object') return null;
  const out = JSON.parse(JSON.stringify(batch));
  for (const k of INTERNAL_BATCH_PROMPT_KEYS) delete out[k];
  return out;
}

function extractAffectedItemIds(issues) {
  const ids = new Set();
  const list = Array.isArray(issues) ? issues : [issues];
  for (const issue of list) {
    if (!issue) continue;
    const s = String(issue);
    for (const m of s.matchAll(/(gen-q-[^\s:\]"']+)/g)) ids.add(m[1]);
    for (const m of s.matchAll(/(gen-l\d+-[^\s:\]"']+)/g)) ids.add(m[1]);
  }
  return ids;
}

function truncatePromptText(text, maxLen = 120) {
  const t = String(text || '');
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}… [truncado]`;
}

function serializeBatchForFixPrompt(batch, issues, maxChars = 12000) {
  let cleaned = cleanBatchForPrompt(batch);
  if (!cleaned) return '';

  const affectedIds = extractAffectedItemIds(issues);
  let json = JSON.stringify(cleaned, null, 1);
  if (json.length <= maxChars) return json;

  const affectedPassageIds = new Set();
  for (const q of cleaned.questions || []) {
    if (affectedIds.has(q.id) && q.passageId) affectedPassageIds.add(q.passageId);
  }

  const shrink = (passageLimit, signTextLimit) => ({
    ...cleaned,
    passages: (cleaned.passages || []).map((p) => {
      if (affectedPassageIds.has(p.id) || affectedIds.has(p.id)) return p;
      return { ...p, text: truncatePromptText(p.text, passageLimit) };
    }),
    questions: (cleaned.questions || []).map((q) => {
      if (affectedIds.has(q.id)) return q;
      if (!q.signText) return q;
      return { ...q, signText: truncatePromptText(q.signText, signTextLimit) };
    }),
  });

  for (const [passageLimit, signTextLimit] of [
    [150, 80],
    [80, 40],
    [40, 20],
  ]) {
    cleaned = shrink(passageLimit, signTextLimit);
    json = JSON.stringify(cleaned, null, 1);
    if (json.length <= maxChars) return json;
  }

  return json;
}

function buildFixRetryPrompt(baseUserPrompt, issues, gate, batch, fixOpts = {}) {
  const note = buildFixNote(issues, gate, fixOpts);
  const list = (Array.isArray(issues) ? issues : [issues]).filter(Boolean);
  const level = String(fixOpts.level || 'B1').trim().toUpperCase();
  const teil = Number(fixOpts.teil);
  const typeMismatch = list.some((i) => /type_not_allowed/i.test(String(i)));
  const mcqFormatBreak = list.some((i) =>
    /correct=["']true["']|correct=["']false["']|options_missing|MCQ requiere exactamente 3 options|no válido para type=["']multiple_choice["']/i.test(
      String(i),
    ),
  );
  if ((typeMismatch || mcqFormatBreak) && level === 'A2' && teil === 1) {
    return (
      `${baseUserPrompt}\n\n--- REGENERACIÓN LIMPIA (formato A2 incorrecto) ---\n` +
      `Ignora cualquier JSON anterior. Genera desde cero: exactamente 5× type "multiple_choice". ` +
      `Cada question con options: ["a) …", "b) …", "c) …"] y correct/correctAnswer = "a"|"b"|"c". ` +
      `PROHIBIDO richtig_falsch, correct "true"/"false", options vacío.${note}`
    );
  }
  if (!batch) return baseUserPrompt + note;
  const json = serializeBatchForFixPrompt(batch, issues);
  return (
    `${baseUserPrompt}\n\n--- TU JSON ANTERIOR (contiene errores) ---\n${json}${note}`
  );
}

function passageForbiddenTokens(text, limit = 25) {
  const freq = new Map();
  for (const t of tokenize(text)) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

function buildRejectedSnapshot(result, fallbackIssue) {
  const gate = result?.gate || 'checker';
  const parts = [];
  if (result?.detail) parts.push(String(result.detail));
  else if (result?.issues?.length) parts.push(result.issues.join('\n'));
  if (result?.issue) parts.unshift(String(result.issue));
  if (fallbackIssue && !parts.some((p) => p.includes(String(fallbackIssue)))) {
    parts.push(String(fallbackIssue));
  }
  const reason = parts.filter(Boolean).join('\n\n') || String(fallbackIssue || 'Generación fallida');
  return { reason, gate };
}

/** T4/T5 fallidos → .rejected/ siempre; resto solo con --keep-failed. */
function shouldArchiveRejectedBatch(args, teil) {
  return args.keepFailed || [4, 5].includes(Number(teil));
}

function saveRejectedBatch(batch, basename, { reason, gate } = {}) {
  const dir = path.join(GENERATED_DIR, '.rejected');
  fs.mkdirSync(dir, { recursive: true });
  const rejectedAt = new Date().toISOString();
  const fileStamp = rejectedAt.replace(/[:.]/g, '-');
  const file = path.join(dir, `${basename.replace(/\.json$/i, '')}-${fileStamp}.json`);
  const payload = {
    _rejectedReason: String(reason || 'Generación fallida'),
    _rejectedGate: String(gate || 'unknown'),
    _rejectedAt: rejectedAt,
    ...batch,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Rechazado guardado en: ${path.relative(ROOT, file).replace(/\\/g, '/')}`);
}

function maybeArchiveRejectedBatch(args, teil, batch, basename, meta) {
  if (!batch || !shouldArchiveRejectedBatch(args, teil)) return;
  saveRejectedBatch(batch, basename, meta);
}

async function buildLesenPromptBundle(teil, words, session, moldCtx = null, args = null) {
  const idSuffix = randomBytes(4).toString('hex');
  const topic =
    args?._resolvedTopic ||
    args?.topic ||
    moldCtx?.promptOpts?.topicTag ||
    moldCtx?.molds?.topicTag ||
    null;

  let promptWords = words;
  let vocabSubtypeAdaptation = null;
  const topicNorm = topic ? String(topic).trim() : null;
  if (Number(teil) === 4 && topicNorm && usesB1LesenT4DebateSeeds(args?.level, teil)) {
    const { adaptT4WordsForDebate } = await import('./lib/lesenT4TopicVocab.mjs');
    const adapted = adaptT4WordsForDebate(words, topicNorm);
    promptWords = adapted.words;
    if (adapted.swapped.length) {
      vocabSubtypeAdaptation = { swapped: adapted.swapped, kept: adapted.kept };
      console.log(`T4 vocab×debate (${topicNorm}): ${adapted.swapped.join(', ')}`);
    }
  }
  if (
    Number(teil) === 5 &&
    moldCtx?.textSubtype &&
    String(args?.level || 'B1').toUpperCase() !== 'B2'
  ) {
    const { resolveT5PromptWords, T5_PROMPT_WORD_CAP } = await import('./lib/lesenT5SubtypeVocab.mjs');
    const cap = Math.min(T5_PROMPT_WORD_CAP, words?.length || T5_PROMPT_WORD_CAP);
    const cursor = String(args?._t5SeedEntropy || topicNorm || '').length;
    promptWords = resolveT5PromptWords(moldCtx.textSubtype, {
      count: cap,
      userWords: words,
      topic: topicNorm,
      cursor,
    });
    vocabSubtypeAdaptation = {
      swapped: [`T5×${moldCtx.textSubtype}: ${promptWords.join(', ')}`],
      kept: [],
    };
    console.log(`T5 vocab×subtipo (${moldCtx.textSubtype}): [${promptWords.join(', ')}]`);
  }
  if (args) {
    args._promptWords = promptWords;
    args._vocabSubtypeAdaptation = vocabSubtypeAdaptation;
  }

  if (Number(teil) === 2 && String(args?.level || 'B1').toUpperCase() === 'B1') {
    if (!args._lesenT2UsedOpenings) args._lesenT2UsedOpenings = new Set();
    const pick = pickNextLesenT2Opening(
      args._lesenT2UsedOpenings,
      `${topic || 't2'}:${Date.now()}`,
      topic,
    );
    if (pick.opening) {
      args._lesenT2UsedOpenings.add(pick.opening);
      args._mandatedLesenT2Opening = pick.opening;
      console.log(`Lesen T2 apertura rotada: «${pick.opening}…»`);
    }
  }

  const feedbackMetaOut = {};
  let feedbackRules = [];
  try {
    feedbackRules = await resolveGenerationFeedbackRules({
      module: 'lesen',
      level: args?.level || 'B1',
      topic: topic || undefined,
      teil: Number(teil),
      lang: args?.lang || 'de',
      enabled: args?.generationFeedbackEnabled,
      feedbackMode: args?.feedbackMode,
      maxRules: args?.maxFeedbackRules,
      feedbackRules: args?.feedbackRules,
      feedback: args?.feedback,
      store: args?.feedbackStore,
    });
  } catch (_) {
    feedbackRules = [];
  }
  const promptOpts = {
    idSuffix,
    topic,
    level: args?.level || 'B1',
    ...(moldCtx?.promptOpts || {}),
    fewShotExamples: args?.fewShotExamples || null,
    minimalRules: args?.minimalPromptRules === true,
    topicTag: topic || moldCtx?.promptOpts?.topicTag,
    feedbackRules,
    generationFeedbackEnabled: args?.generationFeedbackEnabled,
    feedbackMode: args?.feedbackMode,
    maxFeedbackRules: args?.maxFeedbackRules,
    feedbackMetaOut,
    forumPhase: args?.forumPhase || null,
    fixedForumPassages: args?._b2TextBank?.passages || null,
    mandatedLesenT2Opening: args?._mandatedLesenT2Opening || null,
  };
  let fullPrompt = buildLesenPrompt(teil, promptWords, promptOpts);
  if (args?.vocabBgStrictAnchor?.length) {
    const { buildVocabBgMandatoryAnchorBlock } = await import('./lib/userVocabPrompt.mjs');
    const block = buildVocabBgMandatoryAnchorBlock(args.vocabBgStrictAnchor, topic, { horen: false });
    if (block) fullPrompt = `${fullPrompt}\n\n${block}`;
  }
  if (feedbackMetaOut.feedbackRulesApplied > 0) {
    console.log(
      `[generationFeedback] mode=${feedbackMetaOut.feedbackMode || '?'} feedbackRulesApplied: ${feedbackMetaOut.feedbackRulesApplied}`,
    );
  }
  return {
    idSuffix,
    fullPrompt,
    promptWords,
    vocabSubtypeAdaptation,
    systemPrompt: null,
    userPrompt: fullPrompt,
    moldCtx,
    generationMetadata: {
      usedFeedback: !!feedbackMetaOut.usedFeedback,
      feedbackRules: feedbackMetaOut.feedbackRules || [],
      feedbackCount: feedbackMetaOut.feedbackCount || 0,
      feedbackCategories: feedbackMetaOut.feedbackCategories || [],
      feedbackMode: feedbackMetaOut.feedbackMode || 'off',
      feedbackVersion: feedbackMetaOut.feedbackVersion || 'v1',
    },
  };
}

function topicMoldOptsFromArgs(args, teil) {
  const sessionMoldKeys = (args.structuralCorpus || [])
    .map((b) => {
      const mold = extractStructuralMold(b, teil);
      return structuralMoldKey(mold) || mold.key;
    })
    .filter(Boolean);
  return {
    lang: args.lang,
    level: args.level,
    usedMoldKeys: sessionMoldKeys,
    extraExcludeSubtypes: args._excludeSubtypes || [],
    exclude: args._t3ExcludeSlugs instanceof Set ? args._t3ExcludeSlugs : new Set(args._t3ExcludeSlugs || []),
  };
}

function recordLesenMoldAttempt(session, args, teil, topic, batch, { ok, moldGateFailure = false } = {}) {
  const opts = topicMoldOptsFromArgs(args, teil);
  recordTopicMoldAttempt(session, {
    topic,
    teil,
    vocabRatio: batch ? vocabRatioFromBatch(batch, { teil }) : null,
    remainingMolds: countRemainingMolds(teil, topic, opts),
    moldGateFailure,
    ok,
  });
}

function handleTopicMoldBlock(err, settleCostFail, finishPart, teil, partAttempts, session, topicFallback) {
  console.warn(`\n⛔ ${err.message}`);
  console.warn('   → Celda marcada para revisión manual; no se gastan más llamadas API en esta incompatibilidad.');
  const t = err?.topic || topicFallback;
  if (session && t) excludeTopicMoldForSession(session, t, teil);
  settleCostFail(err.message, 'topic-mold-block');
  return finishPart({
    ok: false,
    discarded: true,
    braked: true,
    teil,
    reason: err.message,
    attempts: partAttempts,
    gate: 'topic-mold-block',
  });
}

function resolveMoldContext(args, teil, topicTag) {
  const sessionMoldKeys = (args.structuralCorpus || [])
    .map((b) => {
      const mold = extractStructuralMold(b, teil);
      const mk = structuralMoldKey(mold);
      return mk || mold.key;
    })
    .filter(Boolean);
  const molds = resolveLesenGenerationMolds(teil, {
    lang: args.lang,
    level: args.level,
    topicTag: topicTag ?? args._resolvedTopic ?? args.topic,
    extraExcludeSubtypes: args._excludeSubtypes || [],
    extraExcludeTitles: args._excludeTitles || [],
    extraUsedMoldKeys: sessionMoldKeys,
    forceDebateTopic: args._forceDebateTopic || null,
    seedEntropy: args._t5SeedEntropy || args._t4SeedEntropy || `${topicTag}:${Date.now()}`,
  });
  if (!molds) return null;

  const cellLabel = `${topicTag ?? molds.topicTag}×T${teil}`;

  if (Number(teil) === 5 && molds.subtypeDef) {
    console.log(
      `T5 subtipo: ${molds.subtypeDef.label} (${molds.pickTier || '?'})` +
        (molds.variantProfile ? ` · perfil ${molds.variantProfile}` : '') +
        ` · celda ${cellLabel}: ${molds.cellCount} persistidos` +
        (molds.mandatedTitle ? ` · título «${molds.mandatedTitle.slice(0, 48)}${molds.mandatedTitle.length > 48 ? '…' : ''}»` : '') +
        (molds.excludeMolds.moldKeys?.length
          ? ` · moldes usados: ${molds.excludeMolds.moldKeys.join(', ')}`
          : molds.excludeMolds.subtypes.length
            ? ` · excluye subtipos: ${molds.excludeMolds.subtypes.join(', ')}`
            : ''),
    );
    return {
      textSubtype: molds.textSubtype,
      variantProfile: molds.variantProfile,
      institutionSeed: molds.institutionSeed,
      mandatedTitle: molds.mandatedTitle,
      promptOpts: {
        textSubtype: molds.textSubtype,
        subtypeDef: molds.subtypeDef,
        excludeMolds: molds.excludeMolds,
        institutionSeed: molds.institutionSeed,
        mandatedTitle: molds.mandatedTitle,
        bankEscalation: args._t5BankEscalation || '',
      },
      molds,
    };
  }

  if (Number(teil) === 4 && molds.debateSeed) {
    const seedPreview = molds.debateSeed.length > 72
      ? `${molds.debateSeed.slice(0, 72)}…`
      : molds.debateSeed;
    console.log(
      `T4 seed: ${seedPreview} (${molds.pickTier || '?'}) · celda ${cellLabel}: ${molds.cellCount} persistidos` +
        (molds.mandatedTitle ? ` · título «${molds.mandatedTitle.slice(0, 48)}${molds.mandatedTitle.length > 48 ? '…' : ''}»` : '') +
        (molds.excludeMolds.subtypes.length
          ? ` · excluye seeds: ${molds.excludeMolds.subtypes.length}`
          : ''),
    );
    return {
      debateSeed: molds.debateSeed,
      mandatedTitle: molds.mandatedTitle,
      promptOpts: {
        debateSeed: molds.debateSeed,
        excludeMolds: molds.excludeMolds,
        mandatedTitle: molds.mandatedTitle,
        topicTag: topicTag ?? molds.topicTag ?? args._resolvedTopic ?? args.topic,
      },
      molds,
    };
  }

  return null;
}

function validationIssues(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('==') && !l.startsWith('Preguntas:') && !l.startsWith('Esquema:'));
}

function firstValidationIssue(output) {
  const line = String(output || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line || 'Validación técnica fallida';
}

function isChk29Failure(result) {
  const blob = [result?.issue, ...(result?.issues || []), result?.detail].filter(Boolean).join('\n');
  return /CHK-29/i.test(blob);
}

function isChk27Failure(result) {
  const blob = [result?.issue, ...(result?.issues || []), result?.detail].filter(Boolean).join('\n');
  return /CHK-27/i.test(blob);
}

function isStructuralMoldFailure(result, teil) {
  if (![4, 5].includes(Number(teil))) return false;
  if (isChk29Failure(result)) return true;
  return Number(teil) === 4 && isChk27Failure(result);
}

function tryCalidadExplanationAutoFix(batch, teil, { log = true } = {}) {
  const t = Number(teil);
  if (![2, 5].includes(t)) return { batch, fixed: 0 };
  const out = applyDeterministicExplanationFixes(batch);
  if (out.fixed > 0 && log) {
    console.log(`  CHK-18b: ${out.fixed} explanation(s) auto-corregida(s) (determinista)`);
  }
  return out;
}

async function runQualityAndStructuralGates(args, teil, batch, { onFail, relFile } = {}) {
  // Pre-audit: re-apply decap only (full normalize already ran in coerceGeneratedLesenPart)
  batch = applyGermanCapsNormalize(batch, { decapOnly: true, log: !args.inMemory }).batch;

  if (Number(teil) === 4 && args?._lesenT4ForumNames?.length) {
    batch = enforceLesenT4PlannedForumNames(batch, args._lesenT4ForumNames);
  }

  const gateFile = relFile ? relFile.replace(/\\/g, '/') : '';
  const runNewGates = !args.skipQualityGates && !args.dryRun;

  if (runNewGates) {
    alignQuestionTopicTagsToRequestedTopic(batch);
    const q4 = runQ4PipelineGate(batch, { file: gateFile, profile: 'generated' });
    if (q4.blocked) {
      onFail?.();
      return {
        ok: false,
        gate: 'Q4-metadataSchema',
        issue: q4.issue || 'topic_mismatch',
        issues: q4.verdict.findings
          .filter((f) => f.rule === 'topic_mismatch')
          .map((f) => f.detail)
          .slice(0, 5),
        detail: q4.verdict.findings.map((f) => f.detail).join('\n'),
      };
    }
    runQ1ShadowGate(batch, { file: gateFile, basename: path.basename(gateFile) });
  }

  if (!args.skipQuality) {
    let quality = checkLesenBatchQuality(batch, teil, { file: gateFile, level: args.level });
    const teilN = Number(teil);
    if (!quality.ok && [2, 5].includes(teilN)) {
      const auto = tryCalidadExplanationAutoFix(batch, teilN, { log: !args.inMemory });
      if (auto.fixed > 0) {
        batch = auto.batch;
        quality = checkLesenBatchQuality(batch, teil, { file: gateFile, level: args.level });
      }
    }
    if (!args.inMemory) console.log(formatQualityReport(quality));

    if (isLesenCombinedCalidadLexicoTeil(teilN)) {
      const combined = collectCalidadLexicoIssues(
        batch,
        {
          ok: quality.ok,
          issues: quality.issues || [],
          report: formatQualityReport(quality),
        },
        { level: args.level },
      );
      if (!combined.ok) {
        if (combined.lexIssues.length && !args.inMemory) {
          console.log(formatLexicalReport(combined.lex));
        }
        console.log(
          `  [Lesen T${teil} combined] ${combined.issues.length} issue(s) ` +
            `(calidad ${combined.calidadIssues.length}, léxico ${combined.lexIssues.length})`,
        );
        for (const line of combined.issues.slice(0, COMBINED_CALIDAD_LEXICO_ISSUE_LIMIT)) {
          console.log(`    · ${line}`);
        }
        onFail?.();
        const mcqHits = checkMcqDistinctIssues(batch, teil).findings;
        return {
          ...combinedCalidadLexicoGateResult(combined, { label: `lesen-t${teil}` }),
          detail: combined.report,
          sem2Findings: mcqHits.map((f) => ({ itemId: f.itemId, detail: f.detail })),
        };
      }
      if (!args.inMemory && combined.lex.warnings?.length) {
        console.log(formatLexicalReport(combined.lex));
      }
    } else if (!quality.ok) {
      onFail?.();
      const mcqHits = checkMcqDistinctIssues(batch, teil).findings;
      return {
        ok: false,
        gate: 'calidad',
        issue: quality.issues?.[0] || 'Calidad pedagógica FAIL',
        issues: (quality.issues || []).slice(0, 5),
        detail: formatQualityReport(quality),
        sem2Findings: mcqHits.map((f) => ({ itemId: f.itemId, detail: f.detail })),
      };
    }
  }

  if (!args.skipQuality && !isLesenCombinedCalidadLexicoTeil(Number(teil))) {
    const lex = checkLexical(batch, { level: args.level });
    if (!lex.ok) {
      if (!args.inMemory) console.log(formatLexicalReport(lex));
      onFail?.();
      return {
        ok: false,
        gate: 'lexico',
        issue: lex.issues[0] || 'Error léxico',
        issues: lex.issues.slice(0, 5),
        detail: formatLexicalReport(lex),
      };
    }
    if (!args.inMemory && lex.warnings?.length) console.log(formatLexicalReport(lex));
  }

  if (!args.skipQuality) {
    let dedupCorpus = args.dedupCorpus ?? null;
    if (!args.skipDedup && !dedupCorpus) {
      try {
        const currentIds = new Set((batch.passages || []).map((p) => p.id).filter(Boolean));
        dedupCorpus = buildDedupCorpusFromDir(genDirFor(args), fs, path)
          .filter((e) => !currentIds.has(e.id));
      } catch (e) {
        if (!args.inMemory) console.warn(`  ⚠ dedup corpus omitido: ${e.message}`);
      }
    }

    const topicForCorpus =
      batch._requestedTopic || batch.topicTag || args._resolvedTopic || args.topic;
    const persistedCorpus =
      topicForCorpus && [4, 5].includes(Number(teil))
        ? buildPersistedStructuralCorpus({
            lang: args.lang,
            level: args.level,
            topicTag: topicForCorpus,
            teil,
          })
        : [];
    const structuralCorpus = [
      ...(Array.isArray(args.structuralCorpus) ? args.structuralCorpus : []),
      ...persistedCorpus,
    ];

    const gate = await validatePart(batch, {
      semantic: args.semantic === true,
      skipSem2: args.skipSem2 === true,
      skipNormalize: true,
      skipDedup: args.skipDedup || !dedupCorpus?.length,
      dedupCorpus,
      structuralCorpus: structuralCorpus.length ? structuralCorpus : null,
      structuralCorpusDir: structuralCorpus.length ? null : (args.structuralCorpusDir ?? genDirFor(args)),
      dedupThreshold: args.dedupThreshold ?? 0.55,
      module: 'lesen',
      teil,
      lang: args.lang,
      level: args.level,
    });

    if (!args.inMemory && gate.dedup?.warnings?.length) {
      for (const w of gate.dedup.warnings) console.log(`  ⚠ dedup: ${w}`);
    }

    if (!gate.ok) {
      const first = gate.blocking[0];
      const isDedup = first?.id === 'DEDUP';
      const isMcqDistinct =
        first?.id === 'CHK-28' ||
        (gate.blocking || []).some((f) => f.id === 'CHK-28');
      const issue = first?.message || (isDedup ? 'Deduplicación FAIL' : 'audit-pass-2 IMPORTANT');
      if (!args.inMemory) {
        if (isDedup) console.log(`Deduplicación FAIL: ${issue}`);
        else console.log(`Audit-pass-2 BLOQUEADO: [${first?.severity}][${first?.id}] ${issue}`);
      }
      onFail?.();
      return {
        ok: false,
        gate: isDedup ? 'dedup' : isMcqDistinct ? 'calidad' : 'audit2',
        issue,
        issues: gate.blocking.slice(0, 5).map((f) => `[${f.severity}][${f.id}] ${f.message}`),
        detail: gate.blocking.map((f) => f.message).join('\n'),
        batch: gate.batch,
        sem2Findings: gate.blocking
          .filter((f) => f.id === 'CHK-28')
          .map((f) => ({ itemId: f.scope, detail: f.message })),
      };
    }
    batch = gate.batch;
  }

  if (!args.skipQuality && teil === 5 && String(args.level || 'B1').toUpperCase() !== 'B2') {
    const t5Topic = checkLesenT5BatchTopic(batch);
    if (!t5Topic.ok) {
      onFail?.();
      return {
        ok: false,
        gate: 'content_topic',
        issue: t5Topic.issue,
        issues: [t5Topic.issue],
        detail: t5Topic.issue,
        rule: t5Topic.rule,
      };
    }
  }

  if (!args.skipQuality && teil === 3 && String(args.level || batch.level || 'B1').toUpperCase() === 'A2') {
    const batchTag = batch.topicTag || batch._requestedTopic;
    for (const p of batch.passages || []) {
      const introTag = batchTag || p?.topicTag;
      if (!introTag) continue;
      const ct = checkPassageContentTopic(
        { ...p, topicTag: introTag },
        { level: 'A2', teil: 3, module: 'lesen' },
      );
      if (ct.mismatch) {
        onFail?.();
        const issue = ct.detail || `T3 A2 topic «${introTag}» ≠ contenido`;
        return {
          ok: false,
          gate: 'content_topic',
          issue,
          issues: [issue],
          detail: issue,
          rule: 'content_topic_mismatch',
        };
      }
    }
  }

  if (!args.skipQuality && teil === 4) {
    const p0 = batch.passages?.[0] || batch.passage;
    const introTag = batch.topicTag || batch._requestedTopic || p0?.topicTag;
    if (p0 && introTag) {
      const ct = checkPassageContentTopic({ ...p0, topicTag: introTag });
      if (ct.mismatch) {
        onFail?.();
        const issue = ct.detail || `intro detectada «${ct.detected}» ≠ «${introTag}»`;
        return {
          ok: false,
          gate: 'content_topic',
          issue,
          issues: [issue],
          detail: issue,
          rule: 'content_topic_mismatch',
        };
      }
    }
    const t4Topic = assessT4TopicAlignment(batch);
    const isA2T4 = String(args.level || batch.level || '').toUpperCase() === 'A2';
    const isB2T4 = String(args.level || batch.level || '').toUpperCase() === 'B2';
    if (!isA2T4 && !isB2T4 && !t4Topic.ok && !t4Topic.skip) {
      const issue = formatT4TopicAlignmentFailure(t4Topic) || 'T4 topic mismatch';
      onFail?.();
      return {
        ok: false,
        gate: 'content_topic',
        issue,
        issues: [issue],
        detail: issue,
        rule: t4Topic.reason || 'content_topic_mismatch',
      };
    }
  }

  if (runNewGates && !args.skipQuality) {
    runQ3PipelineGate(batch, { file: gateFile });
    if (!args.skipLanguageTool) {
      await runLanguageToolPipelineAdvisory(batch, {
        file: gateFile,
        skipLanguageTool: false,
      });
    }
  }

  return { ok: true, batch };
}

async function runDualGates(args, teil, batch, relFile) {
  const {
    _rejectedReason: _r,
    _rejectedGate: _g,
    _rejectedAt: _a,
    _scoreEstimate: _s,
    ...cleanBatch
  } = batch;
  batch = cleanBatch;

  if (args.inMemory) {
    const gates = await runQualityAndStructuralGates(args, teil, batch, { relFile });
    if (!gates.ok) return gates;
    return { ok: true, batch: gates.batch || batch };
  }

  const absPath = path.join(ROOT, relFile);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');

  const unlinkTmp = () => {
    try { fs.unlinkSync(absPath); } catch (_) { /* ignore */ }
  };

  if (!args.skipValidate) {
    const validation = validateBatchFile(args.lang, args.level, relFile);
    if (!validation.ok) {
      unlinkTmp();
      return {
        ok: false,
        gate: 'formato',
        issue: validationIssues(validation.output)[0] || 'Validación técnica fallida',
        issues: validationIssues(validation.output).slice(0, 5),
        detail: validation.output,
      };
    }
  }

  const gates = await runQualityAndStructuralGates(args, teil, batch, { onFail: unlinkTmp, relFile });
  if (!gates.ok) return gates;
  const finalBatch = gates.batch || batch;
  // Early write above is for validateBatchFile only. Gates apply decapOnly in memory —
  // without this rewrite, --skip-pool-ready leaves the pre-gate (often re-capped) file on disk.
  if (!args.dryRun) {
    fs.writeFileSync(absPath, `${JSON.stringify(finalBatch, null, 2)}\n`, 'utf8');
  }
  return { ok: true, batch: finalBatch };
}

async function queuePause(session) {
  if (!session.lastApiCallAt) return;
  const elapsed = Date.now() - session.lastApiCallAt;
  if (elapsed < session.minPauseMs) {
    const wait = session.minPauseMs - elapsed;
    console.log(`Cola API: pausa ${(wait / 1000).toFixed(1)}s…`);
    await sleep(wait);
  }
}

function budgetRemaining(session) {
  return Math.max(0, session.maxApiCalls - session.apiCallsUsed);
}

async function callLlm(session, args, { prompt, maxTokens, thinkingConfig, ...rest }) {
  return callGemini(session, args, { prompt, maxTokens, thinkingConfig, ...rest });
}

async function callGemini(session, args, { prompt, maxTokens, thinkingConfig }) {
  if (session.apiCallsUsed >= session.maxApiCalls) {
    session.stopped = true;
    session.stopReason = 'max-api-calls';
    throw new ApiBudgetStopError();
  }

  await queuePause(session);

  assertPartFileBrake(session, args);

  const doCall = async () => {
    session.apiCallsUsed += 1;
    session.totalAttempts += 1;
    session.lastApiCallAt = Date.now();
    const costLabel = session._partFile ? ` · ${formatPartFileCostLabel(session)}` : '';
    console.log(
      `Llamada API ${session.apiCallsUsed}/${session.maxApiCalls}${costLabel} · ${session.model}`,
    );
    return generateGemini({
      prompt,
      maxTokens,
      model: session.model,
      jsonMode: true,
      thinkingConfig,
      // max503Retries: retries specifically for transient 5xx/503 errors.
      // Decoupled from apiRetries (quality/format retries) so 503s are
      // retried aggressively without consuming quality-retry budget.
      max503Retries: 8,
    });
  };

  try {
    const result = await doCall();
    trackGeminiUsage(session, result.usage, args);
    return result;
  } catch (err) {
    if (err instanceof DailyQuotaError || err?.name === 'DailyQuotaError') throw err;
    if (!is429Error(err)) throw err;

    console.warn('\n⏳ 429 rate limit — esperando 60s para UN reintento…');
    await sleep(RATE_LIMIT_WAIT_MS);

    if (session.apiCallsUsed >= session.maxApiCalls) {
      session.stopped = true;
      session.stopReason = '429';
      throw new RateLimitStopError(
        'Gemini 429 tras esperar 60s y sin presupuesto de API restante. Para sin quemar más cuota.',
      );
    }

    await queuePause(session);
    try {
      const result = await doCall();
      trackGeminiUsage(session, result.usage, args);
      return result;
    } catch (err2) {
      session.stopped = true;
      session.stopReason = '429';
      throw new RateLimitStopError(
        `Gemini 429 persistente tras esperar 60s: ${err2.message}\nPara sin quemar más intentos.`,
      );
    }
  }
}

function finalizeIngest(args, teil, batch, basename, relFile) {
  console.log(
    `Guardado: ${relFile} (${batch.questions.length} preguntas, ${(batch.passages || []).length} passages)`,
  );

  if (args.skipValidate) {
    console.log('Validación omitida (--no-validate)');
  } else {
    console.log('Validación técnica OK ✅');
  }

  if (!args.skipQuality) {
    console.log('Calidad pedagógica OK ✅');
  }

  if (!args.skipIngest) {
    console.log('Comprobando pre-ingest (CEFR + staging)…');
    const ingest = checkLesenBatchIngest(batch, {
      lang: args.lang,
      level: args.level,
      batchId: basename,
    });
    console.log(formatIngestReport(ingest));
    if (!ingest.ok) {
      const errors = ingest.results.flatMap((r) => r.errors || []);
      return {
        ok: false,
        discarded: true,
        teil,
        reason: 'pre-ingest',
        gate: 'cefr',
        issue: errors.join('; ') || 'pre-ingest',
        issues: errors,
        ingest,
        file: relFile,
      };
    }
  }

  console.log(
    `Siguiente: node scripts/ingest-to-staging.mjs --lang ${args.lang} --level ${args.level} --file ${relFile} --auto-approve`,
  );
  return { ok: true, file: relFile, teil };
}

async function finalizeBatch(args, teil, batch, basename, relFile) {
  const gates = await runDualGates(args, teil, batch, relFile);
  if (!gates.ok) {
    return {
      ok: false,
      discarded: true,
      teil,
      reason: gates.issue,
      issue: gates.issue,
      issues: gates.issues,
      gate: gates.gate,
      detail: gates.detail,
      file: relFile,
      batch: gates.batch,
      sem2Findings: gates.sem2Findings,
    };
  }
  batch = gates.batch || batch;
  if (args.inMemory && !args.writeFile) {
    return { ok: true, batch, teil };
  }

  const absPath = path.join(ROOT, relFile);
  if (args.inMemory && args.writeFile && !args.dryRun) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
    console.log(
      `Guardado: ${relFile} (${batch.questions.length} preguntas, ${(batch.passages || []).length} passages)`,
    );
  }

  if (!args.dryRun && !args.skipPoolReady) {
    try {
      const promo = await finalizePoolReady(absPath, batch, {
        level: args.level,
        skipQ1: args.skipQ1 === true,
      });
      relFile = relPathAfterPoolReady(relFile, promo.poolPath);
      const contentOkLesen =
        promo.q1OnlyReject ||
        String(promo.poolPath || '').replace(/\\/g, '/').includes('pool-content-ok-lesen');
      if (promo.verdict !== 'READY' && !contentOkLesen) {
        return {
          ok: false,
          discarded: true,
          teil,
          reason: (promo.reasons || []).slice(0, 3).join(', ') || 'pool_ready_reject',
          issue: (promo.reasons || [])[0] || 'pool_ready_reject',
          issues: promo.reasons || [],
          gate: 'poolReady',
          file: relFile,
          batch,
        };
      }
    } catch (err) {
      console.warn(`  [poolReady] aviso: ${err.message}`);
      if (args.inMemory) {
        return { ok: false, reason: err.message, teil, batch, file: relFile };
      }
    }
  }

  if (args.inMemory) {
    return { ok: true, batch, file: relFile, teil };
  }
  return finalizeIngest(args, teil, batch, basename, relFile);
}

async function generateT3Part(args, session) {
  const words = resolveTargetWords(args);
  if (!args.inMemory) {
    console.log(`\n── Lesen T3 · make-t3 (0 llamadas API) ──`);
    console.log(`Palabras objetivo (${words.length}): ${words.join(', ') || '(ninguna)'}`);
  }

  if (args.dryRun) {
    console.log('[dry-run] buildValidatedT3Part (in-process, 0 API)');
    return { ok: true, dryRun: true, teil: 3, words, apiCalls: 0 };
  }

  try {
    const requestedTopic = args._resolvedTopic || args.topic || null;
    if (requestedTopic) {
      preflightTopicMoldGeneration(3, requestedTopic, topicMoldOptsFromArgs(args, 3));
    }
    const exclude = args._t3ExcludeSlugs instanceof Set ? args._t3ExcludeSlugs : new Set(args._t3ExcludeSlugs || []);
    let batch = buildValidatedT3Part({
      words,
      maxAttempts: 8,
      exclude,
      requestedTopic,
    });
    const slug = batch._blueprintSlug || '';
    if (slug) {
      if (!(args._t3ExcludeSlugs instanceof Set)) args._t3ExcludeSlugs = new Set();
      args._t3ExcludeSlugs.add(slug);
    }
    const topic =
      args._resolvedTopic ||
      args.topic ||
      resolveGenerationTopic(args, { module: 'lesen', teil: 3 });
    batch = tagBatchWithTopic(batch, topic);
    if (args._resolvedTopic || args.topic) {
      batch._requestedTopic = args._resolvedTopic || args.topic;
    }
    batch.teil = 3;
    const tag = 'gemini';
    const basename = nextOutputBasename(3, tag);
    const relFile = args.inMemory && !args.writeFile
      ? 'memory-t3.json'
      : path.relative(ROOT, path.join(genDirFor(args), basename)).replace(/\\/g, '/');
    const result = await finalizeBatch(args, 3, batch, basename, relFile);
    if (result.ok) return { ...result, words, apiCalls: 0 };
    return { ...result, words, apiCalls: 0, discarded: true, teil: 3, reason: result.reason || result.issue };
  } catch (err) {
    if (err instanceof TopicMoldIncompatibleError) {
      return {
        ok: false,
        discarded: true,
        teil: 3,
        reason: err.message,
        apiCalls: 0,
        t3BlueprintExhausted: true,
        gate: 'topic-mold-block',
      };
    }
    if (!(args._t3ExcludeSlugs instanceof Set)) args._t3ExcludeSlugs = new Set();
    for (const slug of err.failedSlugs || []) {
      if (slug) args._t3ExcludeSlugs.add(slug);
    }
    if (err.lastSlug) args._t3ExcludeSlugs.add(err.lastSlug);
    const requestedTopic = args._resolvedTopic || args.topic || null;
    let t3BlueprintExhausted = isT3BlueprintExhaustedError(err);
    if (!t3BlueprintExhausted && requestedTopic) {
      const stock = listT3BlueprintStockForTopic(requestedTopic, args._t3ExcludeSlugs);
      t3BlueprintExhausted = !stock.generatable;
    }
    return {
      ok: false,
      discarded: true,
      teil: 3,
      reason: err.message,
      apiCalls: 0,
      t3BlueprintExhausted,
    };
  }
}

async function generateLlmPart(args, teil, session) {
  args.module = 'lesen';
  args.teil = teil;
  const settleCostOk = (file) =>
    flushCostForPart(session, args, {
      ok: true,
      file,
      module: 'lesen',
      teil,
      topic: args._resolvedTopic || args.topic || null,
    });
  const settleCostFail = (reason, gate = null) =>
    flushCostForPart(session, args, {
      ok: false,
      failReason: reason,
      failGate: gate,
      module: 'lesen',
      teil,
      topic: args._resolvedTopic || args.topic || null,
    });
  args.teil = teil;
  const levelUpper = String(args?.level || 'B1').toUpperCase();
  if (levelUpper === 'B2' && Number(teil) === 1) {
    const fp = args.forumPhase;
    if (!fp || !['passage', 'questions', 'a', 'b'].includes(fp)) {
      throw new Error('B2 Lesen T1: indica --forum-phase passage|questions');
    }
    args.forumPhase = fp === 'a' ? 'passage' : fp === 'b' ? 'questions' : fp;
    if (args.forumPhase === 'questions') {
      if (!args.textBankFile) {
        throw new Error('B2 Lesen T1 Fase B: indica --text-bank <archivo.json del banco>');
      }
      args._b2TextBank = loadB2ForumTextBank(args.textBankFile);
      console.log(`Text bank: ${path.relative(ROOT, args._b2TextBank._textBankPath).replace(/\\/g, '/')}`);
    } else {
      args.skipPoolReady = true;
    }
  }
  const words = resolveTargetWords(args);
  const tag = 'gemini';

  const gDir = genDirFor(args);
  ensureLevelStagingDirs(args?.level || 'B1');

  const chosenTopic = args._resolvedTopic || resolveGenerationTopic(args, { module: 'lesen', teil });
  console.log(`Tema: ${chosenTopic}${args.topic ? ' (elegido)' : ' (rotación)'}`);
  args._resolvedTopic = chosenTopic;

  let moldCtx;
  try {
    moldCtx = resolveMoldContext(args, teil, chosenTopic);
  } catch (err) {
    if (err?.name === 'TopicMoldExhaustedError') {
      settleCostFail(err.message, 'topic-mold-block');
      return {
        ok: false,
        discarded: true,
        braked: true,
        teil: Number(teil),
        reason: err.message,
        attempts: 0,
        gate: 'topic-mold-block',
      };
    }
    throw err;
  }
  let promptBundle = await buildLesenPromptBundle(teil, words, session, moldCtx, args);
  let applyT4ForumNames = null;
  if (Number(teil) === 4 && usesB1LesenT4DebateSeeds(args?.level, teil)) {
    const levelDir = levelUpper;
    const nameExtraDirs = [
      path.join(ROOT, 'batches/ready/pool-verified', levelDir),
      path.join(ROOT, 'batches/needs-regeneration', levelDir),
    ].filter((d) => fs.existsSync(d));
    applyT4ForumNames = (bundle) => {
      if (!args._lesenT4ForumCastSessionExclude) args._lesenT4ForumCastSessionExclude = new Set();
      const pick = pickLesenT4ForumCast({
        level: levelDir,
        teil: 4,
        sessionExclude: args._excludeNames || [],
        sessionExcludeCasts: args._lesenT4ForumCastSessionExclude,
        entropy: `${chosenTopic || 't4'}:${args._t4SeedEntropy || Date.now()}`,
        extraDirs: nameExtraDirs,
      });
      const forumNames = pick.names;
      args._lesenT4ForumNames = forumNames;
      args._lesenT4ForumCastSignature = pick.castSignature;
      pushSessionNameExclude(args, forumNames);
      console.log(
        `Nombres foro T4: ${forumNames.join(', ')} (cast ${pick.castSignature.slice(0, 48)}… · dialogueNamesBank)`,
      );
      const nameOpts = { useNames: forumNames, avoidNames: TEMPLATE_DEFAULT_NAMES };
      return {
        ...bundle,
        userPrompt: injectLesenT4ForumNames(bundle.userPrompt, nameOpts),
        fullPrompt: bundle.fullPrompt
          ? injectLesenT4ForumNames(bundle.fullPrompt, nameOpts)
          : bundle.fullPrompt,
      };
    };
    promptBundle = applyT4ForumNames(promptBundle);
  }
  let prompt = promptBundle.userPrompt;
  let baseUserPrompt = prompt;

  const resetPromptFresh = async (hint) => {
    const entropyBump = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    if (Number(teil) === 5) {
      args._t5SeedEntropy = `${chosenTopic}:${entropyBump}`;
    } else if (Number(teil) === 4) {
      args._t4SeedEntropy = `${chosenTopic}:t4:${entropyBump}`;
    }
    moldCtx = resolveMoldContext(args, teil, chosenTopic);
    promptBundle = await buildLesenPromptBundle(teil, words, session, moldCtx, args);
    if (applyT4ForumNames) promptBundle = applyT4ForumNames(promptBundle);
    const base = promptBundle.userPrompt;
    prompt = hint
      ? `${base}\n\nNota: intento anterior rechazado por calidad (${hint}). Genera contenido NUEVO desde cero con el subtipo obligatorio.`
      : base;
    promptBundle = { ...promptBundle, userPrompt: prompt, fullPrompt: prompt };
    baseUserPrompt = prompt;
  };

  const resolveMaxTokens = () => resolveMaxOutputTokens(session.provider, 'lesen', teil);

  const basename = nextOutputBasename(teil, tag);
  const outFile = path.join(gDir, basename);
  const relFile = path.relative(ROOT, outFile).replace(/\\/g, '/');
  let maxTokens = resolveMaxTokens();

  console.log(`\n── Lesen T${teil} · ${basename} ──`);
  console.log(`Proveedor: ${session.provider} · Palabras (${promptBundle.promptWords?.length ?? words.length}): ${(promptBundle.promptWords ?? words).join(', ')}`);
  console.log(`Modelo: ${session.model} · max_output_tokens=${maxTokens}`);

  initPartFileTracker(session, args, { relFile });

  if (args.dryRun) {
    console.log('\n[dry-run] Prompt (primeras 1200 chars):\n');
    console.log(prompt.slice(0, 1200) + (prompt.length > 1200 ? '…' : ''));
    console.log(`\n[dry-run] Se guardaría en: ${relFile}`);
    return { ok: true, dryRun: true, file: relFile, teil, words };
  }

  if (usesApiBudget(session.provider) && budgetRemaining(session) <= 0) {
    session.stopped = true;
    session.stopReason = 'max-api-calls';
    throw new ApiBudgetStopError();
  }

  let partAttempts = 0;
  let lastIssue = null;
  let lastGate = null;
  let lastBatch = null;
  let wordCopyFixHintUsed = false;

  const finishPart = (result) => {
    logPartFileOutcome(session, {
      ok: result.ok,
      braked: result.braked,
      reason: result.reason,
    });
    return result;
  };

  const handlePartBrake = (err) => {
    console.warn(`\n⛔ ${err.message}`);
    console.warn('   → Se abandona este archivo; el lote/celda continúa con el siguiente intento.');
    settleCostFail(err.message, 'part-brake');
    return finishPart({
      ok: false,
      discarded: true,
      braked: true,
      teil,
      reason: err.message,
      attempts: partAttempts,
      gate: 'part-brake',
    });
  };

  try {
    const isB2LesenIntegrated = String(args.level || '').toUpperCase() === 'B2' && [3, 4, 5].includes(Number(teil));
    if ([3, 4, 5].includes(Number(teil)) && !isB2LesenIntegrated) {
      const preflight = preflightTopicMoldGeneration(teil, chosenTopic, topicMoldOptsFromArgs(args, teil));
      console.log(
        `Molde preflight T${teil}×${chosenTopic}: ${preflight.compatible} compatible(s), ${preflight.remaining} restante(s)`,
      );
      if (Number(teil) === 5 && preflight.remaining <= 0) {
        throw new TopicMoldIncompatibleError({
          topic: chosenTopic,
          teil: Number(teil),
          compatible: preflight.compatible,
          message:
            `Lesen T5×${chosenTopic}: 0 moldes restantes en celda (preflight) — ampliar perfiles/subtipos o revisión manual.`,
        });
      }
      assertTopicMoldCircuitClosed(session, chosenTopic, teil, topicMoldOptsFromArgs(args, teil));
    }
  } catch (err) {
    if (err instanceof TopicMoldIncompatibleError || err instanceof TopicMoldCircuitBreakerError) {
      return handleTopicMoldBlock(err, settleCostFail, finishPart, teil, partAttempts, session, chosenTopic);
    }
    throw err;
  }

  const resetPromptWithFix = (issues, gate, batch = lastBatch) => {
    const issueList = (Array.isArray(issues) ? issues : [issues]).filter(Boolean);
    const useWordCopyDetail = !wordCopyFixHintUsed && hasWordMatchSignal(issueList);
    if (useWordCopyDetail) wordCopyFixHintUsed = true;
    prompt = buildFixRetryPrompt(baseUserPrompt, issues, gate, batch, {
      teil,
      level: args?.level,
      wordCopyDetail: useWordCopyDetail,
      combinedWc: Number(teil) === 2 && batch ? combinedPassageWordCount(batch) : null,
    });
    if (batch) {
      maxTokens = Math.max(resolveMaxTokens(), maxTokens + 1024);
    }
  };

  for (let fix = 0; fix <= args.fixRetries; fix++) {
    partAttempts += 1;
    incrementPartFileFixIteration(session);
    maxTokens = resolveMaxTokens();
    if (fix > 0) {
      console.log(`\nReintento ${fix}/${args.fixRetries} · ${lastIssue || 'checker'}…`);
    }

    let text;
    let usage;
    let stopReason;
    let lastApiError = null;

    for (let attempt = 1; attempt <= args.apiRetries; attempt++) {
      try {
        if (attempt > 1) console.log(`Reintento API ${attempt}/${args.apiRetries}…`);
        const result = await callLlm(session, args, { prompt, maxTokens });
        text = result.text;
        usage = result.usage;
        stopReason = result.stopReason;
        lastApiError = null;
        break;
      } catch (err) {
        if (err instanceof PartFileBrakeError) {
          return handlePartBrake(err);
        }
        if (
          err instanceof ApiBudgetStopError ||
          err instanceof RateLimitStopError ||
          err instanceof DailyQuotaError
        ) {
          throw err;
        }
        lastApiError = err;
        console.error(`Error ${session.provider}: ${err.message}`);
        if (attempt >= args.apiRetries) {
          if (fix >= args.fixRetries) {
            return {
              ok: false,
              discarded: true,
              teil,
              reason: err.message,
              attempts: partAttempts,
            };
          }
          lastIssue = err.message;
          break;
        }
      }
    }

    if (!text) {
      if (fix < args.fixRetries) {
        resetPromptWithFix(lastApiError?.message || 'sin respuesta del modelo', 'generación');
        continue;
      }
      return {
        ok: false,
        discarded: true,
        teil,
        reason: lastApiError?.message || 'sin respuesta del modelo',
        attempts: partAttempts,
      };
    }

    if (isLikelyTruncated(session.provider, usage, maxTokens, stopReason)) {
      const msg = `JSON truncado (max_output_tokens=${maxTokens})`;
      lastIssue = msg;
      if (fix < args.fixRetries) {
        resetPromptWithFix(msg, 'formato');
        continue;
      }
      return { ok: false, discarded: true, teil, reason: msg, attempts: partAttempts };
    }

    let batch;
    try {
      batch = extractJson(text);
    } catch (err) {
      lastIssue = err.message;
      if (fix < args.fixRetries) {
        resetPromptWithFix(err.message, 'formato');
        continue;
      }
      return { ok: false, discarded: true, teil, reason: err.message, attempts: partAttempts };
    }

    if (!batch || typeof batch !== 'object' || !Array.isArray(batch.questions)) {
      const msg = 'JSON raíz inválido (falta array questions)';
      lastIssue = msg;
      if (fix < args.fixRetries) {
        resetPromptWithFix(msg, 'formato');
        continue;
      }
      return { ok: false, discarded: true, teil, reason: msg, attempts: partAttempts };
    }

    if (args.saveRaw) {
      const rawBasename = basename.replace(/\.json$/i, '.raw.json');
      const rawPath = path.join(gDir, rawBasename);
      fs.mkdirSync(path.dirname(rawPath), { recursive: true });
      fs.writeFileSync(rawPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
      console.log(`  [save-raw] ${path.relative(ROOT, rawPath).replace(/\\/g, '/')}`);
    }

    batch = coerceGeneratedLesenPart(batch, {
      module: 'lesen',
      teil,
      lang: args.lang,
      level: args.level,
      rootTopicTag: chosenTopic,
    });
    batch = tagBatchWithTopic(batch, chosenTopic);
    if (args._resolvedTopic || args.topic) {
      batch._requestedTopic = args._resolvedTopic || args.topic;
    }
    if (moldCtx?.textSubtype) {
      batch._textSubtype = moldCtx.textSubtype;
    }
    if (moldCtx?.institutionSeed?.institutionName) {
      batch._t5InstitutionSeed = moldCtx.institutionSeed.institutionName;
    }
    if (moldCtx?.institutionSeed?.variantProfile || moldCtx?.variantProfile) {
      batch._t5VariantProfile = moldCtx.institutionSeed?.variantProfile || moldCtx.variantProfile;
    }
    const mandatedTitle = moldCtx?.mandatedTitle || moldCtx?.molds?.mandatedTitle;
    if (mandatedTitle && batch.passages?.[0]) {
      batch._mandatedTitle = mandatedTitle;
      const got = String(batch.passages[0].title || '').trim();
      if (got !== mandatedTitle) {
        console.log(`  Título corregido: «${got.slice(0, 40)}…» → «${mandatedTitle.slice(0, 48)}…»`);
        batch.passages[0].title = mandatedTitle;
      }
    }

    if (Number(teil) === 5 && !args.skipDedup) {
      const bankCheck = assertLesenT5NotBankDuplicate(batch, {
        lang: args.lang,
        level: args.level,
      });
      if (!bankCheck.ok) {
        console.log(`  Lesen T5 bank-dedup FAIL: ${bankCheck.issue}`);
        lastIssue = bankCheck.issue;
        args._t5BankEscalation = buildT5BankDuplicateEscalationBlock(bankCheck);
        if (fix < args.fixRetries) {
          settleCostFail(bankCheck.issue, 'bank-dedup');
          await resetPromptFresh(`regurgitación banco (${bankCheck.matchTitle || bankCheck.passageId})`);
          fix -= 1;
          continue;
        }
        settleCostFail(bankCheck.issue, 'bank-dedup');
        maybeArchiveRejectedBatch(args, teil, lastBatch, basename, {
          reason: bankCheck.issue,
          gate: 'bank-dedup',
        });
        return finishPart({
          ok: false,
          discarded: true,
          teil,
          reason: bankCheck.issue,
          attempts: partAttempts,
          gate: 'bank-dedup',
        });
      }
      args._t5BankEscalation = '';
    }

    if (moldCtx?.debateSeed || moldCtx?.molds?.debateSeed) {
      batch._debateSeed = moldCtx.debateSeed || moldCtx.molds.debateSeed;
    } else if (moldCtx?.debateTopic || moldCtx?.molds?.debateTopic) {
      batch._debateTopic = moldCtx.debateTopic || moldCtx.molds.debateTopic;
    }
    const promptWords = promptBundle.promptWords ?? args._promptWords ?? words;
    if (args._userVocab?.requested?.length || promptWords.length) {
      batch = attachVocabFeedback(batch, promptWords, {
        topic: chosenTopic,
        prompted: promptWords,
        originalRequested: args._userVocab?.requested,
        subtypeAdaptation: args._vocabSubtypeAdaptation?.swapped,
        excluded: args._userVocab?.excluded,
      });
      console.log(formatVocabFeedbackSummary(batch.userVocabFeedback));
      if (teil === 1 && batch.userVocabFeedback?.used?.length) {
        // Advisory only. The lexical-overlap check cannot tell a forced word from a
        // natural one: on 23 sep 2026 it flagged 33% of the nouns in hand-curated
        // de/A2 T1 texts and 51% in de/B1 T1, and flagged the requested words less
        // often (20%) than ordinary nouns. SEM-1 judges forced vocabulary instead
        // ("forced_vocab"): 0/16 false positives, 15/16 forced sentences caught.
        const coherence = vocabNarrativeCoherenceGate(batch);
        if (!coherence.ok) console.log(`  (aviso, no bloquea) vocab coherencia léxica: ${coherence.reason}`);
      }
    }
    if (levelUpper === 'B2' && Number(teil) === 1 && args.forumPhase === 'passage') {
      const labels = ['A', 'B', 'C', 'D'];
      batch.passages = (batch.passages || []).map((p, i) => ({
        ...p,
        module: 'lesen',
        teil: 1,
        level: 'B2',
        personKey: String(p.personKey || labels[i] || '').toUpperCase() || labels[i],
      }));
      batch.questions = [];
      const bankVal = validateB2ForumPassageBank(batch);
      if (!bankVal.ok) {
        lastIssue = bankVal.issues.join('; ');
        if (fix < args.fixRetries) {
          resetPromptWithFix(lastIssue, 'calidad-forum-passage');
          continue;
        }
        return finishPart({
          ok: false,
          discarded: true,
          teil,
          reason: lastIssue,
          attempts: partAttempts,
        });
      }
      batch.topicTag = chosenTopic;
      const bankPath = saveB2ForumTextBank(batch, {
        topic: chosenTopic,
        basename: basename.replace(/\.json$/i, '-text-bank.json'),
      });
      const bankRel = path.relative(ROOT, bankPath).replace(/\\/g, '/');
      console.log(`[text-bank] Fase A OK → ${bankRel}`);
      console.log('Siguiente: --forum-phase questions --text-bank', bankRel);
      settleCostOk(bankRel);
      return finishPart({
        ok: true,
        file: bankRel,
        teil,
        phase: 'passage',
        textBank: bankPath,
        batch,
        words,
        attempts: partAttempts,
      });
    }

    if (levelUpper === 'B2' && Number(teil) === 1 && args.forumPhase === 'questions') {
      batch = mergeB2ForumQuestions(args._b2TextBank, batch);
      batch._examInstructionIncluded = true;
    }

    if (promptBundle?.generationMetadata) {
      batch.generationMetadata = { ...promptBundle.generationMetadata };
    }
    lastBatch = batch;

    if (!args.skipValidate) console.log('Validando formato…');
    if (!args.skipQuality && fix === 0) console.log('Comprobando calidad pedagógica…');

    let result = await finalizeBatch(args, teil, batch, basename, relFile);
    if (result.ok) {
      recordLesenMoldAttempt(session, args, teil, chosenTopic, batch, { ok: true });
      if (Number(teil) === 4) {
        pushSessionNameExclude(args, extractLesenT4ForumNames(result.batch || batch));
        if (args._lesenT4ForumCastSignature) {
          args._lesenT4ForumCastSessionExclude?.add(args._lesenT4ForumCastSignature);
        }
        recordLesenT4ForumCastFromGeneration({
          level: args.level || 'B1',
          teil: 4,
          batch: result.batch || batch,
          plannedSignature: args._lesenT4ForumCastSignature || null,
        });
      }
      settleCostOk(result.file || relFile);
      return finishPart({ ...result, words, attempts: partAttempts, batch: result.batch || batch });
    }

    recordLesenMoldAttempt(session, args, teil, chosenTopic, batch, {
      ok: false,
      moldGateFailure: isStructuralMoldFailure(result, teil),
    });

    try {
      assertTopicMoldCircuitClosed(session, chosenTopic, teil, topicMoldOptsFromArgs(args, teil));
    } catch (err) {
      if (err instanceof TopicMoldCircuitBreakerError) {
        maybeArchiveRejectedBatch(args, teil, lastBatch, basename, {
          reason: err.message,
          gate: 'topic-mold-circuit',
        });
        return handleTopicMoldBlock(err, settleCostFail, finishPart, teil, partAttempts, session, chosenTopic);
      }
      throw err;
    }

    lastIssue = result.issue || result.reason || 'checker';
    lastGate = result.gate || lastGate;

    // ── P2d: triaje de reparación (gratis / quirúrgico antes de reintento LLM completo) ──
    {
      const maxSurgicalRounds = 5;
      for (let surgicalRound = 0; surgicalRound < maxSurgicalRounds; surgicalRound++) {
        const triage = classifyAndRepair(batch, result);

        if (triage.discard) {
          const discardReason = triage.reason || lastIssue || 'triaje: descartar';
          console.log(`  Triaje CUBO D → DESCARTAR: ${discardReason}`);
          maybeArchiveRejectedBatch(args, teil, lastBatch, basename, {
            reason: discardReason,
            gate: lastGate || 'triage',
          });
          settleCostFail(discardReason, lastGate || 'triage');
          return finishPart({ ok: false, discarded: true, teil, reason: discardReason, attempts: partAttempts });
        }

        if (triage.repaired === true) {
          const cubeLabel = triage.cube || '?';
          const fixedLabel = (triage.fixed || []).join(', ') || 'campos';
          console.log(`  Triaje CUBO ${cubeLabel}: reparado (${fixedLabel}) — re-validando sin LLM…`);
          batch = triage.batch;
          const capsFixed = (triage.fixed || []).some((c) => c === 'CHK-14');
          batch = applyGermanCapsNormalize(batch, { decapOnly: !capsFixed }).batch;
          lastBatch = batch;

          const reResult = await finalizeBatch(args, teil, batch, basename, relFile);
          if (reResult.ok) {
            console.log(`  Triaje exitoso → guardado sin reintento LLM`);
            settleCostOk(reResult.file || relFile);
            return finishPart({ ...reResult, words, attempts: partAttempts, batch: reResult.batch || batch });
          }
          result = reResult;
          lastIssue = result.issue || result.reason || 'checker post-triage';
          lastGate = result.gate || lastGate;
          continue;
        }

        if (triage.repaired !== 'targeted' || !triage.repairKind) break;

        const label = surgicalRepairLabel(triage.repairKind, args.level);
        console.log(`  Triaje CUBO C (${label}) → reparación localizada (1 llamada LLM)…`);
        let repaired;
        try {
          repaired = await runSurgicalRepair(triage, batch, {
            teil,
            module: 'lesen',
            callLlm: (opts) => callLlm(session, args, opts),
            maxTokens,
            lang: args.lang,
            level: args.level,
            issues: result.issues || [result.issue || result.reason].filter(Boolean),
          });
        } catch (err) {
          if (err instanceof PartFileBrakeError) return handlePartBrake(err);
          throw err;
        }
        if (repaired) {
          batch = repaired;
          lastBatch = batch;
        } else {
          // The batch is unchanged, so triage would pick the same repair again
          // with the same outcome: on de/A2 Lesen T1 (23 sep 2026) one file spent
          // 6 of its 10 calls repeating an identical length-bias repair. Hand over
          // to the normal fix retry instead.
          console.log(`  Reparación ${triage.repairKind}: sin cambios en batch — paso al reintento normal`);
          break;
        }
        console.log(`  Re-validando tras ${triage.repairKind}…`);
        const reResult = await finalizeBatch(args, teil, batch, basename, relFile);
        if (reResult.ok) {
          console.log(`  Reparación ${triage.repairKind} OK → guardado sin regenerar parte`);
          settleCostOk(reResult.file || relFile);
          return finishPart({
            ...reResult,
            words,
            attempts: partAttempts,
            batch: reResult.batch || batch,
            localizedRepair: triage.repairKind,
          });
        }
        result = reResult;
        lastIssue = result.issue || result.reason || `checker post-${triage.repairKind}-repair`;
        lastGate = result.gate || lastGate;
      }
    }

    if (isStructuralMoldFailure(result, teil) && batch) {
      const label = isChk29Failure(result) ? 'CHK-29' : 'CHK-27';
      console.log(`  ${label} → excluir molde y regenerar T${teil} con subtipo/debate distinto…`);
      pushSessionMoldExclude(args, batch);
      pushSessionStructuralCorpus(args, batch);
      settleCostFail(result.issue || label, result.gate || 'audit2');
      try {
        assertTopicMoldCircuitClosed(session, chosenTopic, teil, topicMoldOptsFromArgs(args, teil));
      } catch (err) {
        if (err instanceof TopicMoldCircuitBreakerError) {
          return handleTopicMoldBlock(err, settleCostFail, finishPart, teil, partAttempts, session, chosenTopic);
        }
        throw err;
      }
      await resetPromptFresh(`${label} molde estructural / tema`);
      lastIssue = result.issue || label;
      lastGate = result.gate || 'audit2';
      fix -= 1;
      continue;
    }

    if (fix >= args.fixRetries) {
      console.error(result.detail || result.reason || 'Puertas FAIL');
      const rejected = buildRejectedSnapshot(result, lastIssue);
      maybeArchiveRejectedBatch(args, teil, lastBatch, basename, rejected);
      settleCostFail(lastIssue || result.reason || 'Puertas FAIL', lastGate || result.gate || 'checker');
      return finishPart({ ...result, words, attempts: partAttempts });
    }

    settleCostFail(lastIssue || result.reason || 'checker', lastGate || result.gate || 'checker');
    resetPromptWithFix(result.issues || result.issue || result.reason, result.gate || 'checker');
  }

  const rejected = buildRejectedSnapshot({ gate: lastGate, issue: lastIssue }, lastIssue);
  maybeArchiveRejectedBatch(args, teil, lastBatch, basename, rejected);
  settleCostFail(lastIssue || 'Generación fallida', lastGate || 'checker');
  return finishPart({
    ok: false,
    discarded: true,
    teil,
    reason: lastIssue || 'Generación fallida',
    attempts: partAttempts,
  });
}

async function generateOnePart(args, teil, session) {
  if (Number(teil) === 3 && usesB1LesenT3MakeT3(args.level, teil)) {
    return generateT3Part(args, session);
  }
  return generateLlmPart(args, teil, session);
}

/** Shared factory session for terminal + web hybrid (in-memory gates, no spawn). */
export function createLesenFactorySession(opts = {}) {
  const args = {
    lang: opts.lang || 'de',
    level: opts.level || 'B1',
    provider: 'gemini',
    model: opts.model || null,
    maxApiCalls: opts.maxApiCalls ?? 50,
    pauseMs: Math.max(MIN_PAUSE_MS, opts.pauseMs ?? MIN_PAUSE_MS),
    fixRetries: opts.fixRetries ?? 2,
    maxAttemptsPerFile: opts.maxAttemptsPerFile ?? DEFAULT_MAX_ATTEMPTS_PER_FILE,
    maxCostPerFileUsd: opts.maxCostPerFileUsd ?? DEFAULT_MAX_COST_PER_FILE_USD,
    apiRetries: opts.apiRetries ?? 1,
    skipValidate: true,
    skipQuality: false,
    skipIngest: true,
    skipDedup: opts.skipDedup ?? true,
    inMemory: true,
    writeFile: opts.writeFile ?? false,
    keepFailed: false,
    dryRun: false,
    topic: opts.topic || null,
    words: opts.words || null,
    dedupCorpus: opts.dedupCorpus ?? null,
    structuralCorpus: opts.structuralCorpus ?? [],
    dedupThreshold: opts.dedupThreshold ?? 0.55,
    semantic: opts.semantic !== false,
    skipSem2: opts.skipSem2 !== false,
    allowProModel: opts.allowProModel === true,
  };
  args.provider = 'gemini';
  const session = createSession(args);
  return { session, args };
}

/**
 * Generate one Lesen part via Gemini factory (T3 = make-t3, no API).
 * @returns {Promise<{ ok: boolean, batch?: object, ms: number, apiCalls?: number, reason?: string }>}
 */
export async function generateLesenPart(opts = {}) {
  const t0 = Date.now();
  let session;
  let args;

  if (opts.session?.session && opts.session?.args) {
    ({ session, args } = opts.session);
  } else {
    ({ session, args } = createLesenFactorySession(opts));
  }

  const teil = Number(opts.teil);
  if (!Number.isFinite(teil) || teil < 1 || teil > 5) {
    return { ok: false, reason: 'invalid_teil', ms: Date.now() - t0 };
  }

  args.teil = teil;
  args.topic = opts.topic ?? args.topic;
  args._resolvedTopic = opts.topic ?? args._resolvedTopic ?? args.topic;
  if (opts.wordCount != null) args.wordCount = opts.wordCount;
  else if (Number(teil) === 5 && args.wordCount == null) args.wordCount = 6;
  if (Array.isArray(opts.words) && opts.words.length) {
    args.words = [...opts.words];
  }
  if (opts.vocabContext) {
    args.vocabContext = opts.vocabContext;
  }
  if (opts.vocabBgStrictAnchor?.length) {
    args.vocabBgStrictAnchor = [...opts.vocabBgStrictAnchor];
  }
  if (opts.skipQuality === true) args.skipQuality = true;
  if (opts.skipQ1 === true) args.skipQ1 = true;
  if (opts.testMode === true) {
    args.testMode = true;
    args.skipPoolReady = true;
  }
  args.fixRetries = opts.fixRetries ?? args.fixRetries;
  if (opts.maxAttemptsPerFile != null) args.maxAttemptsPerFile = opts.maxAttemptsPerFile;
  if (opts.maxCostPerFileUsd != null) args.maxCostPerFileUsd = opts.maxCostPerFileUsd;
  if (opts.semantic === false) args.semantic = false;
  else if (opts.semantic === true) args.semantic = true;
  if (opts.skipSem2 === false) args.skipSem2 = false;
  else if (opts.skipSem2 === true) args.skipSem2 = true;
  else if (args.skipSem2 == null) args.skipSem2 = true;
  args.fewShotExamples = opts.fewShotExamples ?? args.fewShotExamples;
  args.minimalPromptRules = opts.minimalPromptRules ?? args.minimalPromptRules;
  args.inMemory = true;
  args.writeFile = opts.writeFile ?? args.writeFile ?? false;
  args.skipDedup = opts.skipDedup ?? args.skipDedup;
  if (opts.dedupCorpus != null) {
    args.dedupCorpus = opts.dedupCorpus;
    args.skipDedup = opts.skipDedup ?? !opts.dedupCorpus?.length;
  }

  try {
    const result = await generateOnePart(args, teil, session);
    const ms = Date.now() - t0;
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason || result.issue || 'generation_failed',
        braked: result.braked,
        ms,
        apiCalls: session.apiCallsUsed,
        teil,
        gate: result.gate,
        issues: result.issues,
      };
    }
    let batch = result.batch;
    if (!batch && result.file) {
      batch = JSON.parse(fs.readFileSync(path.join(ROOT, result.file), 'utf8'));
    }
    return {
      ok: true,
      batch,
      ms,
      apiCalls: session.apiCallsUsed,
      teil,
      file: result.file || null,
      words: result.words,
      attempts: result.attempts ?? 1,
      localizedRepair: result.localizedRepair || null,
      session: { session, args },
    };
  } catch (err) {
    if (
      err instanceof ApiBudgetStopError ||
      err instanceof RateLimitStopError ||
      err instanceof DailyQuotaError
    ) {
      throw err;
    }
    return {
      ok: false,
      reason: err.message || 'generation_error',
      ms: Date.now() - t0,
      apiCalls: session.apiCallsUsed,
      teil,
    };
  }
}

function recordResult(session, result) {
  const t = result.teil;
  if (!session.byTeil[t]) session.byTeil[t] = { generated: 0, discarded: 0, attempts: 0 };
  if (result.attempts) session.byTeil[t].attempts += result.attempts;
  if (result.ok && !result.dryRun) session.byTeil[t].generated += 1;
  else if (result.discarded) session.byTeil[t].discarded += 1;
}

function printFinalSummary(session, args) {
  const saved = Object.values(session.byTeil).reduce((n, s) => n + (s?.generated || 0), 0);
  const discarded = Object.values(session.byTeil).reduce((n, s) => n + (s?.discarded || 0), 0);

  console.log('\n══ Resumen generador Lesen ══');
  console.log(`Proveedor: ${session.provider} · Modelo: ${session.model}`);
  console.log(`Intentos totales: ${session.totalAttempts}`);
  console.log(`Partes guardadas (formato + calidad OK): ${saved}`);
  console.log(`Partes descartadas: ${discarded}`);
  console.log(`Llamadas API Gemini: ${session.apiCallsUsed}/${session.maxApiCalls}`);
  console.log('Por Teil (guardadas / descartadas · intentos):');
  for (const t of [1, 2, 3, 4, 5]) {
    const s = session.byTeil[t];
    if (!s || (s.generated === 0 && s.discarded === 0 && s.attempts === 0)) continue;
    const apiNote = t === 3 ? ' (T3 sin API)' : '';
    console.log(
      `  T${t}: ${s.generated} guardadas, ${s.discarded} descartadas, ${s.attempts} intentos${apiNote}`,
    );
  }
  if (session.stopped && usesApiBudget(session.provider)) {
    if (session.stopReason === 'max-api-calls') {
      console.log('\ncuota diaria alcanzada, continúa mañana');
    } else if (session.stopReason === '429') {
      console.log('\nDetenido por rate limit 429 persistente — reanuda más tarde.');
    }
  }
}

export async function runLesenGenerator(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  args.provider = await resolveLesenProvider(args.provider);
  const teile = teileToRun(args);
  if (args.fixRetries == null) {
    args.fixRetries = 2;
  }
  const session = createSession(args);

  if (!args.dryRun && !args.fromCoverage && !args.fromBank && !args.words?.length) {
    throw new Error('Indica --from-coverage, --from-bank o --words');
  }

  if (
    !args.dryRun &&
    teile.some((t) => t !== 3) &&
    !process.env.GEMINI_API_KEY &&
    !process.env.GOOGLE_API_KEY
  ) {
    throw new Error('Falta GEMINI_API_KEY en .env');
  }

  if (args.refreshCoverage) refreshCoverageReport(args.lang, args.level);

  console.log(
    `\nGenerador Lesen (${args.lang}/${args.level}) · ${args.provider} · ${session.model} · Teile: ${teile.join(', ')} × ${args.count}`,
  );
  if (!args.words?.length) {
    console.log(`Palabras objetivo por parte: ${args.wordCount} (--word-count)`);
  } else {
    console.log(
      `Palabras objetivo por parte: ${Math.min(args.words.length, args.wordCount)} de ${args.words.length} en --words (tope --word-count ${args.wordCount})`,
    );
  }
  logCefrCoverageThreshold();
  console.log(
    `Cuota Gemini: max ${session.maxApiCalls} llamadas · pausa ≥${session.minPauseMs}ms · fix-retries=${args.fixRetries} · api-retries=${args.apiRetries}`,
  );
  console.log(`Salida: batches/generated/`);

  const results = [];
  // Kill-switch: stop the batch after this many consecutive parts that all
  // exhausted their 503 retries (= Gemini is down, not just a short spike).
  const MAX_CONSECUTIVE_503 = 3;
  let consecutive503Failures = 0;

  outer: for (const teil of teile) {
    for (let i = 0; i < args.count; i++) {
      if (
        usesApiBudget(session.provider) &&
        teil !== 3 &&
        !args.dryRun &&
        budgetRemaining(session) <= 0
      ) {
        session.stopped = true;
        session.stopReason = 'max-api-calls';
        console.log('\ncuota diaria alcanzada, continúa mañana');
        break outer;
      }

      if (args.count > 1 || teile.length > 1) {
        console.log(`\n======== T${teil} · ${i + 1}/${args.count} ========`);
      }

      try {
        const result = await generateOnePart(args, teil, session);
        recordResult(session, result);
        results.push(result);
        // Reset 503 counter on any successful or quality-failed (non-503) result
        if (!result.reason || !/503|reintentos agotados/i.test(String(result.reason))) {
          consecutive503Failures = 0;
        } else {
          consecutive503Failures += 1;
        }
        if (session.stopped) break outer;
      } catch (err) {
        if (err instanceof ApiBudgetStopError) {
          console.log('\ncuota diaria alcanzada, continúa mañana');
          session.stopped = true;
          session.stopReason = 'max-api-calls';
          break outer;
        }
        if (err instanceof RateLimitStopError) {
          console.error(`\n${err.message}`);
          session.stopped = true;
          session.stopReason = '429';
          break outer;
        }
        if (err instanceof DailyQuotaError || err?.name === 'DailyQuotaError') {
          throw err;
        }
        console.error(err.message || err);
        session.byTeil[teil].discarded += 1;
        results.push({ ok: false, discarded: true, teil, reason: err.message });
      }

      // After each discarded part, check if it was a 503 exhaustion
      const last = results[results.length - 1];
      if (last && !last.ok && /503|reintentos agotados/i.test(String(last.reason || ''))) {
        consecutive503Failures += 1;
        if (consecutive503Failures >= MAX_CONSECUTIVE_503) {
          console.error(
            `\n🛑 ${consecutive503Failures} partes consecutivas agotaron reintentos de 503.` +
            ` Gemini parece caído — deteniendo lote. Reintenta en unos minutos.`,
          );
          session.stopped = true;
          session.stopReason = '503-exhausted';
          break outer;
        }
      } else if (last && last.ok) {
        consecutive503Failures = 0;
      }
    }
  }

  printFinalSummary(session, args);

  const ok = results.filter((r) => r.ok).length;
  if (session.stopped && session.stopReason === 'max-api-calls') {
    return { ok: ok > 0, results, session, exitCode: EXIT_API_BUDGET };
  }
  if (session.stopped && session.stopReason === '429') {
    return { ok: ok > 0, results, session, exitCode: EXIT_RATE_LIMIT };
  }
  return { ok: ok === results.length, results, session, exitCode: ok === results.length ? 0 : 1 };
}

export {
  callLlm,
  usesApiBudget,
  budgetRemaining,
  MIN_PAUSE_MS,
  DEFAULT_WORD_COUNT,
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  runLesenGenerator(process.argv.slice(2))
    .then(({ exitCode }) => process.exit(exitCode ?? 0))
    .catch((err) => {
      if (err instanceof DailyQuotaError || err?.name === 'DailyQuotaError') {
        console.error(`\n${err.message}`);
        process.exit(EXIT_DAILY_QUOTA);
      }
      console.error(err.message || err);
      process.exit(1);
    });
}
