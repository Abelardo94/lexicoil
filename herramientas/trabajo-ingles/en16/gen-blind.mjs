// Reviewer view of every valid Reading/Listening batch in norm/: text/transcript + questions with key and
// explanation, neutral ids (q1..qn), shuffled file names R01.. so no reviewer knows which exam/part it is.
// Writing/Speaking are rubric tasks (no key) and are checked by hand.
import fs from 'node:fs';
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const runs = JSON.parse(fs.readFileSync('runs.json', 'utf8')).filter((r) => r.valid && r.conformant && /lesen|horen/.test(r.module) && (!only || only.test(r.name)));
let s = 20261013 + (only ? 7 : 0); const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const order = runs.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
const dir = process.argv[3] || 'blind'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const map = {};
order.forEach((r, n) => {
  const b = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  const mod = b.questions[0].module; const teil = b.questions[0].teil; const isL = mod === 'horen';
  const text = b.passages.map((p, i) => (isL ? `[Recording ${i + 1}]\n` : b.passages.length > 1 ? `[Text ${i + 1}]\n` : '') + [p.title, p.text].filter(Boolean).join('\n')).join('\n\n');
  const pIndex = Object.fromEntries(b.passages.map((p, i) => [p.id, i + 1])); const qids = {};
  const qs = b.questions.map((q, k) => { qids[`q${k + 1}`] = q.id; return { id: `q${k + 1}`, ...(b.passages.length > 1 && pIndex[q.passageId] ? { [isL ? 'recording' : 'text']: `${isL ? 'Recording' : 'Text'} ${pIndex[q.passageId]}` } : {}), question: q.question, ...(q.options?.length ? { options: q.options } : {}), key: q.correct, explanation: q.explanation }; });
  const id = `R${String(n + 1).padStart(2, '0')}`; const title = b.passages.length === 1 ? b.passages[0].title : `${b.passages.length} ${isL ? 'recordings' : 'texts'}`;
  fs.writeFileSync(`${dir}/${id}.txt`, [`Part: ${isL ? 'Listening' : 'Reading'} Part ${teil}`, `Title: ${title}`, '', isL ? 'TRANSCRIPT:' : 'TEXT:', text, '', 'QUESTIONS (with the key and explanation to be checked):', JSON.stringify(qs, null, 1)].join('\n'));
  map[id] = { name: r.name, part: `${mod}-t${teil}`, file: r.file, title, nq: qs.length, qids };
});
fs.writeFileSync(`${dir}-map.private.json`, JSON.stringify(map, null, 1));
console.log(Object.keys(map).length, 'blind files in', dir);
