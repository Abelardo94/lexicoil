#!/usr/bin/env node
/**
 * El gate de basura de plantilla, saboteado a propósito.
 *
 * El defecto real: 175 anuncios del Teil 3 de de/B1 terminaban en
 * "Stichworte: <lemas flojos>." — un hueco de plantilla en español dentro de
 * contenido de examen alemán. Los exámenes servidos estaban limpios, así que no
 * saltó nada: solo aparecía en los exámenes ENSAMBLADOS DESDE EL BANCO, que es
 * la ruta personalizada.
 *
 *   node scripts/lib/__tests__/contentPlaceholders.test.mjs
 */
import assert from 'node:assert/strict';
import { findDebris, mapStrings, stripTrailingSlot } from '../contentPlaceholders.mjs';

let passed = 0;
const total = 8;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const AD = 'A) Tierpension — Pflege Ihres Hundes im Urlaub, 18 Euro pro Tag. Stichworte: <lemas flojos>.';

console.log('contentPlaceholders\n');

test('encuentra el marcador real de los anuncios', () => {
  const d = findDebris(AD);
  assert.equal(d.length, 1);
  assert.equal(d[0].text, '<lemas flojos>');
});

test('lo encuentra dentro de arrays de opciones, que es donde estaba', () => {
  const doc = { questions: [{ id: 'q1', options: ['A) bien.', AD] }] };
  const found = [];
  mapStrings(doc, (v) => { found.push(...findDebris(v)); return null; });
  assert.equal(found.length, 1, 'no miró dentro de options[]');
});

test('encuentra TODO, llaves y lorem', () => {
  assert.equal(findDebris('TODO: escribir esto').length, 1);
  assert.equal(findDebris('Hola {{nombre}}').length, 1);
  assert.equal(findDebris('Lorem ipsum dolor').length, 1);
});

test('no marca el marcado HTML legítimo', () => {
  assert.deepEqual(findDebris('Escribe <b>algo</b> aquí'), []);
  assert.deepEqual(findDebris('Primera línea<br>segunda'), []);
});

test('no marca texto normal con signos de menor que', () => {
  assert.deepEqual(findDebris('5 < 7 y 9 > 3'), []);
});

test('la limpieza deja el anuncio intacto', () => {
  assert.equal(
    stripTrailingSlot(AD),
    'A) Tierpension — Pflege Ihres Hundes im Urlaub, 18 Euro pro Tag.',
  );
});

test('la limpieza NO toca un marcador en mitad de la frase', () => {
  // Ahí la frase nunca se escribió y un script no puede inventarla: tiene que
  // salir en el informe como no reparable, no desaparecer en silencio.
  const roto = 'A) Kurs — <tema> jeden Montag um 18 Uhr.';
  assert.equal(stripTrailingSlot(roto), roto);
  assert.equal(findDebris(stripTrailingSlot(roto)).length, 1);
});

test('no toca los identificadores', () => {
  const doc = { id: 'cur-de-B1-<x>', questions: [{ id: 'q<1>', question: AD }] };
  mapStrings(doc, (v) => stripTrailingSlot(v));
  assert.equal(doc.id, 'cur-de-B1-<x>');
  assert.equal(doc.questions[0].id, 'q<1>');
});

console.log(`\n${passed} de ${total} pruebas en verde.`);
if (process.exitCode) console.error('HAY FALLOS');
