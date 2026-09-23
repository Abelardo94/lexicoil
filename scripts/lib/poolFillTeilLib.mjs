/**
 * poolFillTeilLib.mjs — generar + validar + publicar una parte pool (sin mezclar rechazos).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './loadEnv.mjs';
import { REJECTED_DIR } from './batchPaths.mjs';
import { generateLesenPart, createLesenFactorySession } from '../generate-lesen-part-gemini.mjs';
import {
  createExamFactorySession,
  generateExamPartSingle,
} from './generatePartGeminiLib.mjs';
import {
  pickScarcestTopic,
  loadPoolRecords,
  rankTopicGaps,
  countTopicStock,
} from './poolGapPlanner.mjs';
import { topicsForLevel } from './levelPlanner.mjs';
import {
  pickTopicAlignedWeakWords,
  refreshCoverageRegistry,
  recordGenerationOutcome,
  printCoverageSummary,
  vocabPickContext,
} from './coverageRegistry.mjs';
import { pushSessionMoldExclude, pushSessionStructuralCorpus } from './poolFillSessionExclude.mjs';
import { setupConsoleUtf8, hrDouble, MARK_OK, MARK_FAIL } from './consoleSafe.mjs';
import { resolvePublishFile } from './resolvePublishFile.mjs';
import {
  isT3BlueprintExhaustedReason,
  listT3BlueprintStockForTopic,
} from './lesenT3BlueprintStock.mjs';
import {
  isT4SeedExhaustedReason,
  listT4SeedStockForTopic,
  preflightLesenT4Topic,
  shouldSkipLesenT4Topic,
} from './lesenT4SeedStock.mjs';
import {
  a2LesenGeminiStockStub,
  skipB1LesenT3BlueprintStock,
} from './a2LesenGeneration.mjs';

export { preflightLesenT4Topic, shouldSkipLesenT4Topic };

const require = createRequire(import.meta.url);
const { normalizeB1Topic } = require(path.join(ROOT, 'js/data/b1Topics.js'));

export function refreshVocabCoverage(lang, level) {
  setupConsoleUtf8();
  console.log('\n[sync] Actualizando registro de cobertura…');
  refreshCoverageRegistry(lang, level);
  printCoverageSummary(lang, level);
}

export function rebuildPoolManifest() {
  const res = spawnSync(process.execPath, ['scripts/build-pool-stock-manifest.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return res.status === 0;
}

export function planRotation(ctx) {
  const records = loadPoolRecords(ctx.lang, ctx.level);
  const recent = ctx.recentTopics || [];
  const hardSkip = new Set(
    [...(ctx.skipTopics || []), ...(ctx.exhaustedTopics || [])]
      .map((t) => normalizeB1Topic(t))
      .filter(Boolean),
  );
  const forced = ctx.forcedTopic ? normalizeB1Topic(ctx.forcedTopic) : null;
  if (forced && hardSkip.has(forced)) {
    return {
      topic: null,
      words: [],
      nextCursor: ctx.vocabCursor || 0,
      recentTopics: recent,
      exhausted: true,
      forcedTopicExhausted: forced,
    };
  }

  const wordCount = Math.min(8, Math.max(5, Number(ctx.wordCount) || 6));
  const vocabSkip = new Set(hardSkip);
  const maxTopicTries = topicsForLevel(ctx.level, { scope: 'gap', lang: ctx.lang }).length + 2;

  for (let tryN = 0; tryN < maxTopicTries; tryN++) {
    const topic =
      forced ||
      pickScarcestTopic(records, ctx.module, ctx.teil, {
        targetPerCell: ctx.targetPerCell,
        lang: ctx.lang,
        level: ctx.level,
        excludeTopics: [
          ...recent.slice(-Math.max(1, ctx.rotateEvery - 1)),
          ...vocabSkip,
        ],
        noFallback: vocabSkip.size > 0,
      });
    if (!topic) {
      return {
        topic: null,
        words: [],
        nextCursor: ctx.vocabCursor || 0,
        recentTopics: recent,
        exhausted: true,
      };
    }
    const normTopic = normalizeB1Topic(topic);

    try {
      const { words, nextCursor } = pickTopicAlignedWeakWords({
        lang: ctx.lang,
        level: ctx.level,
        topic,
        count: wordCount,
        cursor: ctx.vocabCursor,
        context: ctx.vocabContext || vocabPickContext(ctx.module, ctx.teil),
      });
      const gaps = rankTopicGaps(records, ctx.module, ctx.teil, ctx.targetPerCell, ctx.level);
      const row = gaps.find((g) => g.topic === normTopic);
      console.log(
        `\n[plan] Celda ${ctx.module} T${ctx.teil} · tema «${topic}» (stock ${row?.count ?? 0}, objetivo ${ctx.targetPerCell})`,
      );
      console.log(`   Palabras (${words.length}): ${words.join(', ')}`);
      return { topic, words, nextCursor, recentTopics: [...recent, topic].slice(-8) };
    } catch (err) {
      const msg = err?.message || String(err);
      if (forced) {
        console.error(
          `\n⛔ Tema forzado «${topic}» sin vocab planificable (${msg}) — no se puede generar.`,
        );
        return {
          topic: null,
          words: [],
          nextCursor: ctx.vocabCursor || 0,
          recentTopics: recent,
          exhausted: true,
          forcedTopicExhausted: normTopic,
          vocabPlanError: msg,
        };
      }
      console.warn(
        `\n⏭ Tema «${topic}» sin vocab planificable (${msg}) — rotando a otro tema`,
      );
      vocabSkip.add(normTopic);
    }
  }

  console.warn(
    `\n⛔ Sin temas con vocab planificable para ${ctx.module} T${ctx.teil} ` +
      `(probados ${vocabSkip.size} tema(s) excluido(s)).`,
  );
  return {
    topic: null,
    words: [],
    nextCursor: ctx.vocabCursor || 0,
    recentTopics: recent,
    exhausted: true,
    vocabTopicsExhausted: [...vocabSkip],
  };
}

/** Lesen T3: ¿saltar tema por catálogo agotado (sin stock tras dedup/exclusión)? */
export function shouldSkipLesenT3Topic(module, teil, topic, reason, sessionLesen, levelFallback = null) {
  if (String(module).toLowerCase() !== 'lesen' || Number(teil) !== 3 || !topic) return false;
  const level = sessionLesen?.args?.level || levelFallback || 'B1';
  if (skipB1LesenT3BlueprintStock(level, teil)) return false;
  if (isT3BlueprintExhaustedReason(reason)) return true;
  const exclude = sessionLesen?.args?._t3ExcludeSlugs;
  const stock = listT3BlueprintStockForTopic(topic, exclude instanceof Set ? exclude : new Set(exclude || []));
  return !stock.generatable;
}

export function preflightLesenT3Topic(topic, sessionLesen, levelFallback = null) {
  const level = sessionLesen?.args?.level || levelFallback || 'B1';
  if (skipB1LesenT3BlueprintStock(level, 3)) return a2LesenGeminiStockStub();
  const exclude = sessionLesen?.args?._t3ExcludeSlugs;
  return listT3BlueprintStockForTopic(
    topic,
    exclude instanceof Set ? exclude : new Set(exclude || []),
  );
}

/**
 * Lesen T3/T4 preflight cuando `--topic` fuerza un tema: abortar si agotado; si no, saltar y rotar.
 * @returns {'proceed'|'skip'|'abort'} action
 * @returns {string} [message] when abort
 */
export function lesenForcedTopicPreflightAction(forcedTopic, currentTopic, stock, teil) {
  if (stock.generatable) return { action: 'proceed' };
  const forced = forcedTopic ? normalizeB1Topic(forcedTopic) : null;
  const current = normalizeB1Topic(currentTopic);
  if (!forced || forced !== current) return { action: 'skip' };

  const detail =
    Number(teil) === 3
      ? `${stock.compatibleTotal} compatibles, 0 disponibles tras dedup/exclusión`
      : `${stock.preflightOkCount} preflight-OK, ${stock.freshCount} frescas, tier=${stock.pickTier}`;
  return {
    action: 'abort',
    message:
      `⛔ Tema forzado «${current}» agotado — no se puede generar (Lesen T${teil}). ${detail}`,
  };
}

function moveToRejected(relFile, reason) {
  const abs = path.isAbsolute(relFile) ? relFile : path.join(ROOT, relFile);
  if (!fs.existsSync(abs)) return null;
  fs.mkdirSync(REJECTED_DIR, { recursive: true });
  const base = path.basename(abs);
  let dest = path.join(REJECTED_DIR, base);
  if (fs.existsSync(dest)) dest = path.join(REJECTED_DIR, `${Date.now()}-${base}`);
  try {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    fs.writeFileSync(dest, `${JSON.stringify({ _rejectedReason: reason, ...raw }, null, 2)}\n`, 'utf8');
    fs.unlinkSync(abs);
  } catch {
    fs.renameSync(abs, dest);
  }
  return path.relative(ROOT, dest).replace(/\\/g, '/');
}

export async function generatePoolPart(ctx) {
  const { module, teil, topic, words, lang, level, sessionLesen, sessionExam } = ctx;

  if (module === 'lesen') {
    let session = sessionLesen;
    if (!session) {
      session = createLesenFactorySession({
        lang,
        level,
        writeFile: true,
        maxApiCalls: ctx.maxApiCalls,
        semantic: true,
        skipSem2: true,
      });
    }
    const result = await generateLesenPart({
      teil,
      topic,
      words,
      writeFile: true,
      session,
      fixRetries: ctx.fixRetries ?? 2,
      maxAttemptsPerFile: ctx.maxAttemptsPerFile,
      maxCostPerFileUsd: ctx.maxCostPerFileUsd,
      semantic: true,
      skipSem2: true,
      vocabContext: ctx.vocabContext || vocabPickContext(module, teil),
      vocabBgStrictAnchor: ctx.vocabBgStrictAnchor || null,
      skipQuality: ctx.skipQuality === true,
      testMode: ctx.testMode === true,
      skipQ1: Number(teil) === 4,
    });
    if (result.ok && result.batch) {
      pushSessionMoldExclude(session.args, result.batch);
      pushSessionStructuralCorpus(session.args, result.batch);
    }
    return { ...result, sessionLesen: session };
  }

  let session = sessionExam;
  if (!session) {
    session = await createExamFactorySession({
      module,
      teil,
      lang,
      level,
      maxApiCalls: ctx.maxApiCalls,
    });
  }
  const result = await generateExamPartSingle({
    module,
    teil,
    topic,
    words,
    lang,
    level,
    session,
    fixRetries: ctx.fixRetries ?? 2,
    maxAttemptsPerFile: ctx.maxAttemptsPerFile,
    maxCostPerFileUsd: ctx.maxCostPerFileUsd,
    vocabBgStrictAnchor: ctx.vocabBgStrictAnchor || null,
    skipQuality: ctx.skipQuality === true,
    testMode: ctx.testMode === true,
  });
  return { ...result, sessionExam: result.session || session };
}

export function publishPoolPart(ctx) {
  const { module, teil, relFile, lang, level, tag, syncPool } = ctx;
  const resolved = resolvePublishFile(relFile, level);
  if (!resolved) {
    const msg = `Archivo no encontrado para publicar: ${relFile} (buscado tambien en pool-verified/)`;
    console.error(`\n${MARK_FAIL} ${msg}`);
    return { ok: false, status: 1, error: msg };
  }
  if (resolved.source !== 'given' && resolved.source !== 'generated') {
    console.log(`[publish] Resuelto desde ${resolved.source}: ${resolved.relFile}`);
  }

  const script =
    module === 'lesen'
      ? 'scripts/publish-lesen-generated.mjs'
      : 'scripts/publish-exam-generated.mjs';

  const args = [
    script,
    '--file',
    resolved.relFile,
    '--continue',
    '--publish',
    '--allow-bank-dup',
    '--lang',
    lang,
    '--level',
    level,
    '--tag',
    tag || 'gemini',
  ];
  if (module === 'lesen' && teil != null) args.push('--teil', String(teil));
  if (module !== 'lesen') {
    args.push('--module', module);
    if (teil != null) args.push('--teil', String(teil));
  }
  if (syncPool) args.push('--sync-pool');

  console.log(`\n${hrDouble()}`);
  console.log(`Publicando ${resolved.relFile} (POOL-2 + banco)`);
  console.log(hrDouble());
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (res.status === 0) {
    return { ok: true, status: 0, file: resolved.relFile };
  }
  const detail = `${res.stdout || ''}${res.stderr || ''}`.trim();
  console.error(`\n${MARK_FAIL} Publicacion fallida (exit ${res.status ?? 1})`);
  if (detail) {
    console.error(detail.slice(0, 8000));
  } else {
    console.error('Sin salida del subproceso publish-exam-generated / publish-lesen-generated.');
  }
  return {
    ok: false,
    status: res.status ?? 1,
    error: detail || `publish subprocess exit ${res.status ?? 1}`,
    file: resolved.relFile,
  };
}

export async function runPoolFillCycle(ctx) {
  const gen = await generatePoolPart(ctx);
  if (!gen.ok) {
    if (gen.file) moveToRejected(gen.file, gen.reason || 'generation_failed');
    return {
      ok: false,
      stage: 'generate',
      reason: gen.reason,
      braked: gen.braked,
      gate: gen.gate,
      sessionLesen: gen.sessionLesen,
      sessionExam: gen.sessionExam,
    };
  }

  const relFile = gen.file;
  if (!relFile) {
    return { ok: false, stage: 'generate', reason: 'no_file', sessionLesen: gen.sessionLesen, sessionExam: gen.sessionExam };
  }

  const batch = gen.batch || loadBatchFromRelFile(relFile);

  if (!ctx.publish) {
    const normPath = relFile.replace(/\\/g, '/');
    if (normPath.includes('pool-content-ok-lesen')) {
      console.warn(
        `${MARK_FAIL} Solo pool-content-ok (Q1) — no cuenta para stock; reintenta o usa skipQ1 en T4 pool-fill`,
      );
      return {
        ok: false,
        stage: 'poolReady',
        reason: 'q1_only_content_ok',
        file: relFile,
        sessionLesen: gen.sessionLesen,
        sessionExam: gen.sessionExam,
      };
    }
    console.log(`${MARK_OK} Validada en ${relFile} (sin --publish)`);
    if (batch) {
      recordGenerationOutcome({
        lang: ctx.lang,
        level: ctx.level,
        module: ctx.module,
        teil: ctx.teil,
        topic: ctx.topic,
        requestedWords: ctx.words,
        batch,
        published: false,
      });
    }
    return { ok: true, file: relFile, published: false, sessionLesen: gen.sessionLesen, sessionExam: gen.sessionExam };
  }

  const pub = publishPoolPart({ ...ctx, relFile });
  if (!pub.ok) {
    moveToRejected(pub.file || relFile, 'publish_or_pool2_failed');
    return {
      ok: false,
      stage: 'publish',
      reason: pub.error || 'publish_failed',
      file: pub.file || relFile,
      sessionLesen: gen.sessionLesen,
      sessionExam: gen.sessionExam,
    };
  }

  console.log(`${MARK_OK} Publicada: ${pub.file || relFile}`);
  if (batch) {
    recordGenerationOutcome({
      lang: ctx.lang,
      level: ctx.level,
      module: ctx.module,
      teil: ctx.teil,
      topic: ctx.topic,
      requestedWords: ctx.words,
      batch,
      published: true,
    });
  }
  return {
    ok: true,
    file: relFile,
    published: true,
    sessionLesen: gen.sessionLesen,
    sessionExam: gen.sessionExam,
  };
}

function loadBatchFromRelFile(relFile) {
  const abs = path.isAbsolute(relFile) ? relFile : path.join(ROOT, relFile);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

export function printGapStatus(lang, level, module, teil, targetPerCell) {
  const lv = String(level || 'B1').toUpperCase();
  const records = loadPoolRecords(lang, lv);
  const officialTopics = topicsForLevel(lv, { scope: 'gap', lang });
  const { untagged, total } = countTopicStock(records, module, teil, lv, { lang });
  const ranked = rankTopicGaps(records, module, teil, targetPerCell, lv, { lang });
  const scopeLabel = String(lang).toLowerCase() === 'en' ? 'temas en/B1' : (lv === 'A2' ? 'ejes oficiales A2' : 'temas B1');
  console.log(
    `\nCelda ${module} T${teil} · ${total} partes verificadas ` +
      `(${untagged} sin eje ${scopeLabel})`,
  );
  console.log(`Objetivo por tema: ${targetPerCell} partes limpias · ${officialTopics.length} ejes\n`);
  console.log(`${'Tema'.padEnd(14)} ${'Stock'.padStart(5)} ${'Faltan'.padStart(6)}`);
  for (const row of ranked) {
    if (row.deficit <= 0 && row.count >= targetPerCell) continue;
    console.log(`${row.topic.padEnd(14)} ${String(row.count).padStart(5)} ${String(row.deficit).padStart(6)}`);
  }
  const next = pickScarcestTopic(records, module, teil, { targetPerCell, level: lv, lang });
  console.log(`\nSiguiente tema sugerido: ${next}`);
}
