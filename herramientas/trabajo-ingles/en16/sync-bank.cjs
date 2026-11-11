// node sync-bank.cjs <regex> : push norm/<lots matching regex> into the en/B1 bank (same ids only; never adds or removes)
// and into batches/merged. Question = norm fields + bank's own extra fields (lang); passage = title + text.
const fs = require('fs'); const R = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en12'; const B = R + '/library/en/B1/questions.json';
const rx = new RegExp(process.argv[2]); const bank = JSON.parse(fs.readFileSync(B, 'utf8')); let q = 0, p = 0;
for (const f of fs.readdirSync('norm').filter((f) => rx.test(f))) {
  const b = JSON.parse(fs.readFileSync('norm/' + f, 'utf8'));
  for (const x of b.questions) { const i = bank.questions.findIndex((y) => y.id === x.id); if (i < 0) throw new Error('no en banco ' + x.id); const nx = { ...bank.questions[i], ...x }; if (JSON.stringify(nx) !== JSON.stringify(bank.questions[i])) { bank.questions[i] = nx; q++; } }
  for (const x of b.passages) { const t = bank.passages.find((y) => y.id === x.id); if (!t) throw new Error('no en banco ' + x.id); if (t.text !== x.text || t.title !== x.title) { t.text = x.text; t.title = x.title; p++; } }
  fs.copyFileSync('norm/' + f, R + '/batches/merged/' + f.replace(/^e\d-/, ''));
}
fs.writeFileSync(B, JSON.stringify(bank, null, 2) + '\n'); console.log('preguntas actualizadas', q, '· pasajes', p);
