/**
 * Pre-flight ingest validation for Hören batches (CEFR + A2 register).
 * Lesen uses length+complexity via validateCandidate; Hören blueprint only lengthOnly —
 * this module runs full CefrGate.validatePassage per transcript + A2 register heuristics.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './loadEnv.mjs';
import { batchToCandidates } from '../pipeline/lib/candidateBuilder.mjs';
import { validateCandidate, resolveBlueprint } from '../pipeline/lib/validateCandidate.mjs';
import {
  extractIngestErrors,
  formatCefrGateError,
  formatCefrMetricsSummary,
} from './gateReportFormat.mjs';

loadEnvFile();

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CefrGate = require(path.join(ROOT, 'js/engine/validation/CefrGate.js'));

/** Word bounds aligned with EXAM_LENGTH_RULES.horen.A2 in examTemplatePrompt.mjs */
const HOREN_A2_LENGTH = {
  1: { min: 15, max: 80 },
  2: { min: 70, max: 160 },
  3: { min: 12, max: 55 },
  4: { min: 140, max: 260 },
};

export { logCefrCoverageThreshold, getCefrMinCoverage } from './lesenBatchIngestCheck.mjs';

/** B1 register leaked into A2 Hören (from external review + pool audit). */
export const A2_HOREN_B1_REGISTER_RE =
  /\b(Herausforderung|Experte(?:n|n)?\s+f[uü]r|digitale\s+Kommunikation|Einblicke|herzlich\s+willkommen\s+zu\s+unserer\s+Sendung|Beratungsgespr[aä]che|Vorstellungsgespr[aä]ch|Personalabteilung|Arbeitssuchende|kritisch\s+zu\s+sein|beeinflussen)\b/i;

/** Comma + relative pronoun — heuristic anchor for Relativsatz detection. */
export const A2_HOREN_RELATIVE_CLAUSE_RE =
  /,\s*(?:der|die|das|den|dem|des|dessen|deren|denen|welche|welcher|welches|welchem|welchen)\s+[a-zäöüß]/i;

const REL_PRONOUN =
  '(?:der|die|das|den|dem|des|dessen|deren|denen|welche|welcher|welches|welchem|welchen)';

/** Comma + preposition + relative pronoun — always complex for A2 Hören T4. */
const PREP_BEFORE_RELATIVE_RE =
  /,\s*(?:mit|für|in|an|auf|über|unter|vor|nach|bei|von|zu|durch|gegen|ohne|um|bis|seit|während|trotz|wegen|statt|anstatt|innerhalb|außerhalb)\s+(?:dem|der|den|das|des|dessen|deren|denen|welchem|welcher|welchen|welches)\b/gi;

/** Explicit subject inside relative clause → object relative (not simple subject). */
const EXPLICIT_SUBJECT_IN_REL_RE =
  /^\s*(?:man|ich|wir|sie|er|es|du|ihr|einer|eine|einem|einen|jemand|niemand|wer|was)\b/i;

/** Extended zu-Infinitiv frame (Es ist … zu VERB) — reflexive B1 register. */
export const A2_HOREN_ES_IST_ZU_VERB_RE =
  /\b(?:es|etwas|eine?[rnm]?)\s+ist\s+[^.\n]{0,80}\s+zu\s+[a-zäöüß]+(?:en|ern|eln|n)\b/i;

/** Fixed «zu» phrases — not zu-Infinitiv (locative/adverbial). */
const ZU_FIXED_PHRASE_RE =
  /\bzu\s+(?:Hause|Fuß|zweit|dritt|Beginn|Ende|spät|früh|viel|wenig|erst|letzt|mindest|höchst|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b/gi;

/** Verb/noun + zu + infinitive, or bare zu + infinitive. */
const ZU_INFINITIV_RE =
  /\b(?:[a-zäöüß]+(?:en|ern|eln)|[a-zäöüß]+n)\s+zu\s+[a-zäöüß]+(?:en|ern|eln|n)\b|\bzu\s+[a-zäöüß]+(?:en|ern|eln|n)\b/gi;

/** Max zu-Infinitiv constructions per passage / whole batch by teil. */
const ZU_INF_LIMITS = {
  1: { perPassage: 1, total: 3 },
  2: { perPassage: 2, total: 2 },
  3: { perPassage: 1, total: 3 },
  4: { perPassage: 1, total: 1 },
};

/** T4 A2 Hören: max 1 simple subject relative per passage; 0 complex (see analyzeRelativeClauses). */
const RELATIVE_CLAUSE_T4 = 4;

function stripZuFixedPhrases(text) {
  return String(text || '').replace(ZU_FIXED_PHRASE_RE, ' ');
}

export function findZuInfinitiv(text) {
  const scrubbed = stripZuFixedPhrases(text);
  return [...scrubbed.matchAll(ZU_INFINITIV_RE)].map((m) => m[0]);
}

function isDemonstrativeAfterComma(pronoun, clauseBody) {
  const p = String(pronoun || '').toLowerCase();
  if (!['der', 'die', 'das'].includes(p)) return false;
  return /^\s*(?:ist|sind|war|waren|wird|werden|hat|haben|kann|können|muss|müssen|soll|sollen|darf|dürfen|mag|mögen|will|wollen)\b/i.test(
    clauseBody || '',
  );
}

function hasZuInfinitivInRelativeClause(clauseBody) {
  return /\bzu\s+[a-zäöüß]+(?:en|ern|eln|n)\b/i.test(String(clauseBody || ''));
}

function hasNestedRelative(clauseBody) {
  return new RegExp(`,\\s*${REL_PRONOUN}\\s+[a-zäöüß]`, 'i').test(String(clauseBody || ''));
}

function wordsBeforeFinalVerb(clauseBody) {
  const tokens = String(clauseBody || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const w = tokens[i].replace(/[,;:]$/, '');
    if (
      /^(?:bin|bist|ist|sind|war|waren|wird|werden|hat|haben|kann|können|muss|müssen|soll|sollen|darf|dürfen|mag|mögen|will|wollen)$/i.test(
        w,
      )
    ) {
      return i;
    }
    if (
      /^(?:[a-zäöüß]+(?:e|st|t|en|ern|eln)|[a-zäöüß]{3,}(?:t|e|st))$/i.test(w) &&
      !/^(?:nicht|auch|sehr|noch|schon|nur|mal|gar|hier|dort|heute|morgen|gestern|immer|oft|manchmal|vielleicht|dann|aber|und|oder)$/i.test(
        w,
      )
    ) {
      return i;
    }
  }
  return tokens.length;
}

/** Classify one comma-relative: simple subject (A2 OK) vs complex (B1 register). */
export function classifyRelativeClause(pronoun, clauseBody) {
  const p = String(pronoun || '').toLowerCase();
  const body = String(clauseBody || '');

  if (isDemonstrativeAfterComma(p, body)) {
    return { kind: 'false_positive', reason: 'demonstrative/main_clause' };
  }
  if (/^welch/i.test(p)) {
    return { kind: 'complex', reason: 'welche_pronoun' };
  }
  if (p === 'dessen' || p === 'deren' || p === 'des' || p === 'denen') {
    return { kind: 'complex', reason: 'genitive_or_dative_plural' };
  }
  if (p === 'den' || p === 'dem') {
    return { kind: 'complex', reason: 'non_subject_pronoun' };
  }
  if (hasNestedRelative(body)) {
    return { kind: 'complex', reason: 'nested' };
  }
  if (hasZuInfinitivInRelativeClause(body)) {
    return { kind: 'complex', reason: 'zu_infinitiv_in_clause' };
  }
  if (EXPLICIT_SUBJECT_IN_REL_RE.test(body)) {
    return { kind: 'complex', reason: 'object_relative' };
  }
  if (!['der', 'die', 'das'].includes(p)) {
    return { kind: 'complex', reason: 'non_subject_pronoun' };
  }
  if (wordsBeforeFinalVerb(body) > 4) {
    return { kind: 'complex', reason: 'clause_too_long' };
  }
  return { kind: 'simple_subject', reason: 'ok' };
}

/** All Relativsätze in text with simple/complex classification (T4 A2 calibration). */
export function analyzeRelativeClauses(text) {
  const s = String(text || '');
  const clauses = [];

  for (const m of s.matchAll(PREP_BEFORE_RELATIVE_RE)) {
    clauses.push({
      raw: m[0],
      pronoun: 'prep+rel',
      kind: 'complex',
      reason: 'preposition_relative',
    });
  }

  const startRe = new RegExp(`,\\s*(${REL_PRONOUN})\\b\\s*([^.!?\\n]*)`, 'gi');
  for (const m of s.matchAll(startRe)) {
    const { kind, reason } = classifyRelativeClause(m[1], m[2]);
    if (kind === 'false_positive') continue;
    clauses.push({
      raw: m[0],
      pronoun: m[1],
      clauseBody: m[2],
      kind,
      reason,
    });
  }

  return clauses;
}

export function checkRelativeClausesForPassage(text) {
  const clauses = analyzeRelativeClauses(text);
  const errors = [];

  if (clauses.length >= 2) {
    errors.push(`density (${clauses.length} Relativsätze, max 1 simple subject)`);
  } else if (clauses.length === 1 && clauses[0].kind === 'complex') {
    errors.push(`complex (${clauses[0].reason})`);
  }

  return {
    clauses,
    simpleCount: clauses.filter((c) => c.kind === 'simple_subject').length,
    complexCount: clauses.filter((c) => c.kind === 'complex').length,
    ok: errors.length === 0,
    errors,
  };
}

export function countRelativeClauses(text) {
  return analyzeRelativeClauses(text).length;
}

function countZuInfinitiv(text) {
  return findZuInfinitiv(text).length;
}

function hasEsIstZuVerbFrame(text) {
  return A2_HOREN_ES_IST_ZU_VERB_RE.test(String(text || ''));
}

function lengthBoundsForTeil(teil, level = 'A2') {
  if (String(level).toUpperCase() !== 'A2') return { min: 0, max: 9999 };
  const r = HOREN_A2_LENGTH[Number(teil)];
  if (!r) return { min: 0, max: 9999 };
  return { min: r.min, max: r.max };
}

export function checkHorenA2Register(batch, teil) {
  const errors = [];
  const t = Number(teil ?? batch.passages?.[0]?.teil ?? batch.questions?.[0]?.teil);
  const limits = ZU_INF_LIMITS[t] || { perPassage: 2, total: 4 };
  let totalZu = 0;
  const passages = batch.passages || [];

  for (const p of passages) {
    const text = p.text || p.transcript || '';
    const zuHere = countZuInfinitiv(text);
    totalZu += zuHere;
    if (zuHere > limits.perPassage) {
      errors.push(
        `register_gate:zu_infinitiv_density:passage ${p.id || '?'} has ${zuHere} (max ${limits.perPassage} for T${t})`,
      );
    }
    if (t === RELATIVE_CLAUSE_T4) {
      const relCheck = checkRelativeClausesForPassage(text);
      if (!relCheck.ok) {
        errors.push(
          `register_gate:relative_clause:passage ${p.id || '?'} — ${relCheck.errors.join('; ')}`,
        );
      }
    }
    if (t === 4 && hasEsIstZuVerbFrame(text)) {
      errors.push(
        `register_gate:es_ist_zu_verb:passage ${p.id || '?'} (A2 Hören T4 — avoid «Es ist … zu VERB» frame)`,
      );
    }
    const b1Hit = text.match(A2_HOREN_B1_REGISTER_RE);
    if (b1Hit) {
      errors.push(
        `register_gate:b1_vocab:passage ${p.id || '?'} contains «${b1Hit[0]}» (A2 Hören — use simpler Alltagssprache)`,
      );
    }
  }

  if (totalZu > limits.total) {
    errors.push(
      `register_gate:zu_infinitiv_total:T${t} has ${totalZu} zu-Infinitiv (max ${limits.total})`,
    );
  }
  return { ok: errors.length === 0, errors };
}

const COMPLEXITY_REASON_RE = /^(?:subordinate_|complexity_)/;

function cefrPassageChecksPartComplexity(batch, { lang, level, bounds }) {
  const errors = [];
  const metrics = [];
  const texts = [];
  for (const p of batch.passages || []) {
    const text = p.text || p.transcript || '';
    if (!text.trim()) {
      errors.push(`passage ${p.id || '?'}: empty transcript`);
      continue;
    }
    texts.push(text);
    const result = CefrGate.validatePassage(text, { level, lang, lengthBounds: bounds });
    const reasons = (result.reasons || []).filter((r) => !COMPLEXITY_REASON_RE.test(r));
    const blocking = reasons.some((r) => /^(?:length_|coverage_below)/.test(r));
    metrics.push({ passageId: p.id, ...result.metrics, reasons, withinRange: !blocking });
    if (blocking) {
      for (const r of reasons) errors.push(`passage ${p.id || '?'}: cefr_gate:${r}`);
    }
  }
  if (texts.length) {
    const part = CefrGate.validatePassage(texts.join('\n'), { level, lang, passageLengthExempt: true });
    for (const r of (part.reasons || []).filter((x) => COMPLEXITY_REASON_RE.test(x))) {
      errors.push(`part: cefr_gate:${r}`);
    }
    metrics.push({ passageId: 'part', ...part.metrics });
  }
  return { errors, metrics };
}

function cefrPassageChecks(batch, { lang, level, teil }) {
  const errors = [];
  const metrics = [];
  const bounds = lengthBoundsForTeil(teil, level);

  // A2 Hören T1 is five ~6-sentence monologues. Per segment, the A2 ≤12%
  // subordinate cap means zero, and one «weil» fails the part: 8 of the 13
  // published A2 T1 parts would fail that way. Complexity (sentence length,
  // subordinates) is measured over the whole part; length and coverage stay
  // per segment.
  if (String(level).toUpperCase() === 'A2' && Number(teil) === 1) {
    return cefrPassageChecksPartComplexity(batch, { lang, level, bounds });
  }

  for (const p of batch.passages || []) {
    const text = p.text || p.transcript || '';
    if (!text.trim()) {
      errors.push(`passage ${p.id || '?'}: empty transcript`);
      continue;
    }
    const result = CefrGate.validatePassage(text, {
      level,
      lang,
      lengthBounds: bounds,
    });
    metrics.push({ passageId: p.id, ...result.metrics, reasons: result.reasons, withinRange: result.withinRange });
    if (!result.withinRange) {
      for (const r of result.reasons || []) {
        errors.push(`passage ${p.id || '?'}: cefr_gate:${r}`);
      }
    }
  }
  return { errors, metrics };
}

export function checkHorenBatchIngest(batch, { lang = 'de', level = 'B1', batchId = 'batch', teil = null } = {}) {
  const lv = String(level || batch.level || 'B1').toUpperCase();
  const t = Number(teil ?? batch.passages?.[0]?.teil ?? batch.questions?.[0]?.teil ?? 0);
  const blueprint = resolveBlueprint(lang, lv);
  const candidates = batchToCandidates(batch, {
    lang,
    level: lv,
    blueprint,
    batchId,
    source: 'horenBatchIngestCheck',
  });

  const results = candidates.map((candidate) => {
    const validation = validateCandidate(candidate, blueprint);
    const errors = [...(validation.errors || [])];
    const warnings = [...(validation.warnings || [])];
    let cefrPassage = { errors: [], metrics: [] };
    let register = { ok: true, errors: [] };

    if (lv === 'A2' && candidate.module === 'horen') {
      cefrPassage = cefrPassageChecks(batch, { lang, level: lv, teil: candidate.teil ?? t });
      errors.push(...cefrPassage.errors);
      register = checkHorenA2Register(batch, candidate.teil ?? t);
      errors.push(...register.errors);
    }

    return {
      teil: candidate.teil,
      valid: errors.length === 0,
      errors,
      warnings,
      cefr: validation.cefr,
      cefrPassage: cefrPassage.metrics,
      register,
    };
  });

  if (!results.length && lv === 'A2') {
    const cefrPassage = cefrPassageChecks(batch, { lang, level: lv, teil: t });
    const register = checkHorenA2Register(batch, t);
    const errors = [...cefrPassage.errors, ...register.errors];
    results.push({
      teil: t,
      valid: errors.length === 0,
      errors,
      warnings: [],
      cefr: null,
      cefrPassage: cefrPassage.metrics,
      register,
    });
  }

  return {
    ok: results.every((r) => r.valid),
    results,
  };
}

export function formatHorenIngestReport(report, { level = 'B1' } = {}) {
  const lines = [];
  if (report.ok) {
    lines.push('Hören ingest pre-check OK ✅');
  } else {
    lines.push('Hören ingest pre-check FAIL');
  }
  for (const r of report.results) {
    if (r.valid) {
      lines.push(`  T${r.teil}: OK`);
      continue;
    }
    const detailed = r.errors?.length ? r.errors : extractIngestErrors({ results: [r] }, level);
    lines.push(`  T${r.teil}: ${(detailed || []).join('; ')}`);
    const metricLines = formatCefrMetricsSummary(r.cefr, level);
    for (const ml of metricLines) lines.push(ml);
    if (r.cefrPassage?.length) {
      for (const m of r.cefrPassage.filter((x) => !x.withinRange).slice(0, 3)) {
        lines.push(
          `    · ${m.passageId}: avgLen=${m.avgSentenceLen} subPct=${m.subordinatePct}% cov=${m.coverageVsLevel}%`,
        );
      }
    }
  }
  return lines.join('\n');
}

export { formatCefrGateError, extractIngestErrors, formatCefrMetricsSummary };
