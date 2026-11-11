// Builds review.html from the pilot batches + my findings. Run with node from anywhere.
import fs from 'node:fs';
import path from 'node:path';

const SP = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1');
const DIR = path.join(SP, 'pilot-batches');

const PART_NAMES = {
  lesen: { label: 'Reading', 1: 'Signs & messages', 2: 'Matching people to texts', 3: 'Long text MCQ', 4: 'Gapped text', 5: 'Multiple-choice cloze', 6: 'Open cloze' },
  horen: { label: 'Listening', 1: 'Short extracts (picture MCQ)', 2: 'Short dialogues', 3: 'Gap fill (monologue)', 4: 'Interview MCQ' },
  schreiben: { label: 'Writing', 1: 'Email + Part 2 article/story' },
  sprechen: { label: 'Speaking', 1: 'Parts 1–4' },
};
const ORDER = ['lesen', 'horen', 'schreiben', 'sprechen'];

// My findings, keyed by file slug. q = question id suffix (or null for the whole batch).
const FLAGS = {
  'lesen-t1-notices-hospital-01': [
    { sev: 'crit', q: 'q3', text: 'La explicación dice «Option ‘a’ captures this best», pero la clave es c. Además, «main instruction» es discutible: el aviso pide sobre todo silencio; c es solo una parte.' },
  ],
  '_rejected-lesen-t3': [
    { sev: 'crit', q: null, text: 'Rechazado por el validador: la pregunta 3 apunta a un pasaje con una errata en el id («abobroad»). Se arregla en un segundo; el contenido se revisa igual.' },
    { sev: 'warn', q: 'q1', text: 'El auditor (CHK-34) dice que la cita de la explicación no respalda la opción correcta. Mira si la respuesta A se deduce del texto.' },
  ],
  'horen-t1-pics-travel-times-01': [
    { sev: 'warn', q: 's5-q1', text: 'La opción correcta es la más larga (+28 %). Pista involuntaria.' },
    { sev: 'warn', q: 's6-q1', text: 'La opción correcta es la más larga (+36 %).' },
    { sev: 'info', q: null, text: 'En Cambridge el Part 1 lleva dibujos; aquí las opciones son texto, como en los exámenes ya publicados.' },
  ],
  'horen-t2-gist-free-time-04': [
    { sev: 'warn', q: 'q1', text: 'La opción correcta es la más larga (+59 %).' },
  ],
  'lesen-t5-cloze-online-shopping-01': [
    { sev: 'warn', q: 'q5', text: 'La opción correcta es la más larga (6 letras frente a 4/5). Con palabras sueltas pesa menos.' },
    { sev: 'warn', q: 'q6', text: 'La opción correcta es la más larga (8 frente a 6/3).' },
  ],
  'lesen-t4-gapped-community-garden-01': [
    { sev: 'info', q: null, text: 'El auditor marca el título como «truncado» porque no acaba en punto. Es un titular: falso positivo.' },
  ],
  'schreiben-email-school-project-01': [
    { sev: 'crit', q: 'w-t2-email-school-project-01-q1', text: 'Explicación en ALEMÁN («Bewertung: Inhalt vollständig…»). Viene del normalizador (normalizeBatch.mjs:175), no de Gemini: se arregla en el código.' },
  ],
  'sprechen-speaking-free-time-02': [
    { sev: 'crit', q: null, text: 'Tipo «rubric» en vez de «short_answer» (lo mismo se corrigió a mano el 21 sep). Arreglo mecánico en el normalizador.' },
    { sev: 'warn', q: 't2-speaking-free-time-02-q1', text: '«(Imagine a colour photo…)»: el alumno leería una instrucción para el diseñador. Los exámenes publicados tampoco tienen foto, pero lo dicen mejor («Describe this colour photo of…»).' },
    { sev: 'warn', q: 't3-speaking-free-time-02-q1', text: '«(Imagine a prompt with 5 images…)»: mismo problema en el Part 3.' },
  ],
  'sprechen-speaking-sport-health-01': [
    { sev: 'crit', q: null, text: 'Tipo «rubric» en vez de «short_answer», y alguna explicación en alemán (normalizador).' },
  ],
  'sprechen-speaking-study-work-02': [
    { sev: 'crit', q: null, text: 'Tipo «rubric» en vez de «short_answer», y alguna explicación en alemán (normalizador).' },
  ],
  'sprechen-speaking-travel-transport-01': [
    { sev: 'crit', q: null, text: 'Tipo «rubric» en vez de «short_answer» (normalizador).' },
  ],
};

function stripLetter(opt) {
  return String(opt).replace(/^[a-h]\)\s*/i, '');
}

const batches = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  const slug = f.replace(/\.json$/, '');
  const b = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const mod = b.questions[0]?.module || slug.split('-')[0].replace(/^_rejected$/, 'lesen');
  const teil = mod === 'schreiben' || mod === 'sprechen' ? 1 : Number(b.questions[0]?.teil) || 0;
  const passages = (b.passages || []).map((p) => ({ id: p.id, title: p.title || '', text: p.text || '' }));
  const questions = (b.questions || []).map((q) => ({
    id: q.id,
    short: q.id.split('-').slice(-2).join('-'),
    teil: q.teil,
    type: q.type,
    segment: q.segmentLabel || '',
    passageId: q.passageId || '',
    question: q.question || '',
    options: (q.options || []).map(stripLetter),
    correct: String(q.correct ?? ''),
    explanation: q.explanation || '',
  }));
  const flags = (FLAGS[slug] || []).map((fl) => ({
    ...fl,
    qid: fl.q ? questions.find((q) => q.id.endsWith(fl.q))?.id || null : null,
  }));
  batches.push({
    slug,
    rejected: slug.startsWith('_rejected'),
    module: mod,
    teil,
    moduleLabel: PART_NAMES[mod]?.label || mod,
    partLabel: mod === 'schreiben' || mod === 'sprechen' ? PART_NAMES[mod][1] : `Part ${teil} · ${PART_NAMES[mod]?.[teil] || ''}`,
    passages,
    questions,
    flags,
  });
}
batches.sort((a, b) => ORDER.indexOf(a.module) - ORDER.indexOf(b.module) || a.teil - b.teil);

const tpl = fs.readFileSync(path.join(SP, 'review.template.html'), 'utf8');
const data = JSON.stringify(batches).replace(/</g, '\\u003c');
fs.writeFileSync(path.join(SP, 'piloto-ingles.html'), tpl.replace('__DATA__', data));
console.log('batches', batches.length, 'questions', batches.reduce((n, b) => n + b.questions.length, 0), 'flags', batches.reduce((n, b) => n + b.flags.length, 0));
