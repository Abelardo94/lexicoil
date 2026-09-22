/**
 * germanCapsNormalize.mjs — post-generation, pre-audit German capitalization layer.
 *
 * Stable baseline: v3.0-stable (G2 Iteration 3, 2026-07-08). See GERMAN-CAPS-NORMALIZE.md.
 *
 * Does NOT modify pos-caps-check / v6.1-B-G2. Applies deterministic fixes only:
 *   0. stripMarkdownLeakInBatch (passages + questions[].question)
 *   1. decapitalizeMidSentence (adj/adv/homograph/article+adj)
 *   2. capitalizeNounsInText via capitalizeBatchNouns
 *   3. normalizeBatchMcqOptionCapitalization
 *   4. dedupeBatchMcqOptionLetterPrefixes (always — MCQ a)/b)/c) double-prefix safety net)
 */

/** Stable implementation tag — bump when guards change so poolReadyCheck restamps. */
export const GERMAN_CAPS_NORMALIZE_VERSION = 'v3.23-lesen-t2-angebote-corpus-2026-07-28';
import {
  decapitalizeBatchMidSentence,
  capitalizeBatchNouns,
} from './capitalizeNouns.mjs';
import { normalizeBatchMcqOptionCapitalization, dedupeBatchMcqOptionLetterPrefixes } from './normalizeMcq.mjs';
import { stripMarkdownLeakInBatch } from './stripMarkdownLeak.mjs';
import { collectDocumentProperNames, restoreProperNamesInBatch } from './institutionProperNameGuard.mjs';

const TOKEN_RE = /([A-Za-zÄÖÜäöüß]+(?:-[A-Za-zÄÖÜäöüß]+)*)|([^A-Za-zÄÖÜäöüß]+)/g;

const TEXT_PATHS = [
  ['passages', 'text'],
  ['passages', 'title'],
  ['passages', 'transcript'],
  ['passages', 'ads'],
  ['passages', 'audio', 'text'],
  ['questions', 'question'],
  ['questions', 'signText'],
  ['questions', 'explanation'],
  ['questions', 'statement'],
  ['questions', 'matchLabels'],
  ['questions', 'options'],
];

function tokenize(text) {
  const tokens = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) tokens.push(m[0]);
  return tokens;
}

function diffTokenChanges(before, after, ctx) {
  if (before === after) return [];
  const bt = tokenize(before);
  const at = tokenize(after);
  const changes = [];
  if (bt.length !== at.length) {
    changes.push({ kind: 'rewrite', path: ctx, before: before.slice(0, 120), after: after.slice(0, 120) });
    return changes;
  }
  for (let i = 0; i < bt.length; i++) {
    if (bt[i] !== at[i]) {
      changes.push({ kind: 'token', path: ctx, from: bt[i], to: at[i], index: i });
    }
  }
  return changes;
}

function walkBatchStrings(batch, visitor, prefix = '') {
  if (!batch || typeof batch !== 'object') return;
  (batch.passages || []).forEach((p, pi) => {
    const base = `${prefix}passages[${pi}]`;
    if (typeof p.text === 'string') visitor(`${base}.text`, p.text);
    if (typeof p.title === 'string') visitor(`${base}.title`, p.title);
    if (typeof p.transcript === 'string') visitor(`${base}.transcript`, p.transcript);
    if (Array.isArray(p.ads)) {
      p.ads.forEach((ad, ai) => {
        if (typeof ad === 'string') visitor(`${base}.ads[${ai}]`, ad);
      });
    }
    if (Array.isArray(p.audio)) {
      p.audio.forEach((turn, ti) => {
        if (turn?.text) visitor(`${base}.audio[${ti}].text`, turn.text);
      });
    }
  });
  (batch.questions || []).forEach((q, qi) => {
    const base = `${prefix}questions[${qi}]`;
    for (const key of ['question', 'signText', 'explanation', 'statement']) {
      if (typeof q[key] === 'string') visitor(`${base}.${key}`, q[key]);
    }
    if (Array.isArray(q.matchLabels)) {
      q.matchLabels.forEach((l, li) => {
        if (typeof l === 'string') visitor(`${base}.matchLabels[${li}]`, l);
      });
    }
    if (Array.isArray(q.options)) {
      q.options.forEach((opt, oi) => {
        if (typeof opt === 'string') visitor(`${base}.options[${oi}]`, opt);
        else if (opt?.text) visitor(`${base}.options[${oi}].text`, opt.text);
      });
    }
  });
}

/** Collect all German text fields from a Lesen batch. */
export function collectLesenTextFields(batch) {
  const fields = [];
  walkBatchStrings(batch, (path, value) => fields.push({ path, value }));
  return fields;
}

/**
 * Apply the full caps normalization pipeline to a batch.
 * @returns {{ batch, stats, changes }}
 */
export function applyGermanCapsNormalize(batch, opts = {}) {
  if (!batch || typeof batch !== 'object') {
    return { batch, stats: { markdownFixed: 0, decapFixed: 0, capFixed: 0, fieldsChanged: 0 }, changes: [] };
  }

  const beforeMap = new Map();
  walkBatchStrings(batch, (path, value) => beforeMap.set(path, value));
  const documentProperNames = collectDocumentProperNames(batch);

  // Steps 1 and 2 encode GERMAN orthography (mid-sentence decap + noun capitalization) and
  // this module has no language awareness of its own — it works off a fixed German noun list.
  // Running them on English silently capitalizes common nouns ("the Bus back to school").
  // Risk #1 in docs/audit/gates-en-applicability.md. Absent lang still means German, which is
  // the historical default asserted by normalizeBatch.lang-guard.test.mjs. The
  // language-neutral steps (markdown strip, MCQ prefix dedupe) run for every language.
  const germanCaps = String(opts.lang || 'de').trim().toLowerCase() === 'de';

  const { batch: stripped, totalFixed: markdownFixed } = stripMarkdownLeakInBatch(batch);
  const { batch: decapped, totalFixed: decapFixed } = germanCaps
    ? decapitalizeBatchMidSentence(stripped)
    : { batch: stripped, totalFixed: 0 };
  let current = decapped;
  let capFixed = 0;
  if (germanCaps && !opts.decapOnly) {
    const capped = capitalizeBatchNouns(current);
    current = capped.batch;
    capFixed = capped.totalFixed;
  }
  const normalized = opts.decapOnly ? current : normalizeBatchMcqOptionCapitalization(current);
  const { batch: dedupedRaw, fixed: dedupeFixed } = dedupeBatchMcqOptionLetterPrefixes(normalized);
  // The restore undoes the German decap heuristics above, so it only applies when they ran.
  // It treats passages[0].title as a proper name and forces its casing case-insensitively
  // across the batch; an English headline ("The Green Valley Music Festival") then turned
  // "decided to (1) ______ the Green Valley" into "…______ The Green Valley".
  const deduped = germanCaps ? restoreProperNamesInBatch(dedupedRaw, documentProperNames) : dedupedRaw;

  const changes = [];
  walkBatchStrings(deduped, (path, after) => {
    const before = beforeMap.get(path);
    if (before == null || before === after) return;
    changes.push(...diffTokenChanges(before, after, path));
  });

  const stats = {
    markdownFixed,
    decapFixed,
    capFixed,
    dedupeFixed,
    fieldsChanged: new Set(changes.map((c) => c.path)).size,
    tokenChanges: changes.filter((c) => c.kind === 'token').length,
  };

  if (opts.log && (stats.markdownFixed || stats.decapFixed || stats.capFixed || stats.dedupeFixed)) {
    console.log(
      `  [germanCapsNormalize] markdown=${stats.markdownFixed} decap=${stats.decapFixed} cap=${stats.capFixed} dedupe=${stats.dedupeFixed} fields=${stats.fieldsChanged}`,
    );
  }

  // Always stamp so poolReady / audits know which rule version touched the batch.
  // Generation used to skip stamping → disk looked "never normalized" after skip-pool-ready.
  deduped._germanCapsNormalizeVersion = GERMAN_CAPS_NORMALIZE_VERSION;
  deduped._germanCapsNormalizedAt = new Date().toISOString();

  return { batch: deduped, stats, changes };
}

export { TEXT_PATHS };
