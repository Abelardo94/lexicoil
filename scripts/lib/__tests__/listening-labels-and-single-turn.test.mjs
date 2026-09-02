/**
 * listening-labels-and-single-turn.test.mjs
 *
 * Two regressions found doing QA on the English B1 Listening, both of them
 * German leaking into an English exam:
 *
 * 1) ExamBuilder renamed Hören Teil 1 segments to "Aufnahme N" for every
 *    language, overwriting the "Recording N" already in the data. Commit
 *    37e28a8 fixed the JSON but not the code that rewrites it, so it came back:
 *    Part 1 said "Aufnahme 1…7" and Part 2 onwards said "Recording 1…6".
 *
 * 2) parseSegments parsed a lone labelled turn ("Man: It's freezing…")
 *    correctly and then threw the parse away, handing the raw line to TTS —
 *    which read the label out loud ("Man: It's freezing outside today").
 *
 * Run:  node scripts/lib/__tests__/listening-labels-and-single-turn.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let passed = 0, failed = 0;
function assert(desc, cond) {
  if (cond) { console.log(`  OK   ${desc}`); passed++; }
  else { console.error(`  FAIL ${desc}`); failed++; }
}

// ---------------------------------------------------------------- 1) labels
globalThis.PassageResolver = require(path.join(ROOT, 'js/library/PassageResolver.js'));
const ExamBlueprint = require(path.join(ROOT, 'js/library/ExamBlueprint.js'));
globalThis.ExamBlueprint = ExamBlueprint;
const ExamBuilder = require(path.join(ROOT, 'js/library/ExamBuilder.js'));
const { loadBlueprintFileSync } = require(
  path.join(ROOT, 'js/engine/validation/blueprintResolver.js'),
);

function horenT1Labels(lang, level, bankPath, blueprintId) {
  const bank = JSON.parse(fs.readFileSync(path.join(ROOT, bankPath), 'utf8'));
  const blueprint = loadBlueprintFileSync(blueprintId);
  ExamBlueprint.cacheBlueprint(lang, level, blueprint);
  const assembled = ExamBlueprint.assemble(bank, blueprint);
  const exam = ExamBuilder.buildFromBlueprint(lang, level, bank, blueprint, {
    mode: 'standard',
    assembled,
  });
  const t1 = (exam.horenParts || []).find((p) => p.teil === 1);
  return (t1?.segments || []).map((s) => s.label);
}

const enLabels = horenT1Labels('en', 'B1', 'library/en/B1/questions.json', 'cambridge_B1');
assert(
  `EN Hören Teil 1 labels are "Recording N" (got ${JSON.stringify(enLabels.slice(0, 2))})`,
  enLabels.length > 0 && enLabels.every((l) => /^Recording \d+$/.test(l)),
);
assert(
  'EN Hören Teil 1 has no German label',
  !enLabels.some((l) => /Aufnahme/.test(l)),
);

const deLabels = horenT1Labels('de', 'B1', 'library/de/B1/questions.json', 'goethe_B1');
assert(
  `DE Hören Teil 1 keeps "Aufnahme N" (got ${JSON.stringify(deLabels.slice(0, 2))})`,
  deLabels.length > 0 && deLabels.every((l) => /^Aufnahme \d+$/.test(l)),
);

// ------------------------------------------------------- 2) single turn TTS
const ListeningScript = require(path.join(ROOT, 'js/bootstrap/listeningScript.js'));

const oneTurn = "Man: It's freezing outside today! I hope the snow melts by Saturday.";
const prepared = ListeningScript.prepare(oneTurn, 'en');
assert('single labelled turn stays one voice', prepared.length === 1);
assert('single labelled turn keeps its speaker', prepared[0].speaker === 'Man');
assert(
  'single labelled turn does not send the label to TTS',
  !/^Man:/.test(prepared[0].text) && prepared[0].text.startsWith("It's freezing"),
);
assert(
  'singleVoiceText strips the label',
  ListeningScript.singleVoiceText(oneTurn) === "It's freezing outside today! I hope the snow melts by Saturday.",
);

const announcement = 'Hello everyone. I am here to tell you about the library.';
assert(
  'unlabelled announcement is passed through untouched',
  ListeningScript.singleVoiceText(announcement) === announcement,
);

const twoTurns = 'Woman: Shall we go to the beach? Man: Yes, but later.';
assert('two turns still split into two voices', ListeningScript.prepare(twoTurns, 'en').length === 2);
assert(
  'singleVoiceText leaves a multi-turn transcript alone',
  ListeningScript.singleVoiceText(twoTurns) === twoTurns,
);

console.log(`\nlistening labels + single turn: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
