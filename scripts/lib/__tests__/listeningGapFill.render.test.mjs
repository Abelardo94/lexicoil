/**
 * listeningGapFill.render.test.mjs
 *
 * Regression, found running the app against en/B1 (not by reading code):
 * Cambridge Listening Part 3 is sentence completion — gap_fill items with an empty option
 * pool. renderGoetheHorenPart sends every question straight to renderQ, and renderQ's
 * "no options" branch printed a dead grey line instead of an input, so six of the 25
 * listening questions could not be answered in any of the three English exams. The line
 * also read "Keine Optionen": the isOff flag it keyed off means "official exam", not
 * "German", and every caller passes a hardcoded true.
 *
 * Runs the REAL renderQ out of examRunner.js in a vm, same slicing trick as
 * scripts/test-exam-runner-render.mjs, so the assertions cannot drift from the source.
 *
 * Run:  node scripts/lib/__tests__/listeningGapFill.render.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const {
  isAnswerKeyRenderable,
  optKey,
  normalizeGradingToken,
  getRenderableAnswerKeys,
} = require(path.join(ROOT, 'js/engine/validation/isAnswerKeyRenderable.js'));

function loadRenderQ(lang) {
  const src = fs.readFileSync(path.join(ROOT, 'js/ui/exam/examRunner.js'), 'utf8');
  const helpers = src.slice(src.indexOf('function esc(s)'), src.indexOf('function renderGoetheHorenPart'));
  const renderers = src.slice(src.indexOf('const _akr = typeof IsAnswerKeyRenderable'), src.indexOf('function updProg()'));
  const sandbox = {
    console,
    IsAnswerKeyRenderable: { isAnswerKeyRenderable, optKey, normalizeGradingToken, getRenderableAnswerKeys },
    wrapW: (t) => String(t || ''),
    lcDebug: { warn() {} },
    S: { answers: {}, examData: { lang } },
  };
  vm.createContext(sandbox);
  vm.runInContext(helpers + renderers, sandbox);
  return sandbox;
}

let passed = 0;
let failed = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  OK   ${desc}`); passed++; }
  else { console.error(`  FAIL ${desc}`); failed++; }
}

const gapQ = {
  id: '14',
  number: 14,
  type: 'gap_fill',
  question: 'The departure time from the school is 7:30 [gap].',
  correct: 'am',
  options: [],
};
const mcqNoOpts = { id: '9', number: 9, type: 'multiple_choice', question: 'Broken item', correct: 'A', options: [] };

// ── the English exam ───────────────────────────────────────────────────────
const en = loadRenderQ('en');
const html = en.renderQ(gapQ, 14, 'horen_2_0', 'True', 'False', 'R', true, {});

assert('sentence completion renders a text input', /<input[^>]+type="text"[^>]+class="gap-input"/.test(html));
assert('no dead "no options" line', !/Keine Optionen/.test(html) && !/No options/.test(html));
assert('the sentence itself stays visible', html.includes('The departure time from the school is 7:30'));
assert('the item keeps its number', html.includes('14.'));
assert(
  'the answer is stored under the same key the grader reads (mod_id)',
  html.includes('S.answers["horen_2_0_14"]') || html.includes("S.answers['horen_2_0_14']"),
);
assert('the typed answer is trimmed like the open-cloze input', /\.value\.trim\(\)/.test(html));
assert('progress is updated so the item counts', html.includes('updProg()'));

// A previously typed answer must survive a re-render.
en.S.answers['horen_2_0_14'] = 'am';
assert('a saved answer comes back in the input', /value="am"/.test(en.renderQ(gapQ, 14, 'horen_2_0', 'True', 'False', 'R', true, {})));

// The dead line still exists for genuinely broken items — but in English now.
const brokenEn = en.renderQ(mcqNoOpts, 9, 'horen_1', 'True', 'False', 'R', true, {});
assert('a real option-less MCQ still reports it, in English', brokenEn.includes('No options') && !brokenEn.includes('Keine Optionen'));

// ── German must not move ───────────────────────────────────────────────────
const de = loadRenderQ('de');
const brokenDe = de.renderQ(mcqNoOpts, 9, 'horen_1', 'Richtig', 'Falsch', 'R', true, {});
assert('German still says "Keine Optionen"', brokenDe.includes('Keine Optionen'));

const mcq = {
  id: '1', number: 1, type: 'multiple_choice', question: 'Was ist richtig?', correct: 'A',
  options: [{ key: 'A', text: 'eins' }, { key: 'B', text: 'zwei' }],
};
assert(
  'a normal MCQ is untouched (radios, no input)',
  /type="radio"/.test(de.renderQ(mcq, 1, 'horen_1', 'Richtig', 'Falsch', 'R', true, {})) &&
    !/gap-input/.test(de.renderQ(mcq, 1, 'horen_1', 'Richtig', 'Falsch', 'R', true, {})),
);

// ── the content this was found on ──────────────────────────────────────────
const exams = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/exams/en_B1.json'), 'utf8'));
const p3Items = exams.flatMap((e) =>
  (e.horenParts || [])
    .filter((p) => Number(p.teil) === 3)
    .flatMap((p) => [...(p.questions || []), ...((p.segments || []).flatMap((s) => s.questions || []))]),
);
// Six gaps per exam; the count was hard-coded to 18 (three exams) and broke on the fourth.
assert(
  `en/B1 Listening Part 3 still ships sentence completion (${p3Items.length} items, ${exams.length} exams)`,
  p3Items.length === exams.length * 6,
);
assert('every one of them is gap_fill with an empty pool', p3Items.every((q) => q.type === 'gap_fill' && !(q.options || []).length));
assert('all of them render an input', p3Items.every((q) => /class="gap-input"/.test(en.renderQ(q, q.number, 'horen_2_0', 'True', 'False', 'R', true, {}))));

// No German UI words left in the English exam content (the segment labels said "Aufnahme").
const enRaw = fs.readFileSync(path.join(ROOT, 'data/exams/en_B1.json'), 'utf8');
assert('no German labels left in en/B1 content', !/Aufnahme/.test(enRaw));

console.log(`\nlistening gap fill render: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
