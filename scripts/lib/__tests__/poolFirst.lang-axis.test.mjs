/**
 * Pool-first Teile are per-language, and a pool miss must fall back to generation.
 *
 * Guards the two ways this can regress:
 *  1. An unknown lang silently inheriting the Goethe map (CLAUDE.md trap #4).
 *  2. filterPersonalAiChunks dropping a Teil the pool never served, which
 *     leaves a hole in the exam — pickFromLocalSeed returns null on exhaustion
 *     and nothing regenerates it.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PF = require('../../../js/engine/personalLesenPoolFallback.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`OK   ${msg}`);
  } else {
    console.error(`FAIL ${msg}`);
    failures++;
  }
}

const eq = (a, b) => JSON.stringify([...a]) === JSON.stringify([...b]);

// --- 1. per-language slot lists -------------------------------------------

assert(eq(PF.horenPoolFirstTeils('de'), [1, 4]), 'de Hören pool-first stays T1/T4');
assert(eq(PF.lesenPoolFirstTeils('de'), [2]), 'de Lesen pool-first stays T2');
assert(eq(PF.horenPoolFirstTeils('en'), [1, 2, 3, 4]), 'en Listening pool-first covers all 4 Parts');
assert(eq(PF.lesenPoolFirstTeils('en'), [1, 2, 3, 4, 5, 6]), 'en Reading pool-first covers all 6 Parts');

// spec.language carries names, subject codes carry two-letter codes
assert(eq(PF.horenPoolFirstTeils('german'), [1, 4]), 'language name "german" resolves like "de"');
assert(eq(PF.lesenPoolFirstTeils('english'), [1, 2, 3, 4, 5, 6]), 'language name "english" resolves like "en"');

// unknown lang must never inherit the Goethe map
assert(eq(PF.horenPoolFirstTeils('fr'), []), 'unknown lang has no pool-first Hören Teile');
assert(eq(PF.lesenPoolFirstTeils(undefined), []), 'missing lang has no pool-first Lesen Teile');
assert(eq(PF.lesenPoolFirstTeils('es'), []), 'es has no pool-first Teile until DELE ships');

// legacy flat exports still name the Goethe lists
assert(eq(PF.HOREN_POOL_FIRST_TEILS, [1, 4]), 'legacy HOREN_POOL_FIRST_TEILS unchanged');
assert(eq(PF.LESEN_POOL_FIRST_TEILS, [2]), 'legacy LESEN_POOL_FIRST_TEILS unchanged');

// default lang keeps old call sites on the Goethe map
assert(PF.isHorenPoolFirstTeil(1) === true, 'isHorenPoolFirstTeil defaults to de');
assert(PF.isLesenPoolFirstTeil(2) === true, 'isLesenPoolFirstTeil defaults to de');
assert(PF.isLesenPoolFirstTeil(6, 'en') === true, 'en Reading P6 is pool-first');
assert(PF.isLesenPoolFirstTeil(6, 'de') === false, 'de has no Lesen T6');

// --- 2. a pool miss falls back to generation ------------------------------

const enPlan = [1, 2, 3, 4, 5, 6].map((teil) => ({ expectKey: 'lesenParts', teil }));
const enSpec = { skills: ['lesen'], language: 'english' };

const noServedInfo = PF.filterPersonalAiChunks(enPlan, enSpec);
assert(noServedInfo.length === 0, 'without poolServedTeils the static list decides (legacy shape)');

const partiallyServed = PF.filterPersonalAiChunks(enPlan, {
  ...enSpec,
  poolServedTeils: { lesen: [1, 2], horen: [] },
});
assert(
  eq(partiallyServed.map((c) => c.teil), [3, 4, 5, 6]),
  'Teile the pool missed stay on the AI plan instead of vanishing',
);

const allServed = PF.filterPersonalAiChunks(enPlan, {
  ...enSpec,
  poolServedTeils: { lesen: [1, 2, 3, 4, 5, 6], horen: [] },
});
assert(allServed.length === 0, 'a fully served module costs no generation');

const noneServed = PF.filterPersonalAiChunks(enPlan, {
  ...enSpec,
  poolServedTeils: { lesen: [], horen: [] },
});
assert(noneServed.length === 6, 'an empty pool degrades to full generation, not a broken exam');

// German keeps its behaviour when the pool serves what it always served
const dePlan = [1, 2, 3, 4, 5].map((teil) => ({ expectKey: 'lesenParts', teil }));
const deServed = PF.filterPersonalAiChunks(dePlan, {
  skills: ['lesen'],
  language: 'german',
  poolServedTeils: { lesen: [2], horen: [] },
});
assert(eq(deServed.map((c) => c.teil), [1, 3, 4, 5]), 'de Lesen still sends 4 Teile to the AI');

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall pool-first lang-axis assertions passed');
