// CHK-18b (MCQ key vs explanation word overlap) over every batch in norm/ of the given folder.
import fs from 'node:fs';
const { findKeyExplanationMismatches } = await import('file:///C:/Danilo/Programas/LEXICOIL/lexiloop-en12/scripts/lib/keyExplanationGate.mjs');
const dir = process.argv[2] || 'norm'; let n = 0;
for (const f of fs.readdirSync(dir)) {
  const b = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'));
  for (const h of findKeyExplanationMismatches(b)) { n++; console.log(f.replace('.json', ''), '::', h.message.slice(0, 170)); }
}
console.log('hallazgos', n);
