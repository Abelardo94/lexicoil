#!/usr/bin/env node
/**
 * Reading Part 6 is an OPEN cloze: no options, so a gap whose answer is a content
 * word accepts every synonym and cannot be marked. Cambridge gaps function words
 * for exactly that reason.
 *
 * en/B1 had 5 lexical gaps in 18 (the third part, 847ef76b, is already 6/6
 * grammatical — the generator does it right when it does it right). Three of them
 * were demonstrably open:
 *
 *   made  "we (2) ___ a compromise"        — reached, came to
 *   lots  "took (4) ___ of photos"         — plenty, loads
 *   never "I had (1) ___ worked ... before" — not
 *
 * Each repair restores the content word into the prose and moves the blank to a
 * nearby function word whose answer is locked by collocation, not by meaning:
 * "made ___ compromise" needs the indefinite article, "___ show our friends" is
 * the infinitive of purpose, "advertisement ___ the local newspaper" is fixed
 * ("on the newspaper" does not exist). The gap stays inside its own sentence and
 * keeps its number, so gap order and every stored answer position hold.
 *
 * `next` and `spending` are left alone: lexical, but forced in practice.
 *
 *   node scripts/repair-en-b1-t6-lexical-gaps.mjs            # dry run
 *   node scripts/repair-en-b1-t6-lexical-gaps.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/loadEnv.mjs';

const apply = process.argv.includes('--apply');

/**
 * `from` must match verbatim or nothing is written: the same exam lives in the
 * seed, in curated and in the served file, and a silent miss in one of them
 * would leave production on the broken variant.
 */
const REPAIRS = [
  {
    question: 'ql_en-b1-r-t6-open-cloze-family-trip-01-q2',
    oldKey: 'made', newKey: 'a',
    from: 'In the end, we (2) _____ a compromise',
    to: 'In the end, we made (2) _____ compromise',
    why: '"reached/came to a compromise" valia igual que "made". El articulo indefinido de '
       + '"make a compromise" no admite alternativa.',
  },
  {
    question: 'ql_en-b1-r-t6-open-cloze-family-trip-01-q4',
    oldKey: 'lots', newKey: 'to',
    from: 'We also took (4) _____ of photos to show our friends back home.',
    to: 'We also took lots of photos (4) _____ show our friends back home.',
    why: '"plenty/loads of photos" valian igual que "lots". El infinitivo de finalidad solo '
       + 'admite "to".',
  },
  {
    question: 'ql_en-b1-r-t6-open-cloze-part-time-job-01-q1',
    oldKey: 'never', newKey: 'in',
    from: 'I found an advertisement in the local newspaper for a shop assistant in a small bakery. I had (1) _______ worked in a shop before,',
    to: 'I found an advertisement (1) _______ the local newspaper for a shop assistant in a small bakery. I had never worked in a shop before,',
    why: '"I had not worked ... before" valia igual que "never". "in the newspaper" es fija; '
       + '"on the newspaper" no existe. El hueco se adelanta una frase pero sigue siendo el '
       + 'primero del pasaje, asi que no altera el orden.',
  },
  // Estos dos se habian dado por "forzados en la practica" al clasificarlos a ojo.
  // No lo estaban: el gate los siguio marcando y al releerlos la alternativa salta a
  // la vista. Van por lo mismo que los tres de arriba.
  {
    question: 'ql_en-b1-r-t6-open-cloze-family-trip-01-q6',
    oldKey: 'next', newKey: 'that',
    from: 'We all agreed that we would definitely like to return (6) _____ year.',
    to: 'We all agreed (6) _____ we would definitely like to return next year.',
    why: '"return every year" y "return each year" valen igual que "next". "agree that" no '
       + 'admite otra palabra en ese hueco.',
  },
  {
    question: 'ql_en-b1-r-t6-open-cloze-part-time-job-01-q3',
    oldKey: 'spending', newKey: 'with',
    from: 'but I enjoyed (3) _______ time with my colleagues.',
    to: 'but I enjoyed spending time (3) _______ my colleagues.',
    why: '"I enjoyed my time with my colleagues" vale igual que "spending". '
       + '"spend time with" no admite otra preposicion.',
  },
];

const TARGETS = [
  'library/reusable-seed/en_B1.json',
  'library/curated/en/B1',
  'library/published-exams/en/B1',
  'data/exams/en_B1.json',
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

/** Every object that looks like a part holding a passage and questions. */
function* parts(node) {
  if (Array.isArray(node)) { for (const v of node) yield* parts(v); return; }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.questions) && (node.passage?.text || node.text)) yield node;
  for (const v of Object.values(node)) if (v && typeof v === 'object') yield* parts(v);
}

const counts = new Map(REPAIRS.map((r) => [r.question, { text: 0, key: 0 }]));
let filesTouched = 0;

for (const target of TARGETS) {
  for (const file of jsonFiles(target)) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const done = [];

    for (const part of parts(data)) {
      for (const r of REPAIRS) {
        const q = part.questions.find((x) => x.id === r.question);
        if (!q) continue;

        // Idempotent: a repair already in the tree counts as satisfied, so the
        // script stays runnable as the record of every repair made.
        const holder = part.passage?.text !== undefined ? part.passage : part;
        if (typeof holder.text === 'string' && holder.text.includes(r.from)) {
          holder.text = holder.text.replace(r.from, r.to);
          counts.get(r.question).text++;
          done.push(`${r.question}  texto reescrito`);
        } else if (typeof holder.text === 'string' && holder.text.includes(r.to)) {
          counts.get(r.question).text++;
        }

        const current = String(q.correct ?? q.correctAnswer ?? '');
        if (current === r.oldKey) {
          if (q.correct !== undefined) q.correct = r.newKey; else q.correctAnswer = r.newKey;
          counts.get(r.question).key++;
          done.push(`${r.question}  clave ${JSON.stringify(r.oldKey)} -> ${JSON.stringify(r.newKey)}`);
        } else if (current === r.newKey) {
          counts.get(r.question).key++;
        } else {
          console.error(`  AVISO ${rel} ${r.question}: clave inesperada ${JSON.stringify(current)}`);
        }
      }
    }

    if (!done.length) continue;
    filesTouched++;
    console.log(`\n${rel}`);
    for (const d of done) console.log(`  ${d}`);

    if (apply) {
      const nl = raw.includes('\r\n') ? '\r\n' : '\n';
      const tail = raw.endsWith('\n') ? nl : '';
      fs.writeFileSync(file, JSON.stringify(data, null, 2).replace(/\n/g, nl) + tail);
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
let bad = 0;
for (const [id, c] of counts) {
  console.log(`${id}\n   texto ${c.text}×   clave ${c.key}×`);
  if (c.text === 0 || c.key === 0 || c.text !== c.key) bad++;
}
console.log(`\n${filesTouched} ficheros.`);
if (bad) {
  console.error(`\n${bad} reparaciones desparejadas (texto y clave deben ir juntos y a la vez). Revisa.`);
  process.exit(1);
}
console.log(apply ? 'Aplicado.' : 'Simulacro. Repite con --apply para escribir.');
