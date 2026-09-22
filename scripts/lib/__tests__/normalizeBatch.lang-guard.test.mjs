/**
 * normalizeBatch.lang-guard.test.mjs
 * Regression: German noun-capitalization must NOT run on non-German batches.
 * (docs/audit/gates-en-applicability.md, riesgos activos #1 y #2)
 * Run:  node scripts/lib/__tests__/normalizeBatch.lang-guard.test.mjs
 */
import { normalizeBatch } from '../normalizeBatch.mjs';

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  OK   ${desc}`); passed++; }
  else { console.error(`  FAIL ${desc}`); failed++; }
}

// 1) English text must be left untouched (no Team/Job/Meeting capitalization).
const enText = 'i have a meeting with my team about the computer problem';
const en = normalizeBatch(
  { passages: [{ id: 'p1', text: enText }], questions: [] },
  { module: 'lesen', teil: 3, lang: 'en', level: 'B1' },
);
assert('EN passage text unchanged (no de capitalization)', en.passages[0].text === enText);

// 2) Spanish likewise untouched.
const esText = 'tengo una reunion con mi equipo sobre el problema';
const es = normalizeBatch(
  { passages: [{ id: 'p1', text: esText }], questions: [] },
  { module: 'lesen', teil: 1, lang: 'es', level: 'B1' },
);
assert('ES passage text unchanged', es.passages[0].text === esText);

// 3) German still capitalizes nouns (behavior preserved).
const de = normalizeBatch(
  { passages: [{ id: 'p1', text: 'ich habe ein meeting mit meinem team' }], questions: [] },
  { module: 'lesen', teil: 2, lang: 'de', level: 'B1' },
);
assert('DE still capitalizes (Meeting/Team)', /Meeting/.test(de.passages[0].text) && /Team/.test(de.passages[0].text));

// 4) No lang provided defaults to German (historical behavior).
const def = normalizeBatch(
  { passages: [{ id: 'p1', text: 'ich habe ein team' }], questions: [] },
  { module: 'lesen', teil: 2 },
);
assert('default (no lang) => de capitalization', /Team/.test(def.passages[0].text));

// 5) An English headline title must not be forced onto matching text as a "proper name".
// The restore step copied "The Green Valley Music Festival" into the passage, capitalizing
// the article after a cloze gap (quarantined batch lesen-t5-cloze-music-festival-02).
const titleText = 'I decided to (1) ______ the Green Valley Music Festival. It was a family trip to the mountains.';
const enTitled = normalizeBatch(
  {
    passages: [
      { id: 'p1', title: 'The Green Valley Music Festival', text: titleText },
      { id: 'p2', title: 'A Family Trip to the Mountains', text: 'x' },
    ],
    questions: [],
  },
  { module: 'lesen', teil: 5, lang: 'en', level: 'B1' },
);
assert('EN title casing not copied into passage text', enTitled.passages[0].text === titleText);

// 6) Cambridge Speaking: four parts stay four, keep short_answer and their English guidance.
// The Goethe path capped teil at 3, retyped to planungsaufgabe/praesentation and swapped the
// explanation for the German rubric (quarantined batch sprechen-speaking-free-time-01).
const spQ = [1, 2, 3, 4].map((t) => ({
  id: `en-b1-s-t${t}-x-q1`, module: 'sprechen', type: 'short_answer',
  question: `Part ${t} task`, explanation: `In Part ${t}, talk about it.`,
}));
const enSp = normalizeBatch({ questions: spQ }, { module: 'sprechen', lang: 'en', level: 'B1' });
assert('EN sprechen keeps teils 1-4', enSp.questions.map((q) => q.teil).join('') === '1234');
assert('EN sprechen keeps short_answer', enSp.questions.every((q) => q.type === 'short_answer'));
assert('EN sprechen keeps English explanation', enSp.questions[3].explanation === 'In Part 4, talk about it.');
const enSpTagged = normalizeBatch(
  { questions: [{ ...spQ[0], topicTags: ['t-en-b1-socializing-and-relationships'] }] },
  { module: 'sprechen', lang: 'en', level: 'B1' },
);
assert('EN sprechen topicTags not mapped to Goethe topics', !/Freizeit|Medien/.test(JSON.stringify(enSpTagged.questions[0].topicTags)));

const enW = normalizeBatch(
  { questions: [1, 2].map((t) => ({ id: `en-b1-w-t${t}-x-q1`, module: 'schreiben', type: 'short_answer', question: 'Write.', explanation: `Part ${t} guidance.` })) },
  { module: 'schreiben', lang: 'en', level: 'B1' },
);
assert('EN schreiben keeps English explanation', enW.questions[1].explanation === 'Part 2 guidance.');

// 6b) English Lesen keeps its language marker through the pool-legacy strip; without it
// audit-pass-2 (inferAuditLang) judged the normalized batch against the Goethe blueprint.
const enLesen = normalizeBatch(
  { passages: [{ id: 'p1', text: 'x' }], questions: [{ id: 'en-b1-r-t1-x-q1', type: 'multiple_choice', question: 'x', options: ['a) 1', 'b) 2', 'c) 3'], correct: 'a', passageId: 'p1' }] },
  { module: 'lesen', teil: 1, lang: 'en', level: 'B1' },
);
assert('EN lesen keeps language marker', enLesen.questions[0].language === 'en');
assert('EN sprechen stamped examType cambridge', enSp.questions.every((q) => q.examType === 'cambridge'));

// 7) German Speaking still gets the Goethe taxonomy (behavior preserved).
const deSp = normalizeBatch(
  { questions: [1, 2, 3].map((t) => ({ id: `gen-q-sp-t${t}-x`, module: 'sprechen', type: 'short_answer', question: 'x', explanation: 'x' })) },
  { module: 'sprechen', lang: 'de', level: 'B1' },
);
assert('DE sprechen still retyped', deSp.questions.every((q) => q.type !== 'short_answer'));

console.log(`\nnormalizeBatch lang-guard: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
