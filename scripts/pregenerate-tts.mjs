#!/usr/bin/env node
/**
 * Pre-generate TTS MP3s for the Hören the app actually serves.
 *
 * The source is resolved exactly like the browser does (scripts/lib/servedExams.mjs): levels
 * served published come from library/published-exams/, the rest from data/exams/<lang>_<level>.json.
 * Reading the legacy file unconditionally used to skip published-only exams — de/B1 serves 19
 * but the legacy file lists 16, so e17–e19 were never pregenerated.
 *
 * Uses the same textHash/cache file naming as netlify/functions/tts.js (ttsCacheLib.js).
 * Re-run after any Hören transcript edit — hash changes => cache miss => silence in prod.
 *
 * Usage:
 *   node scripts/pregenerate-tts.mjs --lang de --level B1
 *   node scripts/pregenerate-tts.mjs --lang de --level A2
 *   node scripts/pregenerate-tts.mjs --all-served
 *   node scripts/pregenerate-tts.mjs --lang de --level B1 --pool   # + Hören parts of library/reusable-seed
 *   node scripts/pregenerate-tts.mjs --lang de --level B1 --dry-run
 *   node scripts/pregenerate-tts.mjs --lang de --level B1 --verify
 *   node scripts/pregenerate-tts.mjs --lang de --level B1 --source legacy   # override
 *
 * Env: TTS_PROVIDER=elevenlabs, ELEVENLABS_API_KEY=...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadEnvFile, ROOT } from './lib/loadEnv.mjs';
import {
  cacheDir,
  manifestPath,
  examManifestPath,
  readCache,
  writeCache,
  normalizeTtsText,
  ttsTextHash,
} from './lib/ttsCache.mjs';
import { resolveServedExams } from './lib/servedExams.mjs';
import { collectExamTtsJobs, sanitizeTtsText, ttsVoiceForLang } from './lib/ttsJobs.mjs';

loadEnvFile();

const require = createRequire(import.meta.url);
const { synthesize, isProviderConfigured, resolveTtsModel } = require(path.join(ROOT, 'netlify/functions/lib/ttsProvider.js'));
const { resolveVoiceId, defaultVoiceForLang } = require(path.join(ROOT, 'netlify/functions/lib/ttsVoices.js'));
const ListeningScript = require(path.join(ROOT, 'js/bootstrap/listeningScript.js'));

const SERVED_TARGETS = [
  ['de', 'B1'],
  ['de', 'A2'],
  ['en', 'B1'],
];

function parseArgs(argv) {
  const out = {
    lang: 'de',
    level: 'B1',
    allServed: false,
    dryRun: false,
    force: false,
    verify: false,
    source: 'auto',
    pool: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') out.lang = String(argv[++i] || 'de').toLowerCase();
    else if (a === '--level') out.level = String(argv[++i] || 'B1').toUpperCase();
    else if (a === '--all-served') out.allServed = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--pool') out.pool = true;
    else if (a === '--source') out.source = String(argv[++i] || 'auto').toLowerCase();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage:
  node scripts/pregenerate-tts.mjs --lang de --level B1 [--dry-run|--verify|--force]
  node scripts/pregenerate-tts.mjs --all-served
  node scripts/pregenerate-tts.mjs --lang de --level B1 --source legacy|published

Source defaults to whatever the app serves (published for de/*, legacy otherwise).
Re-run after editing Hören transcripts in the source the level is served from.`);
}

/** Hören parts of the reusable pool (personal exams), converted exactly as the runtime does
 *  (personalLesenPoolFallback.reusablePartToHorenPart), so the transcripts — and with them
 *  the cache keys — are the ones the app will request. */
function poolHorenExams(lang, level) {
  const seedFile = path.join(ROOT, 'library/reusable-seed', `${lang}_${level}.json`);
  if (!fs.existsSync(seedFile)) return [];
  const PF = require(path.join(ROOT, 'js/engine/personalLesenPoolFallback.js'));
  const { loadBlueprintFile } = require(path.join(ROOT, 'netlify/functions/lib/hybridExamChunkPrompt.js'));
  const blueprint = loadBlueprintFile(lang, level);
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const out = [];
  for (const rec of (seed.records || seed).filter((r) => r.module === 'horen')) {
    const part = PF.reusablePartToHorenPart(rec, blueprint);
    if (part) out.push({ id: `pool:${rec.id}`, topic: `pool:${rec.id}`, horenParts: [part] });
  }
  return out;
}

async function synthJob(job, stats) {
  const { text, voice, lang } = job;
  const clean = sanitizeTtsText(text);
  if (!stats.force) {
    const hit = readCache(voice, clean, lang);
    if (hit) {
      stats.skipped++;
      return { ...job, text: clean, hash: hit.hash, cached: true, bytes: hit.bytes };
    }
  }

  if (stats.dryRun) {
    stats.missing++;
    return { ...job, text: clean, hash: ttsTextHash(clean), cached: false, dryRun: true };
  }

  let audio = null;
  for (let attempt = 0; attempt < 4 && !audio?.length; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    audio = await synthesize(clean, voice, lang);
  }
  if (!audio?.length) {
    stats.failed++;
    console.error(`  FAIL synth ${job.meta?.exam} T${job.meta?.teil ?? '?'} ${String(clean).slice(0, 60)}…`);
    return null;
  }

  const written = writeCache(voice, clean, audio);
  stats.generated++;
  stats.bytes += written.bytes;
  return { ...job, text: clean, hash: written.hash, cached: false, bytes: written.bytes };
}

async function pregenerateLevel(lang, level, opts) {
  const served = await resolveServedExams(lang, level, { source: opts.source });
  const exams = [...served.exams];
  if (opts.pool) exams.push(...poolHorenExams(lang, level));
  const stats = {
    generated: 0,
    skipped: 0,
    failed: 0,
    missing: 0,
    bytes: 0,
    dryRun: opts.dryRun,
    force: opts.force,
    jobs: 0,
  };
  const manifest = {
    lang,
    level,
    source: served.origin,
    sourceKind: served.source,
    provider: process.env.TTS_PROVIDER || 'none',
    model: resolveTtsModel(),
    generatedAt: new Date().toISOString(),
    exams: [],
  };

  const processed = new Set();
  for (const exam of exams) {
    // Catalog and pool share many transcripts: generate and count each clip once.
    const jobs = collectExamTtsJobs(exam, lang).filter((j) => {
      const k = `${j.voice}:${ttsTextHash(j.text)}`;
      if (processed.has(k)) return false;
      processed.add(k);
      return true;
    });
    stats.jobs += jobs.length;
    const entry = {
      topic: exam.topic || exam.id || 'exam',
      jobCount: jobs.length,
      clips: [],
    };

    for (const job of jobs) {
      if (!opts.verify) {
        const result = await synthJob(job, stats);
        if (result) {
          entry.clips.push({
            voice: result.voice,
            hash: result.hash,
            bytes: result.bytes,
            cached: result.cached,
            meta: result.meta,
            preview: result.text.slice(0, 80),
          });
        }
      }
      await new Promise((r) => setTimeout(r, opts.verify ? 0 : 120));
    }

    if (entry.clips.length) manifest.exams.push(entry);
  }

  if (opts.verify) {
    const missing = [];
    const checked = new Set();
    for (const exam of exams) {
      for (const job of collectExamTtsJobs(exam, lang)) {
        const k = `${job.voice}:${ttsTextHash(job.text)}`;
        if (checked.has(k)) continue;
        checked.add(k);
        if (!readCache(job.voice, job.text, lang)) {
          missing.push(job);
        }
      }
    }
    stats.verifyMissing = missing.length;
    if (missing.length) {
      console.error(`${lang}/${level} VERIFY FAIL: ${missing.length} clip(s) still missing cache`);
      missing.slice(0, 5).forEach((j) => {
        console.error(`  - ${j.meta?.exam} T${j.meta?.teil ?? '?'} ${j.voice}:${ttsTextHash(j.text)}`);
      });
    } else {
      console.log(`${lang}/${level} VERIFY OK: all ${stats.jobs} Hören clip(s) cached`);
    }
  }

  if (!opts.dryRun && manifest.exams.length) {
    fs.mkdirSync(path.dirname(examManifestPath(lang, level)), { recursive: true });
    fs.writeFileSync(examManifestPath(lang, level), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  console.log(
    `${lang}/${level} [${served.source}: ${served.origin}]: ${exams.length} exam(s), ${stats.jobs} clip(s) — +${stats.generated} new, ${stats.skipped} cached, ${stats.failed} failed` +
      (opts.dryRun ? `, ${stats.missing} would generate` : '') +
      (stats.bytes ? `, ${Math.round(stats.bytes / 1024)} KB written` : ''),
  );

  return stats;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

if (!args.dryRun && !args.verify && !isProviderConfigured()) {
  console.error('TTS provider not configured. Set TTS_PROVIDER=elevenlabs and ELEVENLABS_API_KEY');
  process.exit(1);
}

fs.mkdirSync(cacheDir(), { recursive: true });

const targets = args.allServed ? SERVED_TARGETS : [[args.lang, args.level]];
let exitCode = 0;
const totals = { generated: 0, skipped: 0, failed: 0, missing: 0, jobs: 0 };

for (const [lang, level] of targets) {
  try {
    const stats = await pregenerateLevel(lang, level, args);
    totals.generated += stats.generated;
    totals.skipped += stats.skipped;
    totals.failed += stats.failed;
    totals.missing += stats.missing || 0;
    totals.jobs += stats.jobs;
    if (stats.verifyMissing > 0) exitCode = 1;
    if (stats.failed > 0 && stats.generated === 0 && stats.skipped === 0) exitCode = 1;
  } catch (err) {
    console.error(`FAIL ${lang}/${level}:`, err.message);
    exitCode = 1;
  }
}

console.log(`\nCache dir: library/tts-cache/ (${fs.readdirSync(cacheDir()).filter((f) => f.endsWith('.mp3')).length} mp3 total)`);
console.log(
  `Totals: ${totals.jobs} clips — +${totals.generated} new, ${totals.skipped} cached, ${totals.failed} failed` +
    (args.dryRun ? `, ${totals.missing} would generate` : ''),
);

process.exit(exitCode);
