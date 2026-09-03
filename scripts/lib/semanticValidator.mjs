/**
 * semanticValidator.mjs — SEM-1: Truth enforcement layer para ingestión al pool.
 *
 * Valida una parte curada con una llamada LLM acotada (una vez por parte).
 * Resultado cacheado por hash de contenido: la segunda llamada sobre la misma
 * parte reutiliza el cache sin tocar el LLM.
 *
 * Solo aplica a módulos con MCQ (lesen, horen). Schreiben/Sprechen → ok:true directo.
 *
 * Checks (en una sola llamada LLM):
 *   1. correctness — ¿la clave marcada es la única correcta según el texto?
 *   2. ambiguity   — ¿hay ≥2 opciones defendibles como correctas?
 *   3. distractor  — ¿algún distractor es absurdo/imposible o demasiado obvio?
 *   4. template    — ¿el pasaje repite un molde temático ya visto en esta sesión?
 *   (explanation eliminado: CHK-18 cubre longitud/trivialidad estructuralmente)
 *
 * Umbral de confianza: CONFIDENCE_THRESHOLD = 0.85.
 * Solo issues con conf ≥ 0.85 bloquean. El ruido (conf ≤ 0.60) queda descartado.
 *
 * Exporta:
 *   validatePartSemantics(part, opts?)   → Promise<{ ok, issues }>
 *   clearSemanticCache()                 → void
 *   clearTemplateRegistry()              → void
 *   getTemplateRegistry()                → Map<string,string>  (para tests)
 *   _setLlmFn(fn)                        → void  (inyección para tests)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Issues below this confidence are discarded (calibration shows clean separation at 0.85).
const CONFIDENCE_THRESHOLD = 0.85;

// ─── LLM backend (swappable for tests) ─────────────────────────────────────
let _llmFn = null; // set by tests; null → use real geminiClient

async function callSemanticLlm(prompt) {
  if (_llmFn) return _llmFn(prompt);

  const useClaude =
    String(process.env.SEMANTIC_USE_CLAUDE || '').trim() === '1' &&
    !!process.env.ANTHROPIC_API_KEY;
  if (useClaude) {
    const { generateContent } = await import('./claudeClient.mjs');
    return generateContent({ prompt, maxRetries: 2, maxTokens: 1024 });
  }

  const { generateContent } = await import('./geminiClient.mjs');
  // gemini-2.5-flash spends reasoning tokens out of the same output budget
  // (thoughtsTokenCount ~1000 on these prompts). At maxTokens 1024 the JSON
  // was cut off mid-`themeTags` every time and never reached `issues`.
  return generateContent({
    prompt,
    jsonMode: true,
    maxRetries: 2,
    maxTokens: Number(process.env.SEMANTIC_MAX_TOKENS || 4096),
    temperature: 0.1,
  });
}

export function _setLlmFn(fn) {
  _llmFn = fn;
}

// ─── In-memory caches ────────────────────────────────────────────────────────
/** contentHash → { ok, issues } */
const _resultCache = new Map();

/** Jaccard fingerprint string → partId (template registry, per session) */
const _templateRegistry = new Map();

export function clearSemanticCache() {
  _resultCache.clear();
}

export function clearTemplateRegistry() {
  _templateRegistry.clear();
}

export function getTemplateRegistry() {
  return _templateRegistry;
}

// ─── Content hash ───────────────────────────────────────────────────────────
function contentHash(part) {
  const h = crypto.createHash('sha256');
  h.update(String(part.module || ''));
  h.update(String(part.teil || ''));
  h.update(JSON.stringify(part.passage || {}));
  h.update(JSON.stringify(part.segments || []));
  h.update(JSON.stringify(part.questions || []));
  return h.digest('hex').slice(0, 32);
}

// ─── Part context extraction ─────────────────────────────────────────────────
/**
 * Extract the passage text + MCQ questions from a seed record.
 * Returns null if the part has no auditable MCQ content (e.g. Schreiben).
 */
function extractPartContext(part) {
  const module = String(part.module || '').toLowerCase();

  // Schreiben / Sprechen: no MCQ → skip semantic validation
  if (module === 'schreiben' || module === 'sprechen') return null;

  // Collect passage text
  const passageText = collectPassageText(part);

  // Collect MCQ questions (type must be MCQ/RF/matching)
  const MCQ_TYPES = new Set(['multiple_choice', 'multiple', 'richtig_falsch', 'true_false', 'matching', 'ja_nein']);
  const allQs = collectQuestions(part);
  const mcqs = allQs.filter((q) => MCQ_TYPES.has(String(q.type || '').toLowerCase()));

  if (!mcqs.length) return null; // nothing to validate semantically

  const lang = String(part.lang || part.language || 'de').slice(0, 2).toLowerCase();

  return { module, teil: part.teil, passageText, questions: mcqs, lang };
}

function collectPassageText(part) {
  const chunks = [];
  const seen = new Set();
  const add = (t) => { const s = String(t || '').trim(); if (s && !seen.has(s)) { seen.add(s); chunks.push(s); } };

  // Single passage (Lesen T1/T3/T5, Hören T4 batch)
  const p = part.passage;
  if (p) {
    add(p.text);
    if (p.title && p.title !== p.text) add(p.title);
    if (Array.isArray(p.passages)) p.passages.forEach((pp) => { if (pp?.text) add(pp.text); });
    // p.transcript: skip if same content as p.text (H4 records store it in both)
    if (p.transcript && p.transcript !== p.text) add(p.transcript);
  }
  // Multi-passage parts (Lesen T2 batch/record: part.passages[] instead of part.passage)
  for (const pp of (part.passages || [])) {
    if (pp?.text) add(pp.text);
    if (pp?.title && pp.title !== pp.text) add(pp.title);
  }
  for (const seg of part.segments || []) {
    if (seg.transcript) add(seg.transcript);
    else if (seg.text) add(seg.text);
  }
  for (const ad of part.ads || []) {
    if (ad.text) add(ad.text);
    if (ad.title) add(ad.title);
  }
  return chunks.join('\n\n').trim();
}

function collectQuestions(part) {
  const qs = [];
  // Direct questions
  for (const q of part.questions || []) qs.push(q);
  // Items (L3/L4)
  for (const it of part.items || []) qs.push(it);
  // Segment questions (H1)
  for (const seg of part.segments || []) {
    for (const q of seg.questions || []) qs.push(q);
  }
  return qs;
}

// ─── Prompt builder ─────────────────────────────────────────────────────────
function optionText(o) {
  // Options may be plain strings OR {key, text} / {value, label} objects
  if (typeof o === 'string') return o.trim();
  if (o && typeof o === 'object') return String(o.text ?? o.label ?? o.value ?? o.key ?? '').trim();
  return String(o ?? '').trim();
}

function formatOptions(q) {
  const opts = q.options || [];
  if (!opts.length) return '  (sin opciones — pregunta Richtig/Falsch o Ja/Nein)';
  return opts.map((o, i) => {
    const letter = String.fromCharCode(97 + i);
    const text = optionText(o);
    // Avoid "a) a) Lena" when option text already starts with "a)"
    const alreadyPrefixed = /^[a-e]\)\s*/i.test(text);
    return `  ${letter}) ${alreadyPrefixed ? text.replace(/^[a-e]\)\s*/i, '') : text}`;
  }).join('\n');
}

/** Goethe T3: "0" = no ad matches; A–J = shared ad list (uppercase). */
function formatCorrectKeyLine(correctLetter, opts) {
  const key = String(correctLetter ?? '').trim();
  if (key === '0') {
    return (
      'Clave: 0 → ningún anuncio A–J encaja (respuesta Goethe T3 válida; ' +
      'NO es error de formato ni clave ausente)'
    );
  }
  const upper = key.toUpperCase();
  if (/^[A-J]$/.test(upper) && Array.isArray(opts) && opts.length) {
    const idx = upper.charCodeAt(0) - 65;
    const text = optionText(opts[idx] || '');
    return `Clave: ${upper}${text ? ` → "${text}"` : ''}`;
  }
  if (/^[A-E]$/.test(upper) && Array.isArray(opts) && opts.length) {
    const idx = upper.charCodeAt(0) - 65;
    const text = optionText(opts[idx] || '');
    return `Clave: ${upper}${text ? ` → "${text}"` : ''}`;
  }
  return `Clave: ${key}`;
}

/**
 * Exam board per language. The format rules below are Goethe conventions and
 * must not be applied to another board's tasks — the same Teil number means a
 * different task in Cambridge (CLAUDE.md trap #3).
 */
/**
 * Issue kinds SEM-1 may raise per language.
 *
 * "distractor" and "template" are calibrated for Goethe and misfire on
 * Cambridge: measured on the en/B1 seed (docs/audit/pilot-sem1-en-B1.json),
 * 16 of 21 findings came from these two and none was a real defect. "template"
 * flagged the prescribed task format itself ("diálogos cortos e independientes"
 * — that *is* Listening Part 1), and "distractor" flagged an option for
 * contradicting the passage, which is what a working distractor does.
 *
 * The prompt already omits them for non-de; this is the deterministic backstop,
 * because a prompt is not a contract. Cross-part repetition is still caught by
 * the in-process themeTags registry, which compares real parts against each
 * other instead of judging one in isolation.
 *
 * Write the Cambridge variants and add them back here (see CLAUDE.md trap #5).
 */
const ISSUE_KINDS_BY_LANG = Object.freeze({
  de: null, // null → no filtering, every kind allowed
  en: Object.freeze(new Set(['correctness', 'ambiguity', 'llm_error'])),
  es: Object.freeze(new Set(['correctness', 'ambiguity', 'llm_error'])),
});

function allowedIssueKinds(lang) {
  const l = String(lang || 'de').slice(0, 2).toLowerCase();
  return l in ISSUE_KINDS_BY_LANG ? ISSUE_KINDS_BY_LANG[l] : null;
}

const EXAM_BOARDS = Object.freeze({
  de: { language: 'alemán', board: 'Goethe B1', part: 'Teil' },
  en: { language: 'inglés', board: 'Cambridge B1 Preliminary', part: 'Part' },
  es: { language: 'español', board: 'DELE B1', part: 'Parte' },
});

function examBoardFor(lang) {
  return EXAM_BOARDS[String(lang || 'de').slice(0, 2).toLowerCase()] || EXAM_BOARDS.de;
}

function buildPrompt(ctx) {
  const { passageText, questions, module, teil } = ctx;
  const lang = String(ctx.lang || 'de').slice(0, 2).toLowerCase();
  const board = examBoardFor(lang);
  const isDe = lang === 'de';

  const qBlocks = questions
    .slice(0, 8) // cap at 8 to keep prompt bounded
    .map((q) => {
      const correctLetter = String(q.correct ?? q.correctAnswer ?? '');
      const opts = q.options || [];
      const lines = [
        `PREGUNTA [${q.id || '?'}]: ${q.question || ''}`,
      ];
      // L4 (ja_nein / opinion): include the full opinion text so the LLM can
      // verify if the marked Ja/Nein answer matches the stated stance.
      if (q.signText && String(q.signText).trim()) {
        lines.push(`Texto de la persona:\n${q.signText.trim()}`);
      }
      if (opts.length) lines.push(formatOptions(q));
      lines.push(formatCorrectKeyLine(correctLetter, opts));
      lines.push(q.explanation ? `Explicación: ${q.explanation}` : '(sin explicación)');
      return lines.join('\n');
    })
    .join('\n\n');

  // For L4 (ja_nein opinion format): the "TEXTO" above is the shared intro.
  // Each question has its own "Texto de la persona" (signText) that must be
  // topically relevant to the question and justify the Ja/Nein answer.
  // Goethe task formats — keyed to Goethe Teil numbers, so de only.
  const isOpinionFormat = isDe && questions.some((q) => q.signText);
  const isT3Matching =
    isDe &&
    Number(teil) === 3 &&
    questions.some((q) => String(q.type || '').toLowerCase() === 'matching');
  const isL2Mcq =
    isDe &&
    Number(teil) === 2 &&
    questions.some((q) => String(q.type || '').toLowerCase() === 'multiple_choice');

  // Cambridge matching (Reading P2) has no "ningún anuncio encaja" key: every
  // prompt matches exactly one option, so a missing key is a real defect here.
  const isCambridgeMatching =
    lang === 'en' &&
    questions.some((q) => String(q.type || '').toLowerCase() === 'matching');

  return `Eres un evaluador experto de exámenes de ${board.language} nivel ${board.board}.
Módulo: ${module.toUpperCase()}, ${board.part} ${teil}.${isCambridgeMatching ? `
Formato: MATCHING Cambridge. Cada pregunta empareja a una persona con UNO de los
textos ofrecidos. No existe la clave "ninguno": toda pregunta tiene exactamente una
correspondencia válida. Si la clave marcada no corresponde, genera issue de correctness.` : ''}${isOpinionFormat ? `
Formato: OPINIONES (Ja/Nein). Cada pregunta incluye el texto donde la persona expresa su postura.` : ''}${isL2Mcq ? `
Formato: L2 MCQ (3 opciones a/b/c por pregunta, pasaje de prensa).
REGLA ANTI-AUTOCONTRADICCIÓN: si la clave marcada está respaldada por el pasaje y NINGUNA otra
opción tiene cita textual defendible, devuelve issues: [] para esa pregunta — NO generes issue
cuyo detail diga «Clave correcta» sin opción rival concreta.
SÍ genera issue si dos opciones parafrasean el mismo hecho (sinónimos) o ambas son defendibles.` : ''}${isT3Matching ? `
Formato: T3 MATCHING (anuncios A–J). Cada pregunta empareja una situación con la lista de anuncios.
CONVENCIÓN GOETHE OBLIGATORIA: la clave "0" (string cero) significa «ningún anuncio encaja».
Es una respuesta CORRECTA y válida — NO la marques como clave inválida, ausente o fuera de A–J.
Exactamente una pregunta del Teil suele llevar clave "0".` : ''}

TEXTO / TRANSCRIPT:
${passageText || (isT3Matching ? '(sin pasaje — validar situación vs anuncios A–J de cada pregunta)' : '(sin texto — validar solo opciones)')}

PREGUNTAS:
${qBlocks}

TAREA: Valida CADA pregunta y el pasaje globalmente. Devuelve SOLO JSON (sin markdown).

REGLA FUNDAMENTAL: No juzgues de memoria ni por sentido común general.
Todo issue de "correctness" o "ambiguity" DEBE apoyarse en una frase literal
del texto/transcript${isT3Matching ? ' o del anuncio A–J citado' : ''}. Si no puedes citar evidencia textual, NO generes el issue.

Checks a realizar:

1. "correctness" (CRITICAL) — Evidencia textual obligatoria.
   ${isT3Matching
     ? `PARA T3 MATCHING:
   - Clave "0": CORRECTA si ningún anuncio A–J satisface la situación. Verifica cada anuncio;
     si ninguno encaja, NO generes issue de correctness.
   - Clave A–J: el anuncio elegido debe ser el único que encaja; cita el texto del anuncio.
   - NUNCA rechaces "0" por no ser letra A–J — es convención oficial Goethe B1.`
     : isOpinionFormat
     ? `PARA FORMATO OPINIONES (Ja/Nein):
   Paso 1: ¿El "Texto de la persona" menciona explícitamente el mismo tema que la
   pregunta? Si el texto trata de un tema DISTINTO, es error: el texto no puede
   justificar la respuesta. Cita las palabras clave del texto y de la pregunta para
   demostrar la discrepancia.
   Paso 2: Si el tema es el mismo, localiza la frase exacta del texto que indica la
   postura. ¿Esa postura coincide con la clave (Ja/Nein)? Si contradice, genera issue
   y cita la frase.`
     : isL2Mcq
     ? `PARA L2 MCQ:
   - Clave correcta respaldada + sin rival textual → NO generes issue (issues: []).
   - Clave incorrecta o sin evidencia → genera issue correctness con cita.
   - Dos opciones (p. ej. b y c) con el mismo significado o ambas defendibles → genera issue
     (correctness o ambiguity) citando el conflicto entre opciones.`
     : `Localiza la frase o fragmento EXACTO del texto/transcript que justifica la clave.
   Copia esa frase en "evidence" (campo interno; no en "detail"). Si no encuentras
   evidencia textual directa, genera issue: la clave no está soportada.`}
   Si es incorrecta o no está justificada por el texto, genera issue.

2. "ambiguity" (CRITICAL) — Evalúa CADA opción no-clave por separado.
   Para cada opción incorrecta: ¿existe alguna frase en el texto que la haga
   defendible? Cita esa frase si existe. Solo genera issue si hay UNA opción concreta
   que puedes defender textualmente (no en abstracto).
   Formato del detail: "Opción X también defendible: '<cita literal del texto>'."

${isDe ? `3. "distractor" (IMPORTANT) — ¿Alguna opción incorrecta es absurda o imposible?
   Solo distractores claramente defectuosos (afirmación imposible, tema ajeno, trampa
   obvia que nadie elegiría). No marques si es simplemente incorrecto pero plausible.

4. "template" (IMPORTANT) — ¿El pasaje sigue un molde narrativo genérico/repetitivo?
   Devuelve también "themeTags": array de 3-5 palabras clave temáticas del pasaje.` : `3. "themeTags" — devuelve 3-5 palabras clave temáticas del pasaje.
   NO es un check y no genera issues: sirve para detectar repetición ENTRE partes,
   que se compara fuera de este prompt.
   NO generes issues de tipo "distractor" ni "template". El formato de esta tarea lo
   fija el examen, así que un pasaje "repetitivo" es lo esperado, no un defecto.`}

Formato de respuesta EXACTO (devuelve SOLO este JSON, sin markdown):
{
  "themeTags": ["palabra1", "palabra2", "palabra3"],
  "issues": [
    {
      "kind": ${isDe ? '"correctness"|"ambiguity"|"distractor"|"template"' : '"correctness"|"ambiguity"'},
      "itemId": "<id de la pregunta, o 'passage'>",
      "detail": "explicación breve en español (≤50 palabras)",
      "confidence": <0.0–1.0 — tu certeza de que esto es un error real, NO una duda>
    }
  ]
}
Si todo es correcto, devuelve: {"themeTags": [...], "issues": []}
NO generes issues sin evidencia textual concreta. NO inventes problemas.
Solo incluye issues con confidence ≥ 0.85 (baja confianza = no es issue real).`;
}

// ─── LLM response parser ────────────────────────────────────────────────────
function parseSemanticResponse(raw) {
  // raw may be a string (Claude) or an object with .text / .candidates (Gemini)
  let text = raw;
  if (typeof raw === 'object' && raw !== null) {
    // Gemini response shape
    text =
      raw.candidates?.[0]?.content?.parts?.[0]?.text ??
      raw.text ??
      raw.content ??
      JSON.stringify(raw);
  }
  text = String(text || '').trim();

  // Strip markdown fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to find a JSON object in the response
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { parsed = null; }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    // Fail-closed. This used to return no issues, which made an unreadable
    // answer indistinguishable from a clean part — a truncated response
    // published unverified content. The caller turns this into a blocking
    // finding instead.
    return {
      themeTags: [],
      issues: [],
      parseError: `respuesta no parseable (${text.length} chars): ${text.slice(0, 120)}`,
    };
  }

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues
        .filter(
          (i) =>
            i &&
            typeof i.kind === 'string' &&
            typeof i.detail === 'string' &&
            ['correctness', 'ambiguity', 'distractor', 'template'].includes(i.kind),
        )
        .map((i) => {
          // Normalize confidence to [0, 1]; default 1.0 if absent (conservative)
          const raw = Number(i.confidence);
          const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1.0;
          return { kind: i.kind, itemId: i.itemId || 'part', detail: i.detail, confidence };
        })
    : [];

  const themeTags = Array.isArray(parsed.themeTags)
    ? parsed.themeTags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 8)
    : [];

  return { themeTags, issues };
}

/**
 * Drop SEM issues where the LLM affirms the marked key but still emitted CRITICAL
 * (batch 071 pattern). Keeps real duplicate-option / dual-defensible defects (073).
 */
export function isSelfContradictorySemIssue(issue) {
  const d = String(issue?.detail || '');
  const dl = d.toLowerCase();

  // Real MCQ defects — never strip
  if (/opciones?\s+[abc]\)\s*(y|e)\s+[abc]\)/i.test(d)) return false;
  if (/opción\s+[abc]\)\s+también defendible/i.test(d)) return false;
  if (/idénticas?\s+en\s+significado|prácticamente\s+lo\s+mismo|expresan\s+prácticamente/i.test(dl)) {
    return false;
  }
  if (/ambas\s+(son\s+)?correctas|no hay distinción|falta diferenciación|sin distinción significativa/i.test(dl)) {
    return false;
  }
  if (/verbessern|besser machen|unterstützung.*schulung|betreuung.*lehrer/i.test(dl) &&
      /idéntic|mismo|prácticamente|distinción|diferenciación/i.test(dl)) {
    return false;
  }

  // Affirms key + cites passage evidence, no rival option → self-contradiction
  if (/clave correcta/i.test(dl) && /evidencia/i.test(dl)) return true;
  if (/^clave correcta[.\s]/i.test(d.trim())) return true;
  if (/evidencia textual directa/i.test(dl) && /clave correcta/i.test(dl)) return true;

  return false;
}

// ─── Template fingerprint (Jaccard on theme tags) ────────────────────────────
const JACCARD_THRESHOLD = 0.5; // ≥50% tag overlap = same template

function jaccardSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Check if themeTags overlap too much with an already-seen fingerprint.
 * If so, return the itemId of the prior part.
 */
function findTemplateMatch(themeTags) {
  for (const [fingerprint, priorId] of _templateRegistry) {
    const priorTags = fingerprint.split('|');
    if (jaccardSimilarity(themeTags, priorTags) >= JACCARD_THRESHOLD) {
      return priorId;
    }
  }
  return null;
}

function registerTemplate(themeTags, partId) {
  const fingerprint = [...new Set(themeTags)].sort().join('|');
  if (fingerprint) _templateRegistry.set(fingerprint, partId);
}

// ─── Disk cache (optional, gated by SEMANTIC_DISK_CACHE env var) ─────────────
const DISK_CACHE_DIR = path.join(ROOT, '.semantic-cache');

function diskCacheRead(hash) {
  if (!process.env.SEMANTIC_DISK_CACHE) return null;
  const file = path.join(DISK_CACHE_DIR, `${hash}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function diskCacheWrite(hash, result) {
  if (!process.env.SEMANTIC_DISK_CACHE) return;
  try {
    fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(DISK_CACHE_DIR, `${hash}.json`), JSON.stringify(result, null, 2));
  } catch {
    // non-critical
  }
}

export async function validatePartSemantics(part, { skipTemplate = false } = {}) {
  const ctx = extractPartContext(part);

  // Schreiben / Sprechen / no MCQ → always OK (no semantic check needed)
  if (!ctx) return { ok: true, issues: [] };

  const hash = contentHash(part);

  // In-memory cache hit
  if (_resultCache.has(hash)) return _resultCache.get(hash);

  // Disk cache hit (optional)
  const diskHit = diskCacheRead(hash);
  if (diskHit) {
    _resultCache.set(hash, diskHit);
    return diskHit;
  }

  // Build prompt + call LLM
  const prompt = buildPrompt(ctx);
  let raw;
  try {
    raw = await callSemanticLlm(prompt);
  } catch (err) {
    // Fail-closed: do not publish without a successful SEM-1 call
    const result = {
      ok: false,
      issues: [{
        kind: 'llm_error',
        itemId: 'part',
        detail: `SEM-1 LLM no disponible: ${err?.message || err}`,
        confidence: 1.0,
      }],
      _llmError: String(err?.message || err),
    };
    _resultCache.set(hash, result);
    return result;
  }

  const { themeTags, issues: rawIssues, parseError } = parseSemanticResponse(raw);

  if (parseError) {
    const result = {
      ok: false,
      issues: [{
        kind: 'llm_error',
        itemId: 'part',
        detail: `SEM-1 sin veredicto legible: ${parseError}`,
        confidence: 1.0,
      }],
      _llmError: parseError,
    };
    _resultCache.set(hash, result);
    return raw?.usage ? { ...result, _usage: raw.usage } : result;
  }

  // Apply confidence threshold — discard low-confidence noise before acting on issues.
  // Template issues injected in-process always pass (they have no LLM confidence field).
  const issues = rawIssues
    .filter((i) => (i.confidence ?? 1.0) >= CONFIDENCE_THRESHOLD)
    .filter((i) => !isSelfContradictorySemIssue(i));

  // Template check (runs in-process, no extra LLM call)
  if (!skipTemplate && themeTags.length) {
    const priorId = findTemplateMatch(themeTags);
    if (priorId) {
      issues.push({
        kind: 'template',
        itemId: 'passage',
        detail: `Pasaje con molde temático similar a "${priorId}" (tags: ${themeTags.join(', ')})`,
        confidence: 1.0,
      });
    }
    registerTemplate(themeTags, part.id || hash.slice(0, 12));
  }

  // Drop issue kinds this language has no calibrated check for. Runs last so it
  // also covers the in-process template finding above, not just the LLM's.
  const allowed = allowedIssueKinds(ctx.lang);
  const kept = allowed
    ? issues.filter((i) => allowed.has(String(i.kind || '').toLowerCase()))
    : issues;

  // Token usage rides along so callers can cost a run; it is not part of the
  // verdict, so the disk cache stores the result without it.
  const result = { ok: kept.length === 0, issues: kept };
  _resultCache.set(hash, result);
  diskCacheWrite(hash, result);
  return raw?.usage ? { ...result, _usage: raw.usage } : result;
}

/** Build SEM-1 prompt for a part (tests / diagnostics). */
export function buildPromptForPart(part) {
  const ctx = extractPartContext(part);
  return ctx ? buildPrompt(ctx) : null;
}

export { extractPartContext, contentHash, collectPassageText, collectQuestions };
