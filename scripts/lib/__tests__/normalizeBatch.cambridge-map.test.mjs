/**
 * normalizeBatch.cambridge-map.test.mjs
 * Etapa 2 EN: coerceGeneratedLesenPart must enforce the Cambridge B1 Reading
 * Teil->questionType map for lang 'en', keep Goethe map for 'de', and leave
 * other langs untouched. (docs/audit/gates-en-applicability.md, riesgo #2)
 * Run:  node scripts/lib/__tests__/normalizeBatch.cambridge-map.test.mjs
 */
import { coerceGeneratedLesenPart, normalizeBatch } from '../normalizeBatch.mjs';

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  OK   ${desc}`); passed++; }
  else { console.error(`  FAIL ${desc}`); failed++; }
}

function mkBatch(type) {
  return {
    passages: [{ id: 'p1', text: 'Sample passage text for the test.' }],
    questions: [{ id: 'q1', type, prompt: 'Q?', options: ['a) one', 'b) two', 'c) three'], correct: 'a' }],
  };
}

// EN: Cambridge map enforced per Teil
const enExpect = { 1: 'multiple_choice', 2: 'matching', 3: 'multiple_choice', 4: 'matching', 5: 'multiple_choice', 6: 'gap_fill' };
for (const [teil, want] of Object.entries(enExpect)) {
  const out = coerceGeneratedLesenPart(mkBatch('short_answer'), { teil: Number(teil), lang: 'en', level: 'B1' });
  assert(`EN T${teil} coerced to ${want}`, out.questions[0].type === want);
}

// DE: Goethe map still applies (T3 matching per TEIL_QUESTION_TYPE)
const de = coerceGeneratedLesenPart(mkBatch('multiple_choice'), { teil: 3, lang: 'de', level: 'B1' });
assert('DE T3 keeps Goethe map (matching)', de.questions[0].type === 'matching');

// ES: no map forced, generated type preserved
const es = coerceGeneratedLesenPart(mkBatch('short_answer'), { teil: 3, lang: 'es', level: 'B1' });
assert('ES type untouched', es.questions[0].type === 'short_answer');

// Productive modules: fallback explanation and Speaking type follow the language.
// Before 23 sep 2026 every en batch got the Goethe line "Bewertung: Inhalt vollständig…"
// and Speaking kept Gemini's type "rubric" (audit CHK-1 critical).
function mkProductive(module, teil, extra = {}) {
  return {
    passages: [],
    questions: [{ id: `x-t${teil}-q1`, module, teil, question: 'Task prompt.', correct: 'rubric', explanation: '', ...extra }],
  };
}
const enSp = normalizeBatch(mkProductive('sprechen', 2, { type: 'rubric' }), { lang: 'en', level: 'B1', module: 'sprechen' });
assert('EN sprechen rubric -> short_answer', enSp.questions.every((x) => x.type === 'short_answer'));
assert('EN sprechen fallback explanation is English', enSp.questions.every((x) => !/Bewertung/.test(x.explanation)));
const enSch = normalizeBatch(mkProductive('schreiben', 2, { type: 'short_answer' }), { lang: 'en', level: 'B1', module: 'schreiben' });
assert('EN schreiben fallback explanation is English', enSch.questions.every((x) => x.explanation && !/Bewertung/.test(x.explanation)));
const deSch = normalizeBatch(mkProductive('schreiben', 2, { type: 'short_answer' }), { lang: 'de', level: 'B1', module: 'schreiben' });
assert('DE schreiben keeps German explanation', deSch.questions.every((x) => /Bewertung/.test(x.explanation)));

console.log(`\nnormalizeBatch cambridge-map: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
