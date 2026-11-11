// Every review output must echo the Ref code of the blind file it is named after, and cover exactly its question ids.
import fs from 'node:fs';
const OUT = process.argv[2] || 'out-opus';
const map = JSON.parse(fs.readFileSync(process.env.MAP || (process.env.MAP || 'blind-map.private.json'), 'utf8'));
let bad = 0, n = 0;
for (const [id, m] of Object.entries(map)) {
  const p = `${OUT}/${id}.json`;
  if (!fs.existsSync(p)) { console.log(`${id}: falta`); bad++; continue; }
  n++;
  let r; try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { console.log(`${id}: JSON invalido`); bad++; continue; }
  const want = Object.keys(m.qids).sort().join(','), got = (r.questions || []).map((q) => q.id).sort().join(',');
  const probs = [];
  if (r.ref !== m.ref) probs.push(`ref ${r.ref} ≠ ${m.ref}` + (Object.entries(map).find(([, v]) => v.ref === r.ref)?.[0] ? ` (es de ${Object.entries(map).find(([, v]) => v.ref === r.ref)[0]})` : ''));
  if (want !== got) probs.push(`ids ${got} ≠ ${want}`);
  if (probs.length) { bad++; console.log(`${id}: ${probs.join(' · ')}`); }
}
console.log(`${OUT}: ${n} resultados, ${bad} con problemas`);
process.exit(bad ? 1 : 0);
