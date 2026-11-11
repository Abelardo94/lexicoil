// CHK-34 (explicacion <-> texto de opcion) sobre todos los lotes norm/, para arreglarlos antes de montar.
import fs from 'node:fs';
const { findExplanationOptionTextAlignFindings } = await import('file:///C:/Danilo/Programas/LEXICOIL/lexiloop-en12/scripts/lib/explanationOptionTextAlign.mjs');
let n = 0;
for (const f of fs.readdirSync('norm')) {
  const b = JSON.parse(fs.readFileSync('norm/' + f, 'utf8'));
  for (const h of findExplanationOptionTextAlignFindings(b)) {
    if (h.severity !== 'CRITICAL' && !process.argv.includes('--all')) continue;
    n++; console.log(h.severity, f.replace('.json', ''), h.itemId, '::', h.message.slice(0, 160));
  }
}
console.log('hallazgos', n);
