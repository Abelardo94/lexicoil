#!/usr/bin/env node
/**
 * Template debris in learner-visible content — see scripts/lib/contentPlaceholders.mjs.
 *
 *   node scripts/audit-content-placeholders.mjs
 *   node scripts/audit-content-placeholders.mjs --strict
 *   node scripts/audit-content-placeholders.mjs --fix     # only the trailing-slot shape
 *
 * Covers both languages: the bug was German, but the pipeline is shared and
 * nothing about it is language-specific.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/loadEnv.mjs';
import { findDebris, mapStrings, stripTrailingSlot } from './lib/contentPlaceholders.mjs';

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const fix = argv.includes('--fix');

const TARGETS = [
  'library/de/B1', 'library/de/A2',
  'library/en/B1',
  'library/curated', 'library/published-exams', 'library/reusable-seed',
  'data/exams',
];

function jsonFiles(target) {
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return abs.endsWith('.json') ? [abs] : [];
  const out = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p)) {
      if (e === '_rejected' || e === '.rejected' || e === 'node_modules') continue;
      const full = path.join(p, e);
      if (fs.statSync(full).isDirectory()) walk(full);
      // Backups are snapshots of content that is itself scanned; one of them is
      // not even valid JSON (library/de/B1/passages.backup-rebuild-*.json).
      else if (full.endsWith('.json') && !/\.backup[-.]/.test(path.basename(full))) out.push(full);
    }
  };
  walk(abs);
  return out;
}

function main() {
  let scanned = 0, found = 0, stripped = 0;
  const unfixable = [];
  const unreadable = [];

  for (const target of TARGETS) {
    for (const file of jsonFiles(target)) {
      scanned++;
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const raw = fs.readFileSync(file, 'utf8');
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        // A gate that dies on one bad file reports nothing about the other 300.
        unreadable.push(`${rel}: ${e.message.slice(0, 80)}`);
        continue;
      }
      const hits = [];

      mapStrings(data, (value, where) => {
        const debris = findDebris(value);
        if (!debris.length) return null;
        if (fix) {
          const cleaned = stripTrailingSlot(value);
          if (cleaned !== value && !findDebris(cleaned).length) {
            stripped++;
            hits.push({ where, kinds: debris.map((d) => d.text), fixed: true });
            return cleaned;
          }
        }
        found += debris.length;
        hits.push({ where, kinds: debris.map((d) => d.text), fixed: false });
        if (!fix) return null;
        unfixable.push(`${rel} ${where}: ${value.slice(0, 100)}`);
        return null;
      });

      if (!hits.length) continue;
      const bad = hits.filter((h) => !h.fixed);
      console.log(`${rel}`);
      console.log(`  ${hits.length} cadenas${fix ? ` · ${hits.length - bad.length} limpiadas · ${bad.length} sin poder limpiar` : ''}`);
      for (const h of hits.slice(0, 4)) console.log(`    ${h.where}  ${h.kinds.slice(0, 2).join(' ')}`);
      if (hits.length > 4) console.log(`    … y ${hits.length - 4} más`);

      if (fix && hits.some((h) => h.fixed)) {
        const nl = raw.includes('\r\n') ? '\r\n' : '\n';
        const tail = raw.endsWith('\n') ? nl : '';
        fs.writeFileSync(file, JSON.stringify(data, null, 2).replace(/\n/g, nl) + tail);
      }
    }
  }

  console.log(`\n${scanned} ficheros escaneados.`);
  if (unreadable.length) {
    console.log(`\n${unreadable.length} ilegibles (no son JSON válido, no se han podido revisar):`);
    for (const u of unreadable) console.log(`  ${u}`);
  }
  if (fix) {
    console.log(`${stripped} marcadores retirados.`);
    if (unfixable.length) {
      console.log(`\n${unfixable.length} NO se pueden limpiar solos (el marcador está dentro de la frase,`);
      console.log('no pegado al final: la frase nunca se escribió y un script no puede inventarla):');
      for (const u of unfixable.slice(0, 10)) console.log(`  ${u}`);
    }
  } else {
    console.log(`${found} marcadores de plantilla.`);
  }

  if (strict && found > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
