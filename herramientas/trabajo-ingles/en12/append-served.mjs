// Append ONE curated exam to data/exams/en_B1.json with curated-to-served's own transform,
// leaving the served entries (hand-fixed since Aug/Sep, ahead of their curated files) untouched.
import fs from 'node:fs'; import path from 'node:path';
const ROOT = process.cwd(); const [file, apply] = process.argv.slice(2);
const { isExamPublishable } = await import('file://' + ROOT + '/scripts/audit-pass-2.mjs');
const servedFile = path.join(ROOT, 'data/exams/en_B1.json');
const served = JSON.parse(fs.readFileSync(servedFile, 'utf8'));
const x = JSON.parse(fs.readFileSync(path.join(ROOT, 'library/curated/en/B1', file), 'utf8'));
const exam = x.exam || x;
const m = /^curated_[^_]+_[^_]+_([0-9a-f]+)\.json$/i.exec(file);
if (!exam.examId) exam.examId = `official-en-B1-${m[1]}`;
if (!exam.id) exam.id = exam.examId;
if (served.some((e) => e.id === exam.id)) throw new Error('ya está servido: ' + exam.id);
const gate = isExamPublishable(exam);
if (!gate.ok) { console.error('BLOQUEADO', gate.blocking.map((f) => f.id + ' ' + f.message)); process.exit(1); }
let dropped = 0;
const allowed = (part) => { const s = new Set(); if (part.passageId) s.add(part.passageId); for (const pp of part.passages || []) { if (pp.passageId) s.add(pp.passageId); if (pp.id) s.add(pp.id); } for (const q of part.questions || []) if (q.passageId) s.add(q.passageId); return s; };
const guard = (c, ids) => { if (!Array.isArray(c.questions)) return; c.questions = c.questions.filter((q) => { if (q.passageId && ids.size && !ids.has(q.passageId)) { dropped++; return false; } return true; }); };
(exam.lesenParts || []).forEach((p) => guard(p, allowed(p)));
(exam.horenParts || []).forEach((p) => (p.segments || []).forEach((s) => guard(s, allowed(s))));
console.log('gate OK · advisory', gate.advisory.length, '· huérfanas', dropped, '· servidos', served.length, '→', served.length + 1, '·', exam.id);
if (apply === '--apply') { served.push(exam); fs.writeFileSync(servedFile, JSON.stringify(served, null, 2) + '\n', 'utf8'); console.log('Escrito'); }
