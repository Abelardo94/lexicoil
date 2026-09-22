#!/usr/bin/env node
/**
 * The duplicate-option gate, sabotaged on purpose.
 *
 * The defect it exists for is `ql_en-b1-r-t5-cloze-cooking-class-01-q1`:
 * ["a) knew", "b) know", "c) knew", "d) known"] with key "c". Two options were
 * the same word, so a candidate who picked "a) knew" wrote the right answer and
 * was marked wrong. It sat in production through a SEM-1 pass that reported two
 * other findings in the same exam, and through a blind human sample — a reader
 * picks the right word and moves on without re-reading the option list.
 *
 *   node scripts/lib/__tests__/duplicateOptionsGate.test.mjs
 */
import assert from 'node:assert/strict';
import { optionBody, duplicateGroups, questionsWithOptions } from '../../audit-en-duplicate-options.mjs';

let passed = 0;
const total = 7;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('duplicateOptionsGate\n');

test('encuentra el defecto real de cooking-class-q1', () => {
  const dups = duplicateGroups(['a) knew', 'b) know', 'c) knew', 'd) known']);
  assert.equal(dups.length, 1);
  assert.equal(dups[0][0], 'knew');
  assert.deepEqual(dups[0][1].map((h) => h.i), [0, 2]);
});

test('no marca opciones distintas', () => {
  assert.deepEqual(duplicateGroups(['a) knowing', 'b) know', 'c) knew', 'd) known']), []);
});

test('la etiqueta no cuenta: "a) knew" y "c) knew" son la misma opcion', () => {
  assert.equal(optionBody('a) knew'), 'knew');
  assert.equal(optionBody('C. Knew'), 'knew');
  assert.equal(optionBody('b - knew'), 'knew');
});

test('no confunde por espacios ni mayusculas', () => {
  assert.equal(duplicateGroups(['a) a wide range', 'b)  A WIDE  RANGE ']).length, 1);
});

test('ignora las opciones vacias', () => {
  assert.deepEqual(duplicateGroups(['a) ', 'b) ', 'c) uno']), []);
});

test('recorre preguntas anidadas dentro de segments y parts', () => {
  const doc = {
    exam: {
      lesenParts: [{ questions: [{ id: 'q1', options: ['a) x', 'b) x'] }] }],
      horenParts: [{ segments: [{ questions: [{ id: 'q2', options: ['a) y', 'b) z'] }] }] }],
    },
  };
  const found = [...questionsWithOptions(doc)].map(([, q]) => q.id);
  assert.deepEqual(found.sort(), ['q1', 'q2'], 'no encontro las preguntas anidadas');
});

test('acepta opciones como objetos {text}', () => {
  assert.equal(duplicateGroups([{ text: 'a) knew' }, { text: 'c) knew' }]).length, 1);
});

console.log(`\n${passed} de ${total} pruebas en verde.`);
if (process.exitCode) console.error('HAY FALLOS');
