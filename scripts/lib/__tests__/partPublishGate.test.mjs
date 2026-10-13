#!/usr/bin/env node
/**
 * Pool servability gate. A part is served only after one semantic check that really ran:
 * SEM-1 (sem1VerifiedAt), SEM-1 not applicable (sem1Skipped) or an independent blind review
 * (reviewVerifiedAt + reviewVerifiedBy). The review stamp needs both fields, so a stray
 * timestamp cannot unlock a part, and it never stands in for the SEM-1 fields.
 *
 *   node scripts/lib/__tests__/partPublishGate.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { partPassesPublishGate: gate } = require(path.join(ROOT, 'netlify/functions/lib/partPublishGate.js'));
const store = fs.readFileSync(path.join(ROOT, 'netlify/functions/lib/reusablePartsStore.js'), 'utf8');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok ', name); };
const base = { complete: true, verified: true };

test('SEM-1 verified passes', () => assert.equal(gate({ ...base, sem1VerifiedAt: '2026-09-03T00:00:00Z' }), true));
test('SEM-1 not applicable passes', () => assert.equal(gate({ ...base, sem1Skipped: 'no-mcq' }), true));
test('blind review with reviewer passes', () =>
  assert.equal(gate({ ...base, reviewVerifiedAt: '2026-09-26T00:00:00Z', reviewVerifiedBy: 'claude-opus-blind-review' }), true));
test('review timestamp alone does not pass', () => assert.equal(gate({ ...base, reviewVerifiedAt: '2026-09-26T00:00:00Z' }), false));
test('reviewer alone does not pass', () => assert.equal(gate({ ...base, reviewVerifiedBy: 'claude-opus-blind-review' }), false));
test('no semantic stamp does not pass', () => assert.equal(gate({ ...base }), false));
test('a review stamp never overrides disabled / incomplete / unverified', () => {
  const review = { reviewVerifiedAt: '2026-09-26T00:00:00Z', reviewVerifiedBy: 'x' };
  assert.equal(gate({ ...base, ...review, disabled: true }), false);
  assert.equal(gate({ ...review, complete: false, verified: true }), false);
  assert.equal(gate({ ...review, complete: true, verified: false }), false);
});
test('the parts store persists the review stamp (else the uploaded part is invisible)', () => {
  assert.match(store, /payload\.reviewVerifiedAt = part\.reviewVerifiedAt/);
  assert.match(store, /payload\.reviewVerifiedBy = part\.reviewVerifiedBy/);
});
test('en/B1 seed: every review stamp names its reviewer, and no record carries both kinds', () => {
  const recs = JSON.parse(fs.readFileSync(path.join(ROOT, 'library/reusable-seed/en_B1.json'), 'utf8')).records;
  for (const r of recs) {
    if (r.reviewVerifiedAt) {
      assert.ok(String(r.reviewVerifiedBy || '').trim(), `${r.id}: review stamp without reviewer`);
      assert.ok(!r.sem1VerifiedAt, `${r.id}: claims both SEM-1 and blind review`);
    }
  }
});

console.log(`\n${passed} passed`);
