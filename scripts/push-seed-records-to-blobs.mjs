#!/usr/bin/env node
/**
 * Push SELECTED reusable-seed records to the production parts pool (Netlify Blobs), any language.
 *
 * seed-reusable-from-curated --apply re-uploads the whole seed without asking, and would rewrite
 * the parts already live (their blobs carry stamps the local file does not); push-seed-to-blobs
 * only knows de/B1. This adds only the records you pick and never overwrites one that exists.
 *
 *   node scripts/push-seed-records-to-blobs.mjs --lang en --level B1 --match "^cur-en-B1-e0[4-7]-"
 *   node scripts/push-seed-records-to-blobs.mjs --lang en --level B1 --match "^cur-en-B1-e0[4-7]-" --apply
 *
 * Dry run by default. With --apply it:
 *   - refuses records that fail partPassesPublishGate (they would be stored but never served);
 *   - skips ids already in the live index (never overwrites);
 *   - aborts if any (module, Teil) would exceed MAX_PER_TEIL, because addReusablePart would then
 *     rotate out the oldest live parts;
 *   - re-reads every pushed part from Blobs and checks it passes the gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadEnvFile, ROOT } from './lib/loadEnv.mjs';

const require = createRequire(import.meta.url);
const { addReusablePart, listPartsIndex, getReusablePart } = require(path.join(ROOT, 'netlify/functions/lib/reusablePartsStore.js'));
const { partPassesPublishGate } = require(path.join(ROOT, 'netlify/functions/lib/partPublishGate.js'));

const argv = process.argv.slice(2);
const flag = (name, def = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const lang = String(flag('--lang', '')).toLowerCase();
const level = String(flag('--level', '')).toUpperCase();
const match = flag('--match');
const apply = argv.includes('--apply');
const MAX_PER_TEIL = 50;
if (!lang || !level || !match) {
  console.error('Uso: --lang en --level B1 --match "<regex sobre el id>" [--apply]');
  process.exit(1);
}

loadEnvFile();
const seedPath = path.join(ROOT, `library/reusable-seed/${lang}_${level}.json`);
const records = JSON.parse(fs.readFileSync(seedPath, 'utf8')).records || [];
const rx = new RegExp(match);
const picked = records.filter((r) => rx.test(r.id));
const ungated = picked.filter((r) => !partPassesPublishGate(r));
console.log(`${lang}/${level}: ${picked.length} registros coinciden con ${rx}`);
if (!picked.length) process.exit(1);
if (ungated.length) {
  console.error(`ABORT: ${ungated.length} no pasan partPassesPublishGate (se guardarían pero nunca se servirían):`);
  ungated.slice(0, 10).forEach((r) => console.error('  ', r.id));
  process.exit(1);
}

const { getStore } = require('@netlify/blobs');
const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error('Faltan NETLIFY_SITE_ID / NETLIFY_API_TOKEN');
  process.exit(1);
}
const store = getStore({ name: 'lexicoil-data', siteID, token });

const modules = [...new Set(picked.map((r) => String(r.module).toLowerCase()))];
const live = {};
for (const m of modules) live[m] = await listPartsIndex(store, lang, level, m);
const liveIds = new Set(Object.values(live).flat().map((e) => e.id));
const todo = picked.filter((r) => !liveIds.has(r.id));
console.log(`Ya en producción: ${picked.length - todo.length} · por subir: ${todo.length}`);

const after = {};
for (const [m, entries] of Object.entries(live)) for (const e of entries) { const k = `${m} T${e.teil}`; after[k] = (after[k] || 0) + 1; }
for (const r of todo) { const k = `${String(r.module).toLowerCase()} T${r.teil}`; after[k] = (after[k] || 0) + 1; }
for (const [k, n] of Object.entries(after).sort()) console.log(`  ${k.padEnd(14)} quedaría en ${n}`);
const over = Object.entries(after).filter(([, n]) => n > MAX_PER_TEIL);
if (over.length) {
  console.error(`ABORT: superaría ${MAX_PER_TEIL} por Teil y la rotación borraría partes vivas: ${over.map(([k]) => k).join(', ')}`);
  process.exit(1);
}
if (!apply) {
  console.log('\nSeco. Añade --apply para subir.');
  process.exit(0);
}

let ok = 0, fail = 0;
for (const r of todo) {
  try { await addReusablePart(store, r, { deferRotate: true }); ok++; } catch (e) { fail++; console.error('  fallo', r.id, e.message); }
}
console.log(`\nSubidas ${ok} · fallos ${fail}`);

let served = 0, bad = [];
for (const r of todo) {
  const back = await getReusablePart(store, lang, level, String(r.module).toLowerCase(), r.id);
  if (back && partPassesPublishGate(back)) served++; else bad.push(r.id);
}
console.log(`Releídas de producción y servibles: ${served}/${todo.length}`);
if (bad.length) { console.error('NO servibles tras subir:', bad.slice(0, 10).join(', ')); process.exit(1); }
