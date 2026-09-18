#!/usr/bin/env node
/**
 * mapWithConcurrency: orden, tope de paralelismo y, sobre todo, fail-closed.
 *
 * Este ayudante se usa para leer blobs en el verificador que decide si producción
 * coincide con la semilla. Si al fallar una lectura devolviera resultados
 * parciales, el verificador reportaría "todo coincide" sobre datos que no llegó a
 * leer — exactamente el tipo de verde silencioso que este repo ya ha pagado caro.
 *
 *   node scripts/lib/__tests__/mapWithConcurrency.test.mjs
 */
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../mapWithConcurrency.mjs';

let passed = 0;
const total = 7;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('mapWithConcurrency\n');

await test('conserva el orden aunque terminen desordenados', async () => {
  const items = [30, 5, 20, 1];
  const out = await mapWithConcurrency(items, 4, async (n) => { await tick(n); return n; });
  assert.deepEqual(out, [30, 5, 20, 1]);
});

await test('no supera el tope de concurrencia', async () => {
  let live = 0, peak = 0;
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    live++; peak = Math.max(peak, live);
    await tick(5);
    live--;
  });
  assert.ok(peak <= 4, `llegó a ${peak} en paralelo, el tope era 4`);
  assert.ok(peak > 1, 'no paralelizó nada');
});

await test('lanza el error del PRIMER item, no del primero en fallar', async () => {
  // El item 3 falla rápido y el 1 falla lento: debe ganar el 1.
  const err = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
    if (n === 3) { await tick(1); throw new Error('tarde-pero-rapido'); }
    if (n === 1) { await tick(40); throw new Error('primero'); }
    return n;
  }).then(() => null, (e) => e);
  assert.equal(err?.message, 'primero');
});

await test('deja de programar trabajo nuevo tras un fallo', async () => {
  let started = 0;
  await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 2, async (n) => {
    started++;
    if (n === 0) { await tick(5); throw new Error('boom'); }
    await tick(5);
  }).catch(() => {});
  assert.ok(started < 50, `arrancó los 50 pese al fallo (${started})`);
});

await test('no deja rechazos sin capturar', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  await mapWithConcurrency([1, 2, 3, 4], 4, async (n) => {
    await tick(n * 3);
    throw new Error(`fallo-${n}`);
  }).catch(() => {});
  await tick(60);
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], `hubo ${unhandled.length} rechazos sin capturar`);
});

await test('nunca devuelve resultados parciales cuando algo falla', async () => {
  const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('no');
    return n;
  }).then((r) => r, () => 'lanzó');
  assert.equal(out, 'lanzó', 'devolvió un array en vez de lanzar: un verificador lo leería como completo');
});

await test('lista vacía devuelve lista vacía', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});

console.log(`\n${passed} de ${total} pruebas en verde.`);
if (process.exitCode) console.error('HAY FALLOS');
