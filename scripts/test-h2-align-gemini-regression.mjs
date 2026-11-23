#!/usr/bin/env node
/** Regression — CHK-H2-ALIGN false positives fixed in horenPictureMatching.js (2026-08-08). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HPM = require(path.join(ROOT, 'js/engine/horenPictureMatching.js'));

const FILES = [
  'horen-t2-gemini-102.json',
  'horen-t2-gemini-103.json',
  'horen-t2-gemini-104.json',
  'horen-t2-gemini-106.json',
  'horen-t2-gemini-078.json',
  'horen-t2-gemini-098.json',
  'horen-t2-gemini-105.json',
  'horen-t2-cur-education.json',
];

let failed = 0;
for (const name of FILES) {
  const batch = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'batches/ready/pool-verified/A2', name), 'utf8'),
  );
  const issues = HPM.validatePictureMatchingAlign(batch, { module: 'horen', teil: 2, level: 'A2' });
  if (issues.length) {
    console.error(`FAIL ${name}:`, issues.join('; '));
    failed += 1;
  } else {
    console.log(`OK   ${name}: 0 CHK-H2-ALIGN issues (keys unchanged)`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) still failing`);
  process.exit(1);
}
console.log('\nH2 align gemini regression passed.');
