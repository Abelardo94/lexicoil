#!/usr/bin/env node
/**
 * upload-tts-cache-to-blobs.mjs — sube los clips de library/tts-cache/ a Netlify Blobs.
 *
 * Por que existe: library/tts-cache/ esta en .gitignore y el deploy sale de git, asi
 * que los clips nunca llegan a produccion por ahi. Y por git no caben: ~250 MB a
 * 64 kbps. La entrega es Blobs.
 *
 * El nombre del fichero local ya lleva la clave: `{voz}_{hash}.mp3` -> `tts:{voz}:{hash}`
 * (netlify/functions/lib/ttsCacheLib.js: cacheFileName / cacheKey). No se rehashea
 * ningun texto, asi que no hay forma de que la clave se desvie de la que pide la app.
 *
 * SEGURIDAD
 *   - Seco por defecto. Escribe solo con --apply.
 *   - Salta los MUDOS (< 1024 bytes, MIN_REAL_AUDIO_BYTES): los 112 clips de junio que
 *     habia en git eran stubs de 296 bytes y no son audio.
 *   - Salta lo que ya esta en Blobs, asi que se puede reanudar sin repetir gasto.
 *
 * Uso:
 *   node scripts/upload-tts-cache-to-blobs.mjs --lang de --level B1
 *   node scripts/upload-tts-cache-to-blobs.mjs --lang de --level B1 --apply
 *   node scripts/upload-tts-cache-to-blobs.mjs --all --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadEnvFile, ROOT } from './lib/loadEnv.mjs';
import { cacheDir, cacheKey, readCache } from './lib/ttsCache.mjs';
import { collectExamTtsJobs } from './lib/ttsJobs.mjs';
import { resolveServedExams } from './lib/servedExams.mjs';

loadEnvFile();
const require = createRequire(import.meta.url);
const { getStore } = require('@netlify/blobs');
const { MIN_REAL_AUDIO_BYTES } = require(path.join(ROOT, 'netlify/functions/lib/ttsCacheLib.js'));

const STORE_NAME = 'lexicoil-data';

function parseArgs(argv) {
  const out = { lang: null, level: null, all: false, apply: false, limit: 0, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') out.lang = String(argv[++i] || '').toLowerCase();
    else if (a === '--level') out.level = String(argv[++i] || '').toUpperCase();
    else if (a === '--all') out.all = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--limit') out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--concurrency') out.concurrency = Math.min(8, Math.max(1, Number(argv[++i]) || 4));
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.all && (!args.lang || !args.level)) {
  console.error('Uso: --lang de --level B1   (o --all). Añade --apply para escribir.');
  process.exit(1);
}

/**
 * La lista NO sale de escanear el directorio: sale de los clips que la app va a
 * pedir, calculados con la misma funcion que usa pregenerate-tts. Escanear el
 * directorio es lo que no funciona — hay 1995 stubs mudos de junio y clips con
 * claves viejas que ninguna version actual del codigo solicita.
 */
const dir = cacheDir();
if (!fs.existsSync(dir)) {
  console.error(`No existe ${dir}. Genera los clips antes con pregenerate-tts.mjs.`);
  process.exit(1);
}

const targets = args.all
  ? [['de', 'A2'], ['de', 'B1'], ['en', 'B1']]
  : [[args.lang, args.level]];

const planned = [];
const skipped = { sinGenerar: 0, mudos: 0 };
const vistos = new Set();

let examenesVistos = 0;
for (const [lang, level] of targets) {
  let served;
  try {
    served = await resolveServedExams(lang, level);
  } catch (err) {
    console.warn(`  aviso: ${lang}/${level} sin examenes servidos (${err.message})`);
    continue;
  }
  const exams = served?.exams || [];
  console.log(`  ${lang}/${level}: ${exams.length} examen(es) servidos`);
  examenesVistos += exams.length;
  for (const exam of exams) {
    for (const job of collectExamTtsJobs(exam, lang)) {
      const hit = readCache(job.voice, job.text, lang);
      if (!hit) { skipped.sinGenerar++; continue; }
      if (hit.bytes < MIN_REAL_AUDIO_BYTES) { skipped.mudos++; continue; }
      const key = cacheKey(job.voice, job.text);
      if (vistos.has(key)) continue;
      vistos.add(key);
      planned.push({ file: path.basename(hit.file), voice: job.voice, hash: hit.hash, bytes: hit.bytes, lang, key });
    }
  }
}

planned.sort((a, b) => a.key.localeCompare(b.key));
const totalBytes = planned.reduce((s, p) => s + p.bytes, 0);

console.log(`Pedidos por la app: ${planned.length + skipped.sinGenerar + skipped.mudos} clips · con audio listo: ${planned.length}`);
console.log(`Saltados → sin generar todavia: ${skipped.sinGenerar} · mudos (<${MIN_REAL_AUDIO_BYTES}B): ${skipped.mudos}`);
console.log(`Peso a subir: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

// Cero examenes no es "nada que subir": es que la seleccion no ha mirado nada.
// Este script existe justamente porque un cero silencioso ya nos engaño una vez.
if (!examenesVistos) {
  console.error('\nERROR: 0 examenes servidos. No es que no haya clips — es que no se ha');
  console.error('mirado ninguno. Revisa --lang/--level o resolveServedExams.');
  process.exit(1);
}

if (!planned.length) {
  console.log('\nNada que subir: hay examenes, pero ninguno tiene su audio generado todavia.');
  process.exit(0);
}

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error('\nFaltan NETLIFY_SITE_ID o NETLIFY_API_TOKEN en el .env.');
  process.exit(1);
}
const store = getStore({ name: STORE_NAME, siteID, token });

console.log('\nLeyendo lo que ya hay en producción…');
let existing;
try {
  const listed = await store.list({ prefix: 'tts:' });
  existing = new Set((listed.blobs || []).map((b) => b.key));
} catch (err) {
  console.error(`\nNo se pudo leer Blobs: ${err.message}`);
  console.error('Si es un 401, el token del .env no tiene acceso al store.');
  process.exit(1);
}
const pending = planned.filter((p) => !existing.has(p.key));
console.log(`Ya en producción: ${existing.size} · por subir: ${pending.length}`);

const work = args.limit ? pending.slice(0, args.limit) : pending;

if (!args.apply) {
  console.log('\n— SECO, no se escribe nada —');
  for (const p of work.slice(0, 10)) {
    console.log(`  ${p.key}  ${String(p.bytes).padStart(7)}B  ${p.lang}`);
  }
  if (work.length > 10) console.log(`  … y ${work.length - 10} más`);
  console.log(`\nSubiría ${work.length} clips. Añade --apply para hacerlo.`);
  process.exit(0);
}

console.log(`\nSubiendo ${work.length} clips (concurrencia ${args.concurrency})…`);
let ok = 0;
let fail = 0;
const errores = [];
let cursor = 0;

async function worker() {
  while (cursor < work.length) {
    const p = work[cursor++];
    const n = cursor;
    try {
      const audio = fs.readFileSync(path.join(dir, p.file));
      await store.setJSON(p.key, {
        audioBase64: audio.toString('base64'),
        contentType: 'audio/mpeg',
        voice: p.voice,
        lang: p.lang,
        textHash: p.hash,
        createdAt: Date.now(),
        source: 'pregenerated',
      });
      ok++;
      if (n % 25 === 0 || n === work.length) {
        console.log(`  ${n}/${work.length} · ok ${ok} · fallos ${fail}`);
      }
    } catch (err) {
      fail++;
      errores.push(`${p.key}: ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: args.concurrency }, worker));

console.log(`\nSubidos ${ok} · fallos ${fail}`);
if (errores.length) {
  console.log('Primeros errores:');
  for (const e of errores.slice(0, 5)) console.log(`  ${e}`);
  console.log('Vuelve a lanzar el mismo comando: salta lo ya subido y reintenta el resto.');
}

// Verificacion: releer una muestra de lo escrito, no fiarse del write.
if (ok) {
  const muestra = work.filter((p) => !errores.some((e) => e.startsWith(p.key))).slice(0, 3);
  console.log('\nVerificando una muestra…');
  for (const p of muestra) {
    try {
      const got = await store.get(p.key, { type: 'json' });
      const bytes = got?.audioBase64 ? Buffer.from(got.audioBase64, 'base64').length : 0;
      console.log(`  ${p.key} → ${bytes === p.bytes ? 'OK' : `DESCUADRE ${bytes} vs ${p.bytes}`}`);
    } catch (err) {
      console.log(`  ${p.key} → no se pudo releer: ${err.message}`);
    }
  }
}

process.exit(fail ? 1 : 0);
