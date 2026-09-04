#!/usr/bin/env node
/**
 * Cambridge is a British exam. American spellings in en/* content are defects,
 * and a pool that mixes both is worse than either — a candidate meets "centre"
 * in one Reading part and "center" in the next.
 *
 * Deterministic, so it belongs in a gate rather than in SEM-1: no LLM can be
 * relied on to be consistent about this, and it costs nothing to check.
 *
 *   node scripts/audit-en-spelling-variant.mjs
 *   node scripts/audit-en-spelling-variant.mjs --level B1 --strict
 *
 * --strict exits 1 when any American form is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/loadEnv.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const level = String(flag('--level', 'B1')).toUpperCase();
const strict = argv.includes('--strict');

/** [British (correct for Cambridge), American (defect)] */
const VARIANTS = [
  ['centre', 'center'], ['theatre', 'theater'],
  ['colour', 'color'], ['favourite', 'favorite'], ['neighbour', 'neighbor'],
  ['armour', 'armor'], ['behaviour', 'behavior'], ['flavour', 'flavor'],
  ['harbour', 'harbor'], ['humour', 'humor'], ['labour', 'labor'],
  ['practise', 'practice'],
  ['organise', 'organize'], ['organiser', 'organizer'], ['realise', 'realize'],
  ['recognise', 'recognize'], ['apologise', 'apologize'], ['specialise', 'specialize'],
  ['travelling', 'traveling'], ['cancelled', 'canceled'],
  ['grey', 'gray'], ['jewellery', 'jewelry'],
  ['pyjamas', 'pajamas'], ['aeroplane', 'airplane'],
];

/**
 * Pairs where the "American" form is also correct British English in some
 * sense, so a hit is a prompt to look, never a defect on its own:
 *   tire     — the verb (to tire) is fine; only the car part is tyre
 *   learned  — both learnt and learned are standard British
 *   program  — correct for computer programs; programme for TV and events
 *   meter    — the device; metre is the unit
 * Reported separately and never fails --strict.
 */
const AMBIGUOUS = [
  ['tyre', 'tire'], ['learnt', 'learned'], ['programme', 'program'], ['metre', 'meter'],
];

const seedPath = path.join(ROOT, `library/reusable-seed/en_${level}.json`);
if (!fs.existsSync(seedPath)) {
  console.error(`No existe ${path.relative(ROOT, seedPath)}`);
  process.exit(1);
}
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const records = seed.records || seed;

/** Every learner-visible string in a part. */
function textOf(rec) {
  const bits = [rec.passage?.text || '', rec.passage?.title || '', rec.instruction || ''];
  for (const s of rec.segments || []) bits.push(s.transcript || '');
  for (const a of rec.ads || []) bits.push(typeof a === 'string' ? a : (a?.text || ''));
  for (const q of rec.questions || []) {
    bits.push(q.question || '', q.signText || '', q.explanation || '');
    for (const o of q.options || []) bits.push(typeof o === 'string' ? o : (o?.text || ''));
  }
  return bits.join('\n');
}

const totals = { brit: new Map(), amer: new Map() };
const ambiguous = new Map();
const offenders = [];

for (const rec of records) {
  const text = textOf(rec);
  const amer = [];
  const brit = [];
  for (const [b, a] of VARIANTS) {
    const mb = text.match(new RegExp(`\\b${b}`, 'gi'));
    const ma = text.match(new RegExp(`\\b${a}`, 'gi'));
    if (mb) { totals.brit.set(b, (totals.brit.get(b) || 0) + mb.length); brit.push(`${b}×${mb.length}`); }
    if (ma) { totals.amer.set(a, (totals.amer.get(a) || 0) + ma.length); amer.push(`${a}×${ma.length}`); }
  }
  if (amer.length) offenders.push({ id: rec.id, slot: `${rec.module} T${rec.teil}`, amer, brit });

  for (const [, a] of AMBIGUOUS) {
    const m = text.match(new RegExp(`\\b${a}`, 'gi'));
    if (m) ambiguous.set(a, (ambiguous.get(a) || 0) + m.length);
  }
}

const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' · ') || '(ninguna)';

console.log(`en/${level} — ${records.length} partes\n`);
console.log('Formas británicas (correctas):');
console.log('  ' + fmt(totals.brit) + '\n');
console.log('Formas americanas (defecto):');
console.log('  ' + fmt(totals.amer) + '\n');

console.log('Formas dudosas (correctas en británico según el sentido — mirar, no bloquear):');
console.log('  ' + fmt(ambiguous) + '\n');

if (offenders.length) {
  console.log(`Partes afectadas: ${offenders.length} de ${records.length}`);
  for (const o of offenders) {
    const mixed = o.brit.length ? `   ← mezcla con ${o.brit.join(', ')}` : '';
    console.log(`  ${o.slot.padEnd(12)} ${o.id.slice(-18)}  ${o.amer.join(', ')}${mixed}`);
  }
} else {
  console.log('Sin formas americanas.');
}

const amerTotal = [...totals.amer.values()].reduce((a, b) => a + b, 0);
console.log(`\n${amerTotal} apariciones americanas en ${offenders.length} partes.`);

if (strict && amerTotal > 0) process.exit(1);
