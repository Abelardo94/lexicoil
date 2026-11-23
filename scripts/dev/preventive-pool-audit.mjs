#!/usr/bin/env node
/**
 * Preventive pool audit — B1 / A2 / B2 (report + optional A/B/C apply).
 *
 *   node scripts/dev/preventive-pool-audit.mjs --phase anglicism --level all
 *   node scripts/dev/preventive-pool-audit.mjs --phase caps --level A2 --apply
 *   node scripts/dev/preventive-pool-audit.mjs --phase lexical --level all
 *
 * Phases: anglicism | caps | lexical | lt-ping | summary
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib/loadEnv.mjs';
import { checkLexical } from '../lib/lexicalCheck.mjs';
import {
  anglicismIssuesForText,
  findRawEnglishIssues,
  RAW_ENGLISH_PATTERNS,
} from '../lib/anglicismPolicy.mjs';
import {
  applyGermanCapsNormalize,
  GERMAN_CAPS_NORMALIZE_VERSION,
} from '../lib/germanCapsNormalize.mjs';
import { pingLanguageTool } from '../lib/qualityGates/languageToolGate.mjs';

const LEVELS = ['B1', 'A2', 'B2'];
const POOL_ROOT = path.join(ROOT, 'batches/ready/pool-verified');
const LOG_DIR = path.join(ROOT, 'batches/ready/gate-logs');
const STAMP = new Date().toISOString().slice(0, 10);

const args = process.argv.slice(2);
function argVal(flag, fb) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fb;
}
const phase = String(argVal('--phase', 'lexical')).toLowerCase();
const levelArg = String(argVal('--level', 'all')).toUpperCase();
const apply = args.includes('--apply');
const levels = levelArg === 'ALL' ? LEVELS : [levelArg];

function listPoolFiles(level) {
  const dir = path.join(POOL_ROOT, level);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => ({ level, file: f, abs: path.join(dir, f) }));
}

function collectGermanTexts(batch) {
  const out = [];
  const push = (field, text) => {
    const t = String(text || '').trim();
    if (t) out.push({ field, text: t });
  };
  for (const p of batch.passages || []) {
    push(`passage:${p.id || '?'}:title`, p.title);
    push(`passage:${p.id || '?'}:text`, p.text);
    push(`passage:${p.id || '?'}:transcript`, p.transcript);
  }
  for (const q of batch.questions || []) {
    push(`question:${q.id || '?'}:question`, q.question);
    push(`question:${q.id || '?'}:explanation`, q.explanation);
    push(`question:${q.id || '?'}:signText`, q.signText);
    push(`question:${q.id || '?'}:statement`, q.statement);
    push(`question:${q.id || '?'}:transcript`, q.transcript);
    for (const o of q.options || []) push(`question:${q.id || '?'}:option`, o);
  }
  push('instruction', batch.instruction);
  return out;
}

/** Deterministic RAW_ENGLISH substitutions (category A). */
const AUTO_TEXT_FIXES = RAW_ENGLISH_PATTERNS.map(({ term, suggestion }) => ({
  term,
  suggestion,
}));

function applyRawEnglishFixes(batch) {
  let raw = JSON.stringify(batch);
  const applied = [];
  for (const { term, suggestion } of AUTO_TEXT_FIXES) {
    const m = raw.match(term);
    if (!m) continue;
    const repl = suggestion.split('/')[0].trim().replace(/^«|»$/g, '');
    if (!repl || repl.includes('p. ej')) continue;
    const find = m[0];
    const re = new RegExp(term.source, term.flags);
    const next = raw.replace(re, (match) => {
      if (/^[A-Z]/.test(match)) {
        return repl.charAt(0).toUpperCase() + repl.slice(1);
      }
      return repl;
    });
    if (next !== raw) {
      applied.push({ find, replace: repl, suggestion });
      raw = next;
    }
  }
  if (!applied.length) return { batch, applied };
  const out = JSON.parse(raw);
  out._preventiveAuditFixAt = new Date().toISOString();
  out._preventiveAuditFixNote = applied.map((a) => `${a.find}→${a.replace}`).join('; ');
  return { batch: out, applied };
}

function scanAnglicism(levelFiles) {
  const hits = [];
  const autoFixLog = [];
  for (const { level, file, abs } of levelFiles) {
    let batch = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const lx = checkLexical(batch, { level });
    const angIssues = (lx.issues || []).filter(
      (i) => /inglés|anglicism|Latecoming|workshop|gardening/i.test(i),
    );
    if (!angIssues.length) continue;

    const row = {
      level,
      file,
      category: 'A',
      issues: angIssues,
      pattern: null,
    };

    if (apply) {
      const { batch: fixed, applied } = applyRawEnglishFixes(batch);
      if (applied.length) {
        fs.writeFileSync(abs, `${JSON.stringify(fixed, null, 2)}\n`, 'utf8');
        autoFixLog.push({ level, file, applied, category: 'A' });
        batch = fixed;
      }
    }

    const still = checkLexical(batch, { level });
    const remaining = (still.issues || []).filter((i) => /inglés|anglicism/i.test(i));
    if (remaining.length) {
      row.category = remaining.some((r) => /workshop|Latecoming/i.test(r)) ? 'D' : 'A';
      row.issues = remaining;
      row.promptGap =
        'Prompt: prohibir inglés crudo en RAW_ENGLISH_PATTERNS; reforzar celda con ejemplos DE (ver anglicismPolicy + checklist generación).';
      hits.push(row);
    } else if (!apply) {
      hits.push(row);
    }
  }
  return { hits, autoFixLog, filesScanned: levelFiles.length };
}

function scanCaps(levelFiles) {
  const hits = [];
  const autoFixLog = [];
  for (const { level, file, abs } of levelFiles) {
    const batch = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const before = JSON.stringify(batch);
    const { batch: normalized, stats } = applyGermanCapsNormalize(structuredClone(batch));
    const after = JSON.stringify(normalized);
    const stale = batch._germanCapsNormalizeVersion !== GERMAN_CAPS_NORMALIZE_VERSION;
    const wouldChange = before !== after;

    if (!wouldChange && !stale) continue;

    const sampleFields = [];
    for (const { field, text } of collectGermanTexts(batch)) {
      const { batch: n } = applyGermanCapsNormalize(structuredClone(batch));
      const nText = collectGermanTexts(n).find((x) => x.field === field)?.text;
      if (nText && nText !== text) {
        sampleFields.push({ field, before: text.slice(0, 120), after: nText.slice(0, 120) });
        if (sampleFields.length >= 2) break;
      }
    }

    const row = {
      level,
      file,
      category: wouldChange ? 'A' : 'B',
      staleVersion: stale,
      currentVersion: batch._germanCapsNormalizeVersion || null,
      expectedVersion: GERMAN_CAPS_NORMALIZE_VERSION,
      stats,
      samples: sampleFields,
    };

    if (apply && wouldChange) {
      normalized._preventiveAuditFixAt = new Date().toISOString();
      normalized._preventiveAuditFixNote = `caps:${GERMAN_CAPS_NORMALIZE_VERSION}`;
      fs.writeFileSync(abs, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      autoFixLog.push({ level, file, stats, category: 'A' });
    } else {
      hits.push(row);
    }
  }
  return { hits, autoFixLog, filesScanned: levelFiles.length };
}

function scanLexicalAll(levelFiles) {
  const hits = [];
  const byPattern = new Map();
  for (const { level, file, abs } of levelFiles) {
    const batch = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const lx = checkLexical(batch, { level });
    if (lx.ok && !(lx.warnings || []).length) continue;
    const row = { level, file, issues: lx.issues, warnings: lx.warnings };
    hits.push(row);
    for (const issue of lx.issues || []) {
      const key = issue.replace(/^(passage|question):[^:]+:/, '').slice(0, 60);
      byPattern.set(key, (byPattern.get(key) || 0) + 1);
    }
  }
  const patterns = [...byPattern.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([pattern, count]) => ({ pattern, count }));
  return { hits, patterns, filesScanned: levelFiles.length };
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const levelFiles = levels.flatMap((lv) => listPoolFiles(lv));
  console.log(`[preventive-audit] phase=${phase} levels=${levels.join(',')} files=${levelFiles.length} apply=${apply}`);

  if (phase === 'lt-ping') {
    const ping = await pingLanguageTool();
    const out = path.join(LOG_DIR, `preventive-lt-ping-${STAMP}.json`);
    fs.writeFileSync(out, `${JSON.stringify({ ping, at: new Date().toISOString() }, null, 2)}\n`);
    console.log(JSON.stringify(ping, null, 2));
    process.exit(ping.ok ? 0 : 1);
  }

  let report;
  if (phase === 'anglicism') {
    report = { phase, ...scanAnglicism(levelFiles), at: new Date().toISOString() };
  } else if (phase === 'caps') {
    report = { phase, ...scanCaps(levelFiles), at: new Date().toISOString() };
  } else if (phase === 'lexical') {
    report = { phase, ...scanLexicalAll(levelFiles), at: new Date().toISOString() };
  } else {
    console.error(`Unknown phase: ${phase}`);
    process.exit(1);
  }

  const outPath = path.join(LOG_DIR, `preventive-${phase}-${STAMP}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, outPath)}`);
  console.log(
    `Scanned ${report.filesScanned} — hits=${report.hits?.length ?? 0} autoFixed=${report.autoFixLog?.length ?? 0}`,
  );
  if (report.patterns?.length) {
    console.log('Top patterns:');
    for (const p of report.patterns.slice(0, 8)) console.log(`  ${p.count}x ${p.pattern}`);
  }
  if (report.hits?.length) {
    for (const h of report.hits.slice(0, 15)) {
      console.log(`  [${h.level}] ${h.file} (${h.category || '?'})`);
      const first = (h.issues || [])[0] || (h.samples || [])[0];
      if (first) console.log(`    ${typeof first === 'string' ? first : JSON.stringify(first)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
