#!/usr/bin/env node
/**
 * Deterministic render test — forum_opinions Ja/Nein + ads_matching keys in items[].
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isAnswerKeyRenderable,
  optKey,
  normalizeGradingToken,
  getRenderableAnswerKeys,
} = require('../js/engine/validation/isAnswerKeyRenderable.js');

function loadRunnerRender() {
  const src = fs.readFileSync(path.join(ROOT, 'js/ui/exam/examRunner.js'), 'utf8');
  const start = src.indexOf('function esc(s)');
  const lesenEnd = src.indexOf('function renderGoetheHorenPart');
  const foreachStart = src.indexOf('function forEachGoetheLesenItems');
  const foreachEnd = src.indexOf('function forEachGoetheNotes');
  const optKeyStart = src.indexOf('const _akr = typeof IsAnswerKeyRenderable');
  const setRFEnd = src.indexOf('function updProg()');
  const fnBlock =
    src.slice(start, lesenEnd) +
    src.slice(foreachStart, foreachEnd) +
    src.slice(optKeyStart, setRFEnd);
  const sandbox = {
    console,
    IsAnswerKeyRenderable: { isAnswerKeyRenderable, optKey, normalizeGradingToken, getRenderableAnswerKeys },
    wrapW: (t) => String(t || ''),
    lcDebug: { warn() {} },
    S: { answers: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnBlock, sandbox);
  return sandbox;
}

function ok(label, cond) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
  console.log('OK:', label);
}

const runner = loadRunnerRender();
const ui = {
  lang: 'de',
  reading: 'Lesen',
  teil: 'Teil',
  partial: 'partial',
  option: 'Option',
  trueL: 'Richtig',
  falseL: 'Falsch',
  trueK: 'R',
};

const forumPart = {
  teil: 4,
  blueprintSlot: 'forum_opinions',
  slotType: 'forum_opinions',
  textTitle: 'Sollte Vokabeltraining Pflicht in der Schule sein?',
  instruction: 'Lesen Sie die Meinungen 20 bis 26 zu einem Thema. Stimmt die Person dem Thema zu? Wählen Sie: Ja oder Nein.',
  items: [
    { id: '20', type: 'ja_nein', signText: 'Anna: Ich finde Vokabeltraining wichtig.', correct: 'J' },
    { id: '21', type: 'yn', signText: 'Ben: Das halte ich für unnötig.', correct: 'N' },
  ],
  questions: [],
};

const adsPart = {
  teil: 3,
  blueprintSlot: 'ads_matching',
  slotType: 'ads_matching',
  instruction: 'Lesen Sie die Situationen 13–19. Welche Anzeige passt?',
  ads: Array.from({ length: 10 }, (_, i) => ({
    key: String.fromCharCode(65 + i),
    title: `Anzeige ${String.fromCharCode(65 + i)}`,
    text: `Text ${String.fromCharCode(65 + i)}`,
  })),
  items: [
    { id: '13', type: 'matching', question: 'Maria sucht Nachhilfe.', correct: 'B' },
    { id: '14', type: 'matching', question: 'Keine passende Anzeige.', correct: '0' },
  ],
  questions: [],
};

const forumHtml = runner.renderGoetheLesenPart(forumPart, 3, false, ui);
ok('forum T4: 7× Ja/Nein buttons', (forumHtml.match(/rf-btn/g) || []).length >= 4);
ok('forum T4: answer key lesen_3_20', forumHtml.includes('setRF("lesen_3_20"') || forumHtml.includes("setRF('lesen_3_20'") || forumHtml.includes("setRF(\"lesen_3_20\""));
ok('forum T4: opinion 20 visible', forumHtml.includes('Anna:'));

const adsHtml = runner.renderGoetheLesenPart(adsPart, 2, false, ui);
// El Teil 3 se redibujo el 21 jul 2026: de radios (options-matching-keys) a pills
// con ptSetMatch. El camino de radios sigue vivo en examRunner.js para el matching
// generico (_keyOnlyMatch), pero una parte ads_matching ya no pasa por ahi.
ok('ads T3: pills de matching por situacion', (adsHtml.match(/pt-match-pills/g) || []).length === 2);
ok('ads T3: answer key lesen_2_13', adsHtml.includes('data-ak="lesen_2_13"'));
ok('ads T3: las 10 letras de anuncio + el 0', 'ABCDEFGHIJ0'.split('').every(
  (k) => adsHtml.includes(`ptSetMatch("lesen_2_13","${k}"`),
));
ok('ads T3: option 0 present', adsHtml.includes('ptSetMatch("lesen_2_14","0"'));

let counted = 0;
runner.forEachGoetheQ(
  { lesenParts: [forumPart, adsPart] },
  () => {
    counted += 1;
  },
);
ok('forEachGoetheQ counts forum + ads items', counted === 4);

const partAds = {
  ads: Array.from({ length: 10 }, (_, i) => ({ key: String.fromCharCode(65 + i) })),
};
ok('matching correct 0 renderable when ads inject option 0', runner.isAnswerKeyRenderable(
  { id: 'x', type: 'matching', correct: '0', options: [] },
  partAds,
));
ok('matching correct 0 NOT renderable with own options A-J only', !runner.isAnswerKeyRenderable(
  {
    id: 'y',
    type: 'matching',
    correct: '0',
    options: ['A) ad', 'B) ad'],
    _keyOnlyMatch: true,
  },
  partAds,
));
ok('yn Ja renderable', runner.isAnswerKeyRenderable({ id: 'z', type: 'ja_nein', correct: 'J' }, null));

console.log('\nAll exam runner render checks passed.');
