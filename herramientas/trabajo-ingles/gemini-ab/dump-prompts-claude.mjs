// Same seeded prompts as gen-ab.mjs (prompt v1, worktree lexiloop-en) written to files, so Claude
// subagents can act as the generator. One prompt per (part, rep); no model call here.
import fs from 'node:fs';
const W = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en';
const imp = (p) => import('file:///' + W + '/scripts/lib/' + p);
const { buildBatchParams, buildMasterPrompt, loadPools } = await imp('batchParams.mjs');
function seeded(seed) { let s = seed >>> 0; for (let i = 0; i < 8; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; } return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const PARTS = [['lesen', 4], ['lesen', 5], ['lesen', 6], ['horen', 2], ['horen', 4]];
const pools = loadPools('en'); const real = Math.random;
const runs = JSON.parse(fs.readFileSync('runs.json', 'utf8'));
fs.mkdirSync('claude-prompts', { recursive: true });
const list = [];
for (const [module, teil] of PARTS) for (let rep = 0; rep < 4; rep++) {
  Math.random = seeded(1000 * teil + (module === 'horen' ? 500 : 0) + rep * 7 + 3);
  const params = buildBatchParams(pools, 'en', { level: 'B1', module, teil: String(teil) });
  Math.random = real;
  const pro = runs.find((r) => r.model === 'gemini-2.5-pro' && r.module === module && r.teil === teil && r.rep === rep);
  if (pro.slug !== params.slug) throw new Error(`seed mismatch ${module}-t${teil}-r${rep}: ${pro.slug} vs ${params.slug}`);
  const name = `${module}-t${teil}-r${rep}-${params.slug}`;
  fs.writeFileSync(`claude-prompts/${name}.txt`, buildMasterPrompt('en', params));
  list.push({ name, module, teil, rep, topic: params.topic, slug: params.slug });
}
fs.writeFileSync('claude-prompts/list.json', JSON.stringify(list, null, 1));
console.log(list.length, 'prompts; slugs match the Pro runs');
