#!/usr/bin/env node
/**
 * Audit SEPARABLE_INFINITIVES for false positives on ambiguous prefixes
 * (über-, um-, durch-, unter-, be-).
 *
 * Usage: node scripts/audit-separable-allowlist-ambiguous-prefix.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  SEPARABLE_INFINITIVES,
  INSEPARABLE_INFINITIVES,
} from './lib/enrichBatchMetadata.mjs';
import { classifyDwdsHtml } from './lib/dwdsSeparableClassify.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SeparableResolve = require(path.join(ROOT, 'js/engine/separableResolve.js'));
const OUT = path.join(
  ROOT,
  'batches/ready/gate-logs/separable-allowlist-ambiguous-prefix-audit-2026-08-02.json',
);

const PREFIX_GROUPS = {
  'über-': { ambiguous: true, note: 'Dual accent — default untrennbar unless Grammatik split proven' },
  'um-': { ambiguous: false, note: 'Mostly trennbar (umsetzen, umziehen)' },
  'durch-': { ambiguous: true, note: 'Mostly untrennbar (durchführen)' },
  'unter-': { ambiguous: true, note: 'Mixed — untergehen trennbar; unterschreiben untrennbar' },
  'be-': { ambiguous: true, note: 'Mostly untrennbar (besuchen); beitragen/beibringen trennbar' },
};

/** Curated verdict for ambiguous-prefix allowlist entries (human + DWDS spot-check 2026-08-02). */
const CURATED = {
  umsetzen: { separable: true, verdict: 'ok' },
  umsteigen: { separable: true, verdict: 'ok' },
  umziehen: { separable: true, verdict: 'ok' },
  untergehen: { separable: true, verdict: 'ok' },
  beitragen: { separable: true, verdict: 'ok' },
  beibringen: { separable: true, verdict: 'ok' },
  übernehmen: { separable: false, verdict: 'removed', reason: 'untrennbar (asumir); DWDS false positive via «… über» in examples' },
  überweisen: { separable: false, verdict: 'removed', reason: 'untrennbar (transferencia bancaria)' },
  durchführen: { separable: false, verdict: 'removed', reason: 'untrennbar (realizar); DWDS weak split evidence' },
  unterschreiben: { separable: false, verdict: 'removed', reason: 'untrennbar' },
};

function prefixOf(w) {
  for (const p of Object.keys(PREFIX_GROUPS)) {
    const stem = p.replace(/-$/, '');
    if (w.startsWith(stem)) return p;
  }
  return null;
}

async function dwdsClassify(lemma) {
  const url = `https://www.dwds.de/wb/${encodeURIComponent(lemma)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'LexiCoil-separable-audit/1.0' } });
  const html = await res.text();
  return classifyDwdsHtml(lemma, html);
}

const allow = [...SeparableResolve.SEPARABLE_INFINITIVES].sort();
const inAllowAmbiguous = allow.filter((w) => prefixOf(w));

const removed = ['übernehmen', 'überweisen', 'durchführen', 'unterschreiben'];
const removedStillPresent = removed.filter((w) => SeparableResolve.SEPARABLE_INFINITIVES.has(w));

const perLemma = [];
for (const lemma of Object.keys(CURATED)) {
  const cur = CURATED[lemma];
  const inAllow = SeparableResolve.SEPARABLE_INFINITIVES.has(lemma);
  const inDeny = INSEPARABLE_INFINITIVES.has(lemma);
  let dwds = null;
  try {
    dwds = await dwdsClassify(lemma);
  } catch (e) {
    dwds = { status: 'error', error: e.message };
  }
  perLemma.push({
    lemma,
    prefix: prefixOf(lemma),
    curatedSeparable: cur.separable,
    verdict: cur.verdict,
    reason: cur.reason || null,
    inAllowlist: inAllow,
    inDenylist: inDeny,
    allowlistCorrect: cur.separable ? inAllow && !inDeny : !inAllow && inDeny,
    dwds: dwds?.status ? { status: dwds.status, separable: dwds.separable, reasons: dwds.reasons } : dwds,
  });
}

const syncOk = SeparableResolve.SEPARABLE_INFINITIVES.size === SEPARABLE_INFINITIVES.size
  && [...SeparableResolve.SEPARABLE_INFINITIVES].every((w) => SEPARABLE_INFINITIVES.has(w));

const report = {
  generatedAt: new Date().toISOString(),
  scope: 'SEPARABLE_INFINITIVES ambiguous-prefix audit (über/um/durch/unter/be)',
  rootCause: {
    broadRule: false,
    detail: 'No rule «all über- verbs are separable». Only 4 false positives were manually in allowlist without Grammatik-line verification. DWDS classifier matched collocation «… über» on example sentences.',
  },
  fix: {
    removedFromAllowlist: removed,
    addedToINSEPARABLE_INFINITIVES: removed,
    files: [
      'scripts/lib/enrichBatchMetadata.mjs',
      'js/engine/separableResolve.js',
      'scripts/lib/dwdsSeparableClassify.mjs',
    ],
  },
  allowlistSize: {
    before: 269,
    after: SeparableResolve.SEPARABLE_INFINITIVES.size,
    syncOk,
  },
  ambiguousPrefixInAllowlist: inAllowAmbiguous,
  removedStillPresent,
  perLemma,
  allCorrect: removedStillPresent.length === 0
    && perLemma.every((r) => r.allowlistCorrect)
    && syncOk,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  out: OUT,
  allowlistAfter: report.allowlistSize.after,
  removedStillPresent,
  allCorrect: report.allCorrect,
  ambiguousStillInAllow: inAllowAmbiguous,
}, null, 2));

if (!report.allCorrect) process.exit(1);
