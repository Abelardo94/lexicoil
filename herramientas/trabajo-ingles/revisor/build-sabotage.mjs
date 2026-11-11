// Appends sabotaged units to units.json: copies of good published parts with ONE injected defect each.
// Every edit asserts that the text it replaces exists, so a sabotage can never silently no-op.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, 'units.json');
const units = JSON.parse(fs.readFileSync(file, 'utf8')).filter((u) => !u.unitId.startsWith('sabotage:'));
const EX = 'official-en-B1-f946fa2f9efe';

function base(key) {
  const u = units.find((x) => x.unitId === `good:${EX}|${key}`);
  if (!u) throw new Error(`no unit ${key}`);
  return JSON.parse(JSON.stringify(u));
}
function q(u, suffix, nth = 0) {
  const hits = u.questions.filter((x) => x.id.endsWith(suffix));
  if (!hits[nth]) throw new Error(`${u.unitId}: no question ${suffix}#${nth}`);
  return hits[nth];
}
function swap(obj, field, from, to) {
  const v = obj[field];
  if (typeof v !== 'string' || !v.includes(from)) throw new Error(`"${from}" not found in ${field}`);
  obj[field] = v.replace(from, to);
}
function swapOpt(qq, from, to) {
  const i = qq.options.findIndex((o) => o.includes(from));
  if (i < 0) throw new Error(`option "${from}" not found in ${qq.id}`);
  qq.options[i] = qq.options[i].replace(from, to);
}

const S = [];
function add(name, key, kind, fn) {
  const u = base(key);
  const target = fn(u);
  u.unitId = `sabotage:${name}`;
  u.source = `sabotage of ${EX}|${key}`;
  u.truth = { defective: [target.id], kind };
  S.push(u);
}

add('wrong-key-p3', 'lesen|3', 'wrong key', (u) => {
  const x = q(u, '-q1'); x.correct = 'a'; return x;
});
add('expl-contradicts-l4', 'listening|4', 'explanation contradicts key', (u) => {
  const x = q(u, '-q2');
  x.explanation = 'Elena says that the landscapes were what she liked most about Albania.';
  return x;
});
add('two-correct-p3', 'lesen|3', 'two correct options', (u) => {
  const x = q(u, '-q3');
  swapOpt(x, 'She tries to ignore it by thinking about winning.', 'She now sees it as a sign that her body is ready to run.');
  return x;
});
add('two-correct-l1', 'listening|1', 'two correct options', (u) => {
  const x = q(u, '-q5');
  swapOpt(x, 'On the kitchen table', 'Near the front door');
  return x;
});
add('two-correct-p5', 'lesen|5', 'two correct options', (u) => {
  const x = q(u, '-q3');
  swapOpt(x, 'pleased', 'fantastic');
  return x;
});
add('content-gap-p6', 'lesen|6', 'open-cloze key is a content word', (u) => {
  swap(u, 'text', 'We walked [4] hours along the forest paths.', 'We [4] for hours along the forest paths.');
  const x = q(u, '-q4'); x.correct = 'walked';
  x.explanation = "The past simple verb 'walked' describes what the family did in the forest.";
  return x;
});
add('two-texts-fit-p2', 'lesen|2', 'two texts fit one person', (u) => {
  swap(u, 'text', 'Great for people who want a fast meal before a movie.',
    'Great for people who want a fast meal before a movie. In summer, its large garden terrace is the best place in town to eat outside on a warm evening.');
  return q(u, '-q4');
});
add('key-not-in-audio-l3', 'listening|3', 'key not supported by the recording', (u) => {
  swap(u, 'text', 'The film is about the history of space exploration.', 'The film is about the history of flight.');
  return q(u, '-q5');
});
add('audio-contradicts-key-l2', 'listening|2', 'recording contradicts the key', (u) => {
  swap(u, 'text', 'I learned some useful techniques that I can easily try at home.',
    "honestly I didn't learn anything I could use at home.");
  return q(u, '-q4');
});
add('no-correct-option-p1', 'lesen|1', 'no option is correct', (u) => {
  const x = q(u, '-q5');
  // The sign lives in the question stem ([Text] …); the unit text only holds the first sign.
  swap(x, 'question', 'strictly forbidden unless authorized by a teacher.', 'strictly forbidden at all times.');
  return x;
});
add('above-level-p3', 'lesen|3', 'vocabulary far above B1', (u) => {
  const x = q(u, '-q4');
  swapOpt(x, 'Making sure she does well in both her sport and her studies', 'Reconciling her athletic aspirations with her scholastic obligations');
  return x;
});
add('duplicate-option-l4', 'listening|4', 'duplicate option', (u) => {
  const x = q(u, '-q6');
  swapOpt(x, 'Focus on popular tourist destinations.', 'Write with real passion and honesty.');
  return x;
});

fs.writeFileSync(file, JSON.stringify([...units, ...S], null, 1));
console.log(`sabotage units ${S.length}; total units ${units.length + S.length}`);
