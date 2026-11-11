// Writes one neutral prompt file per unit (blind/NNN.txt) in a shuffled order, and the private key map.
import fs from 'node:fs';
const src = fs.readFileSync('reviewer.mjs', 'utf8');
const SYSTEM = src.match(/const SYSTEM = `([\s\S]*?)`;/)[1];
const units = JSON.parse(fs.readFileSync('units.json', 'utf8'));
// deterministic shuffle so sabotaged copies don't sit next to their originals
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const order = units.map((u, i) => [rnd(), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
fs.rmSync('blind', { recursive: true, force: true }); fs.mkdirSync('blind');
const map = {};
order.forEach((ui, n) => {
  const u = units[ui]; const id = String(n + 1).padStart(3, '0');
  const qids = u.questions.map((q, k) => [`q${k + 1}`, q.id]);
  const qs = u.questions.map((q, k) => ({ id: `q${k + 1}`, ...(q.segment ? { recording: q.segment } : {}), question: q.question, ...(q.options?.length ? { options: q.options } : {}), key: q.correct, explanation: q.explanation }));
  const body = [`Part: ${u.module === 'reading' ? 'Reading' : 'Listening'} Part ${u.teil} (${u.slot})`, `Instruction: ${u.instruction}`, '', u.module === 'reading' ? 'TEXT:' : 'TRANSCRIPT:', u.text, '', 'QUESTIONS (with the key and explanation to be checked):', JSON.stringify(qs, null, 1)].join('\n');
  fs.writeFileSync(`blind/${id}.txt`, body);
  map[id] = { unitId: u.unitId, qids: Object.fromEntries(qids) };
});
fs.writeFileSync('blind-map.private.json', JSON.stringify(map, null, 1));
fs.writeFileSync('reviewer-instructions.md', SYSTEM + `

OUTPUT: for each part file you review, write a JSON file with exactly this shape:
{"questions":[{"id":"<question id>","verdict":"pass"|"fail","problems":[{"type":"<one of: wrong_key, multiple_correct, no_correct, key_unsupported, explanation_mismatch, duplicate_option, above_level, unnatural_english, format, other>","detail":"<one short sentence>"}]}],"part_problems":[{"type":"...","detail":"..."}]}
Every question in the part must appear once. "problems" is [] for a pass.
`);
console.log('blind files', order.length);
