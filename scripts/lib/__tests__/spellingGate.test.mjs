#!/usr/bin/env node
/**
 * The spelling gate, sabotaged on purpose.
 *
 * The first version of this gate reported a clean tree while 40 of the 45
 * American spellings sat in answer options: its walker recursed into arrays but
 * dropped any element that was not an object, so it never read a single option.
 * A gate that cannot fail is worse than no gate, so every case here plants a
 * defect somewhere real and asserts it is found — and plants correct British
 * English and asserts it is NOT flagged.
 *
 *   node scripts/lib/__tests__/spellingGate.test.mjs
 */
import assert from 'node:assert/strict';
import { findAmerican, findAmbiguous, toBritish, matchCase, mapStrings } from '../britishSpelling.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

/** Shaped like a real curated exam: options and ads are arrays of plain strings. */
const fixture = () => ({
  id: 'cur-en-B1-e00-lesen-t2-deadbeef',
  lang: 'en',
  passage: { title: 'Day Trips', text: 'The Science Discovery Centre is open.' },
  questions: [{
    id: 'ql_en-b1-r-t2-notices-center-01-q1',
    question: 'Which place suits them?',
    options: [
      'A) The Mountain Adventure Centre — high-energy activities.',
      'B) The jewelry shop on the high street.',
    ],
    explanation: 'The colorful market is nearby.',
  }],
  segments: [{ id: 'seg-1', transcript: 'I realized the theater was closed.' }],
});

console.log('spellingGate\n');

test('encuentra las formas americanas dentro de arrays de opciones', () => {
  const found = [];
  mapStrings(fixture(), (v) => { found.push(...findAmerican(v)); return null; });
  assert.ok(found.includes('jewelry'), 'no miro dentro de options[] — el fallo original');
});

test('encuentra las formas americanas en transcripciones y explicaciones', () => {
  const found = [];
  mapStrings(fixture(), (v) => { found.push(...findAmerican(v)); return null; });
  assert.ok(found.includes('realized'), 'no miro la transcripcion');
  assert.ok(found.includes('theater'), 'no miro la transcripcion entera');
  assert.ok(found.includes('colorful'), 'no miro explanation');
});

test('no marca las formas britanicas correctas', () => {
  const found = [];
  mapStrings(fixture(), (v) => { found.push(...findAmerican(v)); return null; });
  assert.ok(!found.some((w) => /centre/i.test(w)), 'marco "Centre", que es la forma correcta');
});

test('no confunde "laboratory" con "labor"', () => {
  assert.deepEqual(findAmerican('The laboratory and the laboratories are open.'), []);
});

test('"practice" es sustantivo britanico correcto: se reporta, no se marca', () => {
  assert.deepEqual(findAmerican('Football practice is at six.'), []);
  assert.deepEqual(findAmbiguous('Football practice is at six.'), ['practice']);
});

test('no cuenta "organizers" dos veces', () => {
  assert.deepEqual(findAmerican('The organizers arrived.'), ['organizers']);
});

test('no toca los identificadores', () => {
  const doc = fixture();
  mapStrings(doc, (v) => toBritish(v).text);
  assert.equal(doc.id, 'cur-en-B1-e00-lesen-t2-deadbeef', 'reescribio el id de la parte');
  assert.equal(doc.questions[0].id, 'ql_en-b1-r-t2-notices-center-01-q1',
    'reescribio el id de la pregunta — romperia las referencias y las marcas del muestreo');
});

test('la correccion respeta las mayusculas', () => {
  assert.equal(matchCase('Center', 'centre'), 'Centre');
  assert.equal(matchCase('GRAY', 'grey'), 'GREY');
  assert.equal(matchCase('center', 'centre'), 'centre');
  assert.equal(toBritish('Center and center and GRAY').text, 'Centre and centre and GREY');
});

test('la correccion arregla de verdad el arbol saboteado', () => {
  const doc = fixture();
  mapStrings(doc, (v) => toBritish(v).text);
  const left = [];
  mapStrings(doc, (v) => { left.push(...findAmerican(v)); return null; });
  assert.deepEqual(left, [], `quedaron formas americanas: ${left.join(', ')}`);
  assert.equal(doc.questions[0].options[1], 'B) The jewellery shop on the high street.');
  assert.equal(doc.segments[0].transcript, 'I realised the theatre was closed.');
});

console.log(`\n${passed} de 9 pruebas en verde.`);
if (process.exitCode) console.error('HAY FALLOS');
