/**
 * Blueprint slot conformance — blocks bank ingest of questions that don't fit their Teil.
 * Type rules mirror ExamBlueprint.typeAllowed (what assemble actually uses).
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ExamBlueprint = require(path.join(ROOT, 'js/library/ExamBlueprint.js'));

const MODULE_ALIASES = {
  reading: 'lesen',
  listening: 'horen',
  writing: 'schreiben',
  speaking: 'sprechen',
  use_of_english: 'grammatik',
  grammar: 'grammatik',
};

/** Canonical type token (aligned with ExamBlueprint.normType + ExamValidator aliases). */
export function normalizeQuestionType(raw) {
  const t = String(raw || '').toLowerCase().trim();
  if (t === 'multiple') return 'multiple_choice';
  if (t === 'match') return 'matching';
  if (['rf', 'tf', 'true_false', 'richtig_falsch', 'rfn', 'r_f_n'].includes(t)) return 'richtig_falsch';
  if (['jn', 'yn', 'ja_nein'].includes(t)) return 'ja_nein';
  if (['mc', 'mcq', 'multiple_choice', 'abcd'].includes(t)) return 'multiple_choice';
  if (['person_match', 'person_multi', 'matching_speaker'].includes(t)) return 'matching';
  if (['gap', 'gap_fill'].includes(t)) return 'gap_fill';
  if (
    [
      'short',
      'short_answer',
      'rubric',
      'schreiben',
      'writing',
      'speaking_task',
      'oral_task',
      'speaking',
      'planungsaufgabe',
      'praesentation',
      'praesentationsaufgabe',
      'feedback',
      'feedback_diskussion',
      'feedback_und_fragen',
      'diskussion',
      'personal_questions',
      'about_self',
      'plan_together',
    ].includes(t)
  ) {
    if (t === 'personal_questions' || t === 'about_self' || t === 'plan_together') return t;
    return 'short_answer';
  }
  return t;
}

function normalizeModuleId(module) {
  const m = String(module || '').toLowerCase();
  return MODULE_ALIASES[m] || m;
}

function findBlueprintPart(q, blueprint) {
  const modId = normalizeModuleId(q.module);
  const mod = (blueprint.modules || []).find((m) => m.id === modId);
  if (!mod) return null;
  const teil = typeof q.teil === 'string' ? Number(q.teil) : q.teil;
  const part = (mod.parts || []).find((p) => p.teil === teil);
  if (!part) return null;
  return { mod, part };
}

function hasNonEmptyOptions(q) {
  const opts = q.options ?? q.matchLabels;
  return Array.isArray(opts) && opts.length > 0;
}

// "A", "a) A", "B.", "c) C)" — a label with no content of its own.
const BARE_LABEL_OPTION = /^\s*(?:[a-j][).:]\s*)?([A-J])[).:]?\s*$/;

/**
 * Letters of bare-label matching options that point at no content. Bare labels are fine when the
 * texts they name live elsewhere (Reading Part 2: "A) …" lines in the passage, or one passage per
 * text with an id ending in "-A"). A gapped text whose options are just "a) A" with the sentences
 * nowhere passed conformance before and was unanswerable (A/B 24 sep 2026).
 * Returns null when the options carry their own content.
 */
function unresolvedBareLabels(q, batch) {
  const opts = q.options ?? q.matchLabels;
  if (!Array.isArray(opts) || !opts.length) return null;
  const letters = opts.map((o) => String(o).match(BARE_LABEL_OPTION)?.[1]);
  if (letters.some((l) => !l)) return null;
  // The question's passage and its siblings (one passage per text: "…-A" or "…-01" ids).
  const stem = String(q.passageId || '').replace(/-[A-Za-z0-9]+$/, '');
  const group = (batch?.passages || []).filter(
    (p) => p.id === q.passageId || (stem && String(p.id).replace(/-[A-Za-z0-9]+$/, '') === stem),
  );
  const found = new Set();
  const LABEL_LINE = /(?:^|\n)\s*\(?([A-J])[).:]\s+\S/g;
  for (const p of group) {
    if (!String(p.text || '').trim()) continue;
    for (const m of String(p.text).matchAll(LABEL_LINE)) found.add(m[1]);
    const byId = String(p.id).match(/-([A-J])$/);
    if (byId) found.add(byId[1]);
    const byTitle = String(p.title || '').match(/^\s*\(?([A-J])[).:]\s+\S/);
    if (byTitle) found.add(byTitle[1]);
  }
  return letters.filter((l) => !found.has(l));
}

function hasCorrect(q) {
  const c = q.correct ?? q.correctAnswer;
  return c != null && c !== '';
}

function effectiveType(q) {
  return normalizeQuestionType(q.questionType || q.type);
}

function typeAllowedForSlot(q, allowed) {
  const t = effectiveType(q);
  return ExamBlueprint.typeAllowed({ ...q, type: t, questionType: t }, allowed);
}

/**
 * @param {object} q
 * @param {object} blueprint
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function checkQuestionConformance(q, blueprint, batch = null) {
  const reasons = [];
  const slot = findBlueprintPart(q, blueprint);
  if (!slot) {
    reasons.push('slot_not_in_blueprint');
    return { ok: false, reasons };
  }

  const { part } = slot;
  const allowed = part.questionTypes || [];
  const type = effectiveType(q);

  if (!typeAllowedForSlot(q, allowed)) {
    reasons.push(`type_not_allowed:${type}:allowed=${allowed.join(',')}`);
  }

  if (type === 'matching' && typeAllowedForSlot(q, allowed)) {
    const slotType = String(part.slotType || part.taskFormat || '').toLowerCase();
    const isPictureMatching = slotType.includes('picture_matching') || slotType.includes('picture_schedule');
    const passageHasPictures =
      batch &&
      (batch.passages || []).some((p) => {
        if (q.passageId && p.id !== q.passageId) return false;
        return Array.isArray(p.pictures) && p.pictures.length >= 9;
      });
    if (!hasNonEmptyOptions(q) && !isPictureMatching && !passageHasPictures) {
      reasons.push('matching_missing_options');
    }
    // Reading only: in Listening, bare labels are speakers ("A", "B", "M") and legitimately bare.
    if (!isPictureMatching && !passageHasPictures && batch && normalizeModuleId(q.module) === 'lesen') {
      const missing = unresolvedBareLabels(q, batch);
      if (missing?.length) reasons.push(`matching_options_without_content:${missing.join('')}`);
    }
    if (isPictureMatching || passageHasPictures) {
      const key = String(q.correct ?? q.correctAnswer ?? '').trim().toLowerCase();
      if (!/^[a-i]$/.test(key)) reasons.push('picture_matching_bad_correct');
    }
  }

  if (type === 'multiple_choice' && typeAllowedForSlot(q, allowed)) {
    if (!hasNonEmptyOptions(q)) reasons.push('options_missing');
    if (!hasCorrect(q)) reasons.push('correct_missing');
  }

  if ((type === 'true_false' || type === 'ja_nein') && typeAllowedForSlot(q, allowed)) {
    if (!hasCorrect(q)) reasons.push('correct_missing');
  }

  if (
    (type === 'short_answer' ||
      type === 'personal_questions' ||
      type === 'about_self' ||
      type === 'plan_together') &&
    typeAllowedForSlot(q, allowed)
  ) {
    if (!q.question && !q.prompt && !q.task) reasons.push('prompt_missing');
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * @param {{ questions?: object[] }} batch
 * @param {object} blueprint
 * @returns {{ ok: boolean, items: { id: string, ok: boolean, reasons: string[] }[] }}
 */
export function checkBatchConformance(batch, blueprint) {
  const items = (batch.questions || []).map((q) => {
    const result = checkQuestionConformance(q, blueprint, batch);
    return { id: q.id || '(no-id)', ok: result.ok, reasons: result.reasons };
  });
  return { ok: items.every((i) => i.ok), items };
}
