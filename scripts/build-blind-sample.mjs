#!/usr/bin/env node
/**
 * Build the blind sample — the human control for SEM-1.
 *
 * Items are emitted WITHOUT any machine verdict, so the reviewer's judgement is
 * not anchored. The verdicts go in a separate key file that stays out of the
 * reviewer's hands until their marks are in; comparing the two is what tells us
 * whether SEM-1 can be trusted at volume.
 *
 *   node scripts/build-blind-sample.mjs --lang en --level B1 --size 36
 *
 * Weighting, in order of what we least know:
 *   1. slots SEM-1 cannot inspect at all (gap-fill) — nothing has ever looked
 *   2. questions SEM-1 flagged — do we agree those are real defects?
 *   3. questions SEM-1 passed — the false negatives, the dangerous ones
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './lib/loadEnv.mjs';

const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const lang = String(flag('--lang', 'en')).toLowerCase();
const level = String(flag('--level', 'B1')).toUpperCase();
const size = Number(flag('--size', 36));

const SEED = path.join(ROOT, `library/reusable-seed/${lang}_${level}.json`);
const REPORT = path.join(ROOT, `docs/audit/sem1-${lang}_${level}.json`);
const OUT_ITEMS = path.join(ROOT, `docs/audit/blind-sample-${lang}_${level}.json`);
const OUT_KEY = path.join(ROOT, `docs/audit/blind-sample-${lang}_${level}.key.json`);

const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const records = (seed.records || seed).filter((r) => ['lesen', 'horen'].includes(r.module));

// Which questions did SEM-1 flag? (report is optional — a fresh pool has none)
const flagged = new Set();
if (fs.existsSync(REPORT)) {
  for (const res of require(REPORT).results || []) {
    for (const iss of res.issues || []) if (iss.itemId) flagged.add(iss.itemId);
  }
}

/** The text a reviewer needs to judge this question, and nothing more. */
function contextFor(rec, q) {
  const segs = Array.isArray(rec.segments) ? rec.segments : [];
  const seg =
    segs.find((s) => s.passageId && s.passageId === q.passageId) ||
    segs.find((s) => (s.questions || []).some((sq) => sq.id === q.id));
  if (seg?.transcript) return { label: seg.label || 'Recording', text: seg.transcript };
  if (q.signText) return { label: rec.passage?.title || 'Text', text: String(q.signText) };
  if (rec.passage?.text) return { label: rec.passage.title || 'Text', text: rec.passage.text };
  return { label: 'Text', text: '' };
}

const all = [];
for (const rec of records) {
  for (const q of rec.questions || []) {
    all.push({
      itemId: q.id,
      partId: rec.id,
      module: rec.module,
      teil: Number(rec.teil),
      slot: `${rec.module} T${rec.teil}`,
      type: String(q.type || ''),
      question: q.question || '',
      options: q.options || null,
      key: String(q.correct ?? q.correctAnswer ?? ''),
      context: contextFor(rec, q),
      // hidden from the reviewer, kept for scoring
      _semVerdict: flagged.has(q.id) ? 'flagged' : (rec.sem1Skipped ? 'unchecked' : 'passed'),
    });
  }
}

const tiers = {
  unchecked: all.filter((i) => i._semVerdict === 'unchecked'),
  flagged: all.filter((i) => i._semVerdict === 'flagged'),
  passed: all.filter((i) => i._semVerdict === 'passed'),
};

/** Round-robin by slot so no tier is dominated by one task type. */
function spread(items, n) {
  const bySlot = new Map();
  for (const it of items) {
    if (!bySlot.has(it.slot)) bySlot.set(it.slot, []);
    bySlot.get(it.slot).push(it);
  }
  const qs = [...bySlot.keys()].sort().map((k) => bySlot.get(k));
  const out = [];
  for (let r = 0; out.length < n; r += 1) {
    let placed = false;
    for (const q of qs) {
      if (r >= q.length) continue;
      out.push(q[r]);
      placed = true;
      if (out.length === n) break;
    }
    if (!placed) break;
  }
  return out;
}

// Every flagged item, then fill from the never-inspected slots, then the rest.
const picked = [...tiers.flagged];
const wantUnchecked = Math.min(tiers.unchecked.length, Math.round(size * 0.4));
picked.push(...spread(tiers.unchecked, wantUnchecked));
picked.push(...spread(tiers.passed, Math.max(0, size - picked.length)));

// Deterministic shuffle: the order must not leak which tier an item came from,
// but a rebuild has to produce the same sample or the marks stop lining up.
let s = 20260903;
const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
for (let i = picked.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rand() * (i + 1));
  [picked[i], picked[j]] = [picked[j], picked[i]];
}

const items = picked.map((it, i) => {
  const { _semVerdict, ...visible } = it;
  return { n: i + 1, ...visible };
});
const key = picked.map((it, i) => ({ n: i + 1, itemId: it.itemId, slot: it.slot, semVerdict: it._semVerdict }));

fs.mkdirSync(path.dirname(OUT_ITEMS), { recursive: true });
fs.writeFileSync(OUT_ITEMS, JSON.stringify({ lang, level, builtAt: new Date().toISOString(), items }, null, 2));
fs.writeFileSync(OUT_KEY, JSON.stringify({ lang, level, key }, null, 2));

const counts = key.reduce((a, k) => ({ ...a, [k.semVerdict]: (a[k.semVerdict] || 0) + 1 }), {});
console.log(`Muestra ciega ${lang}/${level}: ${items.length} preguntas de ${all.length}`);
console.log(`  sin check de SEM-1 : ${counts.unchecked || 0}`);
console.log(`  marcadas por SEM-1 : ${counts.flagged || 0}`);
console.log(`  aprobadas por SEM-1: ${counts.passed || 0}`);
const bySlot = items.reduce((a, i) => ({ ...a, [i.slot]: (a[i.slot] || 0) + 1 }), {});
console.log('\n── Por slot ──');
for (const [k, v] of Object.entries(bySlot).sort()) console.log(`  ${k.padEnd(12)} ${v}`);
console.log(`\nÍtems → ${path.relative(ROOT, OUT_ITEMS)}`);
console.log(`Clave → ${path.relative(ROOT, OUT_KEY)}  (no mirar antes de revisar)`);
