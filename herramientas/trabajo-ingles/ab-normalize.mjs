import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const NEW = await import(pathToFileURL(path.join(root, 'scripts/lib/normalizeBatch.mjs')).href);
const OLD = await import(pathToFileURL(path.join(root, 'scripts/lib/normalizeBatch.headcopy.mjs')).href);
const dirs = ['batches/merged', 'batches/generated'];
let n = 0, diff = 0, errs = 0; const byLang = {};
for (const d of dirs) for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
  let b; try { b = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
  if (!b || !Array.isArray(b.questions)) continue;
  const lang = /^en-|en-b1/.test(JSON.stringify(b.questions[0]?.id || '')) ? 'en' : 'de';
  const mod = b.questions[0]?.module; const teil = b.questions[0]?.teil;
  const ctx = { lang, level: 'B1', module: mod, teil };
  let a, o;
  try { a = JSON.stringify(NEW.normalizeBatch(structuredClone(b), ctx)).replace(/"_\w+NormalizedAt":"[^"]*"/g, ''); o = JSON.stringify(OLD.normalizeBatch(structuredClone(b), ctx)).replace(/"_\w+NormalizedAt":"[^"]*"/g, ''); }
  catch { errs++; continue; }
  n++; byLang[lang] = byLang[lang] || [0, 0]; byLang[lang][0]++;
  if (a !== o) { diff++; byLang[lang][1]++; if (lang === 'de') console.log('DE DIFF', d, f); }
}
console.log(`lotes ${n} · distintos ${diff} · errores ${errs} · por idioma [total, distintos]`, byLang);
