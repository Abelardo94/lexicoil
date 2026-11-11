// A/B score, criteria fixed BEFORE reading any review:
//   clean part  = 0 failed questions AND 0 part_problems
//   also: failed questions / total, and clean ignoring part_problems.
// Generation failures (invalid/non-conformant/error) count as NOT clean for the model (denominator = attempts).
import fs from 'node:fs';
const OUT = process.argv[2] || 'out-opus';
const map = JSON.parse(fs.readFileSync('blind-map.private.json', 'utf8'));
const runs = JSON.parse(fs.readFileSync('runs.json', 'utf8'));
const S = {};
const cell = (m, p) => ((S[m] ??= {})[p] ??= { tries: 0, reviewed: 0, clean: 0, cleanQ: 0, q: 0, qf: 0, usd: 0, ms: 0, genFail: 0 });
for (const r of runs) { const c = cell(r.model, `${r.module}-t${r.teil}`); c.tries++; c.usd += r.usd || 0; c.ms += r.ms || 0; if (!(r.valid && r.conformant)) c.genFail++; }
const detail = [];
for (const [id, m] of Object.entries(map)) {
  const c = cell(m.model, m.part);
  let r; try { r = JSON.parse(fs.readFileSync(`${OUT}/${id}.json`, 'utf8')); } catch { detail.push(`${id} SIN REVISION`); continue; }
  c.reviewed++;
  const fails = (r.questions || []).filter((q) => q.verdict === 'fail');
  const pp = r.part_problems || [];
  c.q += m.nq; c.qf += fails.length;
  if (!fails.length) c.cleanQ++;
  if (!fails.length && !pp.length) c.clean++;
  detail.push(`${id} ${m.model.replace('gemini-2.5-', '')} ${m.part} "${m.title}": ${fails.length}/${m.nq} fallan${pp.length ? ` + ${pp.length} de parte` : ''}` +
    fails.map((q) => `\n    ${q.id} ${q.problems.map((p) => `${p.type}: ${p.detail}`).join(' | ')}`).join('') +
    pp.map((p) => `\n    PARTE ${p.type}: ${p.detail}`).join(''));
}
const tot = {};
console.log('modelo  parte     limpias/intentos  (sin contar problemas de parte)  preguntas suspendidas  $/lote  s/lote');
for (const [m, parts] of Object.entries(S)) for (const [p, c] of Object.entries(parts)) {
  const t = (tot[m] ??= { tries: 0, clean: 0, cleanQ: 0, q: 0, qf: 0, usd: 0, genFail: 0 });
  for (const k of Object.keys(t)) t[k] += c[k];
  console.log(`${m.replace('gemini-2.5-', '').padEnd(7)} ${p.padEnd(9)} ${String(c.clean).padStart(2)}/${c.tries}            (${c.cleanQ}/${c.tries})                          ${c.qf}/${c.q}          ${(c.usd / c.tries).toFixed(3)}   ${Math.round(c.ms / c.tries / 1000)}`);
}
for (const [m, t] of Object.entries(tot)) console.log(`TOTAL ${m}: ${t.clean}/${t.tries} limpias (${t.cleanQ} sin contar problemas de parte) · ${t.qf}/${t.q} preguntas suspendidas · fallos de generacion ${t.genFail} · ${t.usd.toFixed(2)} $`);
console.log('\n' + detail.sort().join('\n'));
