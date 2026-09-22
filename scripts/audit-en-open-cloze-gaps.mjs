#!/usr/bin/env node
/**
 * Every Reading Part 6 key must be a function word — see scripts/lib/openClozeGaps.mjs
 * for why a lexical gap in an open cloze is unmarkable rather than untidy.
 *
 * Measured on en/B1 before the repair: 13 grammatical gaps, 5 lexical, and the
 * third part (847ef76b) already 6/6 grammatical.
 *
 *   node scripts/audit-en-open-cloze-gaps.mjs
 *   node scripts/audit-en-open-cloze-gaps.mjs --level B1 --strict
 *
 * --strict exits 1 on any lexical key. Weak-but-grammatical keys are listed and
 * never fail the build: they are a prompt to re-read the gap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/loadEnv.mjs';
import { isFunctionWord, isOpenCloze, WEAK } from './lib/openClozeGaps.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const level = String(flag('--level', 'B1')).toUpperCase();
const lang = String(flag('--lang', 'en')).toLowerCase();
const strict = argv.includes('--strict');

const TARGETS = [
  `library/reusable-seed/${lang}_${level}.json`,
  `library/curated/${lang}/${level}`,
  `library/published-exams/${lang}/${level}`,
  `data/exams/${lang}_${level}.json`,
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

/** Open-cloze parts, wherever they sit. A part carries questions and a passage. */
export function* openClozeParts(node, parent = null) {
  if (Array.isArray(node)) { for (const v of node) yield* openClozeParts(v, parent); return; }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.questions) && isOpenCloze(node)) yield node;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') {
      // lesenParts[5] is Part 6 even when the object itself carries no teil.
      const inferred = /^lesenParts$/.test(k) ? 'lesenParts' : null;
      yield* openClozeParts(v, inferred || parent);
    }
  }
}

function main() {
  let gaps = 0;
  const lexical = [];
  const weak = [];

  for (const target of TARGETS) {
    for (const file of jsonFiles(target)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const part of openClozeParts(data)) {
        for (const q of part.questions || []) {
          const key = String(q.correct ?? q.correctAnswer ?? '').trim();
          if (!key) continue;
          gaps++;
          if (!isFunctionWord(key)) lexical.push({ rel, id: q.id, key });
          else if (WEAK.has(key.toLowerCase())) weak.push({ rel, id: q.id, key });
        }
      }
    }
  }

  console.log(`${lang}/${level} — ${gaps} huecos de open cloze (Reading Part 6)\n`);

  if (lexical.length) {
    console.log('LEXICOS (admiten sinonimo, no se pueden corregir):');
    for (const l of lexical) console.log(`  ${String(l.key).padEnd(12)} ${l.id}   ${l.rel}`);
    console.log();
  }
  if (weak.length) {
    const seen = new Map();
    for (const w of weak) seen.set(w.id, w.key);
    console.log('Gramaticales pero flojos (releer el hueco, no bloquean):');
    for (const [id, key] of seen) console.log(`  ${String(key).padEnd(12)} ${id}`);
    console.log();
  }
  console.log(`${lexical.length} huecos lexicos.`);

  if (strict && lexical.length) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
