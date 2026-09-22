#!/usr/bin/env node
/**
 * The open-cloze gate, sabotaged on purpose.
 *
 * Reading Part 6 has no options, and the engine has no support for alternative
 * accepted answers (there is no `acceptedAnswers` anywhere in js/engine or the
 * functions), so a gap whose key is a content word cannot be marked at all:
 * "we ___ a compromise" takes made, reached and came to. en/B1 shipped five of
 * them. Two survived a first pass because they were classified by eye as
 * "forced in practice" — they were not, and it was this gate that kept saying so.
 *
 *   node scripts/lib/__tests__/openClozeGate.test.mjs
 */
import assert from 'node:assert/strict';
import { isFunctionWord, isOpenCloze, WEAK } from '../openClozeGaps.mjs';
import { openClozeParts } from '../../audit-en-open-cloze-gaps.mjs';

let passed = 0;
const total = 8;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('openClozeGate\n');

test('rechaza las cinco claves lexicas que venian servidas', () => {
  for (const key of ['made', 'lots', 'spending']) {
    assert.equal(isFunctionWord(key), false, `"${key}" deberia marcarse como lexica`);
  }
});

test('acepta las claves gramaticales que las sustituyeron', () => {
  for (const key of ['a', 'to', 'in', 'that', 'with']) {
    assert.equal(isFunctionWord(key), true, `"${key}" es funcional y deberia pasar`);
  }
});

test('acepta las gramaticales que ya estaban bien', () => {
  for (const key of ['for', 'at', 'the', 'on', 'every', 'another', 'who', 'whose', 'because', 'before', 'will']) {
    assert.equal(isFunctionWord(key), true, `"${key}" deberia pasar`);
  }
});

test('"never" pasa el gate pero queda marcado como flojo', () => {
  // Es funcional, asi que no bloquea; pero "I had ___ worked ... before" admite
  // "not" igual de bien, y por eso tiene que salir en la lista de releer.
  assert.equal(isFunctionWord('never'), true);
  assert.equal(WEAK.has('never'), true, 'never deberia estar en WEAK');
});

test('no le afectan espacios ni mayusculas', () => {
  assert.equal(isFunctionWord('  The '), true);
  assert.equal(isFunctionWord('MADE'), false);
});

test('reconoce el Part 6 por module+teil', () => {
  assert.equal(isOpenCloze({ module: 'lesen', teil: 6 }), true);
  assert.equal(isOpenCloze({ module: 'lesen', teil: 5 }), false);
  assert.equal(isOpenCloze({ module: 'horen', teil: 6 }), false);
});

test('reconoce el Part 6 por el slot del blueprint', () => {
  assert.equal(isOpenCloze({ blueprintSlot: 'lesen_t6_open_cloze' }), true);
  assert.equal(isOpenCloze({ slotType: 'open_cloze' }), true);
  assert.equal(isOpenCloze({ blueprintSlot: 'lesen_t5_cloze_mcq' }), false);
});

test('encuentra las partes de open cloze anidadas', () => {
  const doc = { exam: { lesenParts: [
    { module: 'lesen', teil: 5, questions: [{ id: 'a', correct: 'b' }], passage: { text: 'x' } },
    { module: 'lesen', teil: 6, questions: [{ id: 'b', correct: 'made' }], passage: { text: 'y' } },
  ] } };
  const found = [...openClozeParts(doc)];
  assert.equal(found.length, 1, 'deberia encontrar solo la de Part 6');
  assert.equal(found[0].questions[0].id, 'b');
});

console.log(`\n${passed} de ${total} pruebas en verde.`);
if (process.exitCode) console.error('HAY FALLOS');
