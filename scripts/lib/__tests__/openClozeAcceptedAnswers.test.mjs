#!/usr/bin/env node
/**
 * Cambridge Reading Part 6 (open cloze) accepts more than one word in some gaps: "who"/"whom",
 * "because"/"as"/"since". The engine only compared against `correct`, so a learner who wrote
 * a right word was marked wrong. Items now list the others in `acceptedAnswers`.
 *
 *   node scripts/lib/__tests__/openClozeAcceptedAnswers.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AKR = require(path.join(ROOT, 'js/engine/validation/isAnswerKeyRenderable.js'));

const slice = (file, from, to) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${file}: ${from} … ${to}`);
  return src.slice(a, b);
};

const sandbox = { console, IsAnswerKeyRenderable: AKR, normalizeGradingToken: AKR.normalizeGradingToken };
vm.createContext(sandbox);
vm.runInContext(slice('js/ui/exam/examRunner.js', 'function goetheAnswersMatch', 'function togglePersonMatch'), sandbox);
vm.runInContext(slice('js/ui/exam/results.js', 'const OPTION_LETTER_TYPES', 'function countSpeakExchanges'), sandbox);
const { goetheAnswersMatch, acceptedAnswerMatch, correctLabel } = sandbox;
const marks = (user, q) => goetheAnswersMatch(user, q.correct) || acceptedAnswerMatch(user, q);

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const gap = { id: 'g', type: 'gap_fill', options: [], correct: 'because', acceptedAnswers: ['as', 'since'] };

test('the key still marks right', () => assert.equal(marks('because', gap), true));
test('an accepted alternative marks right (case and spaces ignored)', () => {
  assert.equal(marks('as', gap), true);
  assert.equal(marks('  Since ', gap), true);
});
test('a word outside the list still marks wrong', () => assert.equal(marks('so', gap), false));
test('an empty answer never matches an accepted list', () => {
  assert.equal(marks('', { ...gap, acceptedAnswers: ['', null] }), false);
});
test('without acceptedAnswers nothing changes', () => {
  const plain = { ...gap, acceptedAnswers: undefined };
  assert.equal(marks('as', plain), false);
  assert.equal(marks('because', plain), true);
});
test('an option-letter item ignores a stray acceptedAnswers', () => {
  const mcq = { type: 'multiple_choice', options: ['a) x', 'b) y'], correct: 'a', acceptedAnswers: ['b'] };
  assert.equal(marks('b', mcq), false);
});
test('the correction shows every accepted word', () => {
  assert.equal(correctLabel(gap, false), 'because / as / since');
  assert.equal(correctLabel({ ...gap, acceptedAnswers: ['Because', 'as'] }, false), 'because / as');
});

const exSandbox = { console };
vm.createContext(exSandbox);
for (const f of ['js/library/ExamBlueprint.js', 'js/library/ExamBuilder.js']) {
  vm.runInContext(`var toExamQuestion_${path.basename(f, '.js')} = (function(){ ${slice(f, 'function toExamQuestion', '\n  function ')}; return toExamQuestion; })();`, exSandbox);
}
test('both exam builders keep acceptedAnswers', () => {
  for (const k of ['toExamQuestion_ExamBlueprint', 'toExamQuestion_ExamBuilder']) {
    const out = exSandbox[k](gap, 0);
    assert.deepEqual([...out.acceptedAnswers], ['as', 'since'], k);
  }
});

// Data: only gap items carry the field, never the key again, never empty.
const files = [
  ...fs.readdirSync(path.join(ROOT, 'library/curated/en/B1')).filter((f) => f.endsWith('.json')).map((f) => `library/curated/en/B1/${f}`),
  'library/pool-seed/en_B1.json',
  'library/en/B1/questions.json',
];
test('served en/B1 data: acceptedAnswers only on gap items, non-empty, never the key', () => {
  let n = 0;
  for (const f of files) {
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') {
      if ('acceptedAnswers' in o) {
        n++;
        assert.ok(['gap_fill', 'gap'].includes(o.type), `${f} ${o.id}: ${o.type}`);
        assert.ok(Array.isArray(o.acceptedAnswers) && o.acceptedAnswers.length, `${f} ${o.id}`);
        for (const a of o.acceptedAnswers) {
          assert.ok(typeof a === 'string' && a.trim(), `${f} ${o.id}`);
          assert.notEqual(a.toLowerCase(), String(o.correct).toLowerCase(), `${f} ${o.id}: repeats the key`);
        }
      }
      Object.values(o).forEach(walk); } };
    walk(JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  }
  assert.equal(n, 27, 'nine gaps × three copies (curated, pool-seed, bank)');
});

console.log(`\n${passed} passed`);
