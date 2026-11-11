// (copy of regap.cjs) Split one sentence in the football Part 6 so CefrGate subordinates stay <=45%.
// Rewrite 6 open-cloze gaps whose key was not a function word (audit-en-open-cloze-gaps), in EVERY copy:
// raw/ of both rounds, the bank, batches/merged, curated exams, curated index, pool-seed and the served file.
// Passage text by exact sentence replacement; questions by id (with or without "ql_"). Prints per-file counts
// so a copy that was missed shows up as 0.
//   node regap.cjs          (dry: counts only)
//   node regap.cjs --apply
const fs = require('fs'); const path = require('path');
const W = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en12/'; const T = 'C:/Danilo/Programas/LEXICOIL/_trabajo-ingles/';
const apply = process.argv.includes('--apply');
const CH = [
  { id: '(none)', text: [['When my family moved to Leeds last year, I knew nobody, so my dad suggested I should join a local football team.', 'My family moved to Leeds last year, and I knew nobody there. My dad suggested joining a local football team.']] },
];
const SENT = CH.flatMap((c) => c.text);
const QIDS = new Map(CH.map((c) => [c.id, c]));
const files = [
  ...['en12', 'en16'].flatMap((r) => fs.readdirSync(T + r + '/raw').filter((f) => /lesen-t6-open-cloze-(lost-cat|school-play|online-friend|football-team|cooking-disaster)/.test(f)).map((f) => T + r + '/raw/' + f)),
  W + 'library/en/B1/questions.json',
  ...fs.readdirSync(W + 'batches/merged').filter((f) => /lesen-t6-open-cloze-(lost-cat|school-play|online-friend|football-team|cooking-disaster)/.test(f)).map((f) => W + 'batches/merged/' + f),
  ...fs.readdirSync(W + 'library/curated/en/B1').filter((f) => f.endsWith('.json')).map((f) => W + 'library/curated/en/B1/' + f),
  W + 'library/curated/en_B1.json', W + 'library/pool-seed/en_B1.json', W + 'data/exams/en_B1.json',
];
const total = { s: 0, q: 0 };
for (const p of files) {
  const raw = fs.readFileSync(p, 'utf8'); const data = JSON.parse(raw); const c = { s: 0, q: 0 };
  const fix = (s) => { for (const [a, b] of SENT) if (s.includes(a)) { s = s.split(a).join(b); c.s++; } return s; };
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach((v, i) => { if (typeof v === 'string') o[i] = fix(v); else walk(v); }); return; }
    if (!o || typeof o !== 'object') return;
    const ch = QIDS.get(String(o.id || '').replace(/^ql_/, ''));
    if (ch && 'correct' in o) {
      o.correct = ch.correct; if ('correctAnswer' in o) o.correctAnswer = ch.correct;
      if ('explanation' in o) o.explanation = ch.explanation; delete o.acceptedAnswers; c.q++;
    }
    for (const k of Object.keys(o)) { if (typeof o[k] === 'string') o[k] = fix(o[k]); else walk(o[k]); }
  };
  walk(data);
  if (!c.s && !c.q) continue;
  total.s += c.s; total.q += c.q;
  if (apply) {
    const isRaw = p.includes('/raw/');
    if (isRaw) { const o = p.replace('/raw/', '/raw-orig/'); fs.mkdirSync(path.dirname(o), { recursive: true }); if (!fs.existsSync(o)) fs.copyFileSync(p, o); }
    const indent = isRaw ? 1 : 2;
    fs.writeFileSync(p, JSON.stringify(data, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
  }
  console.log(path.relative('C:/Danilo/Programas/LEXICOIL', p).padEnd(70), 'frases', c.s, 'preguntas', c.q);
}
console.log(apply ? 'ESCRITO' : 'SECO', '· frases', total.s, '· preguntas', total.q);
