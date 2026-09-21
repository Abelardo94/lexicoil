#!/usr/bin/env node
/**
 * audit-pass-2.mjs — LexiLoop B1 corpus audit gate (segunda pasada)
 *
 * Uso:
 *   node scripts/audit-pass-2.mjs <ruta>                  # archivo o directorio
 *   node scripts/audit-pass-2.mjs <ruta> --json           # salida JSON estructurada
 *   node scripts/audit-pass-2.mjs <ruta> --fail-on=CRITICAL|IMPORTANT|none
 *   node scripts/audit-pass-2.mjs <ruta> --fix-types      # reescribe type:"multiple" in-place
 *   node scripts/audit-pass-2.mjs <ruta> --summary-only   # solo el bloque RESUMEN
 *   node scripts/audit-pass-2.mjs <ruta> --action-table    # tabla archivo|check|severidad|acción
 *   node scripts/audit-pass-2.mjs <ruta> --action-report=<path.json>
 *
 * Flags combinables. Código de salida 1 si hay findings ≥ --fail-on (default: CRITICAL).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BLACKLIST, B2_QUESTION_BLACKLIST, B1_QUESTION_BLACKLIST } from './blacklist.mjs';
import { normalizeB1Topic } from './lib/b1Topics.mjs';
import { assessT4TopicAlignment, formatT4TopicAlignmentFailure } from './lib/t4TopicAlign.mjs';
import { checkMcqDistinctBatch } from './lib/mcqDistinctCheck.mjs';
import { answerKeySequence } from './lib/balanceMcq.mjs';
import {
  scanP2CapitalizationViolations,
  scanMcqOptionCapitalizationViolations,
  ADJ_NEEDS_ARTICLE_GUARD,
  looksLikeAttributiveAdjective,
} from './lib/capitalizeNouns.mjs';
import { isKnownGermanNoun } from './lib/germanNounLexicon.mjs';
import { findKeyExplanationMismatches } from './lib/keyExplanationGate.mjs';
import { findExplanationOptionTextAlignFindings } from './lib/explanationOptionTextAlign.mjs';
import {
  detectTopicFromT3Situations,
  isLesenT3TopicCompatible,
} from './lib/lesenT3TopicFilter.mjs';
import { verifyHorenT4MatchingChrono } from './lib/horenT4ChronoEvidence.mjs';
import { verifyRfChronoByCharPos } from './lib/horenRfChronoEvidence.mjs';
import { runGermanContentLanguageGate } from './lib/qualityGates/germanContentLanguageGate.mjs';
import { collectMcqLengthBiasIssues } from './lib/mcqLengthBias.mjs';
import {
  isVocabLemmaCorruption,
  isValidGrammarTag,
} from './lib/enrichBatchMetadata.mjs';
import { loadVocabBankLemmaSet } from './lib/vocabBank.mjs';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { detectTopic } = require(path.join(ROOT, 'js/engine/partTopicDetect.js'));
const HorenPictureMatching = require(path.join(ROOT, 'js/engine/horenPictureMatching.js'));
const SprechenBriefing = require(path.join(ROOT, 'js/engine/sprechenBriefing.js'));

// ─── Editable constants ────────────────────────────────────────────────────

const CANONICAL_TYPES = new Set([
  'multiple_choice', 'richtig_falsch', 'ja_nein', 'matching', 'short_answer',
  // Goethe B1 Sprechen (SP-2 taxonomy)
  'planungsaufgabe', 'praesentation', 'feedback_diskussion',
  // Goethe A2 Sprechen (official Modellsatz)
  'personal_questions', 'about_self', 'plan_together',
]);

/** Types canonical for one language only. Cambridge B1 Reading Parts 5 and 6
 *  (mcq_gap_fill, open_cloze) both grade as gap_fill, which has no Goethe
 *  equivalent — keep it out of the shared set so German still rejects it. */
const CANONICAL_TYPES_BY_LANG = {
  en: new Set(['gap_fill']),
};

function isCanonicalType(type, lang) {
  if (CANONICAL_TYPES.has(type)) return true;
  return !!CANONICAL_TYPES_BY_LANG[lang]?.has(type);
}

/** Blueprint: expected item count per (module, teil). null = variable. */
const BLUEPRINT = {
  'lesen-1':   { count: 6,  types: ['richtig_falsch'] },
  'lesen-2':   { count: 6,  types: ['multiple_choice'] },
  'lesen-3':   { count: 7,  types: ['matching'] },
  'lesen-4':   { count: 7,  types: ['ja_nein'] },
  'lesen-5':   { count: 4,  types: ['multiple_choice'] },
  'horen-1':   { count: 10, types: ['richtig_falsch', 'multiple_choice'] },
  'horen-2':   { count: 5,  types: ['multiple_choice'] },
  'horen-3':   { count: 7,  types: ['richtig_falsch'] },
  'horen-4':   { count: 8,  types: ['matching'] },
  'schreiben': { count: null, types: ['short_answer'] },
  'sprechen':  { count: null, types: ['planungsaufgabe', 'praesentation', 'feedback_diskussion', 'personal_questions', 'about_self', 'plan_together', 'short_answer'] },
};

/** Goethe A2 Modellsatz — 5 ítems por Teil (Lesen/Hören T1–T4). */
const BLUEPRINT_A2 = {
  'lesen-1':   { count: 5, types: ['multiple_choice'] },
  'lesen-2':   { count: 5, types: ['multiple_choice'] },
  'lesen-3':   { count: 5, types: ['multiple_choice'] },
  'lesen-4':   { count: 5, types: ['matching'] },
  'horen-1':   { count: 5, types: ['multiple_choice'] },
  'horen-2':   { count: 5, types: ['matching'] },
  'horen-3':   { count: 5, types: ['multiple_choice'] },
  'horen-4':   { count: 5, types: ['ja_nein'] },
  'schreiben': { count: null, types: ['short_answer'] },
  'sprechen':  { count: null, types: ['personal_questions', 'about_self', 'plan_together', 'short_answer'] },
};

/** Cambridge B1 Preliminary: expected item count per (module, teil). Used when exam lang is 'en'.
 *  `options` = options per item. Goethe B1 is 3 everywhere, Cambridge is not: Reading P3/P5 use
 *  four (A–D) and the matching parts offer a bank of eight. Measured on the three published
 *  en/B1 exams (all passing `validate:fidelity`), and matching the real B1 Preliminary paper.
 *  null = the task has no options (open cloze, gap fill). */
const CAMBRIDGE_B1_BLUEPRINT = {
  //  `words` mirrors `wordsPerPassage` in library/blueprints/cambridge_B1.json. Reading P1/P2
  //  carry passageLengthExempt there (signs and notices run ~30 words by design), and the
  //  paper declares no length for Listening — so both are null and simply not checked, rather
  //  than borrowing the Goethe numbers, which is what flagged English transcripts as "too short".
  'lesen-1':   { count: 5, options: 3,    words: null },
  'lesen-2':   { count: 5, options: 8,    words: null },
  'lesen-3':   { count: 5, options: 4,    words: { min: 150, max: 800 } },
  'lesen-4':   { count: 5, options: 8,    words: { min: 150, max: 800 } },
  'lesen-5':   { count: 6, options: 4,    words: { min: 150, max: 800 } },
  'lesen-6':   { count: 6, options: null, words: { min: 150, max: 800 } },
  'horen-1':   { count: 7, options: 3,    words: null },
  'horen-2':   { count: 6, options: 3,    words: null },
  'horen-3':   { count: 6, options: null, words: null },
  'horen-4':   { count: 6, options: 3,    words: null },
  'schreiben': { count: null },
  'sprechen':  { count: null },
};

/** Goethe B2 Modellsatz Erwachsene — Lesen/Hören item counts. */
const BLUEPRINT_B2 = {
  'lesen-1':   { count: 9, types: ['matching'] },
  'lesen-2':   { count: 6, types: ['matching'] },
  'lesen-3':   { count: 6, types: ['multiple_choice'] },
  'lesen-4':   { count: 6, types: ['matching'] },
  'lesen-5':   { count: 3, types: ['matching'] },
  'horen-1':   { count: 10, types: ['richtig_falsch', 'multiple_choice'] },
  'horen-2':   { count: 6, types: ['multiple_choice'] },
  'horen-3':   { count: 6, types: ['matching'] },
  'horen-4':   { count: 8, types: ['multiple_choice'] },
  'schreiben': { count: null, types: ['short_answer'] },
  'sprechen':  { count: null, types: ['short_answer'] },
};

// BLUEPRINT/BLUEPRINT_A2/BLUEPRINT_B2 are Goethe's. Cambridge puts different tasks at the same
// Teil positions, so the count map has to be selected by lang before level.
// See docs/audit/gates-en-applicability.md.
function blueprintForLevel(level, lang = 'de') {
  if (String(lang || 'de').trim().toLowerCase() === 'en') return CAMBRIDGE_B1_BLUEPRINT;
  const lv = String(level || 'B1').toUpperCase();
  if (lv === 'A2') return BLUEPRINT_A2;
  if (lv === 'B2') return BLUEPRINT_B2;
  return BLUEPRINT;
}

function inferAuditLevel(batch) {
  if (batch?.level) return String(batch.level).toUpperCase();
  for (const q of batch?.questions || []) {
    if (q?.level) return String(q.level).toUpperCase();
  }
  return 'B1';
}

function inferAuditLang(batch) {
  const raw = batch?.lang || batch?.language
    || batch?.questions?.find(q => q?.lang || q?.language)?.lang
    || batch?.questions?.find(q => q?.lang || q?.language)?.language;
  return String(raw || 'de').trim().toLowerCase();
}

/** C1/C2 vocabulary blacklist (case-insensitive). Add here to extend. */
// BLACKLIST imported from ./lib/blacklist.mjs — single source of truth

// ─── Finding type ──────────────────────────────────────────────────────────

const SEV = { CRITICAL: 3, IMPORTANT: 2, MINOR: 1, INFO: 0 };

function finding(id, severity, file, scope, message) {
  return { id, severity, file: path.basename(file || ''), scope: scope || '', message };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeText(t) {
  return String(t || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-zäöüß0-9 ]/g, '').trim();
}

function sha1(text) {
  return crypto.createHash('sha1').update(normalizeText(text)).digest('hex');
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zäöüß\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4);
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a), sb = new Set(b);
  let inter = 0;
  for (const t of sb) if (sa.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function bpKey(q) {
  const mod = String(q.module || '').toLowerCase();
  if (mod === 'schreiben' || mod === 'sprechen') return mod;
  return `${mod}-${q.teil}`;
}

/** Balance key: same as bpKey but also splits by type for mixed-type Teile (e.g. Hören T1). */
function balanceKey(q) {
  return `${bpKey(q)}:${q.type}`;
}

function allTextFields(q) {
  const parts = [q.question, q.signText, q.explanation];
  for (const o of q.options || []) parts.push(String(o));
  return parts.filter(Boolean).join(' ');
}

function passageText(p) {
  return `${p.title || ''} ${p.text || ''}`.trim();
}

// ─── CHK-1: Canonical types ────────────────────────────────────────────────

function chk1(batch, file) {
  const findings = [];
  const lang = inferAuditLang(batch);
  for (const q of batch.questions || []) {
    if (!isCanonicalType(q.type, lang)) {
      const hint = q.type === 'multiple' ? ' (usar multiple_choice)' : '';
      findings.push(finding('CHK-1', 'CRITICAL', file, q.id,
        `type:"${q.type}" no es canónico${hint}`));
    }
  }
  return findings;
}

// ─── CHK-2: correct === correctAnswer + valid values per type ──────────────

const VALID_CORRECT = {
  richtig_falsch:  v => ['Richtig','Falsch','R','F'].includes(v) || /^(richtig|falsch|true|false|r|f)$/i.test(v),
  ja_nein:         v => ['Ja','Nein','J','N'].includes(v)        || /^(ja|nein|j|n|yes|no)$/i.test(v),
  matching:        v => /^[a-jA-J0Xx]$/.test(v),
  // Renderer stores the user's click as optKey() → a single letter (any case).
  // Grading uses normalizeGradingToken() which calls .toLowerCase().
  // Both "A" and "a" grade correctly.  Accept a–d (case-insensitive) to cover
  // parts with up to 4 options (some Lesen T2 / Hören T2 records).
  multiple_choice: v => /^[a-dA-D]$/.test(v),
  short_answer:    v => v === 'rubric',
};

function isMcqQuestionType(type) {
  const t = String(type || '').toLowerCase();
  return t === 'multiple_choice' || t === 'multiple' || t === 'mcq';
}

function chk2(batch, file) {
  const findings = [];
  for (const q of batch.questions || []) {
    const c = q.correct, ca = q.correctAnswer;
    if (c == null || ca == null) {
      findings.push(finding('CHK-2', 'CRITICAL', file, q.id, '`correct` o `correctAnswer` es null'));
      continue;
    }
    if (String(c) !== String(ca)) {
      findings.push(finding('CHK-2', 'CRITICAL', file, q.id,
        `correct="${c}" ≠ correctAnswer="${ca}"`));
    }
    const validator = VALID_CORRECT[q.type]
      || (isMcqQuestionType(q.type) ? VALID_CORRECT.multiple_choice : null);
    if (validator && !validator(String(c))) {
      findings.push(finding('CHK-2', 'CRITICAL', file, q.id,
        `correct="${c}" no válido para type="${q.type}"`));
    }
    // richtig_falsch → options must be []
    if (q.type === 'richtig_falsch' && Array.isArray(q.options) && q.options.length > 0) {
      findings.push(finding('CHK-2', 'IMPORTANT', file, q.id,
        'richtig_falsch debe tener options:[]'));
    }
    // matching Hören T4 → 3 options starting a)/b)/c)
    if (q.type === 'matching' && q.module === 'horen' && Number(q.teil) === 4) {
      const opts = q.options || [];
      if (opts.length !== 3) {
        findings.push(finding('CHK-2', 'CRITICAL', file, q.id,
          `Hören T4 matching debe tener 3 options, tiene ${opts.length}`));
      } else {
        ['a) ', 'b) ', 'c) '].forEach((prefix, i) => {
          if (!String(opts[i] || '').startsWith(prefix)) {
            findings.push(finding('CHK-2', 'IMPORTANT', file, q.id,
              `option[${i}] debe empezar por "${prefix}", tiene "${opts[i]}"`));
          }
        });
      }
    }
    // MCQ option count. Goethe B1 is 3 everywhere; Cambridge varies by part (Reading P3/P5
    // use four), so take the expected number from the blueprint of the batch's own (lang,
    // level) when it declares one. Lesen T2 malformed is CRITICAL (Goethe).
    if (isMcqQuestionType(q.type)) {
      const opts = q.options || [];
      const mod = String(q.module || batch.module || '').toLowerCase();
      const teil = Number(q.teil ?? batch.teil);
      const isLesenT2 = mod === 'lesen' && teil === 2;
      const bpPart = blueprintForLevel(inferAuditLevel(batch), inferAuditLang(batch))[`${mod}-${teil}`];
      const expected = bpPart && bpPart.options !== undefined ? bpPart.options : 3;
      if (expected != null && opts.length !== expected) {
        const sev = isLesenT2 ? 'CRITICAL' : 'IMPORTANT';
        const scope = isLesenT2 ? 'lesen-2' : `${mod}-t${teil}`;
        findings.push(finding('CHK-2', sev, file, q.id,
          `${scope}: MCQ requiere exactamente ${expected} options, tiene ${opts.length} (type="${q.type}")`));
      }
    }
  }
  return findings;
}

// ─── CHK-3: Item count vs blueprint ───────────────────────────────────────

function chk3(batch, file) {
  const findings = [];
  const blueprint = blueprintForLevel(inferAuditLevel(batch), inferAuditLang(batch));
  // Group by module+teil
  const groups = {};
  for (const q of batch.questions || []) {
    const key = bpKey(q);
    groups[key] = (groups[key] || 0) + 1;
  }
  for (const [key, count] of Object.entries(groups)) {
    const spec = blueprint[key];
    if (!spec || spec.count === null) continue;
    if (count !== spec.count) {
      findings.push(finding('CHK-3', 'CRITICAL', file, key,
        `${key}: se esperan ${spec.count} ítems, hay ${count}`));
    }
  }
  return findings;
}

// ─── CHK-3b: Teile completamente ausentes (solo modo examen completo) ─────
// chk3 ya detecta conteos incorrectos para los Teile PRESENTES.
// chk3Absent añade: si un Teil esperado tiene 0 ítems → CRITICAL "Teil ausente".
// Solo se llama desde auditExam — nunca en auditorías de batch/parte suelta.
function chk3Absent(flat, file) {
  const findings = [];
  const blueprint = blueprintForLevel(inferAuditLevel(flat), inferAuditLang(flat));
  const presentKeys = new Set();
  for (const q of flat.questions || []) {
    const key = bpKey(q);
    if (blueprint[key]) presentKeys.add(key);
  }
  for (const [key, spec] of Object.entries(blueprint)) {
    if (spec.count === null) continue; // short_answer / sprechen = conteo variable
    if (!presentKeys.has(key)) {
      findings.push(finding('CHK-3', 'CRITICAL', file, key,
        `${key}: se esperan ${spec.count} ítems, hay 0 (Teil ausente)`));
    }
  }
  return findings;
}

// ─── CHK-4: Balance de respuestas ─────────────────────────────────────────

function chk4(batch, file) {
  const findings = [];
  const groups = {};
  for (const q of batch.questions || []) {
    const key = balanceKey(q);
    if (!groups[key]) groups[key] = [];
    groups[key].push(q);
  }

  for (const [key, qs] of Object.entries(groups)) {
    const n = qs.length;
    if (n < 2) continue;
    const type = qs[0]?.type;
    const dist = {};
    for (const q of qs) {
      const v = String(q.correct || '').toLowerCase();
      dist[v] = (dist[v] || 0) + 1;
    }

    if (type === 'multiple_choice' || (type === 'matching' && key.startsWith('horen-4'))) {
      // All 3 letters must appear at least once (enforced for ≥5 MC items — V-18 fix:
      // was n≥6, but n=5 with one missing letter still indicates answer-key bias).
      if (n >= 5) {
        const letters = ['a','b','c'];
        for (const letter of letters) {
          if (!dist[letter]) {
            findings.push(finding('CHK-4', 'IMPORTANT', file, key,
              `Balance MC: letra "${letter}" no aparece ninguna vez. Dist: ${JSON.stringify(dist)}`));
          }
        }
      }
      // No single letter > 65% (allows 3/5=60% which is acceptable with few items).
      // ≥75% with n≥5 is CRITICAL (adivinable: marcar siempre esa letra = ≥75% score).
      for (const [v, cnt] of Object.entries(dist)) {
        const pct = cnt / n;
        const limit = key.startsWith('horen-4') && v === 'a' ? 0.50 : 0.65;
        if (pct > limit) {
          const sev = (n >= 5 && pct >= 0.75) ? 'CRITICAL' : 'IMPORTANT';
          findings.push(finding('CHK-4', sev, file, key,
            `Balance MC: "${v}"=${Math.round(pct*100)}% supera el máximo ${Math.round(limit*100)}%${sev === 'CRITICAL' ? ' (≥75% con n≥5 = adivinable)' : ''}. Dist: ${JSON.stringify(dist)}`));
        }
      }
    } else if (type === 'richtig_falsch' || type === 'ja_nein') {
      const vals = Object.values(dist);
      const allSame = vals.length === 1;
      if (allSame && n >= 5) {
        findings.push(finding('CHK-4', 'IMPORTANT', file, key,
          `Balance: todos los ítems tienen la misma respuesta. Dist: ${JSON.stringify(dist)}`));
      }
      // Rango ampliado a 15-85% para richtig_falsch/ja_nein: con pocos items (5-6),
      // distribuciones como 4/1 (80%) son estadísticamente válidas. Solo flagear extremos
      // evidentes (0% o 100% ya cubierto por allSame; aquí cubrimos 1/6=17% o 5/6=83%).
      if (n >= 5) {
        for (const [v, cnt] of Object.entries(dist)) {
          const pct = cnt / n;
          if (pct < 0.15 || pct > 0.85) {
            findings.push(finding('CHK-4', 'IMPORTANT', file, key,
              `Balance R/F o Ja/Nein: "${v}"=${Math.round(pct*100)}% fuera de rango 15–85%. Dist: ${JSON.stringify(dist)}`));
          }
        }
      }
    }
  }
  return findings;
}

// ─── CHK-5: Global passage dedup ──────────────────────────────────────────

function chk5(allBatches) {
  const findings = [];
  // Build passage registry: hash → [{file, id, title}]
  const byHash = {};
  const byTitle = {};
  const entries = []; // {file, id, tokens, title}

  for (const { batch, file } of allBatches) {
    for (const p of batch.passages || []) {
      const text = passageText(p);
      if (text.length < 30) continue;
      const h = sha1(text);
      if (!byHash[h]) byHash[h] = [];
      byHash[h].push({ file, id: p.id, preview: text.slice(0, 60) });

      const normTitle = normalizeText(p.title || '');
      if (normTitle.length > 5) {
        if (!byTitle[normTitle]) byTitle[normTitle] = [];
        byTitle[normTitle].push({ file, id: p.id });
      }

      entries.push({ file, id: p.id, tokens: tokenize(text), title: p.title || '' });
    }
  }

  // Exact hash duplicates
  for (const [, group] of Object.entries(byHash)) {
    if (group.length < 2) continue;
    const files = [...new Set(group.map(g => g.file))];
    if (files.length < 2) continue; // same file is ok (shouldn't happen)
    findings.push(finding('CHK-5', 'IMPORTANT', files[0], group[0].id,
      `Pasaje idéntico (hash exacto) en ${group.length} archivos: ${files.slice(0,5).join(', ')} — "${group[0].preview}"`));
  }

  // Title duplicates (across files)
  for (const [, group] of Object.entries(byTitle)) {
    if (group.length < 2) continue;
    const files = [...new Set(group.map(g => g.file))];
    if (files.length < 2) continue;
    const ids = group.map(g => g.id).join(', ');
    findings.push(finding('CHK-5', 'MINOR', files[0], ids,
      `Título de pasaje duplicado en ${files.length} archivos: "${group[0].file}" … (ids: ${ids.slice(0,80)})`));
  }

  // Jaccard near-duplicates (skip already flagged exact dups)
  const exactHashes = new Set(
    Object.values(byHash).filter(g => g.length >= 2).flatMap(g => g.map(x => x.id))
  );
  const processed = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (exactHashes.has(entries[i].id)) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (exactHashes.has(entries[j].id)) continue;
      if (entries[i].file === entries[j].file) continue;
      const key = `${entries[i].id}::${entries[j].id}`;
      if (processed.has(key)) continue;
      processed.add(key);
      const sim = jaccard(entries[i].tokens, entries[j].tokens);
      if (sim > 0.6) {
        findings.push(finding('CHK-5', 'MINOR', entries[i].file, entries[i].id,
          `Jaccard=${(sim*100).toFixed(0)}% con "${entries[j].id}" (${entries[j].file})`));
      }
    }
  }

  return findings;
}

// ─── CHK-6: C1/C2 blacklist (+ B2+ for B1 questions) ───────────────────────

function inferBatchLevel(batch) {
  const lv = batch?.level || batch?.questions?.[0]?.level || batch?.passages?.[0]?.level;
  return String(lv || 'B1').trim().toUpperCase();
}

function chk6(batch, file) {
  const findings = [];
  const level = inferBatchLevel(batch);
  const check = (text, scope, entries, label, chkId = 'CHK-6', targetLevel = 'B1') => {
    if (!text) return;
    for (const entry of entries) {
      if (!entry.term.test(text)) continue;
      const match = text.match(entry.term)?.[0] || '';
      const msg = entry.grammar
        ? `Error gramatical "${match}" → ${entry.suggestion}`
        : `${label} "${match}" → usa "${entry.suggestion}" (${targetLevel})`;
      findings.push(finding(chkId, 'IMPORTANT', file, scope, msg));
    }
  };

  for (const p of batch.passages || []) {
    check(p.text, `passage:${p.id}`, BLACKLIST, 'Vocabulario C1/C2');
    check(p.title, `passage:${p.id}:title`, BLACKLIST, 'Vocabulario C1/C2');
  }
  for (const q of batch.questions || []) {
    check(q.question, `q:${q.id}:question`, BLACKLIST, 'Vocabulario C1/C2');
    check(q.signText, `q:${q.id}:signText`, BLACKLIST, 'Vocabulario C1/C2');
    check(q.explanation, `q:${q.id}:explanation`, BLACKLIST, 'Vocabulario C1/C2');
    for (const o of q.options || []) check(String(o), `q:${q.id}:option`, BLACKLIST, 'Vocabulario C1/C2');
    if (level !== 'A2') {
      check(q.question, `q:${q.id}:question`, B2_QUESTION_BLACKLIST, 'Vocabulario B2+ en pregunta');
      check(q.signText, `q:${q.id}:signText`, B2_QUESTION_BLACKLIST, 'Vocabulario B2+ en pregunta');
      check(q.explanation, `q:${q.id}:explanation`, B2_QUESTION_BLACKLIST, 'Vocabulario B2+ en pregunta');
      for (const o of q.options || []) {
        check(String(o), `q:${q.id}:option`, B2_QUESTION_BLACKLIST, 'Vocabulario B2+ en pregunta');
      }
    }
  }
  return findings;
}

// ─── CHK-6c: B1+ blacklist in A2 questions ─────────────────────────────────

function chk6c(batch, file) {
  const findings = [];
  if (inferBatchLevel(batch) !== 'A2') return findings;
  const check = (text, scope, entries, label) => {
    if (!text) return;
    for (const entry of entries) {
      if (!entry.term.test(text)) continue;
      const match = text.match(entry.term)?.[0] || '';
      const msg = `${label} "${match}" → usa "${entry.suggestion}" (A2)`;
      findings.push(finding('CHK-6c', 'IMPORTANT', file, scope, msg));
    }
  };
  for (const q of batch.questions || []) {
    check(q.question, `q:${q.id}:question`, B1_QUESTION_BLACKLIST, 'Vocabulario B1+ en pregunta');
    check(q.signText, `q:${q.id}:signText`, B1_QUESTION_BLACKLIST, 'Vocabulario B1+ en pregunta');
    check(q.explanation, `q:${q.id}:explanation`, B1_QUESTION_BLACKLIST, 'Vocabulario B1+ en pregunta');
    for (const o of q.options || []) {
      check(String(o), `q:${q.id}:option`, B1_QUESTION_BLACKLIST, 'Vocabulario B1+ en pregunta');
    }
  }
  return findings;
}

// ─── CHK-7: Lesen T4 — affirmative + coherence ────────────────────────────

const T4_NEIN_MARKERS = ['dagegen','lehne','bin gegen','nicht einverstanden','skeptisch','ablehnen','sage ich nein','nicht gut'];
const T4_JA_MARKERS   = ['bin dafür','bin für','finde den vorschlag gut','unterstütze','absolut für','befürworte','einverstanden','sehr gut','sage ich ja'];
const T4_NEGATION_RE  = /\b(nicht|kein|kein\w*|lehnt|gegen|ablehn\w*|widerspricht)\b/i;

function chk7(batch, file) {
  const findings = [];
  const level = inferAuditLevel(batch);
  const t4qs = (batch.questions || []).filter((q) => {
    const mod = String(q.module || '').toLowerCase();
    const teil = Number(q.teil);
    // A2 Hören T4 = Ja/Nein sobre entrevista (no patrón Lesen T4 foro).
    if (mod === 'horen' && teil === 4 && level === 'A2') return false;
    // A2 Lesen T4 = matching Anzeigen a–f (no foro B1).
    if (mod === 'lesen' && teil === 4 && level === 'A2') return false;
    // B2 Lesen T4 = Meinung↔Überschrift matching A–H (no foro Ja/Nein).
    if (mod === 'lesen' && teil === 4 && level === 'B2') return false;
    return q.type === 'ja_nein' || (mod === 'lesen' && teil === 4);
  });
  if (!t4qs.length) return findings;

  // Negation in question text (CRITICAL)
  for (const q of t4qs) {
    const m = (q.question || '').match(T4_NEGATION_RE);
    if (m) {
      findings.push(finding('CHK-7', 'CRITICAL', file, q.id,
        `Lesen T4: enunciado contiene negación "${m[0]}". Debe ser afirmativo: "Ist <Name> für den Vorschlag?"`));
    }
  }

  // Homogeneous pattern: accept "Ist <Name> für …?" OR "Sagt die Person: …" (IMPORTANT if neither)
  const isValidT4Question = (q) => {
    const question = q.question || '';
    return (/^Ist\s/i.test(question) && /\?$/.test(question)) ||
           /^Sagt die Person:/i.test(question);
  };
  const nonAffirmative = t4qs.filter(q => !isValidT4Question(q));
  if (nonAffirmative.length > 0) {
    findings.push(finding('CHK-7', 'IMPORTANT', file, nonAffirmative[0].id,
      `Lesen T4: ${nonAffirmative.length} pregunta(s) no siguen el patrón "Ist <Name> für …?" ni "Sagt die Person: …"`));
  }

  // Coherence: signText stance vs correct (IMPORTANT, heuristic)
  for (const q of t4qs) {
    const st = (q.signText || '').toLowerCase();
    const correct = String(q.correct || '').trim();
    const hasNein = T4_NEIN_MARKERS.some(m => st.includes(m));
    const hasJa   = T4_JA_MARKERS.some(m => st.includes(m));
    const hasTrotzdem = /trotzdem|obwohl|dennoch|zwar/.test(st);

    if (hasNein && !hasTrotzdem && correct === 'Ja') {
      findings.push(finding('CHK-7', 'IMPORTANT', file, q.id,
        `Lesen T4: signText sugiere NEIN ("${T4_NEIN_MARKERS.find(m=>st.includes(m))}") pero correct="${correct}". Revisar manualmente.`));
    }
    if (hasJa && !hasNein && correct === 'Nein') {
      findings.push(finding('CHK-7', 'IMPORTANT', file, q.id,
        `Lesen T4: signText sugiere JA ("${T4_JA_MARKERS.find(m=>st.includes(m))}") pero correct="${correct}". Revisar manualmente.`));
    }

    // Meta-tag antinatural (MINOR)
    if (/\bimplizit\b|\bexplizit\b/i.test(q.signText || '')) {
      findings.push(finding('CHK-7', 'MINOR', file, q.id,
        `Lesen T4: signText contiene meta-etiqueta antinatural ("implizit"/"explizit"). Reformula de forma natural.`));
    }
  }

  // Balance Ja/Nein per file (IMPORTANT)
  const jaCount  = t4qs.filter(q => String(q.correct).toLowerCase() === 'ja').length;
  const neinCount = t4qs.length - jaCount;
  if (t4qs.length === 7 && (jaCount < 3 || jaCount > 4)) {
    findings.push(finding('CHK-7', 'IMPORTANT', file, 'T4-balance',
      `Lesen T4: balance Ja/Nein = ${jaCount}/${neinCount}. Se esperan 3–4 Ja y 3–4 Nein.`));
  }

  return findings;
}

// ─── CHK-8: Basic integrity ────────────────────────────────────────────────

function chk8(batch, file, globalIds) {
  const findings = [];
  const passageIds = new Set((batch.passages || []).map(p => p.id));
  const REQUIRED = ['id','module','teil','type','question','correct','correctAnswer'];

  for (const q of batch.questions || []) {
    // Required fields
    for (const field of REQUIRED) {
      if (q[field] == null || q[field] === '') {
        findings.push(finding('CHK-8', 'CRITICAL', file, q.id || '?',
          `Campo obligatorio faltante: "${field}"`));
      }
    }
    // Global ID uniqueness
    if (q.id) {
      if (globalIds.has(q.id)) {
        findings.push(finding('CHK-8', 'CRITICAL', file, q.id, `ID duplicado globalmente: ${q.id}`));
      } else {
        globalIds.add(q.id);
      }
    }
    // passageId integrity
    const needsPassage = ['lesen','horen'].includes(String(q.module || '').toLowerCase());
    if (needsPassage && q.passageId && !passageIds.has(q.passageId)) {
      findings.push(finding('CHK-8', 'CRITICAL', file, q.id,
        `passageId "${q.passageId}" no encontrado en passages[] del mismo archivo`));
    }
  }
  return findings;
}

// ─── CHK-10: Lenguaje absoluto en Lesen T1 y Hören T1 ────────────────────
// Palabras absolutas en ítems RICHTIG hacen el ítem trivialmente correcto (word-match).
// En ítems FALSCH son scope traps legítimas (el Goethe real las usa): no se penalizan.
// La frase "ausschließlich täglich" se penaliza siempre por ser artificialmente obvia.

const ABSOLUTE_WORDS_RE = /\b(immer|nie|niemals|alle[rsn]?|ausschließlich|komplett|völlig|keinerlei|jede[rsn]?|stets|grundsätzlich|absolut|durchgehend|generell)\b/i;
const ABSOLUTE_PHRASE_RE = /ausschließlich\s+täglich/i;

function chk10(batch, file) {
  const findings = [];
  // Evalúa lesen T1 y horen T1 con la misma lógica de correlación
  for (const [mod, teil] of [['lesen', 1], ['horen', 1]]) {
    const rfItems = (batch.questions || []).filter(q =>
      q.module === mod && Number(q.teil) === teil &&
      (q.type === 'richtig_falsch' || q.type === 'true_false'));
    if (rfItems.length === 0) continue;

    const isFalsch  = q => /^falsch$/i.test(String(q.correct || q.correctAnswer || ''));
    const isRichtig = q => /^richtig$/i.test(String(q.correct || q.correctAnswer || ''));
    const hasAbs    = q => ABSOLUTE_WORDS_RE.test(q.question || '');

    // Frase artificial: siempre IMPORTANT
    for (const q of rfItems) {
      if (ABSOLUTE_PHRASE_RE.test(q.question || '')) {
        findings.push(finding('CHK-10', 'IMPORTANT', file, q.id,
          `${mod} T1: frase artificial "ausschließlich täglich" — reescribir como contradicción de contenido.`));
      }
    }

    const absItems   = rfItems.filter(hasAbs);
    const absFalsch  = absItems.filter(isFalsch);
    const absRichtig = absItems.filter(isRichtig);

    // (1) Sobre-uso: >~33% de los RF con palabra absoluta
    if (absItems.length > Math.ceil(rfItems.length / 3)) {
      findings.push(finding('CHK-10', 'IMPORTANT', file, absItems[0].id,
        `${mod} T1: ${absItems.length}/${rfItems.length} enunciados con palabra de alcance (sobre-uso, adivinable).`));
    }
    // (2) Correlación perfecta: ≥2 con absoluta y TODAS en Falsch (0 en Richtig) → "absoluta ⟹ Falsch"
    else if (absItems.length >= 2 && absRichtig.length === 0) {
      findings.push(finding('CHK-10', 'IMPORTANT', file, absFalsch[0].id,
        `${mod} T1: la palabra de alcance predice la respuesta (${absFalsch.length} en Falsch, 0 en Richtig).`));
    }
    // (3) Un solo caso aislado → MINOR (aceptable, pero a vigilar)
    else if (absItems.length === 1) {
      findings.push(finding('CHK-10', 'MINOR', file, absItems[0].id,
        `${mod} T1: 1 enunciado con palabra de alcance («${(absItems[0].question||'').match(ABSOLUTE_WORDS_RE)?.[0]}») — ok si no predice la respuesta.`));
    }
  }
  return findings;
}

// ─── CHK-12: Balance Richtig/Falsch en bloques R/F ────────────────────────
// Para cada (módulo,teil) con ítems richtig_falsch: ninguna respuesta debe superar el 70 %.

function chk12(batch, file) {
  const findings = [];
  const groups = {};
  for (const q of batch.questions || []) {
    if (q.type !== 'richtig_falsch' && q.type !== 'true_false') continue;
    const key = `${q.module}-${q.teil}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(String(q.correct || q.correctAnswer || ''));
  }
  for (const [k, arr] of Object.entries(groups)) {
    if (arr.length < 4) continue;
    const r = arr.filter(x => /^richtig$/i.test(x)).length;
    const share = Math.max(r, arr.length - r) / arr.length;
    if (share > 0.70) {
      findings.push(finding('CHK-12', 'IMPORTANT', file, k,
        `${k}: bloque R/F desbalanceado (${r}R/${arr.length - r}F = ${Math.round(share * 100)}% una respuesta). Máx 70%.`));
    }
  }
  return findings;
}

// ─── CHK-13: MC debe usar las 3 letras, ninguna > 55 % ───────────────────
// Para cada (módulo,teil) con multiple_choice de 3 opciones y ≥3 ítems.

function chk13(batch, file) {
  const findings = [];
  const groups = {};
  for (const q of batch.questions || []) {
    if (q.type !== 'multiple_choice') continue;
    if (!Array.isArray(q.options) || q.options.length !== 3) continue;
    const key = `${q.module}-${q.teil}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(String(q.correct || q.correctAnswer || '').toLowerCase());
  }
  for (const [k, arr] of Object.entries(groups)) {
    if (arr.length < 3) continue;
    const present = new Set(arr);
    const missing = ['a', 'b', 'c'].filter(L => !present.has(L));
    const top = Math.max(...['a', 'b', 'c'].map(L => arr.filter(x => x === L).length)) / arr.length;
    if (missing.length) {
      findings.push(finding('CHK-13', 'IMPORTANT', file, k,
        `${k}: MC no usa la(s) letra(s) ${missing.join(',')} en ningún ítem.`));
    } else if (top > 0.55) {
      findings.push(finding('CHK-13', 'IMPORTANT', file, k,
        `${k}: una letra MC supera el 55% (${Math.round(top * 100)}%).`));
    }
  }
  return findings;
}

// ─── CHK-14: Sustantivos alemanes en minúscula ────────────────────────────
// Dos capas de detección, ambas de baja tasa de falsos positivos:
//
//  Capa A — Sufijos exclusivamente nominales: palabras que terminan en -ung,
//    -heit, -keit, -schaft, -tum, -nis (plurales incluidos) escritas en
//    minúscula después de un artículo. Prácticamente imposible que sean
//    adjetivos o verbos, así que el falso-positivo es casi nulo.
//
//  Capa B — Lista explícita de sustantivos comunes que el LLM olvida
//    capitalizar con frecuencia (detectados empíricamente en el banco).

// CHK-14 triggers after these articles/conjunctions/prepositions.
// Flag /gi so sentence-initial capitals (Der, Die, Das, Kein, Keine…) also match;
// the captured word is then checked separately for lowercase-start.
const ARTICLE_RE_14 = /\b(?:die|der|das|den|dem|des|ein|eine|einen|einem|einer|eines|kein|keine|keinen|keinem|keiner|keines|und|oder|mit|für|ohne|durch|um|bei|nach|seit|von|vor|über|unter|neben|zwischen|je)\s+(\S{4,})/gi;

// Nominal suffixes that are unambiguously nouns (never adjectives/verbs).
// Extended: added -bau, -gut, -werk, -stoff, -zeug, -tat to catch compound nouns.
const NOUN_SUFFIX_RE_14 = /(ung|heit|keit|schaft|tum|nis|nisse|sal|bau|werk|stoff|zeug|tat|ion|ität|ismus|ation|anz|enz|ur|tur|ör)s?$/i;

// Known frequently-miscapitalized nouns — empirical list extended with:
//  • English loanwords used as German nouns (must be capitalized in German)
//  • German nouns with "tricky" endings not covered by NOUN_SUFFIX_RE_14
//  • Nouns from B1 topic areas where LLMs make consistent mistakes
//
// NOTE: "junge" (Junge=boy) and "arbeiten" (Arbeiten=works) are intentionally
// NOT included because they are far more commonly used as adjective/verb and
// produce too many false positives after "der/für/und" in normal sentences.
const KNOWN_LOWER_NOUNS_14 = new Set([
  // ── Everyday nouns ──
  'blumen','blume','garten','gärten','straße','straßen','weg','wege',
  'schule','schulen','lehrer','lehrerin','freund','freunde','freundin',
  'arbeit','wohnung','wohnungen','zimmer','küche','keller',
  'sonne','mond','stern','sterne','erde','himmel','berg','berge',
  'wald','wälder','fluss','flüsse','see','seen','meer','insel',
  'hund','hunde','katze','katzen','vogel','vögel','fisch','fische',
  'tisch','tische','stuhl','stühle','fenster','tür','türen',
  'buch','bücher','film','filme','sport','musik','kunst','theater',
  'mann','männer','frau','frauen','kind','kinder','mädchen',
  'familie','familien','eltern','mutter','vater','bruder','schwester',
  'arzt','ärzte','krankenhaus','apotheke','polizei','feuerwehr',
  'bahnhof','flughafen','hotel','restaurant','geschäft','laden',
  'land','länder','stadt','städte','dorf','dörfer','platz','plätze',
  'markt','märkte','park','parks','brunnen','statue',
  // ── Nouns with -e/-en endings (not covered by suffix regex) ──
  'hypothese','these','analyse','phrase','szene','stunde',
  'woche','pause','gruppe','klasse','aufgabe','frage','antwort',
  'reise','sprache','sprachen','übung','regel','stelle',
  // ── Compound nouns ending in -bau,-werk,-stoff etc. ──
  'wohnungsbau','hausbau','stadtbau','ausbau','umbau','neubau',
  'handwerk','kunstwerk','bauwerk','netzwerk','fahrzeug','werkzeug',
  // ── English loanwords used as German nouns (MUST be capitalized) ──
  'deadline','meeting','team','job','hobby','computer','internet',
  'email','video','blog','podcast','app','clip','link','post',
  'chat','design','trend','event','ticket','coach','fan','kit',
  'check','deal','feedback','update','upgrade','login','logout',
  'workshop','startup','backup','download','upload','streaming',
  'hashtag','selfie','smartphone','laptop','tablet','server',
]);

// Words that might be captured by ARTICLE_RE_14 but are NOT nouns —
// commonly adjectives, adverbs, or verbs in German.
// These are excluded to prevent false positives.
const KNOWN_NOT_NOUNS_14 = new Set([
  'ganz','halb','alle','jede','jeder','jedes','alles','beides',
  'junge','alte','neue','kleine','große','lange','kurze','gute','schöne',
  'erste','zweite','dritte','letzte','frühere','andere','eigene',
  'wichtige','richtige','falsche','einfache','schwierige',
  'nächste','gleiche','selbe','bestimmte','meiste',
  'arbeiten','spielen','lernen','wohnen','leben','fahren','gehen',
  'lesen','schreiben','kochen','kaufen','machen','helfen',
  'sprechen','wünschen','suchen','fragen','antworten','bezahlen','lernen',
  'pflanzen','ernten','tragen','spielen','arbeiten',
  // Sprechen prompts: imperative / finite verbs after und|oder (CHK-14 FP)
  'stellen','planen','geben','nehmen','wählen','einigen','reagieren',
  'verständliche','verständlich','vielen','viele','ledige','ledig',
  // Adjectives in lexicon — not nouns after und/oder/mit
  'teuer','teure','teures','teuren','teurer','teurem',
  'billig','billige','billiges','billigen','billiger','billigem',
  'preiswert','preiswerte','preiswerten','preiswertes','preiswerter','preiswertem',
  'positive','positiven','positives','positiver','positivem',
  'politische','politischen','politisches','politischem','politischer',
  'sogenannte','sogenannten','sogenannter','sogenanntes',
  'übrig','übrige','übrigen','rein','reine','reinen','online',
  'ganz','ganze','ganzen',
  // Canary 2026-07-11: finite / plural verb forms (lexicon marks some as nouns)
  // NOTE: «glaube» is NOT listed — der Glaube is a real noun; see isChk14FiniteVerbFp.
  'brauchen','braucht','brauchst','brauchte','brauchten','bräuchte','bräuchten',
]);

/** Personal pronouns that typically follow a finite verb (ich glaube, brauchen wir…). */
const CHK14_VERB_PRONOUNS = new Set([
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr',
  'mich', 'dich', 'ihm', 'ihn', 'uns', 'euch', 'mir', 'dir',
]);

/**
 * 1st-person / common finite forms that are often also noun lemmas in the lexicon
 * (Glaube, Denken…). Only skip when the next token is a personal pronoun.
 */
const CHK14_FINITE_VERB_BEFORE_PRONOUN = new Set([
  'glaube', 'glaubst', 'glaubt',
  'denke', 'denkst', 'denkt',
  'finde', 'findest', 'findet',
  'weiß', 'weiss', 'weißt', 'weisst',
  'hoffe', 'hoffst', 'hofft',
  'meine', 'meinst', 'meint', // «das meine ich» (not possessive meine+noun — next is pronoun)
]);

/**
 * Comparative adjective surface: teurere, kleineren, bessere, größeren.
 * Requires the comparative -er- plus a strong/weak ending — bare -er agent nouns
 * (Lehrer, Arbeiter) do NOT match.
 */
function looksLikeComparativeAdjective(word) {
  const lc = String(word || '').toLowerCase();
  if (lc.length < 6) return false;
  if (NOUN_SUFFIX_RE_14.test(lc)) return false;
  return /er(?:e|en|er|es|em)$/i.test(lc);
}

/**
 * Positive-degree neuter/weak adjective ending in -es (leises Spielen, gutes Essen).
 * High precision: German noun lemmas rarely end in -es.
 */
function looksLikeNeuterAdjectiveEs(word) {
  const lc = String(word || '').toLowerCase();
  if (lc.length < 5) return false;
  if (NOUN_SUFFIX_RE_14.test(lc)) return false;
  return /es$/i.test(lc);
}

/** Locution «ein paar» (= some); not the noun «das Paar». */
function isEinPaarIdiom(articleLemma, word) {
  return String(articleLemma || '').toLowerCase() === 'ein'
    && String(word || '').toLowerCase() === 'paar';
}

/** Locution «ein bisschen» (= a little); not the noun «das Bisschen». */
function isEinBisschenIdiom(articleLemma, word) {
  return String(articleLemma || '').toLowerCase() === 'ein'
    && String(word || '').toLowerCase() === 'bisschen';
}

function chk14NextToken(text, matchEnd) {
  const m = String(text || '')
    .slice(matchEnd)
    .match(/^\s+(\S+)/);
  if (!m) return null;
  return m[1].replace(/[''´].*$/, '').replace(/[.,!?;:»«"()\[\]{}].*$/, '');
}

function chk14ArticleLemma(fullMatch, capturedWord) {
  const raw = String(fullMatch || '');
  const word = String(capturedWord || '');
  // Prefer leading trigger token (die|und|mit|…) — robust when m[0] still has
  // trailing punctuation on the captured word («und glauben,» vs stripped «glauben»).
  const lead = raw.match(
    /^(die|der|das|den|dem|des|ein|eine|einen|einem|einer|eines|kein|keine|keinen|keinem|keiner|keines|und|oder|mit|für|ohne|durch|um|bei|nach|seit|von|vor|über|unter|neben|zwischen|je)\b/i,
  );
  if (lead) return lead[1].toLowerCase();
  const withoutWord = word && raw.toLowerCase().endsWith(word.toLowerCase())
    ? raw.slice(0, raw.length - word.length)
    : raw;
  return withoutWord.trim().toLowerCase();
}

/** Bare infinitive morphology (glauben, versuchen) — not -ung/-heit nouns. */
function isChk14InfinitiveShape(word) {
  const w = String(word || '').toLowerCase();
  if (w.length < 5) return false;
  if (NOUN_SUFFIX_RE_14.test(w)) return false;
  return /(?:en|eln|ern)$/i.test(w);
}

/**
 * Context-sensitive verb FPs (canary: «das glaube ich», «und brauchen einen»).
 * Keeps «der glaube» (noun) detectable when no pronoun follows.
 *
 * 2026-07-12: also cover bare INFINITIVES after und/oder («und glauben, dass»).
 * The canary finite set (glaube/glaubst/glaubt + pronoun) never matched the
 * infinitive «glauben»; isKnownGermanNoun(glauben) was true only via stem
 * «glaube» (der Glaube) from singularCandidates -en strip.
 */
function isChk14FiniteVerbFp(word, articleLemma, nextTok) {
  const w = String(word || '').toLowerCase();
  const art = String(articleLemma || '').toLowerCase();
  const next = String(nextTok || '').toLowerCase();
  if (!w) return false;
  // «das/es glaube ich» — 1sg after demonstrative/neuter article
  if (CHK14_FINITE_VERB_BEFORE_PRONOUN.has(w) && next && CHK14_VERB_PRONOUNS.has(next)) {
    return true;
  }
  // «und/oder brauchen …» — listed non-nouns after coordinating conj
  if ((art === 'und' || art === 'oder') && KNOWN_NOT_NOUNS_14.has(w)) {
    return true;
  }
  // «und/oder glauben, dass» / «und wissen an …» — bare infinitive after coordinator
  // (not «die Wohnungen»: noun suffix; not «der Glaube»: article is der/die/das)
  if ((art === 'und' || art === 'oder') && isChk14InfinitiveShape(w)) {
    return true;
  }
  return false;
}

function chk14(batch, file) {
  const findings = [];
  function extractTexts(obj, acc = []) {
    if (!obj || typeof obj !== 'object') return acc;
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.length > 8) acc.push(v);
      else if (v && typeof v === 'object') extractTexts(v, acc);
    }
    return acc;
  }
  /** Next token after article+word match; used to skip attributive adj + CapNoun. */
  function nextCapitalizedToken(text, matchEnd) {
    const m = String(text || '')
      .slice(matchEnd)
      .match(/^\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß-]{2,})/);
    if (!m) return null;
    return m[1].replace(/[.,!?;:»«"()\[\]{}].*$/, '');
  }
  const texts = extractTexts(batch);
  const seen = new Set();
  for (const text of texts) {
    ARTICLE_RE_14.lastIndex = 0;
    let m;
    while ((m = ARTICLE_RE_14.exec(text)) !== null) {
      const word = m[1].replace(/[''´].*$/, '').replace(/[.,!?;:»«"()\[\]{}].*$/, ''); // strip punct/apostrophe
      if (!word || seen.has(word.toLowerCase())) continue;
      if (!/^[a-zäöü]/.test(word)) continue; // must start lowercase
      const articleLemma = chk14ArticleLemma(m[0], word);
      const nextTok = chk14NextToken(text, m.index + m[0].length);
      // «ein paar Ideen» — fixed quantifier, not noun «Paar»
      if (isEinPaarIdiom(articleLemma, word)) continue;
      if (isEinBisschenIdiom(articleLemma, word)) continue;
      if (KNOWN_NOT_NOUNS_14.has(word.toLowerCase())) continue; // common adj/verb false positives
      if (isChk14FiniteVerbFp(word, articleLemma, nextTok)) continue;
      if (ADJ_NEEDS_ARTICLE_GUARD.has(word.toLowerCase())) continue; // substantivised adj forms in lexicon
      const hasNounSuffix = NOUN_SUFFIX_RE_14.test(word);
      const isKnownNoun =
        KNOWN_LOWER_NOUNS_14.has(word.toLowerCase()) ||
        hasNounSuffix ||
        isKnownGermanNoun(word);
      if (!isKnownNoun) continue;
      const nextCap = nextCapitalizedToken(text, m.index + m[0].length);
      // v3.7: «die gelbe Tonne» — color/attr adj before CapNoun
      // canary: «leises Spielen», «kleineren Wohnungs…», «eine teurere Wohnung»
      if (nextCap && /^[A-ZÄÖÜ]/.test(nextCap)) {
        if (
          looksLikeAttributiveAdjective(word)
          || looksLikeComparativeAdjective(word)
          || looksLikeNeuterAdjectiveEs(word)
        ) {
          continue;
        }
      }
      seen.add(word.toLowerCase());
      const ctx = text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 30).replace(/\n/g, ' ');
      findings.push(finding('CHK-14', 'IMPORTANT', file, word,
        `Sustantivo en minúscula: "${word}" (tras artículo/conjunción). En alemán los sustantivos van en mayúscula. Contexto: "...${ctx}..."`));
    }
  }
  return findings;
}

// ─── CHK-14b: Adjetivos/adverbios alemanes capitalizados erróneamente ────────
// Complementa CHK-14 en la dirección inversa: detecta palabras de la lista
// NEVER_NOUN_WORDS que aparecen capitalizadas a mitad de frase (no al inicio).
// La lista es conservadora: solo se incluyen palabras sin forma nominal posible.
// Palabras ambiguas (Wissen, Essen, Junge, Lesen, …) se excluyen para evitar FP.

function chk14b(batch, file) {
  const findings = [];
  function collectTexts(obj, acc = []) {
    if (!obj || typeof obj !== 'object') return acc;
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.length > 4) acc.push(v);
      else if (v && typeof v === 'object') collectTexts(v, acc);
    }
    return acc;
  }

  const texts = collectTexts(batch);
  const seen = new Set();

  for (const text of texts) {
    for (const v of scanP2CapitalizationViolations(text)) {
      const key = `${v.severity}:${v.type}:${v.word.toLowerCase()}:${v.fix || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const idx = text.toLowerCase().indexOf(v.word.toLowerCase());
      const start = Math.max(0, idx - 35);
      const end = Math.min(text.length, idx + v.word.length + 35);
      const ctx = text.slice(start, end).replace(/\n/g, ' ');

      if (v.severity === 'advisory') {
        findings.push(finding('CHK-14', 'INFO', file, v.word,
          `Mayúscula a mitad de frase sin patrón claro de error — «${v.word}» no está en el léxico de sustantivos (aviso ortográfico, no bloquea). Contexto: "...${ctx}..."`));
        continue;
      }

      const label = v.type === 'zu_infinitive'
        ? `Infinitivo tras «zu» en mayúscula errónea: «${v.word}» → «zu ${v.fix}»`
        : v.type === 'modal_infinitive'
          ? `Infinitivo sin «zu» en mayúscula errónea: «${v.word}» → «${v.fix}»`
          : `Adjetivo/adverbio/cardinal «${v.word}» en mayúscula errónea (debería ser «${v.fix}»)`;
      findings.push(finding('CHK-14', 'IMPORTANT', file, v.word,
        `${label}. Contexto: "...${ctx}..."`));
    }
  }
  return findings;
}

// ─── CHK-14c: Mayúsculas en opciones MCQ (T2/T5) — reglas P2 estrictas ─────
function chk14c(batch, file) {
  const findings = [];
  const mod = String(batch.module || batch.questions?.[0]?.module || '').toLowerCase();
  const teil = Number(batch.teil ?? batch.questions?.[0]?.teil);
  if (mod !== 'lesen' || ![2, 5].includes(teil)) return findings;

  const seen = new Set();
  for (const q of batch.questions || []) {
    for (const opt of q.options || []) {
      const text = String(opt);
      if (text.length < 8) continue;
      for (const v of scanMcqOptionCapitalizationViolations(text)) {
        const key = `${q.id}:${v.type}:${v.word.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const label =
          v.type === 'bare_infinitive'
            ? `Infinitivo en mayúscula errónea en opción: «${v.word}» → «${v.fix}»`
            : v.type === 'modal_infinitive'
              ? `Infinitivo sin «zu» en mayúscula errónea: «${v.word}» → «${v.fix}»`
              : `Adjetivo/adverbio «${v.word}» en mayúscula errónea (debería ser «${v.fix}»)`;
        findings.push(finding('CHK-14c', 'IMPORTANT', file, q.id, `${label}. Opción: «${text.slice(0, 90)}…`));
      }
    }
  }
  return findings;
}

// ─── CHK-15: Word count de pasajes/transcripts vs blueprint ──────────────
// Cada Teil tiene un rango de palabras establecido en el Modellsatz oficial.
// Se cuenta el texto principal de cada pasaje o transcript.

// Rangos calibrados a partir del Modellsatz oficial Goethe B1:
//   L1: blog ~180 palabras · L2: prensa ~160-200/texto · L3: anuncio ~30-60
//   L4: opinión foro ~40-100 (Modellsatz real: Stefan ~75, Dagmar ~50 etc.)
//   L5: reglamento/aviso ~180-220
//   H1: segmento ~50-85 · H2: monólogo ~250-300 · H3: diálogo ~280-350 · H4: debate ~320-420
const WORD_COUNT_SPEC = {
  'lesen-1':  { min: 140, max: 260, scope: 'passage text (blog/email)' },
  'lesen-2':  { min: 130, max: 250, scope: 'cada passage individual (prensa, 2 textos)' },
  'lesen-3':  { min: 15,  max: 80,  scope: 'cada anuncio/opción' },
  'lesen-4':  { min: 25,  max: 110, scope: 'intro text o signText (opinión foro ~40-100 palabras)' },
  'lesen-5':  { min: 130, max: 280, scope: 'passage text (reglamento/aviso)' },
  'horen-1':  { min: 30,  max: 110, scope: 'cada segmento/transcript' },
  'horen-2':  { min: 180, max: 380, scope: 'transcript monólogo' },
  'horen-2-a2': { min: 70, max: 160, scope: 'transcript diálogo 2 personas (A2 Bild-Zuordnung)' },
  'horen-3':  { min: 200, max: 400, scope: 'transcript conversación' },
  'horen-4':  { min: 250, max: 480, scope: 'transcript debate (3 hablantes)' },
};

const WORD_COUNT_SPEC_A2 = {
  'lesen-1':  { min: 95,  max: 220, scope: 'passage text (A2 press MCQ)' },
  'lesen-2':  { min: 65,  max: 180, scope: 'info board (A2)' },
  'lesen-3':  { min: 60,  max: 200, scope: 'email (A2)' },
  'lesen-4':  { min: 15,  max: 80,  scope: 'each ad (A2 matching a–f)' },
  'horen-1':  { min: 15,  max: 80,  scope: 'A2 short text segment' },
  'horen-3':  { min: 12,  max: 70,  scope: 'A2 short dialogue segment' },
  'horen-4':  { min: 120, max: 280, scope: 'A2 interview transcript' },
};

/** Goethe B2 — forum posts per person (Lesen T1). */
const WORD_COUNT_SPEC_B2 = {
  'lesen-1':  { min: 80, max: 180, scope: 'B2 forum Personen-Beitrag (je Person)' },
  'lesen-2':  { min: 250, max: 400, scope: 'B2 Zeitschrift-Artikel (Sätze einfügen)' },
  'lesen-3':  { min: 350, max: 500, scope: 'B2 Zeitungsartikel (passages[0].text)' },
  'lesen-4':  { min: 40, max: 100, scope: 'B2 Meinungsäußerung (je passage)' },
  'lesen-5':  { min: 200, max: 350, scope: 'B2 Studienordnung (passages[0].text)' },
  'horen-1':  { min: 30, max: 90, scope: 'B2 Hören segment (je passage)' },
  'horen-2':  { min: 280, max: 400, scope: 'B2 Radiointerview (passages[0].text)' },
  'horen-3':  { min: 250, max: 380, scope: 'B2 Radiogespräch Panel (passages[0].text)' },
  'horen-4':  { min: 300, max: 450, scope: 'B2 Vortrag (passages[0].text)' },
};

function resolveWordCountSpec(key, level, lang = 'de') {
  // Cambridge declares its own passage lengths and exempts several parts; falling through to
  // the Goethe table measured English transcripts against German minimums.
  if (String(lang || 'de').trim().toLowerCase() === 'en') {
    const part = CAMBRIDGE_B1_BLUEPRINT[key];
    return part && part.words ? { ...part.words, scope: 'cambridge blueprint' } : null;
  }
  const lv = String(level || '').toUpperCase();
  if (lv === 'A2' && WORD_COUNT_SPEC_A2[key]) {
    return WORD_COUNT_SPEC_A2[key];
  }
  if (lv === 'B2' && WORD_COUNT_SPEC_B2[key]) {
    return WORD_COUNT_SPEC_B2[key];
  }
  return WORD_COUNT_SPEC[key];
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
}

function wordCountSpecKey(refQ) {
  const mod = String(refQ.module || '').toLowerCase();
  const teil = refQ.teil;
  const level = String(refQ.level || '').toUpperCase();
  if (mod === 'horen' && Number(teil) === 2 && level === 'A2') return 'horen-2-a2';
  return `${mod}-${teil}`;
}

function chk15(batch, file) {
  const findings = [];
  const level = inferAuditLevel(batch);
  const lang = inferAuditLang(batch);

  // Check passages (lesen)
  for (const p of batch.passages || []) {
    const text = p.text || '';
    if (!text || text.length < 10) continue;

    // Determine which Teil this passage belongs to via questions referencing it
    const refQ = (batch.questions || []).find(q => q.passageId === p.id);
    if (!refQ) continue;
    const key = wordCountSpecKey(refQ);
    const spec = resolveWordCountSpec(key, level, lang);
    if (!spec) continue;

    const wc = countWords(text);
    if (wc < spec.min) {
      findings.push(finding('CHK-15', 'IMPORTANT', file, p.id,
        `${key} pasaje demasiado corto: ${wc} palabras (mín ${spec.min}). Scope: ${spec.scope}`));
    } else if (wc > spec.max) {
      findings.push(finding('CHK-15', 'IMPORTANT', file, p.id,
        `${key} pasaje demasiado largo: ${wc} palabras (máx ${spec.max}). Scope: ${spec.scope}`));
    }
  }

  // Check L4 signTexts (they are in questions, not passages)
  const l4qs = (batch.questions || []).filter(q =>
    String(q.module||'').toLowerCase() === 'lesen' && Number(q.teil) === 4 && q.signText);
  const l4spec = resolveWordCountSpec('lesen-4', level, lang);
  for (const q of (l4spec ? l4qs : [])) {
    const wc = countWords(q.signText);
    if (wc < l4spec.min) {
      findings.push(finding('CHK-15', 'IMPORTANT', file, q.id,
        `lesen-4 signText demasiado corto: ${wc} palabras (mín ${l4spec.min}). Opinión debe ser substantiva.`));
    } else if (wc > l4spec.max) {
      findings.push(finding('CHK-15', 'IMPORTANT', file, q.id,
        `lesen-4 signText demasiado largo: ${wc} palabras (máx ${l4spec.max}). Opinión debe ser concisa.`));
    }
  }

  return findings;
}

// ─── CHK-16: Anti word-matching — L1 y H3 ────────────────────────────────
// Los enunciados de L1 y H3 NO deben copiar frases del pasaje/transcript.
// Copia verbatim de 4+ palabras de contenido consecutivas es un indicio de
// "word-matching" que hace el ítem trivialmente resoluble sin leer el texto.

const STOP_WORDS_16 = new Set([
  'der','die','das','den','dem','des','ein','eine','einen','einem','einer','eines',
  'und','oder','aber','mit','von','zu','in','an','auf','für','ist','sind','war',
  'hat','hat','sein','haben','werden','dass','nicht','auch','als','bei','nach',
  'sie','er','es','ich','wir','ihr','du','man','sich','wie','so','mehr','noch',
  'aber','doch','weil','wenn','da','dann','schon','sehr','immer','nur','alle',
]);

function contentTokens16(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zäöüß\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS_16.has(w));
}

function chk16(batch, file) {
  const findings = [];
  const passageMap = {};
  for (const p of batch.passages || []) {
    if (p.text || p.title) passageMap[p.id] = `${p.title || ''} ${p.text || ''}`;
  }

  const TARGETS = [
    { mod: 'lesen', teil: 1, type: 'richtig_falsch', window: 4 },
    { mod: 'horen', teil: 3, type: 'richtig_falsch', window: 4 },
  ];

  for (const { mod, teil, type, window } of TARGETS) {
    const qs = (batch.questions || []).filter(q =>
      String(q.module||'').toLowerCase() === mod &&
      Number(q.teil) === teil &&
      (q.type === type || q.type === 'true_false')
    );
    if (!qs.length) continue;

    // Get passage tokens (may be multiple passages for the same teil)
    const passageIds = [...new Set(qs.map(q => q.passageId).filter(Boolean))];
    const passageTokenSet = new Set();
    const allPassageText = passageIds
      .map(pid => passageMap[pid] || '')
      .join(' ');
    const passTokens = contentTokens16(allPassageText);
    // Build 4-gram set from passage
    const passGrams = new Set();
    for (let i = 0; i <= passTokens.length - window; i++) {
      passGrams.add(passTokens.slice(i, i + window).join(' '));
    }
    if (!passGrams.size) continue;

    for (const q of qs) {
      const qTokens = contentTokens16(q.question || '');
      for (let i = 0; i <= qTokens.length - window; i++) {
        const gram = qTokens.slice(i, i + window).join(' ');
        if (passGrams.has(gram)) {
          findings.push(finding('CHK-16', 'IMPORTANT', file, q.id,
            `${mod.toUpperCase()} T${teil}: enunciado copia "${gram}" del pasaje (word-matching). Parafrasea la idea.`));
          break; // one finding per question
        }
      }
    }
  }
  return findings;
}

// ─── CHK-H2-ALIGN: Hören A2 T2 picture_matching — hablante + actividad ↔ clave ─
function chkH2Align(batch, file) {
  const findings = [];
  const level = String(batch.level || batch.questions?.[0]?.level || '').toUpperCase();
  const mod = String(batch.module || batch.questions?.[0]?.module || batch.passages?.[0]?.module || '').toLowerCase();
  const teil = Number(batch.teil || batch.questions?.[0]?.teil || batch.passages?.[0]?.teil);
  const isH2A2 =
    (mod === 'horen' && teil === 2 && level === 'A2') ||
    (batch.passages?.[0]?.pictures?.length >= 9 && batch.questions?.every((q) => q.type === 'matching'));
  if (!isH2A2) return findings;

  const issues = HorenPictureMatching.validatePictureMatchingAlign(batch, {
    module: 'horen',
    teil: 2,
    level: 'A2',
  });
  for (const msg of issues) {
    const scope = msg.match(/^([^:]+):/)?.[1] || 'horen-t2';
    findings.push(finding('CHK-H2-ALIGN', 'CRITICAL', file, scope, msg));
  }
  return findings;
}

// ─── CHK-17: Lesen T3 — estructura y coherencia de la clave ──────────────
//
// El formato canónico de almacenamiento (oficial Goethe / runtime LexiLoop) es:
//   • options[] de 10 entradas A-J IDÉNTICAS en todos los ítems (lista duplicada físicamente).
//   • correct / correctAnswer: letra A-J (mayúscula) o "0" (sin anuncio).
//   • type: "matching".
//   El runtime lee passage.ads[] (seed/bank) o construye ads desde question.options[] (batch).
//
// Material de lectura obligatorio (POOL-2 / GATE-1):
//   passage.ads[] con ≥2 anuncios con texto real (no bare keys), O
//   questions[].options[] con formato A–J de texto largo (batch make-t3).
//   Si no hay NI lo uno NI lo otro → CRITICAL (L3 sin anuncios legibles).
//
// Tres casos posibles:
//
//  A) SHARED DUPLICADO (formato canónico): todos los ítems con options llevan la MISMA lista A-J.
//     Tratar como SHARED: validar claves A-J/0, exactamente 1 "0", sin letras repetidas.
//     → NO emitir IMPORTANT "MCQ-style".
//
//  B) PER-ITEM REAL: las options DIFIEREN entre ítems (cada uno tiene su propio set).
//     Formato estructuralmente incorrecto para B1 L3.
//     → Emitir IMPORTANT "MCQ-style per-item real".
//
//  C) MCQ A2 (options.length ≤ 3, claves a/b/c minúscula): contenido A2 de comprensión
//     lectora mal etiquetado como lesen/teil 3. No es matching B1.
//     → Emitir IMPORTANT "parece MCQ A2 → regenerar" (no CRITICAL de clave inválida).

/** Canonicaliza una línea de option para comparación (trim + colapsar espacios internos). */
function _canonOpt(s) { return String(s).trim().replace(/\s+/g, ' '); }

const L3_AD_MIN_TEXT_LEN = 12;

function _l3OptionText(opt) {
  if (opt == null) return '';
  if (typeof opt === 'string') return opt.trim();
  if (typeof opt === 'object') return String(opt.text ?? opt.label ?? opt.value ?? '').trim();
  return String(opt).trim();
}

function _l3IsBareKeyText(key, text) {
  const k = String(key || '').toUpperCase();
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.toUpperCase() === k) return true;
  return /^[a-j0k]$/i.test(t);
}

/** Cuenta anuncios con cuerpo de texto real (no solo la letra A–J). */
function _l3CountRealAds(ads) {
  if (!Array.isArray(ads)) return 0;
  let n = 0;
  for (const ad of ads) {
    if (typeof ad === 'string') {
      const m = ad.match(/^[a-jA-J0]\)\s*(.+)$/s);
      if (m && m[1].trim().length >= L3_AD_MIN_TEXT_LEN) n++;
      continue;
    }
    if (ad && typeof ad === 'object') {
      const key = ad.key || ad.id || '';
      const body = String(ad.text || ad.body || '').trim();
      if (body && !_l3IsBareKeyText(key, body) && body.length >= L3_AD_MIN_TEXT_LEN) n++;
    }
  }
  return n;
}

function _l3HasPopulatedPassageAds(batch) {
  const ads = batch.ads || batch.passage?.ads || [];
  return _l3CountRealAds(ads) >= 2;
}

/** options[] con líneas A–J de texto largo (formato batch make-t3 o bank legacy). */
function _l3HasLongTextMatchingOptions(t3qs) {
  const itemsWithOptions = t3qs.filter((q) => Array.isArray(q.options) && q.options.length >= 5);
  if (!itemsWithOptions.length) return false;
  const ref = itemsWithOptions.reduce(
    (best, q) => (q.options.length > best.options.length ? q : best),
    itemsWithOptions[0],
  );
  let adLike = 0;
  for (const opt of ref.options) {
    const raw = _l3OptionText(opt);
    if (/^[a-jA-J0]\)\s+.{15,}/.test(raw)) {
      adLike++;
      continue;
    }
    if (typeof opt === 'object' && opt.key) {
      const body = _l3OptionText(opt);
      if (!_l3IsBareKeyText(opt.key, body) && body.length >= L3_AD_MIN_TEXT_LEN) adLike++;
    }
  }
  return adLike >= 2;
}

function chk17(batch, file) {
  const findings = [];
  const t3qs = (batch.questions || []).filter(q =>
    String(q.module||'').toLowerCase() === 'lesen' && Number(q.teil) === 3
  );
  if (!t3qs.length) return findings;

  // ── Detectar caso C (MCQ A2): todos los ítems tienen options.length ≤ 3 ──
  const itemsWithOptions = t3qs.filter(q => Array.isArray(q.options) && q.options.length > 0);
  const allShortOptions = itemsWithOptions.length > 0 &&
    itemsWithOptions.every(q => q.options.length <= 3);

  if (allShortOptions) {
    // A2 Modellsatz: email + 5× MCQ a/b/c is the official format.
    const lv = inferAuditLevel(batch);
    if (lv === 'A2') return findings;
    // B2 Modellsatz: 1 Zeitungsartikel + 6× MCQ a/b/c (integrado, no B1 matching).
    if (lv === 'B2') return findings;
    // Caso C: MCQ A2 en pool B1 — routing finding.
    findings.push(finding('CHK-17', 'IMPORTANT', file, 'lesen-3',
      `L3 parece MCQ A2 (opciones a/b/c por ítem, no lista A-J). No es matching B1. ` +
      `Regenerar con la plantilla correcta de Lesen Teil 3.`));
    return findings;
  }

  // ── Material de lectura: ads poblados O options A–J con texto largo ──
  if (!_l3HasPopulatedPassageAds(batch) && !_l3HasLongTextMatchingOptions(t3qs)) {
    findings.push(finding('CHK-17', 'CRITICAL', file, 'lesen-3',
      `L3 matching sin material de lectura: passage.ads[] vacío o bare keys, y questions[].options[] ` +
      `sin texto de anuncio A–J. Se requiere ≥2 anuncios con texto real en ads[] o options[] largas.`));
    return findings;
  }

  // ── Detectar caso A vs B: misma lista en todos los ítems o no ──
  const itemsWithLongOptions = t3qs.filter(q => Array.isArray(q.options) && q.options.length >= 5);
  let isSharedDuplicated = false;

  if (itemsWithLongOptions.length >= 2) {
    // Compare every item's canonical options against the first item's
    const referenceOpts = itemsWithLongOptions[0].options.map(_canonOpt);
    isSharedDuplicated = itemsWithLongOptions.every(q => {
      const opts = q.options.map(_canonOpt);
      if (opts.length !== referenceOpts.length) return false;
      return opts.every((o, i) => o === referenceOpts[i]);
    });
  } else if (itemsWithLongOptions.length === 1) {
    // Only 1 item has long options — treat as shared (no other item to differ from)
    isSharedDuplicated = true;
  }
  // If no items have long options but also not short → items have no options (already shared mode)
  if (itemsWithLongOptions.length === 0) isSharedDuplicated = true;

  if (!isSharedDuplicated) {
    // Caso B: true per-item MCQ (options differ between items)
    findings.push(finding('CHK-17', 'IMPORTANT', file, 'lesen-3',
      `L3 usa opciones distintas por ítem (MCQ per-ítem real). El formato oficial Goethe ` +
      `requiere la misma lista A-J en todos los ítems. Revisar generación.`));

    // Validate each item's correct vs its own options (a/b/c or A-J)
    const invalid = t3qs.filter(q => {
      const c = String(q.correct ?? q.correctAnswer ?? '').toLowerCase();
      if (c === '0') return false;
      return !/^[a-j]$/.test(c);
    });
    if (invalid.length) {
      findings.push(finding('CHK-17', 'CRITICAL', file, 'lesen-3',
        `L3 per-item: ${invalid.length} ítem(s) con clave inválida: ${invalid.map(q=>q.id+':'+q.correct).join(', ')}`));
    }
    return findings;
  }

  // ── Caso A: SHARED DUPLICADO — validar contenido ──
  const corrects = t3qs.map(q => String(q.correct ?? q.correctAnswer ?? '').toUpperCase());

  // Check valid values (A-J or "0")
  const invalid = corrects.filter(c => !/^([A-J]|0)$/.test(c));
  if (invalid.length) {
    findings.push(finding('CHK-17', 'CRITICAL', file, 'lesen-3',
      `L3: clave(s) inválida(s): ${invalid.join(', ')}. Válidas: A–J o "0".`));
  }

  // Exactly 1 zero (no-match)
  const zeros = corrects.filter(c => c === '0').length;
  if (zeros === 0) {
    findings.push(finding('CHK-17', 'IMPORTANT', file, 'lesen-3',
      `L3: ningún ítem con clave "0" (sin anuncio). El oficial tiene exactamente 1.`));
  } else if (zeros > 1) {
    findings.push(finding('CHK-17', 'IMPORTANT', file, 'lesen-3',
      `L3: ${zeros} ítems con clave "0". El oficial tiene exactamente 1 sin-anuncio.`));
  }

  // No letter repeated (only meaningful in shared mode)
  const letterCounts = {};
  for (const c of corrects.filter(c => c !== '0')) {
    letterCounts[c] = (letterCounts[c] || 0) + 1;
  }
  const repeated = Object.entries(letterCounts).filter(([, n]) => n > 1);
  if (repeated.length) {
    findings.push(finding('CHK-17', 'CRITICAL', file, 'lesen-3',
      `L3: letra(s) repetida(s): ${repeated.map(([l,n])=>`${l}×${n}`).join(', ')}. ` +
      `Cada anuncio A-J solo puede usarse como respuesta correcta 1 vez.`));
  }

  return findings;
}

// ─── CHK-18: Calidad de la explanation ────────────────────────────────────
// Toda pregunta debe tener una explanation substantiva, en alemán, no circular.

// German function words — presence of any 1 confirms text is German.
const GERMAN_MARKER_RE = /\b(der|die|das|den|dem|ein|eine|und|ist|sind|war|haben|wird|nicht|auch|aber|weil|wenn|dass|für|von|zu|auf|aus|mit|an|im|am|ins|zum|zur|kein|keine|dieser|welche|geht|macht|hat|trifft|fahrt|fährt|kocht|lernt|einkaufen|bietet|lehrt|hilft|repariert|zeigt|erklärt|sagt|nennt|gibt|wechselt|verkauft|vermietet|organisiert|vermittelt|reinigt|begleitet|unterrichtet|pflegt)\b/i;
const TRIVIAL_EXPL_RE = /^(richtig|falsch|ja|nein|korrekt|genau|das stimmt|das ist richtig|das ist korrekt|das ist falsch)\.?$/i;
// English counterparts (docs/audit/gates-en-applicability.md — CHK-18 "invertir: detectar
// indicadores de inglés"). Only words with no German homograph, so a German explanation
// never matches by accident: "in/am/an/war/was/also" are deliberately absent.
const ENGLISH_MARKER_RE = /\b(the|is|are|were|because|that|this|these|those|they|their|them|she|he|her|his|its|we|you|your|with|from|have|has|had|does|did|will|would|should|could|can|there|about|when|what|why|how|of|to|for|but|not|and|says|means|mentions|explains|shows|prefers|wants|needs|agrees|suggests)\b/i;
const TRIVIAL_EXPL_EN_RE = /^(correct|incorrect|right|wrong|yes|no|true|false|that's right|that is right|that's correct|that is correct|this is correct)\.?$/i;

function chk18(batch, file) {
  const findings = [];
  const seen = new Set();
  const level = inferAuditLevel(batch);
  const lang = inferAuditLang(batch);

  for (const q of batch.questions || []) {
    // Skip schreiben/sprechen (rubric answers)
    if (['schreiben','sprechen'].includes(String(q.module||'').toLowerCase())) continue;

    const expl = String(q.explanation || '').trim();

    // Missing explanation — V-03: emit IMPORTANT (CHK-8 doesn't require explanation;
    // this gap means questions with no explanation at all were silently skipped by CHK-18).
    // Not CRITICAL because absent explanation doesn't break scoring — it breaks correction UX.
    if (!expl) {
      findings.push(finding('CHK-18', 'IMPORTANT', file, q.id,
        'Explanation ausente. Toda pregunta debe incluir una explanation para la pantalla de corrección.'));
      continue;
    }

    // Minimum length: L3 matching items naturally have shorter explanations
    // (format "AdName bietet X." — 3 words — is valid for matching items)
    const isMatchingItem = q.type === 'matching';
    const minWords = isMatchingItem ? 3 : (level === 'A2' ? 6 : 10);
    const wc = expl.split(/\s+/).filter(w => w.length > 0).length;
    if (wc < minWords) {
      findings.push(finding('CHK-18', 'IMPORTANT', file, q.id,
        `Explanation demasiado corta (${wc} palabras): "${expl.slice(0,60)}". Mínimo: ${minWords} para tipo ${q.type}.`));
      continue;
    }

    // Trivial explanation (just "Richtig" / "Das ist korrekt", or "Correct" / "That's right")
    if (TRIVIAL_EXPL_RE.test(expl) || (lang === 'en' && TRIVIAL_EXPL_EN_RE.test(expl))) {
      findings.push(finding('CHK-18', 'IMPORTANT', file, q.id,
        `Explanation trivial: "${expl}". Debe explicar el razonamiento, no solo confirmar la respuesta.`));
      continue;
    }

    // Wrong language: flag when the explanation shows no marker of the batch's own language.
    // German: umlauts (ä/ö/ü/ß) alone are strong evidence — only flag if none present.
    // English: function-word markers. Other languages have no marker list yet, so they are
    // left alone rather than flagged by German rules (that was the bug: every English
    // explanation came out as "posiblemente no está en alemán").
    if (lang === 'de') {
      const hasUmlauts = /[äöüß]/i.test(expl);
      if (!hasUmlauts && !GERMAN_MARKER_RE.test(expl)) {
        findings.push(finding('CHK-18', 'IMPORTANT', file, q.id,
          `Explanation posiblemente no está en alemán: "${expl.slice(0,80)}..."`));
      }
    } else if (lang === 'en' && !ENGLISH_MARKER_RE.test(expl)) {
      findings.push(finding('CHK-18', 'IMPORTANT', file, q.id,
        `Explanation posiblemente no está en inglés: "${expl.slice(0,80)}..."`));
    }

    // Circular: explanation too similar to question (Jaccard > 0.75)
    if (q.question && !seen.has(q.id)) {
      const qToks = new Set(tokenize(q.question));
      const eToks = new Set(tokenize(expl));
      if (qToks.size >= 4 && eToks.size >= 4) {
        let inter = 0;
        for (const t of eToks) if (qToks.has(t)) inter++;
        const sim = inter / (qToks.size + eToks.size - inter);
        if (sim > 0.75) {
          findings.push(finding('CHK-18', 'IMPORTANT', file, q.id,
            `Explanation circular (${(sim*100).toFixed(0)}% solapamiento con enunciado). Debe añadir información del pasaje, no reformular la pregunta.`));
        }
      }
      seen.add(q.id);
    }
  }
  return findings;
}

// ─── CHK-18b: Clave MCQ vs explicación (T2/T5, determinista) ───────────────
function chk18b(batch, file) {
  const findings = [];
  for (const hit of findKeyExplanationMismatches(batch)) {
    findings.push(finding('CHK-18b', 'IMPORTANT', file, hit.itemId, hit.message));
  }
  return findings;
}

// ─── CHK-34: explanation ↔ quoted option text (matching / post-manual edit) ─
function chk34(batch, file) {
  const findings = [];
  for (const hit of findExplanationOptionTextAlignFindings(batch)) {
    findings.push(finding('CHK-34', hit.severity, file, hit.itemId, hit.message));
  }
  return findings;
}

// ─── CHK-19: Runs de respuestas consecutivas ─────────────────────────────
// ≥4 respuestas idénticas consecutivas en el mismo Teil sugieren sesgo de
// generación o error sistemático. El examen oficial evita rayaduras largas.

function chk19(batch, file) {
  const findings = [];
  // Group by module+teil, preserving order
  const groups = {};
  for (const q of batch.questions || []) {
    const key = bpKey(q);
    if (!groups[key]) groups[key] = [];
    groups[key].push(String(q.correct ?? q.correctAnswer ?? ''));
  }

  for (const [key, answers] of Object.entries(groups)) {
    if (answers.length < 4) continue;
    let run = 1;
    let runVal = answers[0];
    for (let i = 1; i < answers.length; i++) {
      if (answers[i] === runVal) {
        run++;
        if (run >= 4) {
          findings.push(finding('CHK-19', 'IMPORTANT', file, key,
            `${key}: run de ${run} respuestas "${runVal}" consecutivas (posiciones ${i-run+2}–${i+1}). Evitar rayaduras predecibles.`));
          run = 1; // reset to avoid duplicate findings for same run
        }
      } else {
        run = 1;
        runVal = answers[i];
      }
    }
  }
  return findings;
}

// ─── CHK-20: Hören T1 — estructura por segmento ──────────────────────────
// Cada uno de los 5 segmentos de H1 debe tener exactamente:
//   1 ítem richtig_falsch + 1 ítem multiple_choice (formato oficial Goethe).
// CHK-3 verifica el total (10), pero no la distribución interna por segmento.

function chk20(batch, file) {
  const findings = [];
  const level = inferAuditLevel(batch);
  // Only relevant if there are H1 questions
  const h1qs = (batch.questions || []).filter(q =>
    String(q.module||'').toLowerCase() === 'horen' && Number(q.teil) === 1
  );
  if (!h1qs.length) return findings;

  // A2 Modellsatz: 5 segmentos × 1 MCQ (no R/F mix).
  if (level === 'A2') {
    const bySegment = {};
    for (const q of h1qs) {
      const seg = q.segmentLabel || q.passageId || 'seg-unknown';
      if (!bySegment[seg]) bySegment[seg] = { mc: 0 };
      if (q.type === 'multiple_choice' || q.type === 'multiple') bySegment[seg].mc++;
    }
    const segKeys = Object.keys(bySegment);
    if (segKeys.length !== 5) {
      findings.push(finding('CHK-20', 'IMPORTANT', file, 'horen-1',
        `Hören T1 A2: se esperan 5 segmentos distintos, hay ${segKeys.length}.`));
    }
    for (const [seg, counts] of Object.entries(bySegment)) {
      if (counts.mc !== 1) {
        findings.push(finding('CHK-20', 'IMPORTANT', file, `horen-1:${seg}`,
          `H1 A2 segmento "${seg}": ${counts.mc} MCQ (se espera 1).`));
      }
    }
    return findings;
  }

  // Group by segmentLabel (Aufnahme 1…5 or segment passageId)
  const bySegment = {};
  for (const q of h1qs) {
    const seg = q.segmentLabel || q.passageId || 'seg-unknown';
    if (!bySegment[seg]) bySegment[seg] = { rf: 0, mc: 0, ids: [] };
    if (q.type === 'richtig_falsch' || q.type === 'true_false') bySegment[seg].rf++;
    if (q.type === 'multiple_choice') bySegment[seg].mc++;
    bySegment[seg].ids.push(q.id);
  }

  const segKeys = Object.keys(bySegment);

  // Should have exactly 5 segments
  if (segKeys.length !== 5) {
    findings.push(finding('CHK-20', 'IMPORTANT', file, 'horen-1',
      `Hören T1: se esperan 5 segmentos distintos, hay ${segKeys.length}. Verifica segmentLabel en cada pregunta.`));
  }

  // Each segment: exactly 1 RF + 1 MC
  for (const [seg, counts] of Object.entries(bySegment)) {
    if (counts.rf !== 1 || counts.mc !== 1) {
      findings.push(finding('CHK-20', 'IMPORTANT', file, `horen-1:${seg}`,
        `H1 segmento "${seg}": ${counts.rf} RF + ${counts.mc} MC (se espera 1+1). Cada segmento debe tener exactamente 1 R/F y 1 MCQ.`));
    }
  }

  return findings;
}

// ─── CHK-21: Lesen T4 — coherencia del conjunto de opiniones ─────────────────
//
// El formato oficial Goethe B1 exige que los 7 ítems de Lesen Teil 4 provengan de
// UNA sola fuente/blueprint, con:
//   • signText individual ≥ 15 palabras (no el intro compartido del foro).
//   • Todos los signTexts distintos entre sí (no intro copiado 7 veces).
//   • Autores únicos — preferentemente desde `question` («Ist Clara für…?»),
//     no desde la primera palabra del signText (FP histórico con Die/Der/Als…).
//
// Un T4 que falla estas reglas es Frankenstein igual que un L3 con lista A-J mezclada.

/** Prefer question («Ist NAME für…?»); fall back to signText legacy patterns. */
function extractT4Author(q) {
  const question = String(q?.question || '').trim();
  // Dominant generated format (301/301 in pool+canary survey 2026-07-11).
  const fromIstFuer = question.match(/^Ist\s+([A-ZÄÖÜ][a-zäöüß]+)\s+für\b/u);
  if (fromIstFuer) return fromIstFuer[1];
  // Variants seen in fixtures / older wording.
  const fromQLead = question.match(/^(?:Sagt|Stimmt|Hat)\s+([A-ZÄÖÜ][a-zäöüß]+)\b/u);
  if (fromQLead) return fromQLead[1];
  const fromMeinungQ = question.match(/(?:Meinung von|Sagt)\s+([A-ZÄÖÜ][a-zäöüß]+)/u);
  if (fromMeinungQ) return fromMeinungQ[1];

  // Fallback: legacy signText («Meinung von NAME:» / first capitalized token).
  const GERMAN_PRONOUNS = new Set(['Ich', 'Er', 'Sie', 'Es', 'Wir', 'Ihr', 'Du', 'Man']);
  const signText = String(q?.signText || '');
  const m = signText.match(/^(?:Meinung von|Sagt)\s+([A-ZÄÖÜ][a-zäöüß]+)/u);
  if (m) return m[1];
  const first = signText.match(/^([A-ZÄÖÜ][a-zäöüß]+)/u)?.[1] || '';
  return GERMAN_PRONOUNS.has(first) ? '' : first;
}

function chk21(batch, file) {
  const findings = [];
  const t4qs = (batch.questions || []).filter(q =>
    String(q.module||'').toLowerCase() === 'lesen' && Number(q.teil) === 4 &&
    (q.type === 'ja_nein' || q.type === 'richtig_falsch' || q.type === 'true_false')
  );
  if (!t4qs.length) return findings;

  // ── signText vacío o muy corto (<15 palabras) ──
  const short = t4qs.filter(q => {
    const words = String(q.signText || '').trim().split(/\s+/).filter(Boolean).length;
    return words < 15;
  });
  if (short.length) {
    findings.push(finding('CHK-21', 'IMPORTANT', file, 'lesen-4',
      `L4: ${short.length} ítem(s) con signText < 15 palabras (${short.map(q=>q.id).join(', ')}). ` +
      `Cada opinión debe ser un texto individual, no el intro del foro.`));
  }

  // ── signTexts no son todos distintos ──
  const texts = t4qs.map(q => String(q.signText || '').trim());
  const uniqueTexts = new Set(texts);
  if (uniqueTexts.size < texts.length) {
    const dups = texts.filter((t, i) => texts.indexOf(t) !== i);
    findings.push(finding('CHK-21', 'IMPORTANT', file, 'lesen-4',
      `L4: ${texts.length - uniqueTexts.size} signText(s) duplicado(s) — ` +
      `posible intro de foro copiado en cada ítem. Los 7 ítems deben tener opiniones distintas.`));
    void dups;
  }

  // ── Autores no únicos (desde question; fallback signText) ──
  const authors = t4qs.map((q) => extractT4Author(q));
  const namedAuthors = authors.filter(Boolean);
  if (namedAuthors.length >= 2 && new Set(namedAuthors).size < namedAuthors.length) {
    const counts = {};
    for (const a of namedAuthors) counts[a] = (counts[a] || 0) + 1;
    const dups = Object.entries(counts).filter(([,n]) => n > 1).map(([a,n]) => `${a}×${n}`);
    findings.push(finding('CHK-21', 'IMPORTANT', file, 'lesen-4',
      `L4: autores repetidos: ${dups.join(', ')}. Cada ítem debe ser de un autor distinto.`));
  }

  return findings;
}

// ─── CHK-23: Integridad de claves — conflicto segments vs questions ──────────
//
// Some records have the same question IDs duplicated in two places:
//   rec.segments[i].questions[]  (nested, per-segment — generated in context)
//   rec.questions[]              (flat top-level copy — reconstructed from snapshot)
//
// When both exist with the SAME question ID but DIFFERENT `correct` values,
// flattenExam silently discards the segment copy (dedup by ID, part.questions wins).
// The renderer then uses the wrong answer key for those questions.
//
// CRITICAL — always blocks; wrong answer keys = wrong scoring.

export function chk23(batch, file) {
  const findings = [];
  // batch here is the RAW record (pre-normalization), not the flattened exam.
  // We need to access rec.segments and rec.questions directly.
  // NOTE: this check is called on the raw seed record in isPartPoolReady.
  const segQs = (batch.segments || []).flatMap(s => s.questions || []);
  const dirQs = batch.questions || [];
  if (!segQs.length || !dirQs.length) return findings;

  const dirMap = new Map(dirQs.map(q => [q.id, q]));
  const conflicts = [];
  for (const sq of segQs) {
    const dq = dirMap.get(sq.id);
    if (!dq) continue;
    const segVal = String(sq.correct || '').toLowerCase();
    const dirVal = String(dq.correct || '').toLowerCase();
    if (segVal !== dirVal) {
      conflicts.push(`${sq.id.slice(-10)}: segments.correct=${sq.correct} ≠ questions.correct=${dq.correct}`);
    }
  }
  if (conflicts.length > 0) {
    findings.push(finding('CHK-23', 'CRITICAL', file, bpKey(segQs[0]),
      `Conflicto de claves: ${conflicts.length} pregunta(s) tienen correct diferente en segments[] vs questions[]. ` +
      `flattenExam usa questions[] (incorrecto). Ejemplos: ${conflicts.slice(0, 3).join(' | ')}`,
    ));
  }
  return findings;
}

// ─── CHK-22: Lesen T4 — cross-batch Frankenstein (multiple passageIds) ───────
//
// All 7 T4 questions must belong to the SAME forum topic (same passageId).
// If questions carry multiple distinct passageIds they were spliced from different
// generation batches — the examinee would read opinions about topic A while the
// question header asks about topic B.
//
// This is the structural counterpart of SEM-1's topic-relevance check:
//   CHK-22 catches cross-batch contamination (different passageIds in one file).
//   SEM-1  catches within-batch mismatch (same passageId but incoherent content).
//
// CRITICAL — blocks isPartPoolReady regardless of GATE_BLOCK_CHECKS.

function chk22(batch, file) {
  const findings = [];
  const level = inferAuditLevel(batch);
  const t4qs = (batch.questions || []).filter(q =>
    String(q.module || '').toLowerCase() === 'lesen' && Number(q.teil) === 4,
  );
  if (t4qs.length < 2) return findings;

  // B2: una Meinung por passage (6 passageIds distintos es lo esperado).
  if (level === 'B2' && (batch.passages || []).length >= 6) {
    const matching = t4qs.every((q) => String(q.type || '').toLowerCase() === 'matching');
    if (matching) return findings;
  }

  const pids = t4qs.map(q => q.passageId).filter(Boolean);
  const uniquePids = new Set(pids);
  if (uniquePids.size > 1) {
    findings.push(finding('CHK-22', 'CRITICAL', file, 'lesen-4',
      `Lesen T4: ${uniquePids.size} passageIds distintos [${[...uniquePids].join(', ')}]. ` +
      `Todos los ítems deben pertenecer al mismo texto/foro fuente. ` +
      `Contaminación cross-batch detectada (Frankenstein T4).`,
    ));
  }
  return findings;
}

// ─── CHK-24: Canonical case for multiple_choice correct value ─────────────
// MINOR advisory — non-blocking for POOL-2. Grading is case-insensitive but the
// canonical schema requires lowercase letters (a/b/c/d). normalizeBatch now prevents
// this on newly generated parts; CHK-24 surfaces it in pool/batch audits of older data.

function chk24(batch, file) {
  const findings = [];
  for (const q of batch.questions || []) {
    const type = String(q.type || '').toLowerCase();
    if (type !== 'multiple_choice' && type !== 'multiple' && type !== 'mcq') continue;
    const c = String(q.correct ?? q.correctAnswer ?? '');
    if (/^[A-Z]$/.test(c)) {
      findings.push(finding('CHK-24', 'MINOR', file, q.id,
        `correct="${c}" no canónico para multiple_choice — debe ser "${c.toLowerCase()}". ` +
        `El grader puntúa correctamente (case-insensitive), pero el esquema espera minúsculas.`));
    }
  }
  return findings;
}

// ─── CHK-26: topicTag coherente con tema pedido (P1) ───────────────────────
// Bloquea passage.topicTag ≠ batch.topicTag/_requestedTopic y T2 con dos temas distintos.

function expandPoolRecordPassages(rec) {
  if (Array.isArray(rec.passages) && rec.passages.length) return rec.passages;
  const teil = Number(rec.teil);
  if (teil === 2 && Array.isArray(rec.passage?.passages) && rec.passage.passages.length >= 2) {
    return rec.passage.passages.map((p, i) => ({
      id: p.passageId || p.id || `p-${i}`,
      title: p.textTitle || p.title || '',
      text: p.text || '',
      topicTag: p.topicTag,
    }));
  }
  if (rec.passage && (rec.passage.text || rec.passage.transcript)) {
    return [{
      id: rec.passage.id || rec.passage.passageId || rec.id || 'passage',
      title: rec.passage.title || rec.passage.textTitle || '',
      text: rec.passage.text || rec.passage.transcript || '',
      topicTag: rec.passage.topicTag,
    }];
  }
  return [];
}

function resolvePassageTopicTag(p) {
  const explicit = normalizeB1Topic(p.topicTag);
  if (explicit) return { tag: explicit, source: 'explicit' };
  const detected = normalizeB1Topic(detectTopic(String(p.text || p.title || '')));
  if (detected) return { tag: detected, source: 'detected' };
  return { tag: null, source: 'none' };
}

export function enrichRecordForAudit(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  let passages = expandPoolRecordPassages(rec);
  if (!passages.length) return rec;
  const expected = normalizeB1Topic(rec.topicTag || rec._requestedTopic);
  if (expected) {
    passages = passages.map((p) =>
      (p.topicTag ? p : { ...p, topicTag: expected }),
    );
  }
  return { ...rec, passages };
}

function chk26(batch, file) {
  const findings = [];
  const expected = normalizeB1Topic(batch.topicTag || batch._requestedTopic);
  if (!expected) return findings;

  const passages = batch.passages?.length ? batch.passages : expandPoolRecordPassages(batch);
  const teil = Number(batch.teil ?? batch.questions?.[0]?.teil);
  const mod = String(batch.module || batch.questions?.[0]?.module || '').toLowerCase();

  // T3 matching: sin passages — tema solo en enunciados de situación (no anuncios A–J).
  if (mod === 'lesen' && teil === 3 && !passages.length) {
    const detected = detectTopicFromT3Situations(batch.questions);
    if (detected && !isLesenT3TopicCompatible(expected, detected)) {
      findings.push(finding(
        'CHK-26',
        'IMPORTANT',
        file,
        'lesen-3',
        `Contenido T3 (situaciones) detectado como «${detected}» ≠ tema pedido «${expected}».`,
      ));
    }
    return findings;
  }

  if (!passages.length) return findings;

  const resolved = passages.map((p) => ({ p, ...resolvePassageTopicTag(p) }));

  for (const { p, tag, source } of resolved) {
    const pid = p.id || 'passage';
    if (source === 'explicit' && tag !== expected) {
      findings.push(finding(
        'CHK-26',
        'IMPORTANT',
        file,
        pid,
        `topicTag del pasaje «${tag}» ≠ tema pedido «${expected}». ` +
        `Todos los passages deben llevar topicTag «${expected}».`,
      ));
    } else if (source === 'detected' && tag !== expected) {
      findings.push(finding(
        'CHK-26',
        'IMPORTANT',
        file,
        pid,
        `Contenido del pasaje detectado como «${tag}» ≠ tema pedido «${expected}».`,
      ));
    } else if (source === 'none' && passages.length > 1) {
      findings.push(finding(
        'CHK-26',
        'IMPORTANT',
        file,
        pid,
        `No se puede verificar tema del pasaje — debe ser «${expected}».`,
      ));
    }
  }

  const uniqueTags = [...new Set(resolved.map((r) => r.tag).filter(Boolean))];
  if (uniqueTags.length > 1) {
    findings.push(finding(
      'CHK-26',
      'IMPORTANT',
      file,
      'lesen-passages',
      `Los pasajes tienen temas distintos (${uniqueTags.join(' vs ')}). ` +
      `Todos deben ser «${expected}» (especialmente Lesen T2 con 2 textos).`,
    ));
  }

  return findings;
}

// ─── CHK-27: Lesen T4 — debate alineado al tema pedido (P3) ─────────────────
// Complementa CHK-26 (topicTag en passages): aquí el foro debe tratar del tema B1,
// no un debate genérico (Homeoffice, 4-Tage-Woche) etiquetado con otro topicTag.

function chk27(batch, file) {
  const findings = [];
  const level = inferAuditLevel(batch);
  if (level === 'B2') return findings;
  const assessment = assessT4TopicAlignment(batch);
  if (assessment.skip || assessment.ok) return findings;
  const msg = formatT4TopicAlignmentFailure(assessment);
  if (msg) {
    findings.push(finding('CHK-27', 'IMPORTANT', file, 'lesen-4', msg));
  }
  return findings;
}

// ─── CHK-28: Lesen T2 — opciones MCQ no excluyentes (determinista) ───────────
function chk28(batch, file) {
  const findings = [];
  const mod = String(batch.module || batch.questions?.[0]?.module || '').toLowerCase();
  const teil = Number(batch.teil ?? batch.questions?.[0]?.teil);
  if (mod !== 'lesen' || teil !== 2) return findings;

  const { ok, findings: hits } = checkMcqDistinctBatch(batch, 2);
  if (ok) return findings;

  for (const h of hits) {
    findings.push(
      finding(
        'CHK-28',
        'IMPORTANT',
        file,
        h.itemId,
        `${h.pair}: opciones no excluyentes (${h.reason})`,
      ),
    );
  }
  return findings;
}

// ─── CHK-25: Secuencia de claves idéntica entre partes de la misma celda ───
// CHK-4 solo mira balance dentro de UNA parte; esto detecta patrones posicionales
// repetidos entre partes distintas (p. ej. L2 siempre a,b,c,a,b,c).
//
// Umbrales (espacio finito de secuencias → colisiones 2–3 son estadísticamente normales):
//   2–3 partes  → INFO      (advisory, no bloquea)
//   4–6 partes  → IMPORTANT (patrón sospechoso)
//   ≥7 partes   → CRITICAL  (patrón sistemático explotable)

const CHK25_INFO_MAX = 3;
const CHK25_IMPORTANT_MAX = 6;

export function chk25Severity(groupSize) {
  if (groupSize <= CHK25_INFO_MAX) return 'INFO';
  if (groupSize <= CHK25_IMPORTANT_MAX) return 'IMPORTANT';
  return 'CRITICAL';
}

function partKeySequenceGroups(batch) {
  const qs = batch.questions || [];
  if (!qs.length) return [];
  const mod = String(batch.module || qs[0]?.module || '').toLowerCase();
  const teil = Number(batch.teil ?? qs[0]?.teil);
  if (!mod || !Number.isFinite(teil)) return [];

  // Schreiben/Sprechen rubric-only: no MCQ key sequence — CHK-25 N/A (not exploitable).
  if (
    (mod === 'schreiben' || mod === 'sprechen') &&
    qs.every((q) => /^rubric$/i.test(String(q.correctAnswer ?? q.correct ?? '')))
  ) {
    return [];
  }

  const types = [...new Set(qs.map((q) => String(q.type || '').toLowerCase()).filter(Boolean))];
  return types
    .map((type) => ({
      cell: `${mod}-${teil}`,
      type,
      seq: answerKeySequence(qs, type),
    }))
    .filter((g) => g.seq.includes(','));
}

function chk25(allBatches) {
  const findings = [];
  const registry = new Map();

  for (const { batch, file } of allBatches) {
    for (const group of partKeySequenceGroups(batch)) {
      const key = `${group.cell}:${group.type}:${group.seq}`;
      if (!registry.has(key)) {
        registry.set(key, { ...group, files: [] });
      }
      registry.get(key).files.push(file);
    }
  }

  for (const { cell, type, seq, files } of registry.values()) {
    if (files.length < 2) continue;
    const n = files.length;
    const sev = chk25Severity(n);
    const sample = files.slice(0, 4).map((f) => path.basename(f)).join(', ');
    const note = n <= CHK25_INFO_MAX
      ? ' (colisión estadística esperable en espacio finito de secuencias)'
      : '';
    findings.push(finding(
      'CHK-25',
      sev,
      files[0],
      cell,
      `${n} partes en ${cell} (${type}) comparten la misma secuencia posicional de claves: [${seq}]. ` +
      `Ejemplos: ${sample}${n > 4 ? '…' : ''}${note}`,
    ));
  }
  return findings;
}

/** POOL/corpus: auditar secuencias duplicadas entre registros del banco. */
export function chk25PoolRecords(records, label = 'pool', { skipDeprecated = true } = {}) {
  const active = (records || []).filter((rec) => {
    if (!skipDeprecated) return true;
    return !rec._deprecated;
  });
  const allBatches = active.map((rec, i) => ({
    batch: {
      module: rec.module,
      teil: rec.teil,
      questions: rec.questions || rec.part?.questions || [],
    },
    file: rec.id || `${label}-${i}`,
  }));
  return chk25(allBatches);
}

// ─── CHK-9: Beispiel ausente ──────────────────────────────────────────────

const BEISPIEL_TEILE = new Set(['lesen-1','lesen-4','horen-3','horen-4']);

function chk9(batch, file) {
  const findings = [];
  const groups = new Set();
  for (const q of batch.questions || []) {
    const key = bpKey(q);
    if (!BEISPIEL_TEILE.has(key)) continue;
    if (groups.has(key)) continue;
    // Check if any question has beispiel/example marker
    const hasBsp = (batch.questions || []).some(x =>
      bpKey(x) === key && (x.beispiel || x.example || /beispiel|muster/i.test(x.question || ''))
    );
    if (!hasBsp) {
      groups.add(key);
      findings.push(finding('CHK-9', 'INFO', file, key,
        `${key}: el examen oficial incluye un ítem "Beispiel (0)" resuelto. El modelo de datos no lo representa.`));
    }
  }
  return findings;
}

// ─── CHK-11: Hören T4 — coherencia clave↔hablante + anti-copia ────────────

const CHK11_CRITIQUE_RE = /\b(bemängelt|kritisiert|beklagt|lehnt ab|ist dagegen)\b/i;
const CHK11_NEGATIVE_RE = /\b(nicht|kein\w*|problem|schwierig|gegen|schlecht|negativ)\b/i;

function chk11(batch, file) {
  const findings = [];
  const t4qs = (batch.questions || []).filter(q =>
    q.module === 'horen' && Number(q.teil) === 4
  );
  if (!t4qs.length) return findings;

  // A2 H4 = Ja/Nein interview (no speaker-key matching B1).
  if (inferAuditLevel(batch) === 'A2' && t4qs.every((q) => q.type === 'ja_nein')) {
    return findings;
  }

  // Build passage text map for anti-copy check
  const passageMap = {};
  for (const p of batch.passages || []) {
    passageMap[p.id] = (p.text || '').toLowerCase();
  }

  // Check each speaker option appears at least once in correct answers
  const correctVals = t4qs.map(q => q.correct || q.correctAnswer).filter(Boolean);
  const speakersSeen = new Set(correctVals);
  const expectedSpeakers = new Set(['a', 'b', 'c']);
  for (const sp of expectedSpeakers) {
    if (!speakersSeen.has(sp)) {
      findings.push(finding('CHK-11', 'IMPORTANT', file, 'T4-hablantes',
        `Hören T4: el hablante "${sp}" nunca es la respuesta correcta — posible desequilibrio de postura.`));
    }
  }

  for (const q of t4qs) {
    const qText = (q.question || '').toLowerCase();
    const pid = q.passageId;
    const pText = pid ? (passageMap[pid] || '') : '';

    // Anti-copia: enunciado no debe compartir ≥5 palabras consecutivas con el pasaje
    if (pText) {
      const qWords = qText.split(/\s+/).filter(w => w.length >= 4);
      if (qWords.length >= 5) {
        for (let i = 0; i <= qWords.length - 5; i++) {
          const chunk = qWords.slice(i, i + 5).join(' ');
          if (pText.includes(chunk)) {
            findings.push(finding('CHK-11', 'IMPORTANT', file, q.id,
              `Hören T4: enunciado comparte ≥5 palabras consecutivas con el pasaje ("${chunk}") — paráfrasis obligatoria.`));
            break;
          }
        }
      }
    }

    // Lint verbo↔postura: verbo de crítica sin marcador negativo en el hablante
    if (CHK11_CRITIQUE_RE.test(q.question || '') && pText && !CHK11_NEGATIVE_RE.test(pText)) {
      findings.push(finding('CHK-11', 'IMPORTANT', file, q.id,
        `Hören T4: enunciado con verbo de crítica (bemängelt/kritisiert…) pero los turnos del hablante no contienen marcadores negativos — posible inversión de postura: revisar manualmente.`));
    }
  }
  return findings;
}

// ─── CHK-29: Hören T4 — cronología matching (char evidence) ───────────────

function chk29(batch, file) {
  const findings = [];
  const lv = inferAuditLevel(batch);
  const t4qs = (batch.questions || []).filter(
    (q) => q.module === 'horen' && Number(q.teil) === 4 && q.type === 'matching',
  );
  const expected = blueprintForLevel(lv)['horen-4']?.count;
  if (!t4qs.length || expected == null || t4qs.length !== expected) return findings;

  const chrono = verifyHorenT4MatchingChrono(batch);
  for (const msg of chrono.blockingIssues || []) {
    findings.push(finding('CHK-29', 'IMPORTANT', file, 'T4-chrono', msg));
  }
  for (const msg of chrono.warnings || []) {
    findings.push(finding('CHK-29', 'MINOR', file, 'T4-chrono', msg));
  }
  return findings;
}

// ─── CHK-30: Metadatos de pool — integridad básica ─────────────────────────

function chk30PoolMeta(batch, file) {
  const findings = [];
  if (batch._rejectedReason) {
    findings.push(finding(
      'CHK-30',
      'CRITICAL',
      file,
      'meta',
      `_rejectedReason=${JSON.stringify(batch._rejectedReason)} — registro rechazado no debe estar en pool-verified`,
    ));
  }
  return findings;
}

// ─── CHK-30b: Lesen T4 — título truncado / desalineado con _debateSeed ─────

const VALID_TITLE_END_RE = /[.!?»"\u201d)\]:]\s*$/u;

function stripStadtforumPrefix(title) {
  return String(title || '').trim().replace(/^Stadtforum:\s*/i, '').trim();
}

function normalizeTitleCompare(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function titleAlignedWithDebateSeed(titleNorm, seedNorm) {
  if (!titleNorm || !seedNorm) return true;
  const t = titleNorm.toLowerCase();
  const s = seedNorm.toLowerCase();
  if (s.startsWith(t)) return true;
  const prefixLen = Math.min(48, t.length);
  if (prefixLen >= 12 && s.startsWith(t.slice(0, prefixLen))) return true;
  return false;
}

function chk30bLesenT4Title(batch, file) {
  const findings = [];
  const qs = batch.questions || [];
  const isL4 = qs.some((q) => String(q.module || '').toLowerCase() === 'lesen' && Number(q.teil) === 4);
  if (!isL4) return findings;

  const seed = batch._debateSeed || batch.debateSeed;
  const seedNorm = seed ? normalizeTitleCompare(seed) : '';

  for (const p of batch.passages || []) {
    const rawTitle = p.title || p.textTitle || '';
    if (!rawTitle) continue;
    const stripped = stripStadtforumPrefix(rawTitle);
    const titleNorm = normalizeTitleCompare(stripped);
    const endsOk = VALID_TITLE_END_RE.test(titleNorm);

    if (seedNorm) {
      if (!titleAlignedWithDebateSeed(titleNorm, seedNorm)) {
        findings.push(finding(
          'CHK-30b',
          'IMPORTANT',
          file,
          'lesen-4/title',
          `Título del foro no coincide con _debateSeed: «${titleNorm.slice(0, 72)}…» vs seed «${seedNorm.slice(0, 72)}…»`,
        ));
      }
      if (!endsOk && titleNorm.length < seedNorm.length - 2) {
        findings.push(finding(
          'CHK-30b',
          'CRITICAL',
          file,
          'lesen-4/title',
          `Título truncado (sin puntuación final y más corto que _debateSeed): «${rawTitle.slice(0, 96)}»`,
        ));
      }
    } else if (!endsOk && titleNorm.length > 28) {
      findings.push(finding(
        'CHK-30b',
        'IMPORTANT',
        file,
        'lesen-4/title',
        `Título posiblemente truncado (no termina en .!?): «${rawTitle.slice(0, 96)}»`,
      ));
    }
  }
  return findings;
}

// ─── CHK-Q5: Idioma alemán (germanContentLanguageGate) ───────────────────────

function chkQ5GermanContent(batch, file) {
  const findings = [];
  const verdict = runGermanContentLanguageGate(batch, { file: path.basename(file) });
  for (const f of verdict.findings || []) {
    const sev = f.severity === 'block' ? 'CRITICAL' : 'IMPORTANT';
    findings.push(finding('CHK-Q5', sev, file, f.span || 'lang', f.detail || f.rule || 'non_german'));
  }
  return findings;
}

// ─── CHK-31: Corrupción de lematizador (v2.3.16 + red de seguridad) ─────────

const LEMMA_SAFETY_NET = new Set([
  'interessanen', 'kaputen', 'direken', 'hingegangen', 'förderen', 'schlechen',
]);

function vocabularyTagLooksCorrupted(tag, b1Set) {
  const t = String(tag || '').toLowerCase().trim();
  if (!t) return false;
  if (LEMMA_SAFETY_NET.has(t)) return true;
  if (b1Set?.has(t)) return false;
  if (t.endsWith('ieren')) return false;
  if (t.endsWith('deren') || t.endsWith('teren') || t.endsWith('genen')) return false;
  if (!t.endsWith('eren')) return false;
  if (b1Set?.has(`${t.slice(0, -1)}n`)) return true;
  const fromT = `${t.slice(0, -2)}t`;
  return isVocabLemmaCorruption(fromT, t, b1Set);
}

function chk31VocabLemma(batch, file) {
  const findings = [];
  const lv = inferAuditLevel(batch);
  const b1Set = loadVocabBankLemmaSet('de', lv);
  for (const q of batch.questions || []) {
    for (const tag of q.vocabularyTags || []) {
      if (vocabularyTagLooksCorrupted(tag, b1Set)) {
        findings.push(finding(
          'CHK-31',
          'IMPORTANT',
          file,
          q.id,
          `vocabularyTag «${tag}» parece corrupción de lematizador (isVocabLemmaCorruption / banco ${lv})`,
        ));
      }
    }
    for (const gt of q.grammarTags || []) {
      if (!isValidGrammarTag(gt)) {
        findings.push(finding(
          'CHK-31',
          'IMPORTANT',
          file,
          q.id,
          `grammarTag inválido «${gt}» (categoría gramatical no reconocida)`,
        ));
      }
    }
  }
  return findings;
}

// ─── CHK-32: Nombres propios — frecuencia global por celda (≥5%) ───────────

const NAME_SPEAKER_SKIP = new Set([
  'Moderator', 'Moderatorin', 'Sprecher', 'Sprecherin',
]);

function extractProperNamesFromBatch(batch) {
  const names = [];
  const blobs = [
    ...(batch.passages || []).map((p) => p.text || p.transcript || ''),
    ...(batch.segments || []).map((s) => s.text || s.transcript || ''),
  ];
  for (const blob of blobs) {
    for (const m of String(blob).matchAll(/\b([A-ZÄÖÜ][a-zäöüß]{2,18}):/gu)) {
      const n = m[1];
      if (!NAME_SPEAKER_SKIP.has(n)) names.push(n);
    }
  }
  for (const q of batch.questions || []) {
    const a = extractT4Author(q);
    if (a && !NAME_SPEAKER_SKIP.has(a)) names.push(a);
  }
  return names;
}

function cellKeyForBatch(batch) {
  const qs = batch.questions || [];
  const lv = inferAuditLevel(batch);
  const mod = String(batch.module || qs[0]?.module || '').toLowerCase();
  const teil = Number(batch.teil ?? qs[0]?.teil);
  if (!mod || !Number.isFinite(teil)) return null;
  return `${lv}|${mod}|${teil}`;
}

function chk32GlobalNameFrequency(allBatches) {
  const findings = [];
  const filesPerCell = new Map();
  const nameFiles = new Map();

  for (const { batch, file } of allBatches) {
    const ck = cellKeyForBatch(batch);
    if (!ck) continue;
    if (!filesPerCell.has(ck)) filesPerCell.set(ck, new Set());
    filesPerCell.get(ck).add(file);

    const uniqueInFile = new Set(extractProperNamesFromBatch(batch));
    for (const name of uniqueInFile) {
      const nk = `${ck}\0${name}`;
      if (!nameFiles.has(nk)) nameFiles.set(nk, new Set());
      nameFiles.get(nk).add(file);
    }
  }

  const hotNames = new Map();
  for (const [nk, fileSet] of nameFiles) {
    const sep = nk.indexOf('\0');
    const ck = nk.slice(0, sep);
    const name = nk.slice(sep + 1);
    const total = filesPerCell.get(ck)?.size || 0;
    if (total < 8) continue;
    const freq = fileSet.size / total;
    if (freq > 0.05) hotNames.set(nk, { ck, name, freq, count: fileSet.size, total });
  }

  for (const { batch, file } of allBatches) {
    const ck = cellKeyForBatch(batch);
    if (!ck) continue;
    for (const name of new Set(extractProperNamesFromBatch(batch))) {
      const meta = hotNames.get(`${ck}\0${name}`);
      if (!meta) continue;
      findings.push(finding(
        'CHK-32',
        'MINOR',
        file,
        `${ck}/${name}`,
        `Nombre «${name}» en ${meta.count}/${meta.total} archivos de la celda (${(meta.freq * 100).toFixed(1)}%) — posible sesgo de pool`,
      ));
    }
  }

  for (const meta of hotNames.values()) {
    findings.push(finding(
      'CHK-32',
      'INFO',
      '',
      `global/${meta.ck}/${meta.name}`,
      `[global] «${meta.name}» ${meta.count}/${meta.total} (${(meta.freq * 100).toFixed(1)}%) en ${meta.ck}`,
    ));
  }
  return findings;
}

// ─── CHK-33: Sesgo longitud MCQ + sello balanceMcq ─────────────────────────

function chk33McqLengthBias(batch, file) {
  const findings = [];
  const lv = inferAuditLevel(batch);
  // Mismo criterio que generación (gate: true — umbral 20%/12ch + batch ≥2 significativas).
  const msgs = collectMcqLengthBiasIssues(batch, { gate: true, level: lv });
  for (const msg of msgs) {
    findings.push(finding('CHK-33', 'IMPORTANT', file, 'mcq-length', msg));
  }
  const hasMcq = (batch.questions || []).some((q) => {
    const t = String(q.type || '').toLowerCase();
    return t === 'multiple_choice' || t === 'multiple' || t === 'mcq';
  });
  if (hasMcq && !batch._balanceMcqVersion) {
    findings.push(finding(
      'CHK-33',
      'MINOR',
      file,
      'mcq-balance',
      'MCQ presente pero falta _balanceMcqVersion — mcqLengthBias/balanceMcq no aplicado retroactivamente',
    ));
  }
  return findings;
}

// ─── CHK-35: Hören T3 — cronología R/F por char-pos ────────────────────────

function chk35HorenT3RfChrono(batch, file) {
  const findings = [];
  const lv = inferAuditLevel(batch);
  const expected = blueprintForLevel(lv)['horen-3']?.count;
  const t3rf = (batch.questions || []).filter(
    (q) => String(q.module || '').toLowerCase() === 'horen'
      && Number(q.teil) === 3
      && String(q.type || '').toLowerCase() === 'richtig_falsch',
  );
  if (!t3rf.length) return findings;
  if (expected != null && t3rf.length !== expected) return findings;

  const v = verifyRfChronoByCharPos(batch);
  if (v.ok) return findings;

  const badPairs = [];
  for (let i = 1; i < v.details.length; i++) {
    const a = v.details[i - 1];
    const b = v.details[i];
    if (a.pos >= 0 && b.pos >= 0 && b.pos < a.pos) {
      badPairs.push(`${a.id}@${a.pos}→${b.id}@${b.pos}`);
    }
  }
  const detail = badPairs.length
    ? `Orden no monótono en transcript: ${badPairs.slice(0, 4).join('; ')}`
    : `Evidencia char-pos no monótona (${v.metric}, ${v.details.filter((d) => d.pos < 0).length} ítem(s) sin ancla)`;

  findings.push(finding('CHK-35', 'IMPORTANT', file, 'T3-chrono', detail));

  const text = String(batch.passages?.[0]?.text || '');
  if (/\bModerator(?:in)?:/i.test(text) && badPairs.length) {
    findings.push(finding(
      'CHK-35',
      'IMPORTANT',
      file,
      'T3-chrono/moderator',
      'Diálogo con Moderator: revisar si intervenciones del moderador desordenan la secuencia R/F',
    ));
  }
  return findings;
}

// ─── Reporte accionable (Fase 2) ───────────────────────────────────────────

const CHK_SUGGESTED_ACTION = {
  'CHK-Q5': 'retirar',
  'CHK-30': 'retirar',
  'CHK-30b': 'corregir',
  'CHK-22': 'retirar',
  'CHK-23': 'retirar',
  'CHK-31': 'corregir',
  'CHK-32': 'ignorar',
  'CHK-33': 'corregir',
  'CHK-34': 'corregir',
  'CHK-35': 'corregir',
  'CHK-29': 'corregir',
};

function suggestedActionForFinding(f) {
  if (CHK_SUGGESTED_ACTION[f.id]) return CHK_SUGGESTED_ACTION[f.id];
  if (f.severity === 'CRITICAL') return 'retirar';
  if (f.severity === 'INFO') return 'ignorar';
  if (f.severity === 'MINOR') return 'ignorar';
  return 'corregir';
}

function severityLabelEs(f) {
  if (f.severity === 'CRITICAL') return 'crítico';
  if (f.severity === 'IMPORTANT') return 'menor';
  if (f.severity === 'MINOR') return 'cosmético';
  return 'info';
}

function buildActionTableRows(findings) {
  const priority = { crítico: 0, menor: 1, cosmético: 2, info: 3 };
  return findings
    .filter((f) => f.severity !== 'INFO')
    .map((f) => ({
      archivo: f.file,
      check: f.id,
      severidad: severityLabelEs(f),
      accion: suggestedActionForFinding(f),
      scope: f.scope,
      message: f.message,
      sortKey: priority[severityLabelEs(f)] ?? 9,
    }))
    .sort((a, b) => a.sortKey - b.sortKey || a.archivo.localeCompare(b.archivo) || a.check.localeCompare(b.check));
}

function classifyFilesByFindings(allFindings, files) {
  const byFile = new Map(files.map((f) => [path.basename(f), []]));
  for (const f of allFindings) {
    if (!f.file) continue;
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  const clean = [];
  const cosmeticOnly = [];
  const important = [];
  const critical = [];

  for (const [base, list] of byFile) {
    const actionable = list.filter((x) => x.severity !== 'INFO');
    if (!actionable.length) {
      clean.push(base);
      continue;
    }
    if (actionable.some((x) => x.severity === 'CRITICAL')) {
      critical.push(base);
    } else if (actionable.some((x) => x.severity === 'IMPORTANT')) {
      important.push(base);
    } else {
      cosmeticOnly.push(base);
    }
  }

  return { clean, cosmeticOnly, important, critical, byFile };
}

function printActionTable(rows) {
  console.log(C.bold('\n── Tabla accionable (archivo | check | severidad | acción) ──'));
  const col = (s, w) => String(s || '').slice(0, w).padEnd(w);
  console.log(col('archivo', 42) + col('check', 10) + col('severidad', 12) + col('acción', 10) + 'detalle');
  for (const r of rows) {
    const line = col(r.archivo, 42) + col(r.check, 10) + col(r.severidad, 12) + col(r.accion, 10)
      + String(r.message || '').slice(0, 80);
    console.log(r.severidad === 'crítico' ? C.red(line) : line);
  }
}

// ─── Load batches ──────────────────────────────────────────────────────────

function flattenExam(examObj) {
  // Aplanar un examen ensamblado {lesenParts, horenParts, ...} a {passages, questions, ads}
  const passages = [];
  const questions = [];
  const ads = [];
  const MODMAP = { lesenParts: 'lesen', horenParts: 'horen', schreibenParts: 'schreiben', sprechenParts: 'sprechen' };
  for (const [arrKey, module] of Object.entries(MODMAP)) {
    for (const part of examObj[arrKey] || []) {
      const teil = Number(part.teil);

      if (module === 'lesen' && teil === 3 && Array.isArray(part.ads) && part.ads.length) {
        ads.push(...part.ads);
      }

      // Dedup guard: algunos formatos de banco almacenan preguntas en AMBOS part.questions[]
      // y part.segments[].questions[] (duplicado exacto por id). Sin dedup, flattenExam
      // contaría doble → CHK-20 vería 2RF+2MC por segmento en vez del 1+1 esperado.
      // Solo deduplicamos cuando q.id existe; sin id se empuja siempre (no podemos afirmar
      // identidad entre ítems sin id aunque compartan texto).
      const seenQIds = new Set();
      function pushQ(q) {
        const key = q.id;
        if (key && seenQIds.has(key)) return;
        if (key) seenQIds.add(key);
        questions.push(q);
      }

      // Pasajes embebidos en array (ej. Lesen T2 con 2 pasajes: part.passages[])
      // Some seed records store passage identity in `p.passageId` (not `p.id`) — accept both.
      if (Array.isArray(part.passages) && part.passages.length > 0) {
        for (const p of part.passages) {
          passages.push({
            id    : p.id || p.passageId || `${module}-${teil}`,
            title : p.title || p.textTitle || '',
            text  : p.text || '',
          });
        }
      } else if (part.passageId || part.text || part.transcript) {
        // Pasaje único inline (incluyendo transcripts de Hören sin segments)
        passages.push({
          id    : part.passageId || `${module}-${teil}`,
          title : part.textTitle || '',
          text  : part.text || part.transcript || '',
        });
      }

      // Eje-2 Fase B: segments[] es autoridad cuando existe; questions[] es fallback.
      // Si la parte tiene segments → solo se leen segments (questions[] es índice derivado).
      // Si no hay segments → questions[] es la fuente (Lesen, Schreiben, H4 plano).
      if (Array.isArray(part.segments) && part.segments.length > 0) {
        // Path segments-autoridad (Hören T1/T2/T3 reparados y cualquier parte con segments)
        for (const seg of part.segments) {
          if (seg.text || seg.transcript) {
            passages.push({ id: seg.passageId || `${module}-${teil}-seg`, title: seg.label || '', text: seg.text || seg.transcript || '' });
          }
          for (const q of seg.questions || []) {
            pushQ({ ...q, module, teil, passageId: q.passageId || seg.passageId });
          }
          for (const item of seg.items || []) {
            if (item.id && (item.correct != null || item.type)) {
              pushQ({ ...item, module, teil, passageId: item.passageId || seg.passageId });
            }
          }
        }
      } else {
        // Path questions[]-fuente (Lesen, Schreiben, H4 plano, cualquier parte sin segments)
        for (const q of part.questions || []) {
          pushQ({ ...q, module, teil, passageId: q.passageId || part.passageId });
        }
      }

      // Lesen T3/T4: part.items[] (ads matching / forum). Solo existe en Lesen, no en Hören.
      // Se normalizan correctAnswer y question para que pasen CHK-2 y CHK-8.
      const passageIdsSeen = new Set(passages.map(p => p.id));
      for (const item of part.items || []) {
        if (!item.id) continue;
        if (item.correct != null || item.correctAnswer != null || item.type) {
          const effectivePassageId = item.passageId || part.passageId;
          if (item.signText && effectivePassageId && !passageIdsSeen.has(effectivePassageId)) {
            passages.push({ id: effectivePassageId, title: '', text: item.signText });
            passageIdsSeen.add(effectivePassageId);
          }
          const normItem = {
            ...item,
            module,
            teil,
            passageId: effectivePassageId,
            correctAnswer: item.correctAnswer ?? item.correct,
            question: item.question || item.signText || '',
          };
          pushQ(normItem);
        }
      }
    }
  }
  const level = examObj.level
    || (questions[0]?.level)
    || (passages[0]?.level)
    || undefined;
  // lang travels with level: auditExam gates the Goethe-specific checks on it, and
  // blueprintForLevel picks the Cambridge count map from it. Dropping it here silently
  // audited every English exam as German.
  const lang = examObj.lang
    || examObj.language
    || (questions[0]?.lang) || (questions[0]?.language)
    || (passages[0]?.lang) || (passages[0]?.language)
    || undefined;
  return { passages, questions, ads, ...(level ? { level } : {}), ...(lang ? { lang } : {}) };
}

// ─── auditExam: audita un examen ensamblado en memoria ────────────────────
// Devuelve { critical, important, minor, findings, questionsScanned }
export function auditExam(examWrapper, label = 'exam') {
  const exam = examWrapper.exam || examWrapper;
  const flat = flattenExam(exam);
  const globalIds = new Set(); // dedup local al examen
  // Lang-aware audit (docs/audit/gates-en-applicability.md): CHK-6/7/11/16/17/20/21
  // validan formatos de tarea GOETHE en posiciones de Teil que en Cambridge son otras
  // tareas — se omiten para lang!=='de' hasta escribir sus equivalentes Cambridge.
  // CHK-3 usa el mapa de conteos del blueprint correspondiente (vía blueprintForLevel).
  const isDe = inferAuditLang(flat) === 'de';
  const findings = [
    ...chk1(flat, label),
    ...chk2(flat, label),
    ...chk3(flat, label),
    ...chk3Absent(flat, label), // solo en examen completo — detecta Teile con 0 ítems
    ...chk4(flat, label),
    ...chk5([{ batch: flat, file: label }]),
    ...(isDe ? chk6(flat, label) : []), // blacklist de anglicismos: solo aplica a aleman
    ...(isDe ? chk6c(flat, label) : []),
    ...(isDe ? chk7(flat, label) : []),
    ...chk8(flat, label, globalIds),
    ...chk10(flat, label),
    ...(isDe ? chk11(flat, label) : []),
    ...chk29(flat, label),
    ...chk35HorenT3RfChrono(flat, label),
    ...chk30PoolMeta(flat, label),
    ...chk30bLesenT4Title(flat, label),
    ...(isDe ? chkQ5GermanContent(flat, label) : []), // gate de idioma aleman: marcaria todo EN
    ...chk31VocabLemma(flat, label),
    ...chk33McqLengthBias(flat, label),
    ...chk12(flat, label),
    ...chk13(flat, label),
    ...chk14(flat, label),
    ...chk14b(flat, label),
    ...chk14c(flat, label),
    ...chk15(flat, label),
    ...(isDe ? chk16(flat, label) : []),
    ...chkH2Align(flat, label),
    ...(isDe ? chk17(flat, label) : []),
    ...chk18(flat, label),
    ...chk18b(flat, label),
    ...chk34(flat, label),
    ...chk19(flat, label),
    ...(isDe ? chk20(flat, label) : []),
    ...(isDe ? chk21(flat, label) : []),
    ...chk22(flat, label),
    ...chk24(flat, label),
    ...chk28(flat, label),
  ];
  const by = s => findings.filter(f => f.severity === s).length;
  return {
    critical: by('CRITICAL'),
    important: by('IMPORTANT'),
    minor: by('MINOR'),
    findings,
    questionsScanned: flat.questions.length,
  };
}

// ─── POOL-2: gate de ingestión al banco (parte suelta → 0 CRITICAL + 0 IMPORTANT) ──

const MODULE_PARTS_KEY = {
  lesen: 'lesenParts',
  horen: 'horenParts',
  schreiben: 'schreibenParts',
  sprechen: 'sprechenParts',
};

function normPartType(type) {
  const t = String(type || '');
  if (t === 'multiple' || t === 'mcq') return 'multiple_choice';
  if (t === 'true_false') return 'richtig_falsch';
  return t;
}

function normPartQuestion(q, module, teil, defaultLevel) {
  // `correct` is canonical. Resolve from correctAnswer only when correct is absent.
  const correct = q.correct ?? q.correctAnswer;
  const level = q.level || defaultLevel;
  return {
    ...q,
    module,
    teil,
    ...(level ? { level: String(level).toUpperCase() } : {}),
    type: normPartType(q.type || q.questionType),
    correct,
    correctAnswer: correct, // mirror, always equal to correct
    question: q.question || q.signText || q.statement || '',
  };
}

function buildHorenSegments(batch, module, teil) {
  const passageMap = new Map((batch.passages || []).map((p) => [p.id, p]));
  const byPassage = new Map();
  for (const q of batch.questions || []) {
    const pid = q.passageId || '_';
    if (!byPassage.has(pid)) byPassage.set(pid, []);
    byPassage.get(pid).push(normPartQuestion(q, module, teil));
  }
  return [...byPassage.entries()].map(([pid, qs], i) => {
    const p = passageMap.get(pid);
    return {
      id: `seg_${i}`,
      label: qs[0]?.segmentLabel || p?.title || `Aufnahme ${i + 1}`,
      transcript: p?.text || p?.transcript || '',
      passageId: pid === '_' ? undefined : pid,
      ...(Array.isArray(p?.pictures) && p.pictures.length ? { pictures: p.pictures } : {}),
      questions: qs,
    };
  });
}

function flatBatchToPartRecord(batch) {
  const qs = batch.questions || [];
  if (!qs.length) return null;
  const module = String(qs.find((q) => q.module)?.module || batch.module || '').toLowerCase();
  const teil = Number(qs[0]?.teil);
  if (!module || !Number.isFinite(teil)) return null;

  const record = {
    id: batch.id,
    module,
    teil,
    instruction: batch.instruction || '',
    questions: qs.map((q) => normPartQuestion(q, module, teil)),
  };
  if (batch.topicTag) record.topicTag = batch.topicTag;
  if (batch._requestedTopic) record._requestedTopic = batch._requestedTopic;
  if (batch._debateSeed || batch.debateSeed) {
    record._debateSeed = batch._debateSeed || batch.debateSeed;
    record.debateSeed = batch.debateSeed || batch._debateSeed;
  }
  if (batch._debateTopic || batch.debateTopic) {
    record._debateTopic = batch._debateTopic || batch.debateTopic;
    record.debateTopic = batch.debateTopic || batch._debateTopic;
  }

  if (module === 'lesen') {
    const passages = batch.passages || [];
    if (passages.length) record.passages = passages;
    if (teil === 2 && passages.length >= 2) {
      record.passage = {
        title: passages[0]?.title || '',
        passages: passages.map((p) => ({
          passageId: p.id,
          textTitle: p.title || p.textTitle || '',
          text: p.text || '',
        })),
      };
    } else if (teil === 3) {
      const p0 = passages[0] || {};
      record.passage = {
        title: p0.title || '',
        text: p0.text || '',
        ads: batch.ads || p0.ads || [],
      };
      if (batch.ads) record.ads = batch.ads;
    } else if (teil === 4) {
      // L4 passages are exposed as record.passages[] so partRecordToExamPart can build the
      // exam wrapper correctly.  We intentionally preserve passageId on questions so that
      // CHK-8 can still detect cross-batch contamination (different passageIds in same file).
      // Questions with signText are self-contained for answering, but the passageId signals
      // which forum topic they belong to — CHK-22 uses this to detect Frankenstein mixes.
      record.passages = passages.map((p) => ({
        id        : p.id || p.passageId,
        passageId : p.id || p.passageId,
        textTitle : p.title || p.textTitle || '',
        text      : p.text || '',
      }));
      record.passage = { title: passages[0]?.title || '', text: passages[0]?.text || '' };
    } else {
      const p0 = passages[0] || {};
      record.passage = { title: p0.title || '', text: p0.text || '' };
    }
  } else if (module === 'horen') {
    record.segments = buildHorenSegments(batch, module, teil);
    const texts = (batch.passages || []).map((p) => p.text || p.transcript || '').filter(Boolean);
    record.passage = { text: texts.join('\n\n'), transcript: texts.join('\n\n') };
  } else if (module === 'schreiben' || module === 'sprechen') {
    record.task = qs[0]?.question || batch.task || '';
  }

  return record;
}

function partRecordToExamPart(record) {
  const module = String(record.module || '').toLowerCase();
  const teil = Number(record.teil);
  const defaultLevel = record.level ? String(record.level).toUpperCase() : undefined;
  const part = { teil, instruction: record.instruction || '' };
  // Preserve topic for post-assemble diversity / review (pickBest already uses
  // candidate.topic at assemble time; without this the exam part JSON loses it).
  if (record.topicTag) part.topicTag = record.topicTag;

  if (module === 'lesen') {
    const passage = record.passage || {};
    if (Array.isArray(passage.passages) && passage.passages.length >= 2) {
      part.passages = passage.passages;
      part.textTitle = passage.title || '';
    } else if (teil === 3) {
      part.text = passage.text || '';
      part.textTitle = passage.title || '';
      part.ads = passage.ads || record.ads || [];
      const pid = passage.id || passage.passageId || record.questions?.[0]?.passageId;
      if (pid) {
        part.passageId = pid;
        part.passages = [{ id: pid, text: part.text, title: part.textTitle || '' }];
      }
    } else if (teil === 4) {
      if (Array.isArray(record.passages) && record.passages.length > 0) {
        part.passages = record.passages;
        if (record.passages.length === 1) {
          part.text = record.passages[0].text || '';
          part.textTitle = record.passages[0].title || '';
        }
      } else if (passage.text) {
        // Bank-extracted L4 records store the forum intro in record.passage (singular).
        // Reconstruct passages[] so flattenExam can register the passage and CHK-8 can
        // resolve questions' passageId references against it.
        const pid = (record.questions || []).find((q) => q.passageId)?.passageId;
        if (pid) {
          part.passages = [{ id: pid, text: passage.text, title: passage.title || '' }];
        } else {
          part.text = passage.text;
          part.textTitle = passage.title || '';
        }
      }
      if (Array.isArray(record.ads)) part.ads = record.ads;
    } else if (teil === 1 && Array.isArray(record.passages) && record.passages.length > 1) {
      // B2 Lesen T1: vier Forumpersonen — alle IDs für CHK-8 / flattenExam
      part.passages = record.passages.map((p) => ({
        id: p.id || p.passageId,
        passageId: p.id || p.passageId,
        title: p.title || p.textTitle || '',
        textTitle: p.title || p.textTitle || '',
        text: p.text || '',
        personKey: p.personKey,
      }));
      const p0 = record.passages[0] || {};
      part.text = p0.text || '';
      part.textTitle = p0.title || '';
    } else {
      part.text = passage.text || '';
      part.textTitle = passage.title || '';
      part.passageId = record.questions?.[0]?.passageId || passage.passageId;
    }
    part.questions = (record.questions || []).map((q) => normPartQuestion(q, module, teil, defaultLevel));
    if (record.example) part.example = record.example;
    if (Number(teil) === 3 && !part.example) {
      const zeroQ = (part.questions || []).find(
        (q) => String(q.correct ?? q.correctAnswer ?? '').trim().toUpperCase() === '0',
      );
      if (zeroQ) {
        part.example = {
          number: 0,
          label: 'Beispiel',
          situation: zeroQ.question,
          question: zeroQ.question,
          correct: '0',
          correctAnswer: '0',
        };
        part._t3HasNoMatch = true;
      }
    }
  } else if (module === 'horen') {
    const passage = record.passage || {};
    if (Array.isArray(record.segments) && record.segments.length) {
      part.segments = record.segments.map((seg) => ({
        ...seg,
        pictures: seg.pictures || record.passage?.pictures || undefined,
        questions: (seg.questions || []).map((q) => normPartQuestion(q, module, teil, defaultLevel)),
      }));
      if (Number(teil) === 2 && String(record.level || '').toUpperCase() === 'A2') {
        part.blueprintSlot = 'picture_matching';
        part.plays = 1;
      }
      // Derived flat index — segments remain authority for render/scoring/validation.
      part.questions = part.segments.flatMap((seg) => seg.questions || []);
    } else {
      part.transcript = passage.transcript || passage.text || '';
      part.questions = (record.questions || []).map((q) => normPartQuestion(q, module, teil, defaultLevel));
      const firstPid = (record.questions || []).find((q) => q.passageId)?.passageId;
      if (firstPid) part.passageId = firstPid;
    }
    if (!part.transcript) {
      part.transcript =
        passage.transcript ||
        passage.text ||
        (part.segments || []).map((s) => s.transcript).filter(Boolean).join('\n\n') ||
        '';
    }
  } else if (module === 'schreiben') {
    const q0 = (record.questions || [])[0];
    const passage = record.passage || {};
    part.task =
      record.task ||
      record.instruction ||
      passage.text ||
      (q0 && q0.question) ||
      '';
    const lv = String(defaultLevel || record.level || '').toUpperCase();
    const wordsMap =
      lv === 'A2'
        ? { 1: { min: 20, max: 30 }, 2: { min: 30, max: 40 }, 3: { min: 40, max: 40 } }
        : { 1: { min: 80, max: 80 }, 2: { min: 80, max: 80 }, 3: { min: 40, max: 40 } };
    const wordSpec = wordsMap[Number(teil)] || wordsMap[1];
    part.minWords = record.minWords ?? wordSpec.min;
    part.maxWords = record.maxWords ?? wordSpec.max;
    part.targetWords = record.targetWords ?? wordSpec.max;
    part.fieldId = record.fieldId;
    part.taskFormat = record.taskFormat || passage.title || record.taskFormat;
    const task = part.task;
    part.questions = (record.questions || []).length
      ? record.questions.map((q) => normPartQuestion(q, module, teil, defaultLevel))
      : [{
        id: '1', type: 'short_answer', question: task,
        correct: 'rubric', module, teil,
        ...(defaultLevel ? { level: defaultLevel } : {}),
      }];
  } else if (module === 'sprechen') {
    part.level = defaultLevel || record.level;
    part.questions = (record.questions || []).map((q) => normPartQuestion(q, module, teil, defaultLevel));
    SprechenBriefing.enrichSprechenExamPart(part, record);
    if (!part.topic && record.topicTag) part.topic = record.topicTag;
  } else {
    return null;
  }

  return part;
}

function partToExamWrapper(record) {
  const module = String(record.module || '').toLowerCase();
  const partsKey = MODULE_PARTS_KEY[module];
  if (!partsKey) return null;
  const part = partRecordToExamPart(record);
  if (!part) return null;
  return { exam: { level: record.level, [partsKey]: [part] } };
}

/** Excluye CHK-3 "Teil ausente" al auditar una sola parte (no examen completo). */
export function filterPartPoolFindings(findings) {
  return findings.filter((f) => {
    if (f.severity === 'INFO') return false;
    if (f.id === 'CHK-3' && String(f.message).includes('Teil ausente')) return false;
    return true;
  });
}

function splitInputIntoPartRecords(input) {
  if (!input || typeof input !== 'object') return [];
  if (input.exam) {
    const exam = input.exam;
    const out = [];
    for (const [partsKey, mod] of Object.entries({
      lesenParts: 'lesen', horenParts: 'horen', schreibenParts: 'schreiben', sprechenParts: 'sprechen',
    })) {
      for (const p of exam[partsKey] || []) {
        out.push({ module: mod, teil: p.teil, ...p, questions: p.questions || p.items || [] });
      }
    }
    return out;
  }
  if (input.lesenParts || input.horenParts || input.schreibenParts || input.sprechenParts) {
    return splitInputIntoPartRecords({ exam: input });
  }
  if (input.module && (input.questions || input.segments || input.task)) {
    return [enrichRecordForAudit(input)];
  }
  if (Array.isArray(input.questions) && input.questions.length) {
    const groups = new Map();
    for (const q of input.questions) {
      const mod = String(q.module || '').toLowerCase();
      const teil = Number(q.teil);
      const key = `${mod}:${teil}`;
      if (!groups.has(key)) {
        groups.set(key, {
          module: mod,
          teil,
          questions: [],
          passages: input.passages || [],
          ads: input.ads,
          topicTag: input.topicTag,
          _requestedTopic: input._requestedTopic,
          // CHK-27 (T4): sin esto, detectT4DebateTopic cae en FPs (autofrei fallback /
          // «verein»⊂«vereinbaren») y el seed correcto del generador se ignora.
          _debateSeed: input._debateSeed || input.debateSeed,
          debateSeed: input.debateSeed || input._debateSeed,
          _debateTopic: input._debateTopic || input.debateTopic,
          debateTopic: input.debateTopic || input._debateTopic,
        });
      }
      groups.get(key).questions.push(q);
    }
    return [...groups.values()].map((g) => flatBatchToPartRecord(g)).filter(Boolean);
  }
  return [];
}

export function auditSinglePartRecord(record, label) {
  const enriched = enrichRecordForAudit(record);
  // CHK-23/26 run on the raw record BEFORE normalization — flattenExam drops topicTag.
  const rawFindings = [
    ...chk23(enriched, label),
    ...chk26(enriched, label),
    ...chk27(enriched, label),
  ];

  const wrapper = partToExamWrapper(enriched);
  if (!wrapper) {
    return [...rawFindings, finding('AUDIT-ERROR', 'CRITICAL', label, 'part', 'Parte no convertible a examen')];
  }
  const audit = auditExam(wrapper, label);
  return [...rawFindings, ...filterPartPoolFindings(audit.findings)].filter(
    (f) => f.severity === 'CRITICAL' || f.severity === 'IMPORTANT',
  );
}

/**
 * POOL-2 — ¿Puede esta parte entrar al banco/pool recién generado?
 * Bloquea TODO finding CRITICAL o IMPORTANT (21 checks vía auditExam, sin GATE_BLOCK_CHECKS).
 *
 * @param {object} part - Batch {passages,questions}, record reusable, o examen parcial
 * @param {object} [opts]
 * @param {boolean} [opts.allowFailures=false] - Solo desarrollo: aviso rojo, no bloquea
 * @returns {{ ok: boolean, blocking: object[] }}
 *
 * Multi-Teil: divide por (module, teil), audita cada grupo con auditExam y acumula
 * blocking. ok=false si CUALQUIER grupo tiene ≥1 CRITICAL/IMPORTANT. CHK-3 "Teil
 * ausente" se filtra; el conteo incorrecto del Teil presente sí bloquea.
 *
 * Cuando opts.semantic=true la función es ASYNC y añade la capa semántica (SEM-1):
 * una llamada LLM acotada por parte que valida correctness/ambiguity/distractor/
 * explanation/template. Resultado cacheado por hash de contenido (sin recoste LLM).
 *
 * opts.skipSem2=true omite SEM-2 (juez advise-only) — usar en el loop de generación
 * para no pagar 2 LLM por T2; publish/ingest deja skipSem2=false (default).
 */
export async function isPartPoolReady(part, { allowFailures = false, semantic = false, skipSem2 = false } = {}) {
  // ── 1. Structural gate (siempre, síncrono) ─────────────────────────────────
  let structOk;
  let blocking;
  try {
    const records = splitInputIntoPartRecords(part);
    if (!records.length) {
      const err = finding('AUDIT-ERROR', 'CRITICAL', 'isPartPoolReady', 'part', 'Entrada vacía o no reconocida');
      return { ok: false, blocking: [err] };
    }

    blocking = [];
    for (const rec of records) {
      const label = rec.id || `${rec.module}-t${rec.teil}`;
      blocking.push(...auditSinglePartRecord(rec, label));
    }

    if (allowFailures && blocking.length > 0) {
      const ids = [...new Set(blocking.map((f) => f.id))].join(',');
      process.stderr.write(
        `\n\x1b[31m⚠  --allow-audit-failures: ${blocking.length} finding(s) ignorado(s) [${ids}]\x1b[0m\n`,
      );
    }
    structOk = allowFailures || blocking.length === 0;
  } catch (err) {
    const auditError = finding(
      'AUDIT-ERROR', 'CRITICAL', 'isPartPoolReady', 'part',
      `auditExam lanzó excepción: ${err?.message || String(err)}`,
    );
    process.stderr.write(
      `[isPartPoolReady] AUDIT-ERROR — parte no auditable (fail-closed): ${err?.message || err}\n`,
    );
    return { ok: false, blocking: [auditError] };
  }

  // ── 2. Semantic layer (solo cuando semantic:true) ────────────────────────────
  if (!semantic) return { ok: structOk, blocking };

  // Structural failures already block — no need to burn an LLM call
  if (!structOk && !allowFailures) return { ok: false, blocking };

  let semResult;
  try {
    const { validatePartSemantics } = await import('./lib/semanticValidator.mjs');
    semResult = await validatePartSemantics(part);
  } catch (err) {
    blocking.push(
      finding(
        'SEM-LLM-ERROR',
        'CRITICAL',
        'semantic',
        'part',
        `SEM-1 validator crash (fail-closed): ${err?.message || err}`,
      ),
    );
    return { ok: false, blocking };
  }

  if (semResult._llmError) {
    blocking.push(
      finding(
        'SEM-LLM-ERROR',
        'CRITICAL',
        'semantic',
        'part',
        semResult._llmError,
      ),
    );
    return { ok: false, blocking };
  }

  // Convert semantic issues → findings (IMPORTANT severity, id = 'SEM-{kind}')
  const semFindings = (semResult.issues || []).map((iss) =>
    finding(
      `SEM-${iss.kind.toUpperCase()}`,
      // correctness/ambiguity are CRITICAL; distractor/explanation/template are IMPORTANT
      ['correctness', 'ambiguity'].includes(iss.kind) ? 'CRITICAL' : 'IMPORTANT',
      'semantic',
      iss.itemId || 'part',
      iss.detail,
    ),
  );

  blocking.push(...semFindings);

  // ── 3. SEM-2: advise-only (mcq_distinct → checker determinista CHK-28 / calidad) ──
  if (!skipSem2 && shouldRunSem2Part(part)) {
    let sem2;
    try {
      const { runSem2Judge } = await import('./lib/holisticJudge.mjs');
      sem2 = await runSem2Judge(part, {
        topicTag: part._requestedTopic || part.topicTag || part.passages?.[0]?.topicTag,
      });
    } catch (err) {
      blocking.push(
        finding(
          'SEM2-LLM-ERROR',
          'CRITICAL',
          'semantic',
          'part',
          `SEM-2 judge crash (fail-closed): ${err?.message || err}`,
        ),
      );
      return { ok: false, blocking };
    }

    if (sem2._llmError) {
      blocking.push(
        finding(
          'SEM2-LLM-ERROR',
          'CRITICAL',
          'semantic',
          'part',
          sem2.error || 'SEM-2 LLM error',
        ),
      );
      return { ok: false, blocking };
    }
    // mcq_distinct y resto de ejes SEM-2 → solo sem2-advise-log.jsonl (no blocking)
  }

  return { ok: (allowFailures || blocking.length === 0), blocking };
}

function shouldRunSem2Part(part) {
  const mod = String(part?.module || part?.questions?.[0]?.module || '').toLowerCase();
  const teil = Number(part?.teil ?? part?.questions?.[0]?.teil);
  return mod === 'lesen' && teil === 2;
}

// ─── GATE de publicación — fuente única de verdad ────────────────────────────
//
// POLÍTICA V-10 (decidida 2026-07-02):
// Meta final = "publicación ≡ ingestión" (0-CRITICAL, 0-IMPORTANT en ambas).
// La convergencia se hace en dos etapas:
//
//   GATE_BLOCK_CHECKS  — IMPORTANT tratados como CRITICAL AHORA.
//                        Solo invariantes estructurales cuyo fallo produce exámenes
//                        rotos independientemente del contenido.
//
//   GATE_BLOCK_PENDING — IMPORTANT que DEBEN bloquear cuando el pool esté limpio.
//                        Actualmente advisory para no congelar el pipeline.
//                        POOL-5 los moverá a GATE_BLOCK_CHECKS celda a celda,
//                        una vez la matriz pool-health no tenga registros afectados.
//
// Para activar un CHK pendiente: mover su entrada de PENDING → CHECKS (una edición).
//
// Todos los CRITICAL bloquean siempre, independientemente de estos Sets.

// Invariantes estructurales activos:
export const GATE_BLOCK_CHECKS = new Set([
  'CHK-LEVEL',
  'CHK-14c', // P2: mayúsculas erróneas en opciones MCQ T2/T5
  'CHK-17', // L3: misma lista A-J compartida en los 7 ítems (Frankenstein L3)
  'CHK-18b', // T2/T5: clave MCQ no coincide con explicación
  'CHK-20', // H1: cada segmento debe tener exactamente 1RF+1MC (invariante estructural H1)
  'CHK-21', // T4: signText ≥15 palabras y autores únicos (Frankenstein T4)
  'CHK-22', // T4: múltiples passageIds = cross-batch Frankenstein (CRITICAL — siempre bloquea)
  'CHK-26', // P1: topicTag coherente con tema pedido (incl. T3 sin passages)
  'CHK-27', // P3: debate T4 alineado al tema pedido (no Homeoffice en Technik, etc.)
  'CHK-28', // L2: opciones MCQ no excluyentes (determinista, sin LLM)
  'CHK-29', // T4/T5: molde estructural duplicado en celda topicTag×Teil
]);

// Pendientes de activación (advisory hoy, bloqueantes cuando pool-health los soporte):
// Para mover a activo: cut from here, paste into GATE_BLOCK_CHECKS above.
export const GATE_BLOCK_PENDING = new Set([
  // CHK-18: explanation quality (corta <10w, trivial, no alemán, circular).
  // Impacto actual: 53/160 registros (33%). Mover a GATE_BLOCK_CHECKS en POOL-5,
  // cuando pool-health-report muestre 0 registros con CHK-18 en celdas activas.
  'CHK-18',
  // CHK-34 (missing correct quote, MINOR): promover a GATE_BLOCK_CHECKS tras
  // EXPL_OPTION_TEXT_ALIGN_WARN_ONLY_UNTIL (2026-08-10) si 0 FP en pool-verified.
  // CHK-34 CRITICAL (cita = opción incorrecta / texto desalineado) bloquea siempre.
]);

/**
 * Determina si un examen es publicable según el gate de auditoría.
 * Único lugar donde se decide qué bloquea publicación.
 *
 * @param {object} exam - Examen (wrapper {exam:...} o plano)
 * @param {object} [opts]
 * @param {boolean} [opts.allowFailures=false] - Si true, emite aviso rojo pero no bloquea
 * @returns {{ ok: boolean, blocking: object[], advisory: object[] }}
 */
export function checkExamLevelIntegrity(examWrapper, { expectedLevel } = {}) {
  const expected = String(
    expectedLevel || examWrapper?.level || examWrapper?.exam?.level || '',
  )
    .trim()
    .toUpperCase();
  if (!expected) return { ok: true, blocking: [], findings: [] };

  const findings = [];
  const exam = examWrapper?.exam || examWrapper;
  const slots = ['lesenParts', 'horenParts', 'schreibenParts', 'sprechenParts'];

  const auditQuestion = (q, scope, partLabel) => {
    if (!q || typeof q !== 'object') return;
    const ql = q.level ? String(q.level).trim().toUpperCase() : null;
    if (!ql) {
      findings.push(
        finding(
          'CHK-LEVEL',
          'CRITICAL',
          scope,
          `q:${q.id || '?'}`,
          `${partLabel}: pregunta ${q.id || '?'} sin level (esperado ${expected})`,
        ),
      );
    } else if (ql !== expected) {
      findings.push(
        finding(
          'CHK-LEVEL',
          'CRITICAL',
          scope,
          `q:${q.id || '?'}`,
          `${partLabel}: level «${ql}» ≠ esperado «${expected}»`,
        ),
      );
    }
  };

  for (const slot of slots) {
    for (const part of exam?.[slot] || []) {
      const partLabel = `${slot} T${part?.teil ?? '?'}`;
      for (const q of part.questions || []) auditQuestion(q, 'exam', partLabel);
      for (const seg of part.segments || []) {
        for (const q of seg.questions || []) auditQuestion(q, 'exam', `${partLabel}/${seg.label || seg.passageId || 'seg'}`);
      }
    }
  }

  return { ok: findings.length === 0, blocking: findings, findings };
}

export function isExamPublishable(exam, { allowFailures = false, expectedLevel } = {}) {
  // ── CHK-23 pre-check on RAW parts, before auditExam calls flattenExam ────────
  // flattenExam silently resolves questions[]/segments[].questions[] conflicts by
  // preferring questions[] (wrong for Hören). Run CHK-23 before that resolution
  // so divergent exams are blocked here, not silently fixed.
  const preFindings = [];
  const examObj = exam?.exam || {};
  for (const slot of ['lesenParts', 'horenParts', 'schreibenParts', 'sprechenParts']) {
    for (const part of examObj[slot] || []) {
      preFindings.push(...chk23(part, part.id || slot));
    }
  }

  const levelExpected =
    expectedLevel || exam?.level || examObj?.level || null;
  const levelIntegrity = checkExamLevelIntegrity(exam, { expectedLevel: levelExpected });
  preFindings.push(...levelIntegrity.findings);

  // ── Fail-closed: si auditExam lanza
  // → tratar como CRITICAL AUDIT-ERROR. NO publicar. El catch→warn de la CLI (modo reporte)
  // es distinto: está en loadBatchFile y solo aplica al escaneo de directorios.
  let audit;
  try {
    audit = auditExam(exam);
  } catch (err) {
    const auditError = finding(
      'AUDIT-ERROR', 'CRITICAL', 'isExamPublishable', 'exam',
      `auditExam lanzó excepción: ${err?.message || String(err)}`,
    );
    process.stderr.write(
      `[isExamPublishable] AUDIT-ERROR — examen no auditable (fail-closed): ${err?.message || err}\n`,
    );
    return { ok: false, blocking: [auditError], advisory: [] };
  }

  const allFindings = [...preFindings, ...audit.findings];
  const blocking = allFindings.filter(
    (f) => f.severity === 'CRITICAL' || GATE_BLOCK_CHECKS.has(f.id),
  );
  // pending: advisory findings that are in GATE_BLOCK_PENDING (will block in POOL-5)
  const pending = allFindings.filter(
    (f) => f.severity !== 'CRITICAL' && !GATE_BLOCK_CHECKS.has(f.id) && GATE_BLOCK_PENDING.has(f.id),
  );
  const advisory = allFindings.filter(
    (f) => f.severity !== 'CRITICAL' && !GATE_BLOCK_CHECKS.has(f.id) && !GATE_BLOCK_PENDING.has(f.id),
  );
  if (allowFailures && blocking.length > 0) {
    const ids = [...new Set(blocking.map((f) => f.id))].join(',');
    process.stderr.write(
      `\n\x1b[31m⚠  --allow-audit-failures: ${blocking.length} finding(s) ignorado(s) [${ids}]\x1b[0m\n`,
    );
  }
  if (pending.length > 0) {
    const ids = [...new Set(pending.map((f) => f.id))].join(',');
    process.stderr.write(
      `\n\x1b[33m⚠  GATE_BLOCK_PENDING: ${pending.length} finding(s) no bloquean hoy pero lo harán en POOL-5 [${ids}]\x1b[0m\n`,
    );
  }
  return { ok: allowFailures || blocking.length === 0, blocking, pending, advisory };
}

// Exportar símbolos necesarios para publicador y verify
export { flattenExam, BLUEPRINT, partRecordToExamPart, partToExamWrapper, chk14 };

/**
 * loadBatchFile: devuelve siempre un array de batches.
 * - Batch simple → [batch]
 * - Examen ensamblado individual → [flattenExam(exam)]
 * - Array de exámenes → [flattenExam(exam1), flattenExam(exam2), …]
 *   (cada examen se audita por separado para que CHK-3 verifique conteos por examen)
 */
function loadBatchFile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Array de exámenes ensamblados: [{id, exam:{lesenParts,...}}, ...]
  if (Array.isArray(raw)) {
    return raw.map(item => {
      const examObj = item.exam || (item.lesenParts || item.horenParts ? item : null);
      if (examObj) {
        const flat = flattenExam(examObj);
        flat._isFullExam = true; // marcar para chk3Absent en el loop CLI
        return flat;
      }
      return { passages: [], questions: [] };
    });
  }

  // Examen ensamblado individual: {id, exam:{lesenParts,...}} o {lesenParts,...}
  const exam = raw.exam || (raw.lesenParts || raw.horenParts || raw.schreibenParts || raw.sprechenParts ? raw : null);
  if (exam) {
    const flat = flattenExam(exam);
    flat._isFullExam = true; // marcar para chk3Absent en el loop CLI
    return [flat];
  }

  // Pool plano {meta, passages, questions} o batch {passages, questions}
  const POOL_META_KEYS = [
    'id', 'level', 'module', 'teil', 'lang', 'topicTag', '_requestedTopic',
    '_debateSeed', 'debateSeed', '_debateTopic', 'debateTopic',
    '_rejectedReason', '_balanceMcqVersion', '_lengthBiasQuarantine',
    'segments', 'ads', 'instruction',
  ];
  const batch = {
    passages: raw.passages || [],
    questions: raw.questions || [],
  };
  for (const k of POOL_META_KEYS) {
    if (raw[k] != null) batch[k] = raw[k];
  }
  return [batch];
}

function collectFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { recursive: true })
    .filter(f => f.endsWith('.json') && !f.startsWith('.') && !f.includes('.rejected'))
    .map(f => path.join(target, f))
    .filter(f => !path.basename(f).startsWith('.'));
}

// ─── Fix-types helper ──────────────────────────────────────────────────────

function fixTypes(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  let changed = 0;
  for (const q of data.questions || []) {
    if (q.type === 'multiple') { q.type = 'multiple_choice'; changed++; }
    if (q.questionType === 'multiple') { q.questionType = 'multiple_choice'; changed++; }
  }
  if (changed > 0) {
    fs.copyFileSync(filePath, filePath + '.bak');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
  return changed;
}

// ─── Output helpers ────────────────────────────────────────────────────────

const USE_COLOR = process.stdout.isTTY;
const C = {
  red:    s => USE_COLOR ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: s => USE_COLOR ? `\x1b[33m${s}\x1b[0m` : s,
  grey:   s => USE_COLOR ? `\x1b[90m${s}\x1b[0m` : s,
  bold:   s => USE_COLOR ? `\x1b[1m${s}\x1b[0m` : s,
  green:  s => USE_COLOR ? `\x1b[32m${s}\x1b[0m` : s,
};

function sevColor(sev) {
  if (sev === 'CRITICAL') return C.red(sev);
  if (sev === 'IMPORTANT') return C.yellow(sev);
  return C.grey(sev);
}

function printFindings(findings, summaryOnly) {
  // INFO findings are never printed (structural notes, not actionable)
  const printable = findings.filter(f => f.severity !== 'INFO');

  if (!summaryOnly) {
    // Group by CHK id
    const byChk = {};
    for (const f of printable) {
      if (!byChk[f.id]) byChk[f.id] = [];
      byChk[f.id].push(f);
    }
    for (const [chk, flist] of Object.entries(byChk).sort()) {
      console.log(C.bold(`\n── ${chk} (${flist.length}) ──`));
      for (const f of flist) {
        console.log(`  [${sevColor(f.severity)}] ${C.grey(f.file)} ${f.scope ? C.grey(`(${f.scope})`) : ''}`);
        console.log(`    ${f.message}`);
      }
    }
  }

  const counts = { CRITICAL: 0, IMPORTANT: 0, MINOR: 0 };
  for (const f of printable) counts[f.severity] = (counts[f.severity] || 0) + 1;

  console.log(C.bold('\n══ RESUMEN ══'));
  console.log(`  ${C.red('CRÍTICOS')}:   ${counts.CRITICAL}`);
  console.log(`  ${C.yellow('IMPORTANTES')}: ${counts.IMPORTANT}`);
  console.log(`  ${C.grey('MENORES')}:    ${counts.MINOR}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    target: null,
    json: false,
    failOn: 'CRITICAL',
    fixTypes: false,
    summaryOnly: false,
    actionTable: false,
    actionReport: null,
  };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
    else if (a === '--fix-types') args.fixTypes = true;
    else if (a === '--summary-only') args.summaryOnly = true;
    else if (a === '--action-table') args.actionTable = true;
    else if (a.startsWith('--action-report=')) args.actionReport = a.split('=').slice(1).join('=');
    else if (a.startsWith('--fail-on=')) args.failOn = a.split('=')[1].toUpperCase();
    else if (!a.startsWith('--')) args.target = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.target) {
    console.error('Uso: node scripts/audit-pass-2.mjs <ruta> [--json] [--fail-on=CRITICAL] [--fix-types] [--summary-only] [--action-table] [--action-report=path.json]');
    process.exit(2);
  }

  const target = path.resolve(args.target);
  if (!fs.existsSync(target)) {
    console.error(`No existe: ${target}`);
    process.exit(2);
  }

  const files = collectFiles(target);
  if (!args.json && !args.summaryOnly) {
    console.log(C.bold(`\nAuditando ${files.length} archivo(s) en ${target}`));
  }

  // Fix-types pass (before audit)
  if (args.fixTypes) {
    let totalFixed = 0;
    for (const f of files) {
      const n = fixTypes(f);
      if (n > 0 && !args.json) console.log(`  fix-types: ${path.basename(f)} → ${n} correcciones (backup .bak)`);
      totalFixed += n;
    }
    if (!args.json) console.log(`  Total corregido: ${totalFixed} ocurrencias de type:"multiple"`);
  }

  // Load all batches (loadBatchFile returns array of batches per file)
  const allBatches = [];
  let questionsScanned = 0;
  for (const f of files) {
    try {
      const batches = loadBatchFile(f);
      for (const batch of batches) {
        allBatches.push({ batch, file: f });
        questionsScanned += (batch.questions || []).length;
      }
    } catch (e) {
      if (!args.json) console.warn(`  Saltando ${path.basename(f)}: ${e.message}`);
    }
  }

  // Run per-file checks
  const globalIds = new Set();
  const allFindings = [];

  for (const { batch, file } of allBatches) {
    // Same lang gate as auditExam (docs/audit/gates-en-applicability.md): CHK-6/6c/7/11/
    // 16/17/20/21 and chkQ5GermanContent validate GOETHE task formats. Without this the
    // CLI judged English batches by German rules — "use Radfahren instead of cycling".
    const isDe = inferAuditLang(batch) === 'de';
    allFindings.push(...chk1(batch, file));
    allFindings.push(...chk2(batch, file));
    allFindings.push(...chk3(batch, file));
    if (batch._isFullExam) allFindings.push(...chk3Absent(batch, file));
    allFindings.push(...chk4(batch, file));
    if (isDe) allFindings.push(...chk6(batch, file));
    if (isDe) allFindings.push(...chk6c(batch, file));
    allFindings.push(...chk26(batch, file));
    allFindings.push(...chk27(batch, file));
    if (isDe) allFindings.push(...chk7(batch, file));
    allFindings.push(...chk8(batch, file, globalIds));
    allFindings.push(...chk9(batch, file));
    allFindings.push(...chk10(batch, file));
    if (isDe) allFindings.push(...chk11(batch, file));
    allFindings.push(...chk29(batch, file));
    allFindings.push(...chk35HorenT3RfChrono(batch, file));
    allFindings.push(...chk30PoolMeta(batch, file));
    allFindings.push(...chk30bLesenT4Title(batch, file));
    if (isDe) allFindings.push(...chkQ5GermanContent(batch, file));
    allFindings.push(...chk31VocabLemma(batch, file));
    allFindings.push(...chk33McqLengthBias(batch, file));
    allFindings.push(...chk12(batch, file));
    allFindings.push(...chk13(batch, file));
    allFindings.push(...chk14(batch, file));
    allFindings.push(...chk14b(batch, file));
    allFindings.push(...chk14c(batch, file));
    allFindings.push(...chk15(batch, file));
    if (isDe) allFindings.push(...chk16(batch, file));
    allFindings.push(...chkH2Align(batch, file));
    if (isDe) allFindings.push(...chk17(batch, file));
    allFindings.push(...chk18(batch, file));
    allFindings.push(...chk18b(batch, file));
    allFindings.push(...chk34(batch, file));
    allFindings.push(...chk19(batch, file));
    if (isDe) allFindings.push(...chk20(batch, file));
    if (isDe) allFindings.push(...chk21(batch, file));
    allFindings.push(...chk22(batch, file));
    allFindings.push(...chk24(batch, file));
    allFindings.push(...chk28(batch, file));
  }

  // Global checks
  allFindings.push(...chk5(allBatches));
  allFindings.push(...chk25(allBatches));
  allFindings.push(...chk32GlobalNameFrequency(allBatches));

  // Output
  const counts = { critical: 0, important: 0, minor: 0 };
  for (const f of allFindings) {
    if (f.severity === 'CRITICAL') counts.critical++;
    else if (f.severity === 'IMPORTANT') counts.important++;
    else if (f.severity === 'MINOR') counts.minor++;
    // INFO is intentionally excluded from counts and summary
  }

  const actionRows = buildActionTableRows(allFindings);
  const fileGroups = classifyFilesByFindings(allFindings, files);

  if (args.json) {
    console.log(JSON.stringify({
      summary: { ...counts, filesScanned: files.length, questionsScanned },
      fileGroups: {
        clean: fileGroups.clean,
        cosmeticOnly: fileGroups.cosmeticOnly,
        important: fileGroups.important,
        critical: fileGroups.critical,
      },
      actionTable: actionRows,
      findings: allFindings,
    }, null, 2));
  } else {
    printFindings(allFindings, args.summaryOnly);
    if (args.actionTable) printActionTable(actionRows);
    if (!args.summaryOnly) {
      console.log(`\n  Archivos escaneados: ${files.length} | Preguntas: ${questionsScanned}`);
      console.log(C.bold('\n── Clasificación pool ──'));
      console.log(`  Limpios: ${fileGroups.clean.length}`);
      console.log(`  Solo cosmético (MINOR): ${fileGroups.cosmeticOnly.length}`);
      console.log(`  Hallazgos menores (IMPORTANT): ${fileGroups.important.length}`);
      console.log(`  Críticos (CRITICAL): ${fileGroups.critical.length}`);
    }
  }

  if (args.actionReport) {
    const reportPath = path.resolve(args.actionReport);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      target,
      summary: { ...counts, filesScanned: files.length, questionsScanned },
      fileGroups: fileGroups,
      actionTable: actionRows,
      findings: allFindings,
    }, null, 2)}\n`, 'utf8');
    if (!args.json && !args.summaryOnly) {
      console.log(C.green(`\n  Reporte accionable: ${reportPath}`));
    }
  }

  // Exit code
  if (args.failOn !== 'NONE') {
    const failLevel = SEV[args.failOn] ?? SEV.CRITICAL;
    const worstSev = allFindings.reduce((max, f) => Math.max(max, SEV[f.severity] ?? 0), 0);
    if (worstSev >= failLevel) process.exit(1);
  }
}

// Solo ejecutar main() cuando se invoca directamente como CLI (no al importar como módulo)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main().catch(e => { console.error(e); process.exit(2); });
