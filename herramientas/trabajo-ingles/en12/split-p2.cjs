// Reading P2 llego como 1 pasaje con los 8 textos dentro; los publicados usan 8 pasajes ("A – Titulo" + texto)
// y todas las preguntas apuntan al -01. Parte raw/<e*-lesen-t2-*>.txt en 8 pasajes, sin tocar preguntas ni texto.
const fs = require('fs');
for (const f of fs.readdirSync('raw').filter((f) => /-lesen-t2-/.test(f))) {
  const o = JSON.parse(fs.readFileSync('raw/' + f, 'utf8'));
  if (o.passages.length !== 1) { console.log(f, 'ya tiene', o.passages.length, 'pasajes'); continue; }
  const p = o.passages[0];
  const chunks = p.text.split(/\n\n(?=[A-H] – )/);
  if (chunks.length !== 8) throw new Error(f + ': ' + chunks.length + ' trozos');
  const base = p.id.replace(/-01$/, '');
  if (base === p.id) throw new Error(f + ': id sin -01 ' + p.id);
  o.passages = chunks.map((c, i) => {
    const [title, ...rest] = c.split('\n');
    if (!/^[A-H] – /.test(title) || title[0] !== 'ABCDEFGH'[i]) throw new Error(f + ': titulo raro ' + title);
    const { id, title: _t, text, ...extra } = p;
    return { ...extra, id: `${base}-${String(i + 1).padStart(2, '0')}`, title: title.trim(), text: rest.join('\n').trim() };
  });
  for (const q of o.questions) if (q.passageId !== p.id) throw new Error(f + ': pregunta apunta a ' + q.passageId);
  fs.writeFileSync('raw/' + f, JSON.stringify(o, null, 1));
  console.log(f, '-> 8 pasajes:', o.passages.map((x) => x.title).join(' | '));
}
