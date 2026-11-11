// Prompts don't depend on the exam number, only on the slug. gen-prompts deals topics to exams in rank
// order, which clustered tags (e.g. three animal topics in one exam). Re-deal: per slot, permute the 4
// topics across the 4 exams to minimise repeated topicTags inside an exam (squared, so a triple costs
// more than two doubles). Cost is recomputed from the assignment every time — no running tallies.
// Renames prompts/eN-* to match and rewrites list.json.
const fs = require('fs');
const list = JSON.parse(fs.readFileSync('prompts/list.json', 'utf8'));
const slots = [...new Set(list.map((x) => `${x.module}|${x.teil}`))].map((s) => list.filter((x) => `${x.module}|${x.teil}` === s));
const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
const P = perms([1, 2, 3, 4]);
const cost = () => {
  let s = 0;
  for (const e of [1, 2, 3, 4]) {
    const c = {};
    for (const x of list) if (x.exam === e) c[x.topicTag] = (c[x.topicTag] || 0) + 1;
    for (const n of Object.values(c)) s += (n - 1) * (n - 1);
  }
  return s;
};
const before = cost();
for (let pass = 0; pass < 10; pass++) {
  let improved = false;
  for (const items of slots) {
    const cur = items.map((x) => x.exam); let best = { c: cost(), p: cur };
    for (const p of P) { items.forEach((x, i) => { x.exam = p[i]; }); const c = cost(); if (c < best.c) { best = { c, p }; improved = true; } }
    items.forEach((x, i) => { x.exam = best.p[i]; });
  }
  if (!improved) break;
}
console.log('coste antes', before, '-> despues', cost());
const tmp = 'prompts.tmp'; fs.mkdirSync(tmp, { recursive: true });
for (const x of list) {
  const nn = x.name.replace(/^e\d-/, `e${x.exam}-`);
  fs.renameSync(`prompts/${x.name}.txt`, `${tmp}/${nn}.txt`); x.name = nn;
}
for (const f of fs.readdirSync(tmp)) fs.renameSync(`${tmp}/${f}`, `prompts/${f}`);
fs.rmdirSync(tmp);
fs.writeFileSync('prompts/list.json', JSON.stringify(list, null, 1));
