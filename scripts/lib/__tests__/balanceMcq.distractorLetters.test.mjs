/**
 * balanceMcq must move EVERY option letter the explanation names, not only the key's.
 * Before: rotateToTarget resynced only the key letter, and only in "Option a" form, so
 * "They don't discuss the weather (a)" kept pointing at the old slot after a shuffle.
 *
 * Run: node scripts/lib/__tests__/balanceMcq.distractorLetters.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  balanceMcqGroup,
  assertBalanceMcqWriterContract,
  remapExplanationOptionLetters,
  findExplanationLetterRefs,
  stripMcqOptionLabel,
} from '../balanceMcq.mjs';

const require = createRequire(import.meta.url);
const { balanceAnswerPositions } = require('../../../js/engine/prompts/partPostprocess.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`OK: ${name}`); };

/** Every letter ref must name the same option body before and after. */
function refsNameSameBodies(before, after) {
  const rb = findExplanationLetterRefs(before.explanation);
  const ra = findExplanationLetterRefs(after.explanation);
  assert.equal(ra.length, rb.length, 'ref count');
  const body = (q, l) => stripMcqOptionLabel(q.options[l.charCodeAt(0) - 97]);
  rb.forEach((r, i) => assert.equal(body(after, ra[i].letter), body(before, r.letter), `ref ${i} (${r.raw}→${ra[i].raw})`));
}

const mk = (id, options, correct, explanation) => ({ id, type: 'multiple_choice', options, correct, correctAnswer: correct, explanation });

ok('remap is one pass: a→b, b→c, c→a do not chain', () => {
  assert.equal(
    remapExplanationOptionLetters('Not (a), not (b), so (c).', { a: 'b', b: 'c', c: 'a' }),
    'Not (b), not (c), so (a).',
  );
});

ok('remap keeps case and covers Option/Antwort/ist-korrekt forms', () => {
  assert.equal(
    remapExplanationOptionLetters('Option A is wrong; die Option b) passt; c ist korrekt.', { a: 'c', b: 'a', c: 'b' }),
    'Option C is wrong; die Option a) passt; b ist korrekt.',
  );
});

ok('"Option (a)" is rewritten once, not twice', () => {
  assert.equal(remapExplanationOptionLetters('Option (a) fits.', { a: 'b', b: 'c' }), 'Option (b) fits.');
});

ok('"Option für" is German prose, not option f (found in library/de/B1)', () => {
  assert.equal(findExplanationLetterRefs('als zusätzliche Option für die Reise genannt').length, 0);
});

ok('English "(x)" distractor refs follow their options through balanceMcqGroup', () => {
  // Six items all keyed "a" so the balancer must move most of them.
  const qs = Array.from({ length: 6 }, (_, i) =>
    mk(`q${i}`, ['a) The cost', 'b) The weather', 'c) The distance'], 'a',
      "They complain about the cost (a). They don't discuss the weather (b) and the distance (c) is fine."),
  );
  const out = balanceMcqGroup(qs, { seed: 'distractor-en' });
  assert.ok(out.some((q) => q.correct !== 'a'), 'balancer moved something');
  out.forEach((q, i) => refsNameSameBodies(qs[i], q));
});

ok('four-option items (Cambridge Reading P5): "Option d" follows too', () => {
  const qs = Array.from({ length: 6 }, (_, i) =>
    mk(`q${i}`, ['a) designed', 'b) drawn', 'c) invented', 'd) discovered'], 'a',
      'Option a is the collocation; option d means found for the first time.'),
  );
  const out = balanceMcqGroup(qs, { seed: 'four-opt' });
  assert.ok(out.some((q) => q.correct !== 'a'));
  out.forEach((q, i) => refsNameSameBodies(qs[i], q));
});

ok('key-only German explanation: same result as the old key-only resync', () => {
  const qs = Array.from({ length: 6 }, (_, i) =>
    mk(`q${i}`, ['a) Im Park', 'b) Im Kino', 'c) Zu Hause'], 'a', 'Der Sprecher sagt es: Option a) ist richtig.'),
  );
  const out = balanceMcqGroup(qs, { seed: 'de-key-only' });
  out.forEach((q) => assert.equal(q.explanation, `Der Sprecher sagt es: Option ${q.correct}) ist richtig.`));
});

ok('contract (d) rejects an explanation whose distractor letter went stale', () => {
  const before = [mk('q', ['a) X', 'b) Y', 'c) Z'], 'a', 'X is right (a); Y (b) is not.')];
  // What the old code produced: key moved a→b, options rotated, "(b)" left pointing at the old Y slot.
  const after = [mk('q', ['a) Z', 'b) X', 'c) Y'], 'b', 'X is right (b); Y (b) is not.')];
  assert.throws(() => assertBalanceMcqWriterContract(before, after), /contract:d/);
});

ok('runtime balanceAnswerPositions ({key,text}, uppercase keys) remaps distractors', () => {
  const q = {
    type: 'multiple_choice',
    options: [{ key: 'A', text: 'The cost' }, { key: 'B', text: 'The weather' }, { key: 'C', text: 'The distance' }],
    correct: 'C',
    explanation: 'Not the cost (A) nor the weather (B): the distance (C).',
  };
  balanceAnswerPositions([q]); // first MCQ → target index 0, so C moves to A, A→B, B→C
  assert.equal(q.correct, 'A');
  const byKey = Object.fromEntries(q.options.map((o) => [o.key, o.text]));
  assert.equal(q.explanation, 'Not the cost (B) nor the weather (C): the distance (A).');
  assert.equal(byKey.A, 'The distance');
  assert.equal(byKey.B, 'The cost');
  assert.equal(byKey.C, 'The weather');
});

console.log(`\n${n} passed`);
