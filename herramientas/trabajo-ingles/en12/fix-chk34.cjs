// CHK-34 da falsos positivos con apostrofos rectos (los toma por comillas) y con distractores citados.
// Arreglo en raw/: apostrofo tipografico dentro de palabra en las explicaciones marcadas + 1 reescritura.
const fs = require('fs');
const targets = {
  'e1-horen-t1-pics-sport-plans-01': ['s7-q1'],
  'e1-horen-t2-gist-school-life-01': ['q3'],
  'e2-horen-t2-gist-food-cooking-01': ['q3', 'q5'],
  'e3-horen-t2-gist-films-music-01': ['q3'],
  'e3-lesen-t3-long-exchange-student-01': ['q2'],
  'e1-lesen-t5-cloze-rainforest-trip-01': ['q5'],
};
const rewrite = {
  'en-b1-r-t5-cloze-rainforest-trip-01-q5': 'Students "did a short quiz" and then the writer says "I got nine out of ten", so they answered the quiz. In English you do a quiz when you answer the questions. If you make or give a quiz, you write it or set it for other people, and you cannot put a quiz.',
};
for (const [n, sufs] of Object.entries(targets)) {
  const p = 'raw/' + n + '.txt'; const o = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const q of o.questions) {
    if (!sufs.some((s) => q.id.endsWith('-' + s))) continue;
    const before = q.explanation;
    q.explanation = rewrite[q.id] || q.explanation.replace(/(\w)'(\w)/g, '$1’$2');
    if (/^'.*'/.test(q.explanation) || /\s'[A-Z]/.test(q.explanation)) q.explanation = q.explanation.replace(/(^|\s)'([^']+)'/g, '$1"$2"');
    console.log(q.id, before === q.explanation ? 'SIN CAMBIO' : 'ok');
  }
  fs.writeFileSync(p, JSON.stringify(o, null, 1));
}
