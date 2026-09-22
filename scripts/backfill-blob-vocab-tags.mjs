#!/usr/bin/env node
/**
 * backfill-blob-vocab-tags — fills `vocabularyTags` on parts already published to
 * Blobs. It generates NO content and touches NO other field.
 *
 *   node scripts/backfill-blob-vocab-tags.mjs --lang de --level B1
 *   node scripts/backfill-blob-vocab-tags.mjs --lang de --level B1 --module lesen
 *   node scripts/backfill-blob-vocab-tags.mjs --lang de --level B1 --apply
 *
 * SAFETY: no --apply = dry-run, ZERO writes. With --apply it writes through
 * casWriteJson (etag + onlyIfMatch), so a concurrent write causes a retry
 * instead of being clobbered.
 *
 * Why this exists: the repo hook says questions.json changes reach blobs via
 * `seed-from-bank --apply`, but that has been blocked since July 2026 (it let
 * unvalidated bank parts into the personal pool). The route that script points
 * to, `pool-fill-teil --publish`, GENERATES new content with AI — it cannot
 * update metadata on parts that already exist. This only fills one field.
 *
 * Deliberately conservative:
 *   • only fills questions whose blob has fewer than 3 tags,
 *   • never overwrites tags the blob already carries,
 *   • only writes parts where something actually changes.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile, ROOT } from './lib/loadEnv.mjs';
import { tagsForQuestion } from './lib/questionVocabTags.mjs';

const require = createRequire(import.meta.url);
loadEnvFile();
const { getStore } = require('@netlify/blobs');
const { casWriteJson } = require(path.join(ROOT, 'netlify/functions/lib/casBlob.js'));

const MIN_TAGS = 3;

function parseArgs() {
  const a = process.argv.slice(2);
  const val = (flag, dflt) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : dflt);
  return {
    lang: val('--lang', 'de'),
    level: String(val('--level', 'B1')).toUpperCase(),
    module: val('--module', null),
    limit: Number(val('--limit', '0')) || 0,
    outJson: val('--out-json', null),
    apply: a.includes('--apply'),
  };
}

/** question id -> vocabularyTags, from the local bank. */
function loadBankTags(lang, level) {
  const file = path.join(ROOT, 'library', lang, level, 'questions.json');
  if (!fs.existsSync(file)) {
    console.error(`\n✗ ABORT: no existe el banco ${file}\n`);
    process.exit(1);
  }
  const bank = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map();
  for (const q of bank.questions || []) {
    const tags = q.vocabularyTags || [];
    if (q.id && tags.length >= MIN_TAGS) map.set(q.id, tags);
  }
  return map;
}

/** A part's questions, whether they arrive as `questions` or as `items`. */
function partQuestions(payload) {
  return [...(payload?.questions || []), ...(payload?.items || [])];
}

/** Part text used as context when the question alone does not yield 3 tags. */
function partContext(payload) {
  const passage = payload?.passage;
  const chunks = [typeof passage === 'string' ? passage : passage?.text, payload?.instruction];
  for (const ad of payload?.ads || []) chunks.push(typeof ad === 'string' ? ad : ad?.text);
  return chunks.filter(Boolean).join(' ');
}

/**
 * Applies tags to a copy of the payload. Two sources, in this order:
 *   1. the local bank, by id — for `gen-*` questions, which originated there;
 *   2. the blob's own content — for `ql_*` questions, which originated in blobs
 *      and have no bank equivalent (`library/reusable-seed/de_B1.json` turned
 *      out to be a July pull OF the blobs, not a separate source).
 * @returns {{ deBanco: number, deContenido: number, sinTags: number, already: number, payload: object }}
 */
function planPart(payload, bankTags) {
  const next = JSON.parse(JSON.stringify(payload));
  const context = partContext(next);
  let deBanco = 0;
  let deContenido = 0;
  let sinTags = 0;
  let already = 0;
  for (const q of partQuestions(next)) {
    if ((q.vocabularyTags || []).length >= MIN_TAGS) {
      already += 1;
      continue;
    }
    const fromBank = q.id ? bankTags.get(q.id) : null;
    if (fromBank) {
      q.vocabularyTags = fromBank;
      deBanco += 1;
      continue;
    }
    const derived = tagsForQuestion(q, context);
    if (derived.length) {
      q.vocabularyTags = derived;
      deContenido += 1;
      continue;
    }
    sinTags += 1;
  }
  return { deBanco, deContenido, sinTags, already, payload: next, changed: deBanco + deContenido };
}

async function main() {
  const opts = parseArgs();
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) {
    console.error('\n✗ ABORT: faltan NETLIFY_SITE_ID o NETLIFY_API_TOKEN / NETLIFY_AUTH_TOKEN en .env\n');
    process.exit(1);
  }

  const bankTags = loadBankTags(opts.lang, opts.level);
  const store = getStore({ name: 'lexicoil-data', siteID, token });
  const prefix = `reusable_part:${opts.lang}:${opts.level}:${opts.module ? `${opts.module}:` : ''}`;

  let blobs;
  try {
    ({ blobs } = await store.list({ prefix }));
  } catch (e) {
    // Fail-closed, like verify-blobs-vs-seed: no live index means nothing is reported.
    console.error(`\n✗ ABORT: no se pudo listar blobs (${e.message})\n`);
    process.exit(1);
  }
  if (opts.limit) blobs = blobs.slice(0, opts.limit);

  console.log(`\n══ backfill-blob-vocab-tags (${opts.apply ? 'APPLY' : 'dry-run'}) ══ ${opts.lang}/${opts.level}${opts.module ? `/${opts.module}` : ''} ══`);
  console.log(`  banco: ${bankTags.size} preguntas con >=${MIN_TAGS} tags`);
  console.log(`  blobs: ${blobs.length} partes bajo "${prefix}"\n`);

  const stats = { partes: 0, partesTocadas: 0, deBanco: 0, deContenido: 0, sinTags: 0, yaTenian: 0, escritas: 0, errores: 0 };
  const porModulo = {};
  const ejemplos = [];
  const planOut = [];

  for (const b of blobs) {
    let payload;
    try {
      payload = await store.get(b.key, { type: 'json' });
    } catch (e) {
      stats.errores += 1;
      console.warn(`  ⚠ lectura falló key=${b.key} (${e.message})`);
      continue;
    }
    if (!payload) continue;
    stats.partes += 1;

    const plan = planPart(payload, bankTags);
    stats.deBanco += plan.deBanco;
    stats.deContenido += plan.deContenido;
    stats.sinTags += plan.sinTags;
    stats.yaTenian += plan.already;

    const mod = b.key.split(':')[3] || '?';
    porModulo[mod] ||= { partes: 0, rellenadas: 0, sinTags: 0 };
    porModulo[mod].partes += 1;
    porModulo[mod].rellenadas += plan.changed;
    porModulo[mod].sinTags += plan.sinTags;

    if (!plan.changed) continue;
    stats.partesTocadas += 1;
    if (opts.outJson) {
      for (const q of partQuestions(plan.payload)) {
        if ((q.vocabularyTags || []).length >= MIN_TAGS) planOut.push({ key: b.key, id: q.id, tags: q.vocabularyTags });
      }
    }
    if (ejemplos.length < 3) {
      const q = partQuestions(plan.payload).find((x) => (x.vocabularyTags || []).length >= MIN_TAGS);
      ejemplos.push({ key: b.key, id: q?.id, tags: q?.vocabularyTags });
    }

    if (!opts.apply) continue;
    try {
      await casWriteJson(
        store,
        b.key,
        (current) => {
          // Re-planned against what CAS just read: if someone else wrote in the
          // meantime, the tags land on THEIR version, not on our stale one.
          if (!current) return { skip: true, result: 'gone' };
          const fresh = planPart(current, bankTags);
          if (!fresh.changed) return { skip: true, result: 'noop' };
          return { payload: fresh.payload, result: 'written' };
        },
        { logTag: '[backfill-vocab]' },
      );
      stats.escritas += 1;
    } catch (e) {
      stats.errores += 1;
      console.warn(`  ⚠ escritura falló key=${b.key} (${e.message})`);
    }
  }

  console.log('  ┌─ RESULTADO ────────────────────────────────────');
  console.log(`  │ partes leídas            ${stats.partes}`);
  console.log(`  │ partes que cambiarían    ${stats.partesTocadas}`);
  console.log(`  │ a rellenar desde banco   ${stats.deBanco}`);
  console.log(`  │ a rellenar del contenido ${stats.deContenido}`);
  console.log(`  │ ya tenían tags           ${stats.yaTenian}`);
  console.log(`  │ imposibles (texto corto) ${stats.sinTags}`);
  if (opts.apply) console.log(`  │ partes escritas          ${stats.escritas}`);
  console.log(`  │ errores                  ${stats.errores}`);
  console.log('  ├─ por módulo ───────────────────────────────────');
  for (const [mod, s] of Object.entries(porModulo).sort()) {
    console.log(`  │ ${mod.padEnd(10)} partes ${String(s.partes).padStart(4)} · rellenaría ${String(s.rellenadas).padStart(5)} · imposibles ${String(s.sinTags).padStart(4)}`);
  }
  console.log('  └────────────────────────────────────────────────');

  if (ejemplos.length) {
    console.log('\n  ejemplos de lo que se escribiría:');
    for (const e of ejemplos) console.log(`    ${e.key}\n      ${e.id} → ${JSON.stringify(e.tags)}`);
  }

  if (opts.outJson) {
    fs.writeFileSync(opts.outJson, JSON.stringify(planOut, null, 1), 'utf8');
    console.log(`\n  plan volcado en ${opts.outJson} (${planOut.length} preguntas)`);
  }

  if (!opts.apply) {
    console.log('\n  ℹ dry-run: no se ha escrito nada. Añade --apply para aplicarlo.\n');
  }
  if (stats.errores) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`\n✗ ABORT: ${e.stack || e.message}\n`);
  process.exit(1);
});
