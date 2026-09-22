#!/usr/bin/env node
/**
 * Two options that say the same thing make an item unanswerable: only one of
 * them is the key, so a candidate who picks the other writes the right word and
 * is marked wrong. Found in en/B1 Reading Part 5 —
 *   ql_en-b1-r-t5-cloze-cooking-class-01-q1
 *   ["a) knew", "b) know", "c) knew", "d) known"], key "c"
 * — where "knew" is both the key and a distractor.
 *
 * Deterministic and cheap, so it belongs in a gate. SEM-1 did not catch it in
 * two passes over this part (it reported the two lexical ambiguities in the same
 * exam and never mentioned the duplicate), and neither did a blind human sample:
 * a reader sees the gap, picks the right word and moves on without re-reading
 * the option list.
 *
 *   node scripts/audit-en-duplicate-options.mjs
 *   node scripts/audit-en-duplicate-options.mjs --level B1 --strict
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/loadEnv.mjs';

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

/** Drop the "a) " label and normalise, so "a) knew" and "c) knew" compare equal. */
export function optionBody(option) {
  const text = typeof option === 'string' ? option : (option?.text ?? '');
  return text
    .replace(/^\s*[A-Ha-h]\s*[).:-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Every question with an options array, wherever it sits in the file. */
export function* questionsWithOptions(node, trail = '') {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* questionsWithOptions(node[i], `${trail}[${i}]`);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.options) && node.options.length > 1) yield [trail, node];
  for (const [k, v] of Object.entries(node)) {
    if (k === 'options') continue;
    if (v && typeof v === 'object') yield* questionsWithOptions(v, trail ? `${trail}.${k}` : k);
  }
}

/** Duplicate option bodies in one question, as groups of colliding labels. */
export function duplicateGroups(options) {
  const byBody = new Map();
  options.forEach((o, i) => {
    const body = optionBody(o);
    if (!body) return;
    if (!byBody.has(body)) byBody.set(body, []);
    byBody.get(body).push({ i, raw: typeof o === 'string' ? o : o?.text });
  });
  return [...byBody.entries()].filter(([, hits]) => hits.length > 1);
}

function main() {
  let checked = 0;
  const findings = [];

  for (const target of TARGETS) {
    for (const file of jsonFiles(target)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [where, q] of questionsWithOptions(data)) {
        checked++;
        const dups = duplicateGroups(q.options);
        if (!dups.length) continue;
        const key = String(q.correct ?? q.correctAnswer ?? '');
        findings.push({ rel, where, id: q.id, key, options: q.options, dups });
      }
    }
  }

  console.log(`${lang}/${level} — ${checked} preguntas con opciones\n`);
  for (const f of findings) {
    console.log(`${f.rel}`);
    console.log(`  ${f.id || f.where}`);
    console.log(`  opciones: ${JSON.stringify(f.options)}   clave: ${JSON.stringify(f.key)}`);
    for (const [body, hits] of f.dups) {
      const labels = hits.map((h) => h.raw).join('  ==  ');
      console.log(`  DUPLICADA "${body}": ${labels}`);
    }
    console.log();
  }
  console.log(`${findings.length} preguntas con opciones duplicadas.`);

  if (strict && findings.length) process.exit(1);
}

// The test imports optionBody/duplicateGroups/questionsWithOptions; scanning the
// repo on import would make that a slow file-reading side effect.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
