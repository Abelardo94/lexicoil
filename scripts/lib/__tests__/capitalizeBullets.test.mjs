/**
 * A bullet at the start of a line starts a sentence. Schreiben A2 T2 prompts
 * list their Leitpunkte as «\n• Fragen Sie …»; after «… möchten.» the scanner
 * read modal + «Fragen» and blocked schreiben-gemini-058 (23 sep 2026).
 */
import assert from 'node:assert/strict';
import { scanP2CapitalizationViolations } from '../capitalizeNouns.mjs';

const blocks = (t) => scanP2CapitalizationViolations(t).filter((v) => v.severity === 'block').map((v) => `${v.type}:${v.word}`);

assert.deepEqual(blocks('Sagen Sie, dass Sie eine Begleitung mitbringen möchten.\n• Fragen Sie nach dem Weg.'), [], '• bullet after a modal');
assert.deepEqual(blocks('Bestätigen Sie den Termin\n• Fragen Sie, was Sie mitbringen sollen.'), [], '• bullet, no period before');
assert.deepEqual(blocks('Punkte:\n- Fragen Sie nach dem Preis.'), [], '- bullet');
assert.deepEqual(blocks('Wir sollen Fragen.'), ['modal_infinitive:Fragen'], 'real error still caught');
assert.deepEqual(blocks('Sie müssen • Fragen.'), ['modal_infinitive:Fragen'], 'a bullet mid-line is not a line start');

console.log('PASS: bullets at line start begin a sentence');
