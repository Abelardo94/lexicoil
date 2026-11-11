// 4 new en/B1 exams = 12 batches each (Reading P1-P6, Listening P1-P4, Writing, Speaking).
// Per (module, teil) pick 4 DISTINCT topic entries, least-used slugBase first, so no exam
// repeats a published topic. Prompts come from the repo's own buildMasterPrompt (main + #18).
import fs from 'node:fs';
const W = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en12';
const { buildBatchParams, buildMasterPrompt, loadPools } = await import('file:///' + W + '/scripts/lib/batchParams.mjs');
const bank = JSON.parse(fs.readFileSync(W + '/library/en/B1/questions.json', 'utf8'));
const merged = fs.readdirSync(W + '/batches/merged');
const ids = [...(bank.passages || []).map((p) => p.id), ...(bank.questions || []).map((q) => q.id), ...merged].join('\n');
const uses = (base) => (ids.match(new RegExp(base.replace(/[-]/g, '\-'), 'g')) || []).length;
function seeded(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const pools = loadPools('en'); const real = Math.random;
const SLOTS = [['lesen', 1], ['lesen', 2], ['lesen', 3], ['lesen', 4], ['lesen', 5], ['lesen', 6], ['horen', 1], ['horen', 2], ['horen', 3], ['horen', 4], ['schreiben', null], ['sprechen', null]];
fs.mkdirSync('prompts', { recursive: true });
const list = []; const seen = new Set();
for (const [module, teil] of SLOTS) {
  const entries = (teil ? pools.modules[module].topics[String(teil)] : pools.modules[module].topics).filter((e) => module !== 'sprechen' || e.topicT4); // 4 pool entries only have a flat 'topic' -> undefined prompts
  const ranked = entries.map((e, i) => ({ e, i, u: uses(e.slugBase) })).sort((a, b) => a.u - b.u || a.i - b.i).slice(0, 4);
  if (ranked.length < 4) throw new Error(`${module} t${teil}: solo ${ranked.length} temas`);
  ranked.forEach(({ e, u }, exam) => {
    let params = null;
    for (let s = 1; s < 5000 && !params; s++) {
      Math.random = seeded(s * 7919 + exam);
      const p = buildBatchParams(pools, 'en', { level: 'B1', module, teil: teil == null ? undefined : String(teil) });
      Math.random = real;
      if (p.slug.startsWith(e.slugBase + '-')) params = p;
    }
    if (!params) throw new Error(`no seed for ${e.slugBase}`);
    const name = `e${exam + 1}-${module}${teil ? '-t' + teil : ''}-${params.slug}`;
    const key = `${module}-${teil}-${params.slug}`;
    if (seen.has(key)) throw new Error('dup ' + key); seen.add(key);
    fs.writeFileSync(`prompts/${name}.txt`, buildMasterPrompt('en', params));
    list.push({ name, exam: exam + 1, module, teil, slug: params.slug, topic: params.topic, topicTag: params.topicTag, priorUses: u });
  });
}
fs.writeFileSync('prompts/list.json', JSON.stringify(list, null, 1));
for (const x of list) console.log(x.name.padEnd(55), 'usos previos', x.priorUses, '|', String(x.topic).slice(0, 70));
