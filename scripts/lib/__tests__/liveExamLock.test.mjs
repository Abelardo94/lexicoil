/**
 * liveExamLock: the assembler must reserve the parts and passages of live
 * exams. A2 e2–e4 (assembled 9 aug 2026 without this) each reused one part of
 * the live e1, and the fidelity gate failed on cross-exam passage duplicates.
 */
import assert from 'node:assert/strict';
import { collectPassageIds, loadLiveExamLocks } from '../liveExamLock.mjs';

// Passage ids are found wherever a part keeps them.
const ids = collectPassageIds({
  passage: { id: 'p-single' },
  passages: [{ id: 'p-multi-a' }, { id: 'p-multi-b' }],
  segments: [{ passageId: 'p-seg', questions: [{ passageId: 'p-q' }] }],
  ads: [{ key: 'a', passageId: 'p-ad' }],
});
assert.deepEqual([...ids].sort(), ['p-ad', 'p-multi-a', 'p-multi-b', 'p-q', 'p-seg', 'p-single']);
assert.equal(collectPassageIds(null).size, 0);

// Real catalog: A2 has e1 live; its 13 parts are reserved, with their passages.
const a2 = loadLiveExamLocks('de', 'A2');
assert.ok(a2.slots.has(1), 'A2 e1 is live');
assert.equal(a2.missing.length, 0, 'every live slot has its published manifest');
assert.ok(a2.partIds.has('lesen-t3-cur-health'), 'e1 part reused by the old e2 is reserved');
assert.ok(a2.passageIds.has('de-a2-p-lesen-t3-dienstleistungen-alltag-02'), 'and so is its passage');

// A level without a published catalog locks nothing.
const none = loadLiveExamLocks('de', 'C2');
assert.equal(none.slots.size + none.partIds.size + none.passageIds.size, 0);

console.log(`PASS: liveExamLock (A2 live slots ${[...a2.slots].join(',')}, ${a2.partIds.size} parts, ${a2.passageIds.size} passages reserved)`);
