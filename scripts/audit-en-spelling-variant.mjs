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
 *
 * It checks the whole chain, not just the pool: the same strings live in
 * `library/curated/` and in the served `data/exams/`, and it was the served copy
 * that users were reading. Matching is whole-word via scripts/lib/britishSpelling.mjs
 * — a stem-matching gate flags "laboratory" and counts "organizers" twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/loadEnv.mjs';
import { findAmerican, findAmbiguous, mapStrings } from './lib/britishSpelling.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const level = String(flag('--level', 'B1')).toUpperCase();
const strict = argv.includes('--strict');

const TARGETS = [
  `library/reusable-seed/en_${level}.json`,
  `library/curated/en/${level}`,
  `library/published-exams/en/${level}`,
  `data/exams/en_${level}.json`,
];

function jsonFiles(target) {
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return abs.endsWith('.json') ? [abs] : [];
  const out = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p)) {
      if (e === '_rejected' || e === '.rejected') continue;
      const full = path.join(p, e);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.json')) out.push(full);
    }
  };
  walk(abs);
  return out;
}

const amer = new Map();
const ambiguous = new Map();
const offenders = [];
let filesSeen = 0;

for (const target of TARGETS) {
  for (const file of jsonFiles(target)) {
    filesSeen++;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const hits = [];
    mapStrings(data, (value, where) => {
      for (const w of findAmerican(value)) {
        amer.set(w.toLowerCase(), (amer.get(w.toLowerCase()) || 0) + 1);
        hits.push(`${where}: ${w}`);
      }
      for (const w of findAmbiguous(value)) {
        ambiguous.set(w.toLowerCase(), (ambiguous.get(w.toLowerCase()) || 0) + 1);
      }
      return null; // look only
    });
    if (hits.length) offenders.push({ rel, hits });
  }
}

const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}×${v}`).join(' · ') || '(ninguna)';

console.log(`en/${level} — ${filesSeen} ficheros de contenido\n`);
console.log('Formas americanas (defecto):');
console.log('  ' + fmt(amer) + '\n');
console.log('Formas dudosas (correctas en británico según el sentido — mirar, no bloquear):');
console.log('  ' + fmt(ambiguous) + '\n');

if (offenders.length) {
  for (const o of offenders) {
    console.log(`${o.rel}  (${o.hits.length})`);
    for (const h of o.hits.slice(0, 12)) console.log(`    ${h}`);
    if (o.hits.length > 12) console.log(`    … y ${o.hits.length - 12} más`);
  }
}

const total = [...amer.values()].reduce((a, b) => a + b, 0);
console.log(`\n${total} apariciones americanas en ${offenders.length} ficheros.`);

if (strict && total > 0) process.exit(1);
