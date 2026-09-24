#!/usr/bin/env node
/**
 * Quick tests for blueprintConformance.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkQuestionConformance } from './lib/blueprintConformance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assert(label, cond) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
  console.log('OK:', label);
}

const blueprint = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'library/blueprints/goethe_B1.json'), 'utf8'),
);

const matchingNoOpts = {
  id: 'test-h4-match-no-opts',
  module: 'horen',
  teil: 4,
  type: 'matching',
  question: 'Wer sagt das?',
  correct: 'A',
  options: [],
};

const r1 = checkQuestionConformance(matchingNoOpts, blueprint);
assert(
  'Hören T4 matching sin options → matching_missing_options',
  !r1.ok && r1.reasons.includes('matching_missing_options'),
);

const gapFillT4 = {
  id: 'note1-test',
  module: 'horen',
  teil: 4,
  type: 'gap_fill',
  question: 'Farbe der Tonne:',
  correct: 'orange',
  options: [],
};

const r2 = checkQuestionConformance(gapFillT4, blueprint);
assert(
  'Hören T4 gap_fill → type_not_allowed',
  !r2.ok && r2.reasons.some((x) => x.startsWith('type_not_allowed:gap_fill')),
);

const matchingOk = {
  id: 'test-h4-match-ok',
  module: 'horen',
  teil: 4,
  type: 'matching',
  question: 'Wer sagt das?',
  correct: 'A',
  options: ['A', 'B', 'M'],
};

const r3 = checkQuestionConformance(matchingOk, blueprint);
assert('Hören T4 matching con 3 options → pasa', r3.ok && r3.reasons.length === 0);

// Reading matching whose options are bare labels: the letters must point at real content.
const cambridgeB1 = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'library/blueprints/cambridge_B1.json'), 'utf8'),
);
const LETTERS = 'ABCDEFGH'.split('');
const bareOpts = LETTERS.map((L) => `${L.toLowerCase()}) ${L}`);
const gapped = (passages) => ({
  passages,
  questions: [{ id: 'test-r4-q1', module: 'lesen', teil: 4, type: 'matching', passageId: 'p-r4',
    question: 'Which sentence (A-H) best fits gap 1?', correct: 'A', options: bareOpts }],
});
const checkR = (batch) => checkQuestionConformance(batch.questions[0], cambridgeB1, batch);

// the Gemini Flash batch of 24 sep 2026: sentences A-H nowhere, options "a) A"
const r4 = checkR(gapped([{ id: 'p-r4', text: 'We went to the market. (GAP 1) _______. It was fun.' }]));
assert('Reading P4 con opciones "a) A" y sin frases → matching_options_without_content',
  !r4.ok && r4.reasons.includes('matching_options_without_content:ABCDEFGH'));

const r5 = checkR(gapped([{ id: 'p-r4', text: 'Text (GAP 1) ___.\n\n' + LETTERS.slice(0, 7).map((L) => `${L}) Sentence ${L}.`).join('\n') }]));
assert('Reading P4 con una frase ausente (H) → la señala', !r5.ok && r5.reasons.includes('matching_options_without_content:H'));

const r6 = checkR(gapped([{ id: 'p-r4', text: 'Text (GAP 1) ___.\n\n' + LETTERS.map((L) => `${L}) Sentence ${L}.`).join('\n') }]));
assert('Reading con las 8 etiquetas en el texto → pasa', r6.ok);

const byTitle = gapped(LETTERS.map((L, i) => ({ id: `p-courses-0${i + 1}`, title: `${L}. Course ${L}`, text: `About course ${L}.` })));
byTitle.questions[0].passageId = 'p-courses-01';
const r7 = checkR(byTitle);
assert('Reading P2 con un pasaje por texto y la letra en el título → pasa', r7.ok);

const byIdSuffix = gapped(LETTERS.map((L) => ({ id: `p-match-${L}`, text: `Text ${L}.` })));
byIdSuffix.questions[0].passageId = 'p-match-A';
assert('Reading P2 con un pasaje por texto "…-A".."…-H" → pasa', checkR(byIdSuffix).ok);

const r9 = checkR(gapped([{ id: 'p-r4', text: 'Text (GAP 1) ___.' }]));
const withSentences = { ...gapped([{ id: 'p-r4', text: 'Text (GAP 1) ___.' }]) };
withSentences.questions[0].options = LETTERS.map((L) => `${L.toLowerCase()}) ${L}. A full sentence ${L}.`);
assert('Reading P4 con las frases dentro de las opciones → pasa', !r9.ok && checkR(withSentences).ok);

console.log('\nAll blueprint conformance tests passed.\n');
