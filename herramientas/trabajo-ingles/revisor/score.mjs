// Scores a reviewer run against the calibration truth.
// Usage: node score.mjs <outDir>     (outDir holds NNN.json written by the reviewers)
// Metrics fixed before any run:
//   recall     = defective questions failed / defective questions (23)
//   false-fail = questions failed in GOOD units / questions in good units (each needs adjudication:
//                published content can hold real, undiscovered defects)
//   sibling    = in sabotaged/real-bad units, non-target questions failed (same bookkeeping)
import fs from 'node:fs';

const dir = process.argv[2];
// --subset: score only the files present in dir (e.g. a model run on a slice of the calibration)
const SUBSET = process.argv.includes('--subset');
const map = JSON.parse(fs.readFileSync('blind-map.private.json', 'utf8'));
const units = Object.fromEntries(JSON.parse(fs.readFileSync('units.json', 'utf8')).map((u) => [u.unitId, u]));

let defTotal = 0, defCaught = 0, goodQ = 0, goodFail = 0, otherQ = 0, otherFail = 0, missingFiles = 0, missingQ = 0;
const misses = [], falseFails = [], siblingFails = [];
for (const [file, { unitId, qids }] of Object.entries(map)) {
  const u = units[unitId];
  const p = `${dir}/${file}.json`;
  if (!fs.existsSync(p)) { if (!SUBSET) missingFiles++; continue; }
  let r;
  try { r = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { missingFiles++; continue; }
  const byId = Object.fromEntries((r.questions || []).map((q) => [qids[q.id] || q.id, q]));
  const defective = new Set(u.truth.defective);
  for (const q of u.questions) {
    const v = byId[q.id];
    if (!v) { missingQ++; }
    const failed = v?.verdict === 'fail';
    const why = (v?.problems || []).map((x) => `${x.type}: ${x.detail}`).join(' | ');
    if (defective.has(q.id)) {
      defTotal++;
      if (failed) defCaught++; else misses.push(`${file} ${unitId} ${q.id.split('-').pop()} (${u.truth.kind || u.truth.why?.[q.id] || ''})`);
    } else if (unitId.startsWith('good:')) {
      goodQ++;
      if (failed) { goodFail++; falseFails.push(`${file} ${unitId} ${q.id.split('-').pop()} → ${why}`); }
    } else {
      otherQ++;
      if (failed) { otherFail++; siblingFails.push(`${file} ${unitId} ${q.id.split('-').pop()} → ${why}`); }
    }
  }
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + '%' : '-');
console.log(`== ${dir}`);
console.log(`ficheros sin resultado: ${missingFiles} · preguntas sin veredicto: ${missingQ}`);
console.log(`DETECCION  defectos cazados: ${defCaught}/${defTotal} (${pct(defCaught, defTotal)})`);
console.log(`FALSAS     fallos en partes buenas: ${goodFail}/${goodQ} preguntas (${pct(goodFail, goodQ)})`);
console.log(`VECINAS    fallos en otras preguntas de partes malas: ${otherFail}/${otherQ}`);
if (misses.length) console.log('\nNo detectados:\n  ' + misses.join('\n  '));
if (falseFails.length) console.log('\nFallos en partes buenas (a revisar a mano):\n  ' + falseFails.join('\n  '));
if (siblingFails.length) console.log('\nFallos en vecinas:\n  ' + siblingFails.join('\n  '));
