#!/usr/bin/env node
/**
 * Rewrite American spellings to British across the en/* content chain.
 *
 * Cambridge is a British exam, and the pool mixes conventions: two Reading P2
 * parts in the same slot use `centre×12` and `center×12`. The defect is not only
 * in the pool — the same strings are in `library/curated/` and in the served
 * `data/exams/en_B1.json`, so users are reading them in production today.
 *
 *   node scripts/fix-en-spelling-variant.mjs            # dry run, lists every change
 *   node scripts/fix-en-spelling-variant.mjs --apply
 *
 * Changing a `transcript` changes the TTS cache key (`voice:hash(text)`) and so
 * invalidates that clip. Those are counted separately and listed by name, because
 * they cost ElevenLabs credits to regenerate and nothing else here does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/loadEnv.mjs';
import { toBritish, findAmbiguous, mapStrings } from './lib/britishSpelling.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const level = (() => { const i = argv.indexOf('--level'); return i >= 0 ? argv[i + 1] : 'B1'; })();

/** The real sources. dist/ and .netlify/ are build output and are rebuilt from these. */
const TARGETS = [
  `library/reusable-seed/en_${level}.json`,
  `library/curated/en/${level}`,
  `library/published-exams/en/${level}`,
  `data/exams/en_${level}.json`,
];

function collect(target) {
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

let totalHits = 0, totalSpoken = 0, filesChanged = 0;
const spokenClips = [];
const ambiguousSeen = new Map();

for (const target of TARGETS) {
  const files = collect(target);
  if (!files.length) continue;

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const changes = [];

    mapStrings(data, (value, where, key) => {
      for (const a of findAmbiguous(value)) {
        ambiguousSeen.set(a.toLowerCase(), (ambiguousSeen.get(a.toLowerCase()) || 0) + 1);
      }
      const { text, hits } = toBritish(value);
      if (!hits.length) return null;
      const spoken = /transcript/i.test(where) || key === 'transcript';
      changes.push({ where, hits, spoken });
      return text;
    });
    if (!changes.length) continue;

    filesChanged++;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    console.log(`\n${rel}`);
    for (const c of changes) {
      const words = c.hits.map((h) => `${h.from}→${h.to}`).join(', ');
      console.log(`  ${c.spoken ? 'HABLADO ' : '        '}${c.where.padEnd(44)} ${words}`);
      totalHits += c.hits.length;
      if (c.spoken) { totalSpoken += c.hits.length; spokenClips.push(`${rel} ${c.where}`); }
    }

    if (apply) {
      const nl = raw.includes('\r\n') ? '\r\n' : '\n';
      const trailing = raw.endsWith('\n') ? nl : '';
      const body = JSON.stringify(data, null, 2).replace(/\n/g, nl);
      fs.writeFileSync(file, body + trailing);
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${totalHits} correcciones en ${filesChanged} ficheros.`);
console.log(`De ellas ${totalSpoken} caen en transcripciones y invalidan ${spokenClips.length} clips de TTS:`);
for (const c of spokenClips) console.log(`  ${c}`);
if (ambiguousSeen.size) {
  const fmt = [...ambiguousSeen.entries()].map(([k, n]) => `${k}×${n}`).join(' · ');
  console.log(`\nFormas dudosas encontradas y NO tocadas (correctas según el sentido): ${fmt}`);
}
console.log(apply ? '\nAplicado.' : '\nSimulacro. Repite con --apply para escribir.');
