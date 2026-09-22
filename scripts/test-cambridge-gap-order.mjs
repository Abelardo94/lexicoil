#!/usr/bin/env node
/**
 * Gap-bound Reading tasks must follow the passage, not the pick order.
 *
 * The blueprint picker shuffles candidates, which is right for independent items and wrong
 * for "choose the option for gap N": Cambridge Reading P4/P5/P6 were served as gaps
 * 3,5,1,2,4 while the text numbered them 1..5. Built from the real en/B1 bank, repeatedly,
 * because the defect only shows on some shuffles.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const ExamBuilder = require(path.join(ROOT, 'js/library/ExamBuilder.js'));
const ExamBlueprint = require(path.join(ROOT, 'js/library/ExamBlueprint.js'));
globalThis.ExamBlueprint = ExamBlueprint;

function assert(label, cond) {
  if (!cond) {
    console.error('FAIL', label);
    process.exit(1);
  }
  console.log('OK  ', label);
}

const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'library/en/B1/questions.json'), 'utf8'));
const blueprint = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'library/blueprints/cambridge_B1.json'), 'utf8'),
);
ExamBlueprint.cacheBlueprint('en', 'B1', blueprint);

const GAP_SLOTS = new Set(['gapped_text', 'mcq_gap_fill', 'open_cloze']);
const gapNumber = (q) => {
  const m = String(q?.question || q?.statement || '').match(/\bgap\s*(\d+)/i);
  return m ? Number(m[1]) : null;
};

const ROUNDS = 25;
let checked = 0;
const offenders = [];

for (let r = 0; r < ROUNDS; r++) {
  const exam = ExamBuilder.buildFromBlueprint('en', 'B1', bank, blueprint, {
    mode: 'standard',
    skills: ['lesen'],
  });
  for (const part of exam.lesenParts || []) {
    const slot = String(part.blueprintSlot || part.slotType || '');
    if (!GAP_SLOTS.has(slot)) continue;
    const nums = (part.questions || []).map(gapNumber).filter((n) => n != null);
    if (nums.length < 2) continue;
    checked += 1;
    const sorted = [...nums].sort((a, b) => a - b);
    if (nums.join(',') !== sorted.join(',')) {
      offenders.push(`teil ${part.teil} (${slot}): ${nums.join(',')}`);
    }
  }
}

assert(`gap-bound parts were actually exercised (${checked} across ${ROUNDS} builds)`, checked > 0);
if (offenders.length) {
  console.error('Parts served out of gap order:');
  for (const o of [...new Set(offenders)].slice(0, 10)) console.error('   ' + o);
}
assert('every gap-bound part is served in passage order', offenders.length === 0);

// The ordering must stay a no-op where gap numbers are absent: a part whose questions carry
// no gap marker keeps whatever order the picker produced.
const plain = ExamBuilder.buildFromBlueprint('en', 'B1', bank, blueprint, {
  mode: 'standard',
  skills: ['lesen'],
});
const longText = (plain.lesenParts || []).find(
  (p) => String(p.blueprintSlot || p.slotType || '') === 'long_text',
);
assert(
  'non-gap part still built',
  !longText || (longText.questions || []).length > 0,
);

// Sequential tasks without a gap marker follow their one text or recording: Reading P3 tracks
// the paragraphs, Listening P3 (sentence completion) and P4 (interview) track the audio. They
// were served as 1,5,3,4,2 and 6,5,1,3,2,4. Order is read from the bank id suffix (-qN).
const SEQ_SLOTS = new Set(['long_text', 'sentence_completion', 'interview_mcq']);
const idNumber = (q) => {
  const m = String(q?.id || '').match(/-q(\d+)$/i);
  return m ? Number(m[1]) : null;
};
let seqChecked = 0;
const seqOffenders = [];
for (let r = 0; r < ROUNDS; r++) {
  const exam = ExamBuilder.buildFromBlueprint('en', 'B1', bank, blueprint, {
    mode: 'standard',
    skills: ['lesen', 'horen'],
  });
  for (const part of [...(exam.lesenParts || []), ...(exam.horenParts || [])]) {
    const slot = String(part.blueprintSlot || part.slotType || '');
    if (!SEQ_SLOTS.has(slot)) continue;
    const qs = [...(part.questions || []), ...(part.segments || []).flatMap((s) => s.questions || [])];
    const nums = qs.map(idNumber).filter((n) => n != null);
    if (nums.length < 2) continue;
    seqChecked += 1;
    if (nums.join(',') !== [...nums].sort((a, b) => a - b).join(',')) {
      seqOffenders.push(`teil ${part.teil} (${slot}): ${nums.join(',')}`);
    }
  }
}
assert(`sequential parts were actually exercised (${seqChecked} across ${ROUNDS} builds)`, seqChecked > 0);
if (seqOffenders.length) {
  console.error('Sequential parts served out of order:');
  for (const o of [...new Set(seqOffenders)].slice(0, 10)) console.error('   ' + o);
}
assert('every sequential part follows its text or recording', seqOffenders.length === 0);

console.log('\nCambridge gap-order tests passed.');
