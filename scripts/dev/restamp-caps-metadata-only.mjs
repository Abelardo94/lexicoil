#!/usr/bin/env node
/**
 * Restamp _germanCapsNormalizeVersion only — no text normalization.
 *   node scripts/dev/restamp-caps-metadata-only.mjs --dry-run
 *   node scripts/dev/restamp-caps-metadata-only.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/loadEnv.mjs';
import { GERMAN_CAPS_NORMALIZE_VERSION } from '../lib/germanCapsNormalize.mjs';

const apply = process.argv.includes('--apply');
const levels = ['B1', 'A2', 'B2'];
let touched = 0;

for (const level of levels) {
  const dir = path.join(ROOT, 'batches/ready/pool-verified', level);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const abs = path.join(dir, file);
    const batch = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (batch._germanCapsNormalizeVersion === GERMAN_CAPS_NORMALIZE_VERSION) continue;
    batch._germanCapsNormalizeVersion = GERMAN_CAPS_NORMALIZE_VERSION;
    batch._germanCapsMetadataRestampAt = new Date().toISOString();
    batch._germanCapsMetadataRestampNote = 'metadata-only; no applyGermanCapsNormalize';
    touched++;
    if (apply) fs.writeFileSync(abs, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
  }
}

console.log(JSON.stringify({ apply, version: GERMAN_CAPS_NORMALIZE_VERSION, touched }, null, 2));
