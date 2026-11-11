// Sonnet vs Opus on the pilot: per question verdicts, agreements and disagreements.
import fs from 'node:fs';

const map = JSON.parse(fs.readFileSync('blind-pilot-map.private.json', 'utf8'));
const load = (dir, id) => { try { return JSON.parse(fs.readFileSync(`${dir}/${id}.json`, 'utf8')); } catch { return null; } };
const why = (q) => (q?.problems || []).map((p) => `${p.type}: ${p.detail}`).join(' | ');
let both = 0, onlyS = 0, onlyO = 0, none = 0;
const lines = [];
for (const [id, m] of Object.entries(map)) {
  const S = load('out-pilot-sonnet', id), O = load('out-pilot-opus', id);
  if (!S || !O) { lines.push(`${id} ${m.file}: falta ${!S ? 'sonnet' : ''} ${!O ? 'opus' : ''}`); continue; }
  const s = Object.fromEntries(S.questions.map((q) => [q.id, q]));
  const o = Object.fromEntries(O.questions.map((q) => [q.id, q]));
  for (const qid of Object.keys(m.qids)) {
    const fs_ = s[qid]?.verdict === 'fail', fo = o[qid]?.verdict === 'fail';
    if (fs_ && fo) both++; else if (fs_) onlyS++; else if (fo) onlyO++; else none++;
    if (fs_ || fo) lines.push(`${id} ${m.file.replace('.json', '')} ${qid} [${fs_ ? 'S' : '-'}${fo ? 'O' : '-'}]\n    S: ${why(s[qid]) || 'pass'}\n    O: ${why(o[qid]) || 'pass'}`);
  }
  for (const [who, R] of [['S', S], ['O', O]]) for (const p of R.part_problems || []) lines.push(`${id} ${m.file.replace('.json', '')} PART [${who}] ${p.type}: ${p.detail}`);
}
console.log(`preguntas: ambos suspenden ${both} · solo Sonnet ${onlyS} · solo Opus ${onlyO} · ambos aprueban ${none}\n`);
console.log(lines.join('\n'));
