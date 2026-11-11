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
  { id: 'en-b1-r-t6-open-cloze-lost-cat-01-q1',
    text: [['by midnight we still hadn\'t been (1) ____ to find him anywhere.', 'by midnight we (1) ____ still not found him anywhere.']],
    correct: 'had', explanation: 'By midnight points to a time in the past, so the past perfect is needed: "by midnight we had still not found him anywhere". Have would need a present time.' },
  { id: 'en-b1-r-t6-open-cloze-school-play-01-q6',
    text: [['But as (6) ____ as the curtain went up', 'But as soon (6) ____ the curtain went up']],
    correct: 'as', explanation: 'The time conjunction is as soon as, meaning immediately when: "as soon as the curtain went up … my nerves disappeared". The second as completes the fixed phrase; no other word fits after as soon.' },
  { id: 'en-b1-r-t6-open-cloze-online-friend-01-q1',
    text: [['Four years (1) ______, my English teacher', 'Four years ago, my English teacher'], ['and mine was a girl called Isla.', 'and mine was a girl (1) ______ name was Isla.']],
    correct: 'whose', explanation: 'Whose is the possessive relative pronoun: "a girl whose name was Isla" means a girl, and her name was Isla. Who or that cannot be followed directly by a noun like name.' },
  { id: 'en-b1-r-t6-open-cloze-football-team-01-q4',
    text: [['Nobody missed a single session all winter, (4) ______ the freezing weather.', 'Nobody missed a single session all winter, (4) ______ though the weather was often freezing.']],
    correct: 'even', explanation: 'Even though means although, and makes the contrast stronger: nobody missed a session "even though the weather was often freezing". Only even goes before though here.' },
  { id: 'en-b1-r-t6-open-cloze-cooking-disaster-01-q2',
    text: [['the cheese sauce boiled for so (2) ______ that it turned into a thick brown paste', 'the cheese sauce boiled for (2) ______ long that it turned into a thick brown paste']],
    correct: 'so', explanation: 'So + adverb + that shows a result: the sauce boiled "for so long that it turned into a thick brown paste". Too or very cannot be followed by a that-clause of result.' },
  { id: 'en-b1-r-t6-open-cloze-cooking-disaster-01-q4',
    text: [['there was (4) ______ on the table at all, apart from a plate of burnt bread', 'there was nothing on the table at all, apart (4) ______ a plate of burnt bread']],
    correct: 'from', explanation: 'Apart from means except: "nothing on the table at all, apart from a plate of burnt bread". Apart is always followed by from in this meaning.' },
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
