// Checks that every reviewer output belongs to the blind file it is named after:
// same question ids, and the echoed "title" appears in that file (and in no other file of the set).
// Usage: node verify-outputs.mjs <blindDir> <outDir>
import fs from 'node:fs';

const [blindDir, outDir] = process.argv.slice(2);
const blinds = Object.fromEntries(fs.readdirSync(blindDir).map((f) => [f.replace(/\.txt$/, ''), fs.readFileSync(`${blindDir}/${f}`, 'utf8')]));
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
let bad = 0, n = 0;
for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith('.json'))) {
  const id = f.replace(/\.json$/, '');
  n++;
  const txt = blinds[id];
  if (!txt) { bad++; console.log(`${f}: no blind file ${id}`); continue; }
  let r;
  try { r = JSON.parse(fs.readFileSync(`${outDir}/${f}`, 'utf8')); } catch (e) { bad++; console.log(`${f}: invalid JSON`); continue; }
  const want = (txt.match(/"id": "q\d+"/g) || []).map((x) => x.match(/q\d+/)[0]).sort().join(',');
  const got = (r.questions || []).map((q) => q.id).sort().join(',');
  const problems = [];
  if (want !== got) problems.push(`ids ${got || '-'} ≠ ${want}`);
  const t = norm(r.title);
  if (!t) problems.push('no title echoed');
  else {
    const inOwn = norm(txt).includes(t);
    const elsewhere = Object.entries(blinds).filter(([k, v]) => k !== id && norm(v).includes(t)).map(([k]) => k);
    if (!inOwn) problems.push(`title "${r.title}" not in ${id}` + (elsewhere.length ? ` (found in ${elsewhere.join(',')})` : ''));
  }
  if (problems.length) { bad++; console.log(`${f}: ${problems.join(' · ')}`); }
}
console.log(`${outDir}: ${n} resultados, ${bad} con problemas`);
process.exit(bad ? 1 : 0);
