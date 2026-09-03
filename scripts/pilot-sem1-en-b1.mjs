#!/usr/bin/env node
/**
 * Etapa 1 pilot — run SEM-1 over the en/B1 reusable seed and measure what it costs.
 *
 * Two jobs at once: it stamps sem1VerifiedAt on the records that pass (which is
 * what unblocks the pool — partPassesPublishGate needs it), and it records real
 * token usage per part so the Fase 1 budget stops being an estimate.
 *
 *   node scripts/pilot-sem1-en-b1.mjs --dry-run       # no writes, still calls the LLM
 *   node scripts/pilot-sem1-en-b1.mjs --apply         # stamp passing records
 *   node scripts/pilot-sem1-en-b1.mjs --apply --limit 5
 *
 * Records that fail go to quarantine (sem1Failed + the findings) rather than
 * being stamped — an unverified part must never reach the served pool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePartSemantics, clearSemanticCache } from './lib/semanticValidator.mjs';
import { loadEnvFile, ROOT } from './lib/loadEnv.mjs';

loadEnvFile();

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const limitArg = argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : Infinity;

const SEED = path.join(ROOT, 'library/reusable-seed/en_B1.json');
const REPORT = path.join(ROOT, 'docs/audit/pilot-sem1-en-B1.json');

// gemini-2.5-flash paid-tier rates; free tier bills nothing but the token
// counts are the same, so the figure below is the "if we were paying" number.
const USD_PER_MTOK_IN = 0.30;
const USD_PER_MTOK_OUT = 2.50;

const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const records = seed.records || seed;

const pending = records.filter(
  (r) => !r.sem1Skipped && !r.sem1VerifiedAt && !r.sem1Failed,
);

console.log(`Piscina en/B1: ${records.length} registros · ${pending.length} sin SEM-1`);
if (!pending.length) {
  console.log('Nada que verificar.');
  process.exit(0);
}

const todo = pending.slice(0, Number.isFinite(limit) ? limit : pending.length);
console.log(`Verificando ${todo.length}${apply ? ' (--apply: se sellarán los que pasen)' : ' (dry-run)'}\n`);

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
