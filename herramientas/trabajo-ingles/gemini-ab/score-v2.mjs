// Prompt v1 vs v2 on Reading P5 + Listening P2, same review pass (out-opus-v2).
// Criteria as score-ab.mjs: clean = 0 failed questions AND 0 part_problems.
// Also: reviewer consistency on the v1 files, first pass (out-opus) vs this pass, per question.
import fs from 'node:fs';
const map = JSON.parse(fs.readFileSync('blind-v2-map.private.json', 'utf8'));
const map1 = JSON.parse(fs.readFileSync('blind-map.private.json', 'utf8'));
const byKey1 = Object.fromEntries(Object.entries(map1).map(([id, m]) => [m.key, id]));
const load = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const S = {}; const detail = []; let agree = 0, disagree = 0; const flips = [];
for (const [id, m] of Object.entries(map)) {
  const r = load(`out-opus-v2/${id}.json`); if (!r) { detail.push(`${id} SIN REVISION`); continue; }
  const k = `${m.part} ${m.prompt} ${m.model.replace('gemini-2.5-', '')}`;
  const c = (S[k] ??= { n: 0, clean: 0, cleanQ: 0, q: 0, qf: 0 });
  const fails = (r.questions || []).filter((q) => q.verdict === 'fail'); const pp = r.part_problems || [];
  c.n++; c.q += m.nq; c.qf += fails.length; if (!fails.length) c.cleanQ++; if (!fails.length && !pp.length) c.clean++;
  detail.push(`${id} ${k} "${m.title}": ${fails.length}/${m.nq}${pp.length ? ` + ${pp.length} parte` : ''}` + fails.map((q) => `\n    ${q.id} ${q.problems.map((p) => `${p.type}: ${p.detail}`).join(' | ')}`).join('') + pp.map((p) => `\n    PARTE ${p.type}: ${p.detail}`).join(''));
  if (m.prompt === 'v1') {
    const r1 = load(`out-opus/${byKey1[m.key]}.json`);
    const v1 = Object.fromEntries((r1?.questions || []).map((q) => [q.id, q.verdict]));
    for (const q of r.questions || []) { if (v1[q.id] === q.verdict) agree++; else { disagree++; flips.push(`${m.key} ${q.id}: 1ª ${v1[q.id]} → 2ª ${q.verdict}`); } }
  }
}
console.log('parte       prompt modelo  limpias  (sin problemas de parte)  preguntas suspendidas');
for (const k of Object.keys(S).sort()) { const c = S[k]; console.log(`${k.padEnd(22)} ${c.clean}/${c.n}      (${c.cleanQ}/${c.n})                  ${c.qf}/${c.q}`); }
const tot = {}; for (const [k, c] of Object.entries(S)) { const p = k.split(' ')[1]; const t = (tot[p] ??= { n: 0, clean: 0, cleanQ: 0, q: 0, qf: 0 }); for (const x in t) t[x] += c[x]; }
for (const [p, t] of Object.entries(tot)) console.log(`TOTAL ${p}: ${t.clean}/${t.n} limpias (${t.cleanQ} sin contar parte) · ${t.qf}/${t.q} preguntas suspendidas`);
console.log(`\nConsistencia del revisor en los v1 (1ª pasada vs 2ª): ${agree} coinciden, ${disagree} cambian\n  ` + flips.join('\n  '));
console.log('\n' + detail.sort().join('\n'));
