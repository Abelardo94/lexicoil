#!/usr/bin/env node
/**
 * Run SEM-1 over a reusable-seed pool and measure what it costs.
 *
 * Two jobs at once: with --apply it stamps sem1VerifiedAt on the records that
 * pass (which is what unblocks the pool — partPassesPublishGate needs it), and
 * it always records real token usage per part, so budget figures come from
 * measurement rather than estimate.
 *
 *   node scripts/run-sem1-over-seed.mjs --lang en --level B1 --apply
 *   node scripts/run-sem1-over-seed.mjs --lang de --level B1 --sample 30
 *   node scripts/run-sem1-over-seed.mjs --lang en --level B1 --dry-run --limit 5
 *
 * --sample N takes a stratified sample (evenly across module/Teil) instead of
 * the first N, which is what you want when auditing an existing pool rather
 * than working through a backlog. Sampling implies read-only.
 *
 * Records that fail go to quarantine (sem1Failed + the findings) rather than
 * being stamped — an unverified part must never reach the served pool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { validatePartSemantics, clearSemanticCache } from './lib/semanticValidator.mjs';
import { loadEnvFile, ROOT } from './lib/loadEnv.mjs';

loadEnvFile();

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const lang = String(flagValue('--lang', 'en')).toLowerCase();
const level = String(flagValue('--level', 'B1')).toUpperCase();
const sample = Number(flagValue('--sample', 0)) || 0;
const limit = Number(flagValue('--limit', 0)) || Infinity;
// Sampling audits a pool we are not repairing in this pass, so it never writes.
const apply = argv.includes('--apply') && !sample;

if (argv.includes('--apply') && sample) {
  console.log('--sample es solo lectura; se ignora --apply.\n');
}

const SEED = path.join(ROOT, `library/reusable-seed/${lang}_${level}.json`);
const REPORT = path.join(ROOT, `docs/audit/sem1-${lang}_${level}.json`);

if (!fs.existsSync(SEED)) {
  console.error(`No existe ${path.relative(ROOT, SEED)}`);
  process.exit(1);
}

// gemini-2.5-flash paid-tier rates; free tier bills nothing but the token
// counts are the same, so the figure below is the "if we were paying" number.
const USD_PER_MTOK_IN = 0.30;
const USD_PER_MTOK_OUT = 2.50;

const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const records = seed.records || seed;

/** Round-robin across module/Teil so a sample is not all one slot. */
function stratify(pool, n) {
  const bySlot = new Map();
  for (const r of pool) {
    const k = `${r.module}:${r.teil}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(r);
  }
  const queues = [...bySlot.keys()].sort().map((k) => bySlot.get(k));
  const out = [];
  for (let round = 0; out.length < n; round += 1) {
    let placed = false;
    for (const q of queues) {
      if (round >= q.length) continue;
      out.push(q[round]);
      placed = true;
      if (out.length === n) break;
    }
    if (!placed) break; // every queue exhausted
  }
  return out;
}

// Sampling audits what is already stamped; the backlog mode takes what is not.
const pool = sample
  ? records.filter((r) => !r.sem1Skipped)
  : records.filter((r) => !r.sem1Skipped && !r.sem1VerifiedAt && !r.sem1Failed);

console.log(
  `Piscina ${lang}/${level}: ${records.length} registros · ${pool.length} ${
    sample ? 'candidatos a muestreo (sellados incluidos)' : 'sin SEM-1'
  }`,
);
if (!pool.length) {
  console.log('Nada que verificar.');
  process.exit(0);
}

const todo = sample
  ? stratify(pool, Math.min(sample, pool.length))
  : pool.slice(0, Number.isFinite(limit) ? limit : pool.length);

console.log(
  `Verificando ${todo.length}${
    sample ? ' (muestra estratificada, solo lectura)' : apply ? ' (--apply: se sellarán los que pasen)' : ' (dry-run)'
  }\n`,
);

clearSemanticCache(); // measure real calls, not cache hits

const results = [];
let inTok = 0;
let outTok = 0;
const startedAt = Date.now();

for (const [i, rec] of todo.entries()) {
  const label = `${rec.module} T${rec.teil}`.padEnd(12);
  process.stdout.write(`[${String(i + 1).padStart(2)}/${todo.length}] ${label} ${rec.id.slice(-16)} … `);

  let res;
  const t0 = Date.now();
  try {
    res = await validatePartSemantics(rec);
  } catch (err) {
    console.log(`ERROR ${err.message}`);
    results.push({ id: rec.id, module: rec.module, teil: rec.teil, error: err.message });
    continue;
  }
  const ms = Date.now() - t0;

  const u = res._usage || {};
  inTok += Number(u.promptTokenCount || 0);
  outTok += Number(u.candidatesTokenCount || 0);

  const critical = (res.issues || []).filter((s) =>
    ['correctness', 'ambiguity'].includes(String(s.kind).toLowerCase()),
  );
  const ok = res.ok !== false && critical.length === 0;

  console.log(
    `${ok ? 'PASA' : 'FALLA'} · ${(res.issues || []).length} issues (${critical.length} críticos) · ${ms} ms`,
  );

  for (const iss of critical.slice(0, 2)) {
    console.log(`         ↳ ${iss.kind}: ${String(iss.detail || '').slice(0, 110)}`);
  }

  results.push({
    id: rec.id,
    module: rec.module,
    teil: rec.teil,
    ok,
    issues: res.issues || [],
    ms,
    usage: u,
  });

  if (apply) {
    if (ok) {
      rec.sem1Ok = true;
      rec.sem1VerifiedAt = new Date().toISOString();
      delete rec.sem1Failed;
    } else {
      rec.sem1Failed = new Date().toISOString();
      rec.sem1Issues = (res.issues || []).map((s) => `${s.kind}: ${s.detail}`).slice(0, 6);
    }
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => r.ok === false).length;
const errored = results.filter((r) => r.error).length;
const usd = (inTok / 1e6) * USD_PER_MTOK_IN + (outTok / 1e6) * USD_PER_MTOK_OUT;

console.log('\n══ RESUMEN ══');
console.log(`  Verificadas:  ${results.length} en ${elapsed}s`);
console.log(`  Pasan:        ${passed}`);
console.log(`  Fallan:       ${failed}`);
if (errored) console.log(`  Errores LLM:  ${errored}`);
console.log(`  Tokens:       ${inTok} in · ${outTok} out`);
console.log(`  Coste equiv.: $${usd.toFixed(4)} (gemini-2.5-flash de pago; free tier = $0)`);
if (results.length) {
  console.log(`  Por parte:    $${(usd / results.length).toFixed(5)} · ${Math.round((inTok + outTok) / results.length)} tokens`);
  console.log(`  Extrapolado a 708 partes: $${((usd / results.length) * 708).toFixed(2)}`);
}

const byTeil = {};
for (const r of results) {
  const k = `${r.module} T${r.teil}`;
  byTeil[k] = byTeil[k] || { pasa: 0, falla: 0 };
  if (r.ok) byTeil[k].pasa++;
  else if (r.ok === false) byTeil[k].falla++;
}
console.log('\n── Por slot ──');
for (const [k, v] of Object.entries(byTeil).sort()) {
  console.log(`  ${k.padEnd(12)} pasa ${v.pasa} · falla ${v.falla}`);
}

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(
  REPORT,
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      applied: apply,
      totals: { verified: results.length, passed, failed, errored, inTok, outTok, usdEquivalent: usd },
      results,
    },
    null,
    2,
  ),
);
console.log(`\nInforme → ${path.relative(ROOT, REPORT)}`);

if (apply) {
  if (seed.records) seed.records = records;
  seed._sem1PilotAt = new Date().toISOString();
  fs.writeFileSync(SEED, JSON.stringify(seed, null, 2));
  const servable = records.filter(
    (r) => r.complete === true && r.verified === true && (r.sem1Skipped || r.sem1VerifiedAt),
  ).length;
  console.log(`Semilla actualizada → ${servable}/${records.length} registros pasan la puerta de publicación`);
}
