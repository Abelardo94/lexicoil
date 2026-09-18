#!/usr/bin/env node
/**
 * verify-blobs-vs-seed — compara el seed local con los blobs de producción (fail-closed).
 *
 *   node scripts/verify-blobs-vs-seed.mjs
 *   node scripts/verify-blobs-vs-seed.mjs --module horen
 *   node scripts/verify-blobs-vs-seed.mjs --module horen --teil 4
 *   node scripts/verify-blobs-vs-seed.mjs --ids gen-h4-003,gen-h4-005
 *
 * Fail-closed (igual que push-seed-to-blobs):
 *   • Error de red al list/get índice o payloads → ABORT, sin reportar divergencias.
 *   • Nunca compara contra backup local — solo blobs live vía @netlify/blobs.
 *
 * Divergencias (solo tras lectura live verificada):
 *   LOCAL_ONLY      — en seed, no en blobs
 *   CONTENT_DIFFERS — contenido semántico distinto (texto/claves/ads reales)
 *   COSMETIC        — solo ruido estructural (informativo, no bloquea)
 *   KEY_FORMAT      — correct uppercase MCQ (deuda norm., non-blocking)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadEnvFile, ROOT } from './lib/loadEnv.mjs';
import { buildUpdatedPayload, keySeqForPart } from './lib/mergeSeedBlobPayload.mjs';
import { progressWriter } from './lib/mapWithConcurrency.mjs';

// One writer per label: progressWriter throttles repaints with its own state, so
// building a fresh one per tick would repaint on every single item.
const progressWriters = new Map();
const progress = (label) => {
  if (!progressWriters.has(label)) progressWriters.set(label, progressWriter(label));
  return progressWriters.get(label);
};
import {
  BlobStoreReadError,
  loadBlobIndexStrict,
  runVerifyComparison,
  abortVerifyMessage,
} from './lib/pushSeedBlobStrict.mjs';

loadEnvFile();

const require = createRequire(import.meta.url);
const { getStore } = require('@netlify/blobs');

const argv = process.argv.slice(2);
const filterModule = argv.includes('--module') ? argv[argv.indexOf('--module') + 1] : null;
const filterTeil   = argv.includes('--teil')   ? Number(argv[argv.indexOf('--teil') + 1]) : null;
const specificIds  = argv.includes('--ids')
  ? argv[argv.indexOf('--ids') + 1].split(',').map(s => s.trim())
  : null;
const seedPath = path.join(ROOT, 'library/reusable-seed/de_B1.json');

// Optional metric only — NEVER used as blob fallback for CONTENT_DIFFERS.
const BACKUP_PATH = path.join(ROOT, 'backups/pre-key-entropy-2026-07-03.json');
let backupById = null;
if (fs.existsSync(BACKUP_PATH)) {
  try {
    const backupRaw = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
    backupById = new Map((backupRaw.snapshots || []).map((b) => [b._id, b.payload]));
  } catch { /* optional metric */ }
}

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error('\n✗ ABORT: faltan NETLIFY_SITE_ID o NETLIFY_API_TOKEN / NETLIFY_AUTH_TOKEN en .env\n');
  process.exit(1);
}

const store = getStore({ name: 'lexicoil-data', siteID, token });

// ── Load seed ────────────────────────────────────────────────────────────────
const seedRaw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
let seedArr = Array.isArray(seedRaw) ? seedRaw : (seedRaw.records || []);
const pulledAt = seedRaw._pulledAt || null;
const renormalizedAt = seedRaw._renormalizedKeyEntropyAt || null;

if (filterModule) seedArr = seedArr.filter(p => p.module === filterModule);
if (filterTeil != null) seedArr = seedArr.filter(p => (p.teil === filterTeil || p.part === filterTeil));
if (specificIds) seedArr = seedArr.filter(p => specificIds.includes(p.id || p.partId));

const MODULES = filterModule ? [filterModule] : ['lesen', 'horen', 'schreiben', 'sprechen'];

console.log(`\n${'═'.repeat(68)}`);
console.log(`  verify-blobs-vs-seed  [fail-closed — solo blobs live]`);
if (pulledAt) console.log(`  Seed snapshot: ${pulledAt}`);
if (renormalizedAt) console.log(`  Key-entropy renormalize: ${renormalizedAt}`);
if (filterModule) console.log(`  Filtro: ${filterModule}${filterTeil ? ` T${filterTeil}` : ''}`);
if (specificIds) console.log(`  IDs específicos: ${specificIds.join(', ')}`);
console.log(`${'═'.repeat(68)}\n`);

// ── Load blob index (fail-closed) ─────────────────────────────────────────────
console.log('Cargando índice de blobs (fail-closed)...');
let blobIndex;
let indexStats;
try {
  ({ blobIndex, indexStats } = await loadBlobIndexStrict(store, {
    modules: MODULES,
    onProgress: (mod, done, total) => progress(`  ${mod}`)(done, total),
  }));
} catch (err) {
  console.error(abortVerifyMessage(err instanceof BlobStoreReadError ? err : new BlobStoreReadError(String(err))));
  process.exit(1);
}

for (const mod of MODULES) {
  const m = indexStats.modules[mod] || { indexed: 0 };
  console.log(`  ${mod}: ${m.indexed} blobs cargados (live)`);
}
console.log(`  total índice live: ${indexStats.total}`);
console.log('');

// ── Compare (payload fetch failure → abort) ───────────────────────────────────
let results;
let mergeFailures;
let keySeqChangedInBlob = 0;
let keySeqChecked = 0;
process.stdout.write('Comparando blobs live vs merge esperado');
try {
  ({
    results,
    mergeFailures,
    keySeqChangedInBlob,
    keySeqChecked,
  } = await runVerifyComparison(seedArr, store, blobIndex, {
    buildPayload: buildUpdatedPayload,
    backupById,
    keySeqForPartFn: keySeqForPart,
    onProgress: (_phase, done, total) => progress('  payloads')(done, total),
  }));
} catch (err) {
  console.log(' ABORT\n');
  console.error(abortVerifyMessage(err instanceof BlobStoreReadError ? err : new BlobStoreReadError(String(err))));
  process.exit(1);
}
console.log(' done\n');

// ── Blob-only (informational) ─────────────────────────────────────────────────
const seedIds = new Set(seedArr.map(p => p.partId || p.id).filter(Boolean));
const blobOnly = [...blobIndex.keys()].filter(id => !seedIds.has(id));

function isAllMatchingType(blobPart) {
  const qs = blobPart.questions || [];
  return qs.length > 0 && qs.every(q => {
    const type = String(q.type || '').toLowerCase();
    return type === 'matching' || type === 'match' || type === 'zuordnung';
  });
}
const keyFormatMatchingDebt = results.KEY_FORMAT.filter(({ blobPart }) => isAllMatchingType(blobPart));
const keyFormatRealIssue    = results.KEY_FORMAT.filter(({ blobPart }) => !isAllMatchingType(blobPart));
const curBlobOnly    = blobOnly.filter(id => id.startsWith('cur-'));
const orphanBlobOnly = blobOnly.filter(id => !id.startsWith('cur-'));

const critical = results.LOCAL_ONLY.length + results.CONTENT_DIFFERS.length;

console.log(`${'═'.repeat(68)}`);
console.log(`  ┌─ DIVERGENCIAS DE CONTENIDO (objetivo: 0) — fuente: blobs live ─`);
console.log(`  │ ℹ  Índice leído OK: ${indexStats.total} entradas en Netlify`);

if (results.LOCAL_ONLY.length) {
  console.log(`  │ ❌ LOCAL_ONLY (en seed, no en blobs live): ${results.LOCAL_ONLY.length}`);
  for (const { id, seedPart } of results.LOCAL_ONLY) {
    const mod = seedPart.module || '?'; const teil = seedPart.teil ?? seedPart.part ?? '?';
    console.log(`  │    ${id.padEnd(45)} ${mod} T${teil}`);
  }
} else {
  console.log(`  │ ✅ LOCAL_ONLY:      0`);
}

if (results.CONTENT_DIFFERS.length) {
  console.log(`  │ ❌ CONTENT_DIFFERS (contenido real distinto): ${results.CONTENT_DIFFERS.length}`);
  for (const { id, realFields, fields } of results.CONTENT_DIFFERS) {
    const row = blobIndex.get(id);
    const show = realFields || fields;
    console.log(`  │    ${id.padEnd(45)} ${row?.module || '?'} T${row?.teil ?? '?'} · ${show.join(', ')}`);
  }
} else {
  console.log(`  │ ✅ CONTENT_DIFFERS: 0`);
}

if (results.COSMETIC?.length) {
  console.log(`  │ ℹ  COSMETIC (solo schema/campos vacíos — no bloquea): ${results.COSMETIC.length}`);
  if (results.COSMETIC.length <= 8) {
    for (const { id, cosmeticFields } of results.COSMETIC) {
      const row = blobIndex.get(id);
      console.log(`  │    ${id.padEnd(45)} ${row?.module || '?'} T${row?.teil ?? '?'} · ${cosmeticFields.join(', ')}`);
    }
  } else {
    console.log(`  │    (primeras 5)`);
    for (const { id, cosmeticFields } of results.COSMETIC.slice(0, 5)) {
      const row = blobIndex.get(id);
      console.log(`  │    ${id.padEnd(45)} ${row?.module || '?'} T${row?.teil ?? '?'} · ${cosmeticFields.join(', ')}`);
    }
    console.log(`  │    … y ${results.COSMETIC.length - 5} más`);
  }
}

if (keyFormatRealIssue.length) {
  console.log(`  │ ⚠  KEY_FORMAT MCQ uppercase (deuda norm., grader OK): ${keyFormatRealIssue.length}`);
  for (const { id, upperKeys } of keyFormatRealIssue) {
    const row = blobIndex.get(id);
    console.log(`  │    ${id.padEnd(45)} ${row?.module || '?'} T${row?.teil ?? '?'} · keys: ${upperKeys}`);
  }
  console.log(`  │    → grader puntúa correctamente (case-insensitive). Normalizar en sesión futura.`);
} else {
  console.log(`  │ ✅ KEY_FORMAT MCQ:  0`);
}

console.log(`  │`);
console.log(`  │ ✓  OK (contenido semántico coincide): ${results.OK.length}`);
console.log(`  ├─ DEUDA CONOCIDA (grader tolera, no es fallo del repair) ───────`);
console.log(`  │ ℹ  Matching uppercase by-design (L3 A-J, H4 speakers): ${keyFormatMatchingDebt.length} partes`);
if (orphanBlobOnly.length > 0) {
  console.log(`  │ ⚠  bank-* en blobs sin entrada en seed (MCQ huérfano): ${orphanBlobOnly.length} partes`);
}
if (curBlobOnly.length > 0) {
  console.log(`  │ ℹ  cur-* snapshots website (fuera de scope): ${curBlobOnly.length} partes`);
}
console.log(`  └${'─'.repeat(67)}`);

console.log('');
if (critical === 0) {
  console.log(`  ✅ 0 DIVERGENCIAS DE CONTENIDO — blobs live coinciden semánticamente con merge.`);
  if (results.COSMETIC?.length) {
    console.log(`  ℹ  ${results.COSMETIC.length} partes con ruido estructural (COSMETIC, no acción requerida).`);
  }
  if (backupById && keySeqChecked > 0) {
    console.log(`  ℹ  Secuencias nuevas en blobs live (métrica vs backup pre-push, NO usada en compare): ${keySeqChangedInBlob}/${keySeqChecked}`);
  }
  if (mergeFailures.length) {
    console.log(`  ⚠  ${mergeFailures.length} partes con error al reconstruir merge esperado.`);
  }
  const deudaNorm = keyFormatRealIssue.length + keyFormatMatchingDebt.length;
  if (deudaNorm > 0 || orphanBlobOnly.length > 0) {
    console.log(`  ⚠  Deuda de normalización (no bloquea grading):`);
    if (keyFormatRealIssue.length)    console.log(`       ${keyFormatRealIssue.length} partes MCQ uppercase`);
    if (keyFormatMatchingDebt.length) console.log(`       ${keyFormatMatchingDebt.length} partes matching uppercase by-design`);
    if (orphanBlobOnly.length)        console.log(`       ${orphanBlobOnly.length} bank-* huérfanos sin seed`);
  }
} else {
  console.log(`  ❌ ${critical} DIVERGENCIAS DE CONTENIDO (blobs live leídos OK).`);
  console.log(`  Ejecuta: node scripts/push-seed-to-blobs.mjs --dry-run`);
}
console.log(`${'═'.repeat(68)}\n`);

process.exit(critical > 0 ? 1 : 0);
