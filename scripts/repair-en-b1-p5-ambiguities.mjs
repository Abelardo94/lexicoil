#!/usr/bin/env node
/**
 * Reading Part 5 of en/B1: one duplicated option and four items with two
 * defensible answers. Both quarantined parts are served in production.
 *
 * Each repair swaps ONE distractor, never the key, so the answer letter every
 * stored result refers to stays put. The passage text is not touched either:
 * rewording the gap would change the Reading text a candidate has already read
 * in a stored attempt, and would move nothing that the option list cannot.
 *
 * Why each option was chosen is on the entry. The rule was: the replacement must
 * be B1 vocabulary from the same semantic field, and must NOT fit the gap —
 * verified by re-running SEM-1 over the two parts afterwards.
 *
 *   node scripts/repair-en-b1-p5-ambiguities.mjs            # dry run
 *   node scripts/repair-en-b1-p5-ambiguities.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/loadEnv.mjs';

const apply = process.argv.includes('--apply');

/**
 * `from` must match the option exactly, or nothing is written: these files hold
 * three copies of the same exam and a silent miss in one of them would leave
 * production on the broken variant.
 */
const REPAIRS = [
  {
    question: 'ql_en-b1-r-t5-cloze-cooking-class-01-q1',
    gap: '"I (1) _____ very little about how to prepare it myself"',
    from: 'a) knew', to: 'a) knowing', key: 'c',
    why: 'a) y c) eran la misma palabra, "knew". Quien marcaba a) escribia la respuesta '
       + 'correcta y se le puntuaba mal. "knowing" completa el juego de formas del verbo '
       + '(knowing / know / knew / known) sin encajar en el hueco.',
  },
  {
    question: 'ql_en-b1-r-t5-cloze-cooking-class-01-q3',
    gap: '"Marco was very patient and (3) _____ us exactly what to do"',
    from: 'b) told', to: 'b) spoke', key: 'a',
    why: '"told us exactly what to do" es tan correcto como la clave "showed". Los otros dos '
       + 'distractores ya fallan por gramatica ("said us", "explained us"), asi que "spoke us" '
       + 'mantiene ese criterio y deja una sola respuesta valida.',
  },
  {
    question: 'ql_en-b1-r-t5-cloze-cooking-class-01-q5',
    gap: '"we had all (5) _____ a delicious three-course meal"',
    from: 'c) cooked', to: 'c) bought', key: 'b',
    why: '"cooked a meal" vale igual que la clave "prepared". "bought" es plausible en un '
       + 'contexto de comida pero lo contradice "I felt very proud of what I had achieved".',
  },
  {
    question: 'ql_en-b1-r-t5-cloze-cooking-class-01-q5',
    gap: '"we had all (5) _____ a delicious three-course meal"',
    from: 'd) finished', to: 'd) ordered', key: 'b',
    why: 'Segundo defecto del mismo item, que no estaba en el informe: "finished a meal" '
       + 'tambien se sostiene. Con "ordered" solo queda "prepared".',
  },
  {
    question: 'ql_en-b1-r-t5-cloze-music-festival-03-q4',
    gap: '"It is also a good idea to (4) _____ a waterproof jacket"',
    from: 'a) carry', to: 'a) collect', key: 'd',
    why: '"carry a waterproof jacket" vale igual que la clave "pack". "collect" es del mismo '
       + 'campo (manejar un objeto) y no encaja con "just in case it rains".',
  },
  {
    question: 'ql_en-b1-r-t5-cloze-music-festival-03-q5',
    gap: '"The festival offers a wide (5) _____ of food"',
    from: 'd) variety', to: 'd) amount', key: 'b',
    why: '"a wide variety of food" es tan idiomatico como la clave "a wide range of". '
       + '"a wide amount of" no es una colocacion valida en ingles.',
  },
  {
    question: 'ql_en-b1-r-t5-cloze-music-festival-01-q5',
    gap: '"a fantastic way to (5) _____ new music"',
    from: 'c) explore', to: 'c) listen', key: 'b',
    why: '"explore new music" es una colocacion real y se sostiene frente a la clave '
       + '"discover". "listen new music" falla por gramatica (pide "to"), que es el mismo '
       + 'criterio con el que ya funcionan "said" y "explained" en cooking q3.',
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

/** Every question object in the file, wherever it sits. */
function* questions(node) {
  if (Array.isArray(node)) { for (const v of node) yield* questions(v); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.id === 'string' && Array.isArray(node.options)) yield node;
  for (const v of Object.values(node)) if (v && typeof v === 'object') yield* questions(v);
}

const applied = new Map(REPAIRS.map((r) => [`${r.question}|${r.from}`, 0]));
let filesTouched = 0;

for (const target of TARGETS) {
  for (const file of jsonFiles(target)) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const done = [];

    for (const q of questions(data)) {
      for (const r of REPAIRS) {
        if (q.id !== r.question) continue;
        const i = q.options.indexOf(r.from);
        if (i < 0) {
          // Idempotent: a repair already in the tree counts as satisfied, so the
          // script stays runnable as the record of every repair made.
          if (q.options.includes(r.to)) {
            applied.set(`${r.question}|${r.from}`, applied.get(`${r.question}|${r.from}`) + 1);
          }
          continue;
        }
        const gotKey = String(q.correct ?? q.correctAnswer ?? '');
        if (gotKey !== r.key) {
          console.error(`  AVISO ${rel} ${q.id}: la clave es "${gotKey}", se esperaba "${r.key}". No se toca.`);
          continue;
        }
        q.options[i] = r.to;
        applied.set(`${r.question}|${r.from}`, applied.get(`${r.question}|${r.from}`) + 1);
        done.push(`${q.id}  ${r.from} -> ${r.to}`);
      }
    }

    // A repaired part is no longer quarantined on the strength of the old finding.
    for (const rec of (data.records || [])) {
      if (!Array.isArray(rec.sem1Issues)) continue;
      const ids = new Set((rec.questions || []).map((q) => q.id));
      if (!REPAIRS.some((r) => ids.has(r.question))) continue;
      delete rec.sem1Failed;
      delete rec.sem1Issues;
      rec.sem1NeedsRecheck = true;
      done.push(`${rec.id}  cuarentena levantada, marcado sem1NeedsRecheck`);
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
let missing = 0;
for (const [k, n] of applied) {
  if (n === 0) { console.error(`NO APLICADA: ${k}`); missing++; }
  else console.log(`${n}× ${k}`);
}
console.log(`\n${filesTouched} ficheros.`);
if (missing) { console.error(`\n${missing} reparaciones no encontraron su opcion. Revisa antes de seguir.`); process.exit(1); }
console.log(apply ? 'Aplicado.' : 'Simulacro. Repite con --apply para escribir.');
