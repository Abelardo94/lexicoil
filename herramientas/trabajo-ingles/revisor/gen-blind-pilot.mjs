// Blind files for the pilot's Reading/Listening batches (P101..): same render as calibration.
import fs from 'node:fs';
import path from 'node:path';
const D = '../pilot-batches';
const files = fs.readdirSync(D).filter((f) => /^(lesen|horen|_rejected-lesen)/.test(f)).sort();
fs.rmSync('blind-pilot', { recursive: true, force: true }); fs.mkdirSync('blind-pilot');
const map = {};
files.forEach((f, n) => {
  const b = JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
  const mod = b.questions[0].module; const teil = b.questions[0].teil;
  // the rejected Reading P3 only had a typo in one passageId: point every question at the single passage
  if (f.startsWith('_rejected')) for (const q of b.questions) q.passageId = b.passages[0].id;
  const isListening = mod === 'horen';
  const text = b.passages.map((p, i) => (isListening ? `[Recording ${i + 1}]\n` : (b.passages.length > 1 && teil === 1 ? `[Text ${i + 1}]\n` : '')) + [p.title, p.text].filter(Boolean).join(isListening ? '\n' : '\n\n')).join('\n\n');
  const pIndex = Object.fromEntries(b.passages.map((p, i) => [p.id, i + 1]));
  const qids = {};
  const qs = b.questions.map((q, k) => {
    qids[`q${k + 1}`] = q.id;
    return { id: `q${k + 1}`, ...(isListening && b.passages.length > 1 ? { recording: `Recording ${pIndex[q.passageId]}` } : {}), ...(!isListening && teil === 1 ? { text: `Text ${pIndex[q.passageId]}` } : {}), question: q.question, ...(q.options?.length ? { options: q.options } : {}), key: q.correct, explanation: q.explanation };
  });
  const id = `P${String(101 + n)}`;
  const title = isListening ? (b.passages.length === 1 ? b.passages[0].title : `${b.passages.length} recordings`) : (b.passages.length === 1 ? b.passages[0].title : `${b.passages.length} texts`);
  const body = [`Part: ${isListening ? 'Listening' : 'Reading'} Part ${teil}`, `Title: ${title}`, '', isListening ? 'TRANSCRIPT:' : 'TEXT:', text, '', 'QUESTIONS (with the key and explanation to be checked):', JSON.stringify(qs, null, 1)].join('\n');
  fs.writeFileSync(`blind-pilot/${id}.txt`, body);
  map[id] = { file: f, title, nq: qs.length, qids };
});
fs.writeFileSync('blind-pilot-map.private.json', JSON.stringify(map, null, 1));
for (const [k, v] of Object.entries(map)) console.log(k, v.file, '|', v.title, '| q=' + v.nq);
