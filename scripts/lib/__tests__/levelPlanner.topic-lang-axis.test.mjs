/**
 * levelPlanner.topic-lang-axis.test.mjs
 * Regression: el eje de temas tiene que seguir al idioma.
 *
 * Antes, topicsForLevel/normalizeTopicForLevel no tenian eje de idioma y devolvian
 * siempre B1_TOPICS (aleman). La piscina inglesa se planificaba contra Reisen,
 * Gesundheit, Arbeit..., y el alias aleman mapea `travel` -> `Reisen`, asi que un
 * tema ingles legitimo acababa convertido en aleman.
 *
 * Lo que se protege aqui son las dos direcciones: que el ingles use su lista, y que
 * pedir sin idioma siga dando exactamente el aleman de antes.
 *
 * Run:  node scripts/lib/__tests__/levelPlanner.topic-lang-axis.test.mjs
 */
import { topicsForLevel, normalizeTopicForLevel } from '../levelPlanner.mjs';

let passed = 0;
let failed = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  OK   ${desc}`); passed++; } else { console.error(`  FAIL ${desc}`); failed++; }
}

// 1) Sin idioma: aleman, igual que siempre. Es el caso de todos los llamadores viejos.
const def = topicsForLevel('B1');
assert('sin lang -> lista alemana', def.includes('Reisen') && def.includes('Gesundheit'));
assert('sin lang -> no cuela ingles', !def.includes('Travel'));

// 2) lang de explicito: identico a no pasar nada.
assert(
  'lang "de" identico a omitirlo',
  JSON.stringify(topicsForLevel('B1', { lang: 'de' })) === JSON.stringify(def),
);

// 3) lang en: lista inglesa, y ni un solo tema aleman dentro.
const en = topicsForLevel('B1', { lang: 'en' });
assert('lang "en" -> lista inglesa', en.includes('Travel') && en.includes('City life'));
assert('lang "en" -> sin temas alemanes', !en.some((t) => ['Reisen', 'Gesundheit', 'Arbeit', 'Ernährung'].includes(t)));
assert('las dos listas miden igual (espejo 1 a 1)', en.length === def.length);

// 4) El nucleo del bug: "travel" en ingles NO puede volverse "Reisen".
assert('normalize en: travel -> Travel', normalizeTopicForLevel('B1', 'travel', 'en') === 'Travel');
assert('normalize de: travel -> Reisen (alias aleman intacto)', normalizeTopicForLevel('B1', 'travel', 'de') === 'Reisen');
assert('normalize sin lang: travel -> Reisen', normalizeTopicForLevel('B1', 'travel') === 'Reisen');

// 5) Etiquetas reales de los lotes ingleses que habia sin clasificar.
assert('normalize en: school_life -> Education', normalizeTopicForLevel('B1', 'school_life', 'en') === 'Education');
assert('normalize en: gym -> Health', normalizeTopicForLevel('B1', 'gym', 'en') === 'Health');

// 6) Un tema aleman pedido como ingles no se cuela: mejor sin etiqueta que mal etiquetado.
assert('normalize en: Reisen -> null', normalizeTopicForLevel('B1', 'Reisen', 'en') === null);

// 7) A2 aleman sigue con sus 5 ejes Goethe, que es otra rama de la misma funcion.
const a2 = topicsForLevel('A2', { scope: 'gap' });
assert('A2 gap sigue siendo el eje Goethe (no B1)', a2.length > 0 && !a2.includes('Travel'));

console.log(`\n${passed} OK · ${failed} FAIL`);
process.exit(failed ? 1 : 0);
