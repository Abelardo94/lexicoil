#!/usr/bin/env node
/**
 * Sprint 5 — aggregate item usage → library/{lang}/{level}/calibration.json
 *
 * Usage:
 *   node scripts/calibrate-from-usage.mjs --lang de --level B1 --usage data/usage/de_B1.json
 *   node scripts/calibrate-from-usage.mjs --lang de --level B1 --seed-priors
 *   node scripts/calibrate-from-usage.mjs --lang de --level B1 --from-analytics export.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ItemCalibration = require(path.join(ROOT, 'js/library/ItemCalibration.js'));

function parseArgs(argv) {
  const out = {
    lang: 'de',
    level: 'B1',
    usage: null,
    fromAnalytics: null,
    out: null,
    seedPriors: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') out.lang = argv[++i];
    else if (a === '--level') out.level = argv[++i];
    else if (a === '--usage') out.usage = argv[++i];
    else if (a === '--from-analytics') out.fromAnalytics = argv[++i];
    else if (a === '--seed-priors') out.seedPriors = true;
    else if (a === '--dry-run') out.dryRun = true;
    // Redirige SOLO la escritura: la base que se fusiona sigue siendo la del repo.
    // Lo usa test-calibration.mjs para no reescribir el calibration.json del repo.
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

function calibrationFile(lang, level) {
  return path.join(ROOT, 'library', lang, level, 'calibration.json');
}

function loadExisting(lang, level) {
  const file = calibrationFile(lang, level);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadBank(lang, level) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'library', lang, level, 'questions.json'), 'utf8'));
}

function usageFromFile(file) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
    return raw.items;
  }
  if (Array.isArray(raw.events)) {
    const agg = {};
    for (const ev of raw.events) {
      const id = ItemCalibration.normalizeItemId(ev.itemId || ev.id);
      if (!id) continue;
      if (!agg[id]) agg[id] = { correct: 0, total: 0, module: ev.module, teil: ev.teil };
      agg[id].total++;
      if (ev.correct === true || ev.ok === true) agg[id].correct++;
    }
    return agg;
  }
  return raw;
}

function usageFromAnalytics(exportFile) {
  const snap = JSON.parse(fs.readFileSync(path.resolve(exportFile), 'utf8'));
  const agg = {};
  for (const profile of Object.values(snap.profiles || {})) {
    for (const [id, stat] of Object.entries(profile.itemStats || {})) {
      const nid = ItemCalibration.normalizeItemId(id);
      if (!nid) continue;
      if (!agg[nid]) agg[nid] = { correct: 0, total: 0, module: stat.module, teil: stat.teil };
      agg[nid].correct += stat.correct || 0;
      agg[nid].total += stat.total || 0;
      if (stat.module) agg[nid].module = stat.module;
      if (stat.teil != null) agg[nid].teil = stat.teil;
    }
  }
  return agg;
}

function summarize(cal) {
  const items = Object.values(cal.items || {});
  const withData = items.filter((i) => i.attempts >= 3);
  const avgP =
    withData.length > 0 ? withData.reduce((s, i) => s + i.pValue, 0) / withData.length : null;
  return { total: items.length, measured: withData.length, avgP };
}

const args = parseArgs(process.argv.slice(2));
let calibration = loadExisting(args.lang, args.level);

if (args.seedPriors && !calibration) {
  const bank = loadBank(args.lang, args.level);
  calibration = ItemCalibration.seedPriorsFromBank(bank, { lang: args.lang, level: args.level });
  console.log(`Seeded priors for ${Object.keys(calibration.items).length} bank items`);
}

let usage = {};
if (args.usage) usage = usageFromFile(args.usage);
if (args.fromAnalytics) usage = { ...usage, ...usageFromAnalytics(args.fromAnalytics) };

if (Object.keys(usage).length) {
  calibration = ItemCalibration.mergeUsageIntoCalibration(calibration || {}, usage, {
    lang: args.lang,
    level: args.level,
  });
  console.log(`Merged usage for ${Object.keys(usage).length} item keys`);
}

if (!calibration?.items || !Object.keys(calibration.items).length) {
  console.error('No calibration data — use --seed-priors and/or --usage');
  process.exit(1);
}

const summary = summarize(calibration);
console.log(
  `Calibration: ${summary.total} items, ${summary.measured} measured (≥3 attempts)` +
    (summary.avgP != null ? `, avg p=${summary.avgP.toFixed(3)}` : ''),
);

if (args.dryRun) {
  console.log('Dry-run — not writing file.');
  process.exit(0);
}

const outFile = args.out ? path.resolve(ROOT, args.out) : calibrationFile(args.lang, args.level);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(calibration, null, 2) + '\n', 'utf8');
console.log(`Wrote ${path.relative(ROOT, outFile)}`);
