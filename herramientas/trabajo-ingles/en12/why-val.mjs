// node why-val.mjs <examNo> : builds exam N exactly like publish-promote-candidates (bank = only that exam's
// parts) and prints the ExamValidator errors, which the publisher only counts as "val".
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const ROOT = 'C:/Danilo/Programas/LEXICOIL/lexiloop-en12';
const require = createRequire(import.meta.url);
const ExamBlueprint = require(path.join(ROOT, 'js/library/ExamBlueprint.js'));
require(path.join(ROOT, 'js/library/LibraryLoader.js'));
require(path.join(ROOT, 'js/library/PassageResolver.js'));
const ExamBuilder = require(path.join(ROOT, 'js/library/ExamBuilder.js'));
const ExamValidator = require(path.join(ROOT, 'js/engine/validation/ExamValidator.js'));
const N = Number(process.argv[2]);
const list = JSON.parse(fs.readFileSync('prompts/list.json', 'utf8')).filter((x) => x.exam === N);
const slugs = list.map((x) => x.slug); const hit = (id) => slugs.some((s) => String(id).includes('-' + s + '-') || String(id).endsWith('-' + s));
const full = JSON.parse(fs.readFileSync(ROOT + '/library/en/B1/questions.json', 'utf8'));
const sub = { ...full, questions: full.questions.filter((q) => hit(q.id)), passages: (full.passages || []).filter((p) => hit(p.id)) };
const blueprint = JSON.parse(fs.readFileSync(`${ROOT}/library/blueprints/${ExamBlueprint.INDEX.en_B1}.json`, 'utf8'));
const assembled = ExamBlueprint.assemble(sub, blueprint, {});
console.log('cobertura', ExamBlueprint.coverageSummary(assembled.coverage).ratio, '· seleccionadas', (assembled.selected || []).length);
const exam = ExamBuilder.buildFromBlueprint('en', 'B1', sub, blueprint, { assembled });
const check = new ExamValidator().validate(exam, { strict: true, blueprint });
console.log('valid', check.valid); console.log('errors', check.errors); console.log('warnings', check.warnings);
