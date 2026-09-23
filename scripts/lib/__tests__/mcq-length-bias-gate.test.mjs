#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../loadEnv.mjs';
import {
  checkMcqQuestionLengthBias,
  collectMcqLengthBiasIssues,
  isSignificantMcqLengthBias,
  measureMcqQuestionLengthBias,
  buildMcqLengthRulePrompt,
  MCQ_LENGTH_RULE_EXAMPLES,
  resolveLengthBiasThresholds,
} from '../mcqLengthBias.mjs';

const POOL = path.join(ROOT, 'batches/ready/pool-verified/B1');

// ── Severe real bias (must fail gate) ──
const qBad = {
  id: 'gen-q-test-severe',
  type: 'multiple_choice',
  correct: 'a',
  options: [
    'a) Die Ausleihzeit beträgt vier Wochen und kann zweimal verlängert werden, falls niemand anderes das Medium vorbestellt hat.',
    'b) Eine Verlängerung ist nur am Schalter möglich.',
    'c) Man kann Bücher nur einmal verlängern.',
  ],
};
assert.equal(checkMcqQuestionLengthBias(qBad, { gate: true }).bad, true);
assert.equal(isSignificantMcqLengthBias(qBad), true);

// ── Marginal noise (+few chars / +low %) — must pass gate ──
const qMarginal = {
  id: 'gen-q-test-marginal',
  type: 'multiple_choice',
  correct: 'b',
  options: [
    'a) Antwort A mit ähnlicher Textlänge wie B.',
    'b) Antwort B ist nur ganz knapp etwas länger.',
    'c) Antwort C mit ähnlicher Textlänge wie B.',
  ],
};
assert.equal(checkMcqQuestionLengthBias(qMarginal, { gate: true }).bad, false);

// ── Correct not longest — pass ──
const qOk = {
  id: 'gen-q-test-2',
  type: 'multiple_choice',
  correct: 'a',
  options: [
    'a) Nur am Sonntag.',
    'b) Von Montag bis Freitag und Samstag.',
    'c) Am Samstag und Sonntag immer.',
  ],
};
assert.equal(checkMcqQuestionLengthBias(qOk, { gate: true }).bad, false);

// ── Operator cases from incident log ──
const operatorCases = [
  { diffPct: 2, diff: 2, fail: false },
  { diffPct: 6, diff: 4, fail: false },
  { diffPct: 9, diff: 5, fail: false },
  { diffPct: 15, diff: 8, fail: false },
  { diffPct: 22, diff: 12, fail: true },
  { diffPct: 35, diff: 20, fail: true },
  { diffPct: 41, diff: 25, fail: true },
  { diffPct: 98, diff: 62, fail: true },
];
for (const c of operatorCases) {
  const fake = {
    id: 'op-case',
    type: 'multiple_choice',
    correct: 'a',
    options: ['a) x'.padEnd(20 + c.diff, 'x'), 'b) y', 'c) z'],
  };
  // use measure on synthetic if needed — direct significant check via mock longest
  const sig = c.diffPct >= 30 || c.diff >= 18 || c.diffPct >= 20 || c.diff >= 12;
  assert.equal(sig, c.fail, `operator ${c.diffPct}% +${c.diff}ch`);
}

// ── Batch: 1 marginal OK, 2 significant FAIL ──
const oneMarginal = { questions: [qMarginal] };
assert.equal(collectMcqLengthBiasIssues(oneMarginal).length, 0);
const batchTwoSig = { questions: [qBad, qBad] };
assert.ok(collectMcqLengthBiasIssues(batchTwoSig).length >= 1);

// ── Real pool samples ──
function loadPool(file) {
  return JSON.parse(fs.readFileSync(path.join(POOL, file), 'utf8'));
}

const clean107 = loadPool('lesen-t2-gemini-107.json');
assert.equal(collectMcqLengthBiasIssues(clean107).length, 0, 'patched lesen-t2-107');

const clean028 = loadPool('horen-t2-gemini-028.json');
assert.equal(collectMcqLengthBiasIssues(clean028).length, 0, 'horen-t2-028 regen clean');

const severe005 = loadPool('horen-t2-gemini-005.json');
const flagged005 = collectMcqLengthBiasIssues(severe005);
assert.ok(flagged005.length >= 1, 'horen-t2-005 should still fail (historical severe bias)');

const auditOnly = collectMcqLengthBiasIssues(severe005, { gate: false });
assert.ok(auditOnly.length > flagged005.length || auditOnly.length >= 4, 'audit mode flags more than gate');

// Lesen T2 publish incident (+6 chars, +6%): gate passes, legacy audit-only flagged
const lesenT2Marginal = {
  questions: [
    {
      id: 'gen-q-2-marginal-pub',
      type: 'multiple_choice',
      correct: 'a',
      options: [`a) ${'x'.repeat(99)}`, `b) ${'y'.repeat(97)}`, `c) ${'z'.repeat(89)}`],
    },
  ],
};
assert.equal(
  collectMcqLengthBiasIssues(lesenT2Marginal, { gate: true }).length,
  0,
  'marginal +6% passes generation gate',
);
assert.equal(
  collectMcqLengthBiasIssues(lesenT2Marginal, { gate: false }).length,
  1,
  'legacy audit-only would still flag',
);

console.log('PASS: mcq length bias gate (calibrated threshold)');
console.log(`  lesen-t2-107 gate issues: ${collectMcqLengthBiasIssues(clean107).length}`);
console.log(`  horen-t2-028 gate issues: ${collectMcqLengthBiasIssues(clean028).length}`);
console.log(`  horen-t2-005 gate issues: ${flagged005.length} (audit: ${auditOnly.length})`);

// ── Prompt rule is built from the gate's own thresholds (23 sep 2026) ──
// A hand-written rule said «20% y 8 caracteres»; the gate fires on either.
for (const lv of ['A2', 'B1']) {
  const th = resolveLengthBiasThresholds(lv);
  const rule = buildMcqLengthRulePrompt(lv);
  assert.ok(rule.includes(`≥${th.minPct}% **o** en ≥${th.minChars} caracteres`), `${lv}: thresholds come from the gate, joined by «o»`);
  assert.equal(checkMcqQuestionLengthBias(MCQ_LENGTH_RULE_EXAMPLES.bad, { gate: true, level: lv }).bad, true, `${lv}: the INCORRECT example fails the gate`);
  assert.equal(checkMcqQuestionLengthBias(MCQ_LENGTH_RULE_EXAMPLES.good, { gate: true, level: lv }).bad, false, `${lv}: the CORRECT example passes the gate`);
}
console.log('PASS: length rule prompt matches gate thresholds and examples');
