// node edit-text.cjs <edits.json> : apply exact replacements to passage text in raw/<name>.txt, then check that
// every "double-quoted" fragment in the explanations still appears verbatim in the passage (so an edit never
// breaks a quote the key relies on). Refuses to write a file if a replacement is missing or a quote breaks.
// edits.json = { "<raw name without .txt>": [["old", "new"], ...] }
const fs = require('fs');
const edits = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const norm = (s) => s.replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
for (const [name, reps] of Object.entries(edits)) {
  const p = `raw/${name}.txt`; const o = JSON.parse(fs.readFileSync(p, 'utf8'));
  const text = () => o.passages.map((x) => x.text).join('\n');
  const before = text();
  for (const [a, b] of reps) {
    const pass = o.passages.find((x) => x.text.includes(a));
    if (!pass) throw new Error(`${name}: no encuentro «${a}»`);
    pass.text = pass.text.replace(a, b);
  }
  const quotes = o.questions.flatMap((q) => [...String(q.explanation || '').matchAll(/"([^"]{4,})"/g)].map((m) => [q.id, m[1]]));
  const broken = quotes.filter(([, s]) => norm(before).includes(norm(s)) && !norm(text()).includes(norm(s)));
  if (broken.length) { console.log(name, 'ROMPE CITAS:', broken.map(([id, s]) => id.slice(-3) + ' «' + s + '»').join(' | ')); continue; }
  if (!fs.existsSync('raw-orig/' + name + '.txt')) fs.copyFileSync(p, 'raw-orig/' + name + '.txt');
  fs.writeFileSync(p, JSON.stringify(o, null, 1));
  console.log(name, 'ok ·', reps.length, 'cambios · citas comprobadas', quotes.length);
}
