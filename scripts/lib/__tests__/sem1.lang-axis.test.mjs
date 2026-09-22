/**
 * SEM-1 is per-language: the Goethe format rules and the two miscalibrated
 * checks must not reach Cambridge content, and German must stay untouched.
 *
 * Guards three regressions:
 *  1. The prompt announcing the wrong exam board (it judged Cambridge as Goethe).
 *  2. "distractor" / "template" leaking into an English verdict — measured as
 *     16 of 21 findings on the en/B1 seed, none of them a real defect.
 *  3. An unparseable LLM answer counting as a clean part (fail-open).
 */
import {
  buildPromptForPart,
  validatePartSemantics,
  clearSemanticCache,
  _setLlmFn,
} from '../semanticValidator.mjs';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`OK   ${msg}`);
  else { console.error(`FAIL ${msg}`); failures++; }
}

const mcqPart = (lang, teil = 1) => ({
  id: `test-${lang}-t${teil}`,
  lang,
  level: 'B1',
  module: 'lesen',
  teil,
  passage: { title: 'T', text: 'The pool reopens on Thursday morning after repairs.' },
  questions: [
    {
      id: 'q1',
      type: 'multiple_choice',
      question: 'When does the pool reopen?',
      options: ['a) Thursday', 'b) Monday', 'c) Never'],
      correct: 'a',
    },
  ],
});

// --- 1. the prompt names the right board -----------------------------------

const pDe = buildPromptForPart(mcqPart('de'));
const pEn = buildPromptForPart(mcqPart('en'));

assert(/Goethe B1/.test(pDe), 'de prompt names Goethe');
assert(/Teil/.test(pDe), 'de prompt says Teil');
assert(/Cambridge B1 Preliminary/.test(pEn), 'en prompt names Cambridge');
assert(/Part /.test(pEn), 'en prompt says Part');
assert(!/Goethe/.test(pEn), 'en prompt never mentions Goethe');

// --- 2. the two miscalibrated checks are de-only ---------------------------

assert(/3\. "distractor"/.test(pDe), 'de keeps the distractor check');
assert(/4\. "template"/.test(pDe), 'de keeps the template check');
// The words still appear in en — in the instruction telling the model NOT to
// raise them. What must be gone is the numbered check that asks for them.
assert(!/3\. "distractor"/.test(pEn), 'en prompt drops the distractor check');
assert(!/4\. "template"/.test(pEn), 'en prompt drops the template check');
assert(/NO generes issues de tipo "distractor" ni "template"/.test(pEn), 'en prompt says so explicitly');
assert(/themeTags/.test(pEn), 'en still returns themeTags for cross-part repetition');

// The prompt is not a contract — a model that emits them anyway must be filtered.
async function verdictFor(lang, issues) {
  clearSemanticCache();
  _setLlmFn(async () => ({ text: JSON.stringify({ themeTags: ['a', 'b', 'c'], issues }) }));
  return validatePartSemantics(mcqPart(lang, lang === 'de' ? 1 : 2), { skipTemplate: true });
}

const noisy = [
  { kind: 'distractor', itemId: 'q1', detail: 'opción c absurda', confidence: 1 },
  { kind: 'template', itemId: 'passage', detail: 'molde repetitivo', confidence: 1 },
];

const enNoisy = await verdictFor('en', noisy);
assert(enNoisy.issues.length === 0, 'en drops distractor/template even when the model emits them');
assert(enNoisy.ok === true, 'en part with only miscalibrated findings passes');

const deNoisy = await verdictFor('de', noisy);
assert(deNoisy.issues.length === 2, 'de keeps both kinds');
assert(deNoisy.ok === false, 'de part with those findings still blocks');

// Real defects survive the filter in both languages.
const real = [{ kind: 'correctness', itemId: 'q1', detail: 'clave sin apoyo', confidence: 1 }];
const enReal = await verdictFor('en', real);
assert(enReal.issues.length === 1 && enReal.ok === false, 'en still blocks on correctness');

const enAmb = await verdictFor('en', [
  { kind: 'ambiguity', itemId: 'q1', detail: 'opción b defendible', confidence: 1 },
]);
assert(enAmb.issues.length === 1 && enAmb.ok === false, 'en still blocks on ambiguity');

// --- 3. an unreadable answer must not read as clean ------------------------

clearSemanticCache();
_setLlmFn(async () => ({ text: '{ "themeTags": ["notices", "publ' })); // truncated
const truncated = await validatePartSemantics(mcqPart('en', 3), { skipTemplate: true });
assert(truncated.ok === false, 'a truncated answer fails closed');
assert(
  (truncated.issues || []).some((i) => i.kind === 'llm_error'),
  'a truncated answer is reported as llm_error, not silence',
);

_setLlmFn(null);

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nall SEM-1 lang-axis assertions passed');
