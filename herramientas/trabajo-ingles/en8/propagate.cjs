// Propagate the two Part 6 gap rewrites into the assembled/served files by exact replacement.
// Strings: old sentence -> new (must match). Questions by id (with or without "ql_"): correct/correctAnswer/explanation.
const fs = require('fs'); const R = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en8/';
const SENT = [
  ["and by the end of the camp he didn't want to go home at (5) ______.", 'and by the end of the camp he was (5) ______ of the happiest children there.'],
  ['By lunchtime the bags filled a whole lorry, and the council had to send a second one to take it all (4) ______.', 'By lunchtime there was (4) ______ much rubbish for one lorry, and the council had to send a second one.'],
];
const norm = {}; for (const f of ['e1-lesen-t6-open-cloze-summer-camp-01', 'e4-lesen-t6-open-cloze-beach-cleanup-01']) for (const q of JSON.parse(fs.readFileSync('norm/' + f + '.json', 'utf8')).questions) norm[q.id] = q;
const QIDS = ['en-b1-r-t6-open-cloze-summer-camp-01-q5', 'en-b1-r-t6-open-cloze-beach-cleanup-01-q4'];
for (const rel of process.argv.slice(2)) {
  const p = R + rel; const raw = fs.readFileSync(p, 'utf8'); const data = JSON.parse(raw); const c = { s: 0, q: 0 };
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach((v, i) => { if (typeof v === 'string') o[i] = fix(v); else walk(v); }); return; }
    if (!o || typeof o !== 'object') return;
    const id = String(o.id || '').replace(/^ql_/, '');
    if (QIDS.includes(id) && ('correct' in o)) { const n = norm[id]; o.correct = n.correct; if ('correctAnswer' in o) o.correctAnswer = n.correctAnswer; if ('explanation' in o) o.explanation = n.explanation; c.q++; }
    for (const k of Object.keys(o)) { if (typeof o[k] === 'string') o[k] = fix(o[k]); else walk(o[k]); }
  };
  const fix = (s) => { for (const [a, b] of SENT) if (s.includes(a)) { s = s.split(a).join(b); c.s++; } return s; };
  walk(data); fs.writeFileSync(p, JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  console.log(rel.padEnd(58), 'frases', c.s, 'preguntas', c.q);
}
