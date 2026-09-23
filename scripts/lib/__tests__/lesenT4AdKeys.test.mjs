/**
 * A2 Lesen T4 ad keys must be the letters a–f, whatever the passages are called.
 * The old rule (strip «ad-» from the id) left curated (…-s1) and generated
 * (gen-l4-…-a) parts with the whole id as key, and GATE-2 rejected A2 exams
 * e2–e4 with ads_keys_mismatch (expected ABCDEF) on 23 sep 2026.
 */
import assert from 'node:assert/strict';
import { buildLesenSeedRecordFromBatch } from '../publishToPool.mjs';

function batch(ids) {
  return {
    level: 'A2',
    passages: ids.map((id, i) => ({ id, module: 'lesen', teil: 4, level: 'A2', title: `Anzeige ${i + 1}`, text: `Text ${i + 1}` })),
    questions: [{ id: 'q1', type: 'matching', module: 'lesen', teil: 4, level: 'A2', question: 'Wer?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'X'], correct: 'b' }],
  };
}
const keys = (ids) => buildLesenSeedRecordFromBatch(batch(ids), { lang: 'de', level: 'A2', teil: 4, idPrefix: 't' }).ads.map((a) => a.key).join('');

const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
assert.equal(keys(letters.map((l) => `ad-${l}`)), 'abcdef', 'ad-a…ad-f (the only shape that used to work)');
assert.equal(keys(letters.map((l) => `gen-l4-63cd5fe8-${l}`)), 'abcdef', 'generated part: letter at the end of the id');
assert.equal(keys([1, 2, 3, 4, 5, 6].map((n) => `gen-p-lesen-t4-cur-society-s${n}`)), 'abcdef', 'curated part: no letter → position');
assert.equal(keys(['x-a', 'x-a', 'x-c', 'x-d', 'x-e', 'x-f']), 'abcdef', 'repeated letters → position for all');
assert.equal(keys(['ad-f', 'ad-e', 'ad-d', 'ad-c', 'ad-b', 'ad-a']), 'fedcba', 'an explicit letter wins over the position');

console.log('PASS: lesen T4 ad keys are a–f for every passage naming');
