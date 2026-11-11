// Builds the calibration set for the Cambridge B1 reviewer.
//   good: every Reading/Listening part of the 4 published en/B1 exams (main)
//   real-bad: the parts fixed in 8a1d612, taken from the version before the fix;
//             defective questions = those whose stem/options/key changed in the fix
// Output: units.json  [{unitId, source, module, teil, slot, instruction, text, questions, truth}]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));

function partsOf(examsFile) {
  const out = [];
  for (const rec of load(examsFile)) {
    const e = rec.exam || rec;
    const examId = e.examId || e.id;
    for (const p of e.lesenParts || []) {
      out.push({
        key: `${examId}|lesen|${p.teil}`,
        examId, module: 'reading', teil: p.teil, slot: p.blueprintSlot,
        instruction: p.instruction || '',
        text: [p.textTitle, p.text].filter(Boolean).join('\n\n') +
          (Array.isArray(p.texts) ? '\n\n' + p.texts.map((t) => `${t.label || t.id}: ${t.text}`).join('\n\n') : '') +
          (Array.isArray(p.ads) ? '\n\n' + p.ads.map((t) => `${t.key}) ${t.title} — ${t.text}`).join('\n\n') : ''),
        questions: [...(p.questions || []), ...(p.items || [])].map((q) => { const sq = slimQ(q); if (q.signText) sq.question = `[Text] ${q.signText}
[Question] ${sq.question}`; return sq; }),
        raw: p,
      });
    }
    for (const p of e.horenParts || []) {
      const segs = p.segments || [];
      const text = segs.length
        ? segs.map((s) => `[${s.label || s.id}]\n${s.transcript || ''}`).join('\n\n')
        : p.transcript || '';
      out.push({
        key: `${examId}|listening|${p.teil}`,
        examId, module: 'listening', teil: p.teil, slot: p.blueprintSlot,
        instruction: p.instruction || '',
        text,
        questions: segs.flatMap((s) => (s.questions || []).map((q) => ({ ...slimQ(q), segment: s.label || s.id }))),
        raw: p,
      });
    }
  }
  return out;
}

function slimQ(q) {
  return {
    id: q.id,
    type: q.type,
    question: q.question || '',
    options: q.options || [],
    correct: q.correct ?? q.correctAnswer ?? '',
    explanation: q.explanation || '',
  };
}

// Reading P2 keeps its 8 texts outside `text` in some shapes: surface anything textual we missed.
function ensureText(u) {
  if (u.text.trim().length > 40) return u;
  const extra = JSON.stringify(u.raw.passages || u.raw.texts || u.raw.people || '');
  return { ...u, text: u.text + '\n' + extra };
}

const now = partsOf('en_B1.now.json');
const before = partsOf('en_B1.before.json');
const after = partsOf('en_B1.after.json');

const units = [];
for (const u of now) {
  units.push({ unitId: `good:${u.key}`, source: 'published', ...ensureText(u), truth: { defective: [] } });
}

// Ground truth = the 11 questions the fix commit documents (8a1d612 message): P5 distractors
// that were also correct (or duplicated the key) and P6 open-cloze gaps with content-word keys.
// The same commit also changed US→UK spelling in other items; those are not reviewer targets.
const DEFECTS = {
  'ql_en-b1-r-t5-cloze-music-festival-01-q5': 'distractor "explore" also correct',
  'ql_en-b1-r-t5-cloze-music-festival-03-q4': 'distractor "carry" also correct',
  'ql_en-b1-r-t5-cloze-music-festival-03-q5': 'distractor "variety" also correct',
  'ql_en-b1-r-t5-cloze-cooking-class-01-q1': 'option a duplicates the key (knew/knew)',
  'ql_en-b1-r-t5-cloze-cooking-class-01-q3': 'distractor "told" also correct',
  'ql_en-b1-r-t5-cloze-cooking-class-01-q5': 'distractors "cooked"/"finished" also correct',
  'ql_en-b1-r-t6-open-cloze-family-trip-01-q2': 'open-cloze key is a content word (made)',
  'ql_en-b1-r-t6-open-cloze-family-trip-01-q4': 'open-cloze key is a content word (lots)',
  'ql_en-b1-r-t6-open-cloze-family-trip-01-q6': 'open-cloze key is a content word (next)',
  'ql_en-b1-r-t6-open-cloze-part-time-job-01-q1': 'open-cloze key is a content word (never)',
  'ql_en-b1-r-t6-open-cloze-part-time-job-01-q3': 'open-cloze key is a content word (spending)',
};
for (const b of before) {
  const defective = b.questions.filter((q) => DEFECTS[q.id]).map((q) => q.id);
  if (!defective.length) continue;
  units.push({
    unitId: `realbad:${b.key}`, source: 'pre-fix 8a1d612', ...ensureText(b),
    truth: { defective, why: Object.fromEntries(defective.map((id) => [id, DEFECTS[id]])) },
  });
}

for (const u of units) delete u.raw;
fs.writeFileSync(path.join(here, 'units.json'), JSON.stringify(units, null, 1));
const bad = units.filter((u) => u.truth.defective.length);
console.log(`units ${units.length} · good ${units.length - bad.length} · realbad ${bad.length} · defective questions ${bad.reduce((n, u) => n + u.truth.defective.length, 0)}`);
for (const u of bad) console.log('  ', u.unitId, '→', u.truth.defective.map((x) => x.split('-').pop()).join(','));
