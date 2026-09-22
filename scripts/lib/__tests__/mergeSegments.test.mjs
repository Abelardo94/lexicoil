#!/usr/bin/env node
/**
 * mergeSegments: el emparejamiento de segmentos entre semilla y blob.
 *
 * El fallo real: 35 partes horen-t1-gemini-* tienen todos sus segmentos con
 * `id: null`. El emparejamiento solo por id los descartaba a todos, devolvía el
 * segmento del blob intacto, y el push escribía el blob sobre sí mismo
 * informando "✓ Actualizado". La divergencia sobrevivía a cada push, para
 * siempre, sin que nada lo dijera.
 *
 *   node scripts/lib/__tests__/mergeSegments.test.mjs
 */
import assert from 'node:assert/strict';
import { buildUpdatedPayload } from '../mergeSeedBlobPayload.mjs';
import { comparePayloadSemantic } from '../verifyBlobContent.mjs';

let passed = 0;
const total = 8;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

/**
 * El caso real: mismas opciones barajadas y la MISMA respuesta correcta, solo
 * que en otra letra. mergeOneQuestion rechaza —con razón— cualquier fusión que
 * cambie el texto de la respuesta correcta, así que el fixture tiene que
 * conservarlo o estaríamos probando otra cosa.
 */
const BLOB_OPTS = ['A) uno', 'B) dos'];   // correcta "uno" = A
const SEED_OPTS = ['A) dos', 'B) uno'];   // correcta "uno" = b

const seg = (id, correct, options) => ({
  id,
  transcript: 'Guten Tag.',
  questions: [{ id: 'q1', type: 'multiple', question: '¿?', correct, correctAnswer: correct, options }],
});
const blobSeg = (id) => seg(id, 'A', BLOB_OPTS);
const seedSeg = (id) => seg(id, 'b', SEED_OPTS);
const part = (segments) => ({ id: 'p1', module: 'horen', teil: 1, segments });

console.log('mergeSegments\n');

test('empareja por id cuando lo hay', () => {
  const out = buildUpdatedPayload(part([blobSeg('s1')]), part([seedSeg('s1')]));
  assert.equal(out.segments[0].questions[0].correct, 'b');
});

test('con id null empareja por posición — el fallo de los 35 horen-t1-gemini-*', () => {
  const out = buildUpdatedPayload(part([blobSeg(null)]), part([seedSeg(null)]));
  assert.equal(
    out.segments[0].questions[0].correct, 'b',
    'el segmento del blob volvió intacto: el push escribiría lo mismo y diría que lo actualizó',
  );
});

test('varios segmentos con id null se emparejan en orden', () => {
  const out = buildUpdatedPayload(
    part([blobSeg(null), blobSeg(null), blobSeg(null)]),
    part([seedSeg(null), seedSeg(null), seedSeg(null)]),
  );
  assert.deepEqual(out.segments.map((x) => x.questions[0].correct), ['b', 'b', 'b']);
});

test('si el número de segmentos no coincide NO se empareja por posición', () => {
  // Sin ids y con longitudes distintas no se puede saber qué segmento es cuál:
  // dejar el blob como está es lo correcto, alinear a ciegas sería inventar.
  const out = buildUpdatedPayload(part([blobSeg(null), blobSeg(null)]), part([seedSeg(null)]));
  assert.equal(out.segments.length, 2);
  assert.equal(out.segments[0].questions[0].correct, 'A', 'alineó a ciegas con distinto número de segmentos');
  assert.equal(out.segments[1].questions[0].correct, 'A');
});

test('no se inventa segmentos que el blob no tiene', () => {
  const out = buildUpdatedPayload(part([]), part([seedSeg(null)]));
  assert.deepEqual(out.segments, []);
});

// El otro lado del mismo fallo: el verificador. mergeSegments y
// segmentsContentEqual tienen que estar de acuerdo sobre que es "igual", o el
// que empuja y el que verifica dicen cosas distintas del mismo dato.

test('el verificador NO marca divergencia sobre segmentos identicos con id null', () => {
  const p = part([seedSeg(null), seedSeg(null)]);
  const r = comparePayloadSemantic(p, JSON.parse(JSON.stringify(p)));
  assert.equal(r.hasRealDiff, false, `marco ${JSON.stringify(r.realFields)} sobre payloads identicos`);
});

test('el verificador SI ve una divergencia real con id null', () => {
  const r = comparePayloadSemantic(part([seedSeg(null)]), part([blobSeg(null)]));
  assert.equal(r.hasRealDiff, true, 'no vio una divergencia real por no emparejar los segmentos');
});

test('verificador y fusionador coinciden tras fusionar', () => {
  const esperado = buildUpdatedPayload(part([blobSeg(null), blobSeg(null)]), part([seedSeg(null), seedSeg(null)]));
  assert.equal(comparePayloadSemantic(esperado, esperado).hasRealDiff, false);
});

console.log(`\n${passed} de ${total} pruebas en verde.`);
if (process.exitCode) console.error('HAY FALLOS');
