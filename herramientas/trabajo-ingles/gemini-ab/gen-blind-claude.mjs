// Blind set Opus (Claude subagents) vs Gemini 2.5 Pro: same 20 prompts, both re-reviewed together so neither model is judged by an earlier review.
import fs from 'node:fs';
const runs = [...JSON.parse(fs.readFileSync('runs.json', 'utf8')).filter((r) => r.model === 'gemini-2.5-pro'), ...JSON.parse(fs.readFileSync('runs-claude.json', 'utf8'))].filter((r) => r.valid && r.conformant);
let s = 20260926; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const order = runs.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
fs.rmSync('blind-claude', { recursive: true, force: true }); fs.mkdirSync('blind-claude');
const map = {};
order.forEach((r, n) => {
  const b = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  const mod = b.questions[0].module; const teil = b.questions[0].teil;
  const isListening = mod === 'horen';
  const text = b.passages.map((p, i) => (isListening ? `[Recording ${i + 1}]\n` : '') + [p.title, p.text].filter(Boolean).join(isListening ? '\n' : '\n\n')).join('\n\n');
  const pIndex = Object.fromEntries(b.passages.map((p, i) => [p.id, i + 1]));
  const qids = {};
  const qs = b.questions.map((q, k) => {
    qids[`q${k + 1}`] = q.id;
    return { id: `q${k + 1}`, ...(isListening && b.passages.length > 1 ? { recording: `Recording ${pIndex[q.passageId]}` } : {}), question: q.question, ...(q.options?.length ? { options: q.options } : {}), key: q.correct, explanation: q.explanation };
  });
  const id = `K${String(401 + n)}`;
  const title = b.passages.length === 1 ? b.passages[0].title : `${b.passages.length} recordings`;
  const ref = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(rnd() * 32)]).join('');
  const body = [`Ref: ${ref}`, `Part: ${isListening ? 'Listening' : 'Reading'} Part ${teil}`, `Title: ${title}`, '', isListening ? 'TRANSCRIPT:' : 'TEXT:', text, '', 'QUESTIONS (with the key and explanation to be checked):', JSON.stringify(qs, null, 1)].join('\n');
  fs.writeFileSync(`blind-claude/${id}.txt`, body);
  map[id] = { ref, key: r.key, model: r.model, part: `${mod}-t${teil}`, file: r.file, title, nq: qs.length, qids };
});
fs.writeFileSync('blind-claude-map.private.json', JSON.stringify(map, null, 1));
console.log(Object.keys(map).length, 'blind files');
