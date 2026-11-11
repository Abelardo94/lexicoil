// de/A2 e2 Lesen Teil 3 (lesen-t3-cur-society): q12-q15 were five copies of q11 ("Warum schreibt
// Thomas an Maria?") with the options shuffled. Rewrite q12-q15 as four distinct items on the same
// letter, in every copy that carries content, and recompute the published part's contentHash.
//   node fix-a2-e2-t3.mjs            (dry: counts only)
//   node fix-a2-e2-t3.mjs --apply
import fs from 'node:fs'; import path from 'node:path';
const W = 'C:/Danilo/Programas/LEXICOIL/lexiloop-a2fix/';
const apply = process.argv.includes('--apply');
const opt = (a, b, c) => [{ key: 'A', text: a }, { key: 'B', text: b }, { key: 'C', text: c }];
const NEW = {
  'de-a2-cur-lesen-t3-cur-society-q12': {
    question: 'Was ist für Thomas ein Nachteil vom Fitnessstudio?',
    options: opt('Er muss dort immer allein trainieren.', 'Es kostet 50 Euro im Monat.', 'Es gibt dort nicht genug Geräte.'),
    correct: 'b',
    explanation: 'Thomas schreibt über das Fitnessstudio: "Aber es ist teuer – 50 Euro pro Monat!" Er kann dort allein trainieren, wann er will, aber das ist für ihn kein Problem. Und es gibt "viele Geräte".',
  },
  'de-a2-cur-lesen-t3-cur-society-q13': {
    question: 'Wie viel bezahlt Peter für den Tennisverein?',
    options: opt('15 Euro im Monat.', '50 Euro im Monat.', '15 Euro im Jahr.'),
    correct: 'a',
    explanation: 'Im Text steht: "Mein Freund Peter ist im Tennisverein und zahlt nur 15 Euro monatlich." 50 Euro im Monat kostet das Fitnessstudio.',
  },
  'de-a2-cur-lesen-t3-cur-society-q14': {
    question: 'Was sagt Peter über den Sportverein?',
    options: opt('Man kann trainieren, wann man will.', 'Allein trainieren ist schöner.', 'Mit anderen zusammen macht es mehr Spaß.'),
    correct: 'c',
    explanation: 'Peter sagt, "es macht mehr Spaß mit anderen zusammen zu spielen". Im Verein sind die Trainingszeiten fest; wann man will, kann man nur im Fitnessstudio trainieren.',
  },
  'de-a2-cur-lesen-t3-cur-society-q15': {
    question: 'Was möchte Thomas mit dem Sport erreichen?',
    options: opt('Er möchte abnehmen und fitter werden.', 'Er möchte Tennistrainer werden.', 'Er möchte neue Kollegen finden.'),
    correct: 'a',
    explanation: 'Thomas schreibt: "Ich bin noch jung und möchte abnehmen und meine Fitness verbessern." Von einem Beruf als Trainer schreibt er nichts.',
  },
};
const FILES = [
  'library/published-exams/de/A2/official-de-A2-e2.json',
  'batches/ready/pool-verified/A2/lesen-t3-cur-society.json',
  'library/reusable-seed/de_A2.json',
  'data/exams/de_A2.json',
  'batches/ready/assembled-from-verified/assembled-exam-a2-verified-e2.json',
];
// Option shape differs between copies (objects {key,text} vs "A) …" strings): keep each copy's own.
const shapeOptions = (old, fresh) => {
  if (!Array.isArray(old) || !old.length || typeof old[0] === 'object') return fresh.map((o) => ({ ...o }));
  return fresh.map((o) => `${o.key}) ${o.text}`);
};
const shapeCorrect = (old, c) => (typeof old === 'string' && old === old.toUpperCase() && /^[A-C]$/.test(old) ? c.toUpperCase() : c);
let total = 0;
for (const rel of FILES) {
  const p = W + rel; const raw = fs.readFileSync(p, 'utf8'); const data = JSON.parse(raw); let n = 0;
  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    const id = String(o.id || '').replace(/^ql_/, '');
    const fresh = NEW[id];
    if (fresh && 'question' in o) {
      o.question = fresh.question;
      if ('options' in o) o.options = shapeOptions(o.options, fresh.options);
      if ('correct' in o) o.correct = shapeCorrect(o.correct, fresh.correct);
      if ('correctAnswer' in o) o.correctAnswer = shapeCorrect(o.correctAnswer, fresh.correct);
      if ('explanation' in o) o.explanation = fresh.explanation;
      n++;
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(data);
  total += n;
  console.log(rel.padEnd(78), 'preguntas', n);
  if (apply && n) {
    if (rel.startsWith('library/published-exams/')) {
      const { canonicalPartHash, normalizePartSnapshot } = await import('file:///' + W + 'scripts/lib/partContentHash.mjs');
      const part = data.parts.find((x) => x.module === 'lesen' && Number(x.teil) === 3);
      const origRaw = JSON.parse(raw).parts.find((x) => x.module === 'lesen' && Number(x.teil) === 3);
      const normalized = canonicalPartHash(origRaw.snapshot) !== origRaw.contentHash; // which variant produced the stored hash
      { const before = part.contentHash; part.contentHash = canonicalPartHash(normalized ? normalizePartSnapshot(part.snapshot) : part.snapshot); console.log('   contentHash', before.slice(0, 12), '->', part.contentHash.slice(0, 12)); }
    }
    const indent = (raw.match(/\n( +)"/) || [, '  '])[1].length;
    fs.writeFileSync(p, JSON.stringify(data, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
  }
}
console.log(apply ? 'ESCRITO' : 'SECO', '· preguntas', total);
