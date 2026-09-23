/**
 * wordMatchRepair.mjs — Reparación localizada word-matching (T1 afirmaciones, T2/T5 MCQ).
 */
import { randomBytes } from 'node:crypto';
import { buildT1QuestionsRepairPrompt, buildMcqWordCopyRepairPrompt, buildT2McqWordCopyBatchRepairPrompt } from './lesenTemplatePrompt.mjs';
import { finalizeRepairPrompt } from './germanExplanationPromptRules.mjs';
import { extractJson } from './extractJson.mjs';
import { coerceGeneratedLesenPart } from './normalizeBatch.mjs';
import {
  tokenize,
  hasLongLiteralOverlap,
  sharedContentTokens,
} from './lesenBatchQuality.mjs';

/** @returns {string[]} sliding n-grams (lowercase) of n words */
export function extractForbiddenNgramsFromText(text, nWords = 4, maxOut = 45) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const seen = new Set();
  const out = [];
  for (let i = 0; i <= words.length - nWords; i++) {
    const ng = words.slice(i, i + nWords).join(' ');
    if (!seen.has(ng)) {
      seen.add(ng);
      out.push(ng);
      if (out.length >= maxOut) break;
    }
  }
  return out;
}

/** Literals from checker + frequent 4-grams from source text (repair prompt). */
export function buildForbiddenNgramList(sourceText, literalSnippets = [], maxOut = 45) {
  const priority = [];
  for (const snip of literalSnippets || []) {
    priority.push(...extractForbiddenNgramsFromText(snip, 4, 12));
  }
  const base = extractForbiddenNgramsFromText(sourceText, 4, maxOut);
  return [...new Set([...priority, ...base])].slice(0, maxOut);
}

const WORD_MATCH_RE =
  /palabras idénticas|copia literal|copia ≥|comparten demasiadas palabras|word-matching|pregunta copia|opción correcta copia|afirmación copia/i;

export function hasWordMatchSignal(issues) {
  return (issues || []).some((i) => WORD_MATCH_RE.test(String(i)));
}

/** @returns {Array<{ itemId: string, detail: string }>} */
export function parseWordMatchFindings(issues) {
  const out = [];
  for (const issue of issues || []) {
    const s = String(issue);
    if (!WORD_MATCH_RE.test(s)) continue;
    const m = s.match(/^(gen-q-[^\s:]+):/);
    if (m) out.push({ itemId: m[1], detail: s });
  }
  return out;
}

/** Literal spans from checker messages: «…» */
export function extractLiteralSnippetsFromIssues(issues) {
  const snippets = [];
  const seen = new Set();
  for (const issue of issues || []) {
    if (!WORD_MATCH_RE.test(String(issue))) continue;
    for (const m of String(issue).matchAll(/«([^»]{8,120})»/g)) {
      const snip = m[1].trim();
      if (snip && !seen.has(snip.toLowerCase())) {
        seen.add(snip.toLowerCase());
        snippets.push(snip);
      }
    }
  }
  return snippets.slice(0, 6);
}

/**
 * Detailed fix hint for first word-copy retry (Option B).
 * @param {string[]} issues
 * @param {number} [teil]
 */
export function buildWordCopyFixHint(issues, teil = 2) {
  const t = Number(teil) || 2;
  const literals = extractLiteralSnippetsFromIssues(issues);
  const lines = [
    '',
    'ANTI WORD-MATCHING (OBLIGATORIO — parafraseo B1):',
    `- Máx. 2 palabras de contenido (≥4 letras) iguales al pasaje en pregunta Y opción correcta.`,
    `- PROHIBIDO copiar ≥${t === 5 ? 5 : 4} palabras seguidas del pasaje en la opción correcta.`,
  ];
  if (literals.length) {
    lines.push('', 'Frases literales detectadas (NO repetir tal cual en la opción correcta):');
    for (const snip of literals) lines.push(`  · «${snip}»`);
  }
  lines.push(
    '',
    'Ejemplo concreto (mismo patrón que el checker):',
    'Pasaje: «…Die Miete ist niedriger als auf dem freien Markt, weil die Stadt das Programm unterstützt…»',
    '❌ MALO — opción correcta: «Die Miete ist niedriger als auf dem freien Markt» (copia ≥4 palabras seguidas).',
    '✅ BUENO — opción correcta: «Die Wohnungen sind günstiger als üblich, dank städtischer Förderung.»',
    '',
    'Reescribe TODAS las preguntas MCQ afectadas; mantén la misma clave correcta y el mismo sentido factual.',
  );
  return lines.join('\n');
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

function passageForQuestion(batch, question) {
  const pid = question.passageId;
  return (batch.passages || []).find((p) => p.id === pid) || batch.passages?.[0] || null;
}

function mergeMcqPatch(question, patch) {
  if (!patch || typeof patch !== 'object') return question;
  const out = { ...question };
  if (Array.isArray(patch.options) && patch.options.length >= 3) {
    out.options = patch.options.slice(0, 3).map(String);
  }
  if (typeof patch.question === 'string' && patch.question.trim()) {
    out.question = patch.question.trim();
  }
  if (typeof patch.explanation === 'string' && patch.explanation.trim()) {
    out.explanation = patch.explanation.trim();
  }
  if (patch.correct != null) out.correct = patch.correct;
  if (patch.correctAnswer != null) out.correctAnswer = patch.correctAnswer;
  return out;
}

function correctOptionText(question) {
  const letter = String(question.correctAnswer || question.correct || '')
    .toLowerCase()
    .replace(/[^a-d]/g, '');
  const correctOpt = (question.options || []).find((o) =>
    String(o).toLowerCase().trim().startsWith(`${letter})`),
  );
  return correctOpt ? String(correctOpt).replace(/^[a-d]\)\s*/i, '') : '';
}

function mcqWordCopyStillBad(question, passage, teil) {
  const literalMinWords = Number(teil) === 5 ? 5 : 4;
  const body = `${passage.title || ''} ${passage.text || ''}`;
  const optText = correctOptionText(question);
  if (!optText) return false;
  if (hasLongLiteralOverlap(optText, body, literalMinWords)) return true;
  if (sharedContentTokens(question.question, optText).length >= 3) return true;
  const sharedWithPassage = sharedContentTokens(optText, body);
  return sharedWithPassage.length >= 4;
}

/**
 * T1: reescribe las 6 afirmaciones; pasaje fijo.
 */
export async function repairT1WordMatchBatch(batch, qualityIssues, callLlm, opts = {}) {
  if (!batch?.passages?.[0]?.text || !batch?.questions?.length) return null;

  const passage = batch.passages[0];
  const idSuffix = randomBytes(4).toString('hex');
  const prompt = buildT1QuestionsRepairPrompt({
    passage,
    idSuffix,
    forbiddenTokens: passageForbiddenTokens(passage.text),
    qualityIssues: qualityIssues || [],
  });

  console.log('T1: reparando solo afirmaciones (pasaje fijo)…');

  let raw;
  try {
    raw = await callLlm({ prompt, maxTokens: Math.min(opts.maxTokens ?? 8192, 8192) });
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = extractJson(raw.text ?? raw);
  } catch {
    return null;
  }

  const newQuestions = Array.isArray(parsed?.questions) ? parsed.questions : null;
  if (!newQuestions?.length) return null;

  return coerceGeneratedLesenPart(
    { passages: batch.passages, questions: newQuestions },
    {
      module: 'lesen',
      teil: 1,
      lang: opts.lang || 'de',
      level: opts.level || 'B1',
      rootTopicTag: batch.topicTag || batch._requestedTopic || null,
    },
  );
}

/**
 * T2: reescribe todas las preguntas con word-copy en UNA llamada LLM (pasajes fijos).
 */
export async function repairT2McqWordCopyBatch(batch, findings, callLlm, opts = {}) {
  if (!batch?.questions?.length || !findings?.length) return null;
  const teilForCheck = Number(opts.teil) || 2;
  const minWords = Number(opts.minWords) || (teilForCheck === 5 ? 5 : 4);

  const byItem = new Map();
  for (const f of findings) {
    if (!f.itemId) continue;
    if (!byItem.has(f.itemId)) byItem.set(f.itemId, []);
    byItem.get(f.itemId).push(f);
  }
  if (!byItem.size) return null;

  const items = [];
  for (const [itemId, itemFindings] of byItem) {
    const question = batch.questions.find((q) => q.id === itemId);
    if (!question) continue;
    const passage = passageForQuestion(batch, question);
    if (!passage?.text) continue;
    items.push({ question, passage, findings: itemFindings });
  }
  if (!items.length) return null;

  const passageIds = new Set(items.map((i) => i.passage.id));
  const passages = (batch.passages || []).filter((p) => passageIds.has(p.id));
  const forbiddenTokens = [
    ...new Set(passages.flatMap((p) => passageForbiddenTokens(p.text))),
  ].slice(0, 30);
  const literalSnippets = extractLiteralSnippetsFromIssues(findings.map((f) => f.detail));
  const forbiddenNgrams = buildForbiddenNgramList(
    passages.map((p) => p.text).join('\n'),
    literalSnippets,
  );

  const prompt = buildT2McqWordCopyBatchRepairPrompt({
    passages,
    items,
    minWords,
    forbiddenTokens,
    literalSnippets,
    forbiddenNgrams,
    examLabel: opts.examLabel,
  });

  console.log(
    `T${teilForCheck}: reparando ${items.length} pregunta(s) word-copy en 1 llamada LLM (pasaje(s) fijo(s))…`,
  );

  let raw;
  try {
    raw = await callLlm({ prompt, maxTokens: Math.min(opts.maxTokens ?? 8192, 8192) });
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = extractJson(raw.text ?? raw);
  } catch {
    return null;
  }

  const patches = Array.isArray(parsed?.questions) ? parsed.questions : null;
  if (!patches?.length) return null;

  const patchById = new Map(patches.map((p) => [p.id, p]).filter(([id]) => id));
  let questions = [...batch.questions];
  let repairedAny = false;

  for (const { question, passage } of items) {
    const patch = patchById.get(question.id);
    if (!patch?.options?.length) continue;
    const patched = mergeMcqPatch(question, patch);
    if (!mcqWordCopyStillBad(patched, passage, teilForCheck)) {
      const qIdx = questions.findIndex((q) => q.id === question.id);
      if (qIdx >= 0) {
        questions[qIdx] = patched;
        repairedAny = true;
      }
    } else {
      console.log(`  word-copy aún detectado en ${question.id} tras reparación batch`);
    }
  }

  return repairedAny ? { ...batch, questions } : null;
}

/**
 * T2/T5: reescribe pregunta(s) con opción correcta copiando el pasaje.
 */
export async function repairMcqWordCopyBatch(batch, teil, findings, callLlm, opts = {}) {
  const t = Number(teil);
  if (t === 2 || t === 5) {
    return repairT2McqWordCopyBatch(batch, findings, callLlm, {
      ...opts,
      teil: t,
      minWords: t === 5 ? 5 : 4,
      examLabel:
        t === 5
          ? 'Goethe B1 Lesen Teil 5 (Regeltext/Hausordnung)'
          : opts.examLabel,
    });
  }

  if (!batch?.questions?.length || !findings?.length) return null;
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || 2);

  const byItem = new Map();
  for (const f of findings) {
    if (!f.itemId) continue;
    if (!byItem.has(f.itemId)) byItem.set(f.itemId, []);
    byItem.get(f.itemId).push(f);
  }
  if (!byItem.size) return null;

  let questions = [...batch.questions];
  let repairedAny = false;
  const minWords = t === 5 ? 5 : 4;

  for (const [itemId, itemFindings] of byItem) {
    const qIdx = questions.findIndex((q) => q.id === itemId);
    if (qIdx < 0) continue;
    let question = questions[qIdx];
    const passage = passageForQuestion(batch, question);
    if (!passage?.text) continue;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const literals = extractLiteralSnippetsFromIssues(itemFindings.map((f) => f.detail));
      const prompt = buildMcqWordCopyRepairPrompt({
        passage,
        question,
        teil: t,
        minWords,
        findings: itemFindings,
        forbiddenTokens: passageForbiddenTokens(passage.text),
        forbiddenNgrams: buildForbiddenNgramList(passage.text, literals),
      });

      console.log(`T${t}: reparando pregunta ${itemId} (word-copy, pasaje fijo, intento ${attempt}/${maxAttempts})…`);

      let raw;
      try {
        raw = await callLlm({ prompt, maxTokens: 2048 });
      } catch {
        break;
      }

      let parsed;
      try {
        parsed = extractJson(raw.text ?? raw);
      } catch {
        continue;
      }

      const patch = parsed?.question || parsed;
      if (!patch?.options?.length) continue;

      const patched = mergeMcqPatch(question, patch);
      if (!mcqWordCopyStillBad(patched, passage, t)) {
        questions[qIdx] = patched;
        repairedAny = true;
        break;
      }
      question = patched;
      console.log(`  word-copy aún detectado en ${itemId} tras intento ${attempt}`);
    }
  }

  return repairedAny ? { ...batch, questions } : null;
}

function isMcqBatch(batch) {
  const qs = batch?.questions || [];
  return qs.length > 0 && qs.every((q) => Array.isArray(q.options) && q.options.length >= 3);
}

/**
 * Router word-matching por Teil.
 */
export async function repairWordMatchBatch(batch, teil, issues, callLlm, opts = {}) {
  const module = String(opts.module || batch.questions?.[0]?.module || 'lesen').toLowerCase();
  const t = Number(teil);
  if (module === 'horen') {
    const findings = parseWordMatchFindings(issues);
    if (t === 2) {
      return repairMcqWordCopyBatch(batch, 2, findings, callLlm, opts);
    }
    return repairHorenWordCopyBatch(batch, findings, callLlm, { ...opts, teil: t });
  }
  // Goethe A2 Lesen T1 is a/b/c MCQ, not the B1 richtig/falsch statements.
  // The statement repair rewrote A2 MCQs as true/false items without options:
  // 33 'correct="true" no válido' rejections in 8 attempts on 23 sep 2026.
  if (t === 1 && isMcqBatch(batch)) {
    return repairMcqWordCopyBatch(batch, 1, parseWordMatchFindings(issues), callLlm, opts);
  }
  if (t === 1) {
    return repairT1WordMatchBatch(batch, issues, callLlm, opts);
  }
  if (t === 2 || t === 5) {
    const findings = parseWordMatchFindings(issues);
    return repairMcqWordCopyBatch(batch, t, findings, callLlm, opts);
  }
  return null;
}

/** Hören T1/T3/T4 — MCQ (opción correcta) + RF (enunciado); transcripción fija. */
async function repairHorenWordCopyBatch(batch, findings, callLlm, opts = {}) {
  if (!findings?.length) return null;

  const mcqFindings = [];
  const rfFindings = [];
  for (const f of findings) {
    const q = batch.questions?.find((x) => x.id === f.itemId);
    const mcqOptIssue = /opción correcta copia/i.test(f.detail);
    const isMcq = q?.type === 'multiple_choice' && (q.options?.length || 0) >= 3;
    if (mcqOptIssue || (isMcq && /pregunta copia|comparten demasiadas/i.test(f.detail))) {
      mcqFindings.push(f);
    } else {
      rfFindings.push(f);
    }
  }

  let current = batch;
  let any = false;

  if (mcqFindings.length) {
    const teil = Number(opts.teil) || 1;
    const mcqFixed = await repairT2McqWordCopyBatch(current, mcqFindings, callLlm, {
      ...opts,
      teil,
      examLabel: `Goethe B1 Hören Teil ${teil}`,
    });
    if (mcqFixed) {
      current = mcqFixed;
      any = true;
    }
  }

  if (rfFindings.length) {
    const rfFixed = await repairHorenQuestionWordCopyBatch(current, rfFindings, callLlm, opts);
    if (rfFixed) {
      current = rfFixed;
      any = true;
    }
  }

  return any ? current : null;
}

/** Hören — parafrasear solo enunciado RF / pregunta (sin tocar transcripción). */
async function repairHorenQuestionWordCopyBatch(batch, findings, callLlm, opts = {}) {
  if (!findings?.length) return null;

  const items = findings
    .map((f) => {
      const question = batch.questions?.find((q) => q.id === f.itemId);
      if (!question) return null;
      const passage = passageForQuestion(batch, question);
      return passage?.text ? { question, passage, findings: [f] } : null;
    })
    .filter(Boolean);
  if (!items.length) return null;

  const literalSnippets = extractLiteralSnippetsFromIssues(findings.map((f) => f.detail));
  const forbiddenNgrams = buildForbiddenNgramList(
    items.map((i) => i.passage.text).join('\n'),
    literalSnippets,
  );

  const prompt = finalizeRepairPrompt(
    `Eres examinador Goethe B1 Hören. La TRANSCRIPCIÓN por segmento está aprobada — NO la modifiques.\n` +
    `Parafrasea SOLO el enunciado/pregunta de ${items.length} ítem(s) para que NO copie ≥4 palabras seguidas del audio de SU segmento.\n\n` +
    items
      .map(
        ({ question, passage, findings: fs }) =>
          `## [${question.id}] · passageId ${passage.id || question.passageId || '?'}\n` +
          `### Transcripción del segmento (NO cambiar)\n${String(passage.text || '').trim().slice(0, 1200)}\n\n` +
          `Pregunta actual: ${question.question || ''}\nErrores:\n${fs.map((x) => `- ${x.detail}`).join('\n')}`,
      )
      .join('\n\n') +
    (literalSnippets.length
      ? `\n\n## Frases literales detectadas (NO repetir)\n${literalSnippets.map((s) => `  · «${s}»`).join('\n')}\n`
      : '') +
    (forbiddenNgrams.length
      ? `\n## N-gramas prohibidos (≥4 palabras del audio)\n${forbiddenNgrams.slice(0, 35).map((g) => `  · «${g}»`).join('\n')}\n`
      : '') +
    `\n\nDevuelve SOLO JSON: { "questions": [ { "id": "...", "question": "..." }, ... ] }`,
  );

  console.log(`Hören: reparando ${items.length} enunciado(s) word-copy (1 llamada, audio fijo)…`);

  let raw;
  try {
    raw = await callLlm({ prompt, maxTokens: Math.min(opts.maxTokens ?? 8192, 8192) });
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = extractJson(raw.text ?? raw);
  } catch {
    return null;
  }

  const patches = Array.isArray(parsed?.questions) ? parsed.questions : null;
  if (!patches?.length) return null;

  const patchById = new Map(patches.map((p) => [p.id, p]));
  let questions = [...batch.questions];
  let repairedAny = false;
  for (const { question, passage } of items) {
    const patch = patchById.get(question.id);
    if (!patch?.question) continue;
    const newQ = String(patch.question).trim();
    if (!newQ || hasLongLiteralOverlap(newQ, passage.text, 4)) continue;
    const idx = questions.findIndex((q) => q.id === question.id);
    if (idx >= 0) {
      questions[idx] = { ...questions[idx], question: newQ };
      repairedAny = true;
    }
  }
  return repairedAny ? { ...batch, questions } : null;
}

/** @deprecated use repairHorenWordCopyBatch */
async function repairHorenRfWordCopyBatch(batch, findings, callLlm, opts = {}) {
  return repairHorenWordCopyBatch(batch, findings, callLlm, opts);
}
