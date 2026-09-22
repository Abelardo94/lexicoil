#!/usr/bin/env node
/**
 * backfill-en-topic-tags.mjs — pone topicTag a las partes de en/B1 que no lo tienen.
 *
 * El eje de temas ingles (js/data/enB1Topics.js) es nuevo, asi que las 48 partes
 * que ya existian estan sin etiquetar y el planificador de huecos las cuenta como
 * stock 0. Esto las clasifica por su propio texto, sin llamar a ninguna IA.
 *
 * Uso:
 *   node scripts/backfill-en-topic-tags.mjs            # seco, imprime la tabla
 *   node scripts/backfill-en-topic-tags.mjs --apply    # escribe (hace .bak antes)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './lib/loadEnv.mjs';

const require = createRequire(import.meta.url);
const { EN_B1_TOPICS } = require(path.join(ROOT, 'js/data/enB1Topics.js'));

const APPLY = process.argv.includes('--apply');
const SEED = path.join(ROOT, 'library/reusable-seed/en_B1.json');

/** Palabras que delatan cada tema. Se puntua por numero de aciertos distintos. */
const KEYWORDS = {
  Travel: ['travel', 'trip', 'holiday', 'flight', 'airport', 'hotel', 'tourist', 'abroad', 'journey', 'suitcase', 'passport', 'booking', 'destination', 'backpack', 'place to visit', 'mountains', 'sightseeing'],
  Health: ['health', 'doctor', 'hospital', 'illness', 'medicine', 'patient', 'symptom', 'clinic', 'nurse', 'gym', 'swimming pool', 'wellbeing', 'diet', 'sleep'],
  Work: ['work', 'job', 'career', 'office', 'employer', 'employee', 'colleague', 'salary', 'interview', 'shift', 'manager', 'workplace', 'staff'],
  Technology: ['technology', 'computer', 'software', 'internet', 'online', 'digital', 'smartphone', 'website', 'device', 'screen', 'robot', 'data'],
  Media: ['news', 'newspaper', 'magazine', 'television', 'radio', 'journalist', 'media', 'broadcast', 'article', 'social media', 'podcast'],
  Housing: ['flat', 'apartment', 'rent', 'landlord', 'house', 'neighbour', 'furniture', 'kitchen', 'moving house', 'accommodation', 'tenant'],
  Shopping: ['shop', 'shopping', 'price', 'customer', 'store', 'discount', 'refund', 'receipt', 'market', 'delivery', 'money'],
  Education: ['school', 'student', 'teacher', 'exam', 'university', 'study', 'course', 'homework', 'lesson', 'library', 'degree', 'pupil', 'timetable', 'learn', 'skill'],
  Family: ['family', 'parents', 'mother', 'father', 'brother', 'sister', 'children', 'friend', 'grandmother', 'grandfather', 'cousin', 'relatives'],
  Environment: ['environment', 'climate', 'recycling', 'pollution', 'plastic', 'energy', 'nature', 'waste', 'wildlife', 'sustainable', 'planet'],
  Food: ['food', 'meal', 'cook', 'restaurant', 'recipe', 'vegetable', 'breakfast', 'lunch', 'dinner', 'menu', 'coffee', 'bread'],
  Culture: ['music', 'concert', 'museum', 'theatre', 'film', 'cinema', 'festival', 'exhibition', 'gallery', 'author', 'painting'],
  Sport: ['sport', 'football', 'match', 'training', 'player', 'competition', 'swimming', 'running', 'coach', 'athlete', 'tournament', 'fitness'],
  'Free time': ['hobby', 'free time', 'spare time', 'weekend', 'leisure', 'garden', 'photography', 'relax', 'picnic', 'walking'],
  Transport: ['bus', 'train', 'station', 'bicycle', 'cycling', 'traffic', 'driving', 'underground', 'commute', 'platform', 'parking'],
  'City life': ['city', 'town', 'street', 'centre', 'park', 'urban', 'square', 'council', 'community', 'residents', 'neighbourhood', 'village'],
};

for (const t of EN_B1_TOPICS) {
  if (!KEYWORDS[t]) throw new Error(`Sin palabras clave para el tema "${t}" — la tabla y el eje no cuadran.`);
}

/**
 * Andamiaje de la consigna, no tema. Sin quitarlo, los 4 schreiben T2 salen
 * "Media" por "write an article for your school magazine" cuando en realidad
 * van de Education, Sport o Travel. Se borra antes de puntuar.
 */
const SCAFFOLD = [
  'school magazine', 'write an article', 'write a story', 'write an email',
  'write about', 'an article titled', 'article for', 'articles wanted',
  'story that begins with the sentence', 'story that begins',
  'read this email', 'read the text', 'read the texts',
  'the notes you have made', 'answering all the notes', 'answering all your notes',
  'choose one of the following tasks', 'choose one of the following',
  'answer the questions in part', 'international english website',
  'english-speaking friend', 'target:', 'option 1', 'option 2',
  'article', 'magazine', 'story', 'notice', 'email', 'notes', 'task', 'tasks',
];

function textOf(rec) {
  const bits = [rec.instruction || ''];
  const p = rec.passage;
  if (typeof p === 'string') bits.push(p);
  else if (p) bits.push(p.title || '', p.text || '', p.transcript || '');
  for (const s of rec.segments || []) bits.push(s.label || '', s.text || '', s.transcript || '');
  for (const q of rec.questions || []) {
    bits.push(q.prompt || q.text || q.question || '');
    for (const o of q.options || []) bits.push(typeof o === 'string' ? o : o?.text || '');
  }
  let text = bits.join(' ').toLowerCase();
  for (const phrase of SCAFFOLD) text = text.split(phrase).join(' ');
  return text;
}

/** Cuenta apariciones, hasta 3 por palabra: separa mejor que presencia/ausencia. */
function weigh(text, word) {
  let n = 0;
  let i = text.indexOf(word);
  while (i !== -1 && n < 3) {
    n++;
    i = text.indexOf(word, i + word.length);
  }
  return n;
}

function classify(rec) {
  const text = textOf(rec);
  const scored = EN_B1_TOPICS.map((topic) => {
    const hits = KEYWORDS[topic].filter((w) => text.includes(w));
    const score = KEYWORDS[topic].reduce((sum, w) => sum + weigh(text, w), 0);
    return { topic, score, hits };
  }).sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));
  const [best, second] = scored;
  if (!best.score) return { topic: null, why: '(sin senal)', margin: 0, score: 0 };
  return {
    topic: best.topic,
    why: best.hits.slice(0, 4).join(', '),
    margin: best.score - (second?.score || 0),
    score: best.score,
  };
}

const data = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const rows = [];
let tagged = 0;
let unresolved = 0;

for (const rec of data.records || []) {
  if (rec.topicTag) continue;
  const r = classify(rec);
  rows.push({ id: rec.id, cell: `${rec.module} T${rec.teil}`, ...r });
  if (r.topic) {
    tagged++;
    if (APPLY) {
      rec.topicTag = r.topic;
      rec.topicTagSource = 'backfill-en-topic-tags';
      rec.topicTaggedAt = new Date().toISOString();
    }
  } else unresolved++;
}

console.log(`${'celda'.padEnd(13)} ${'tema'.padEnd(12)} ${'m'.padStart(2)}  evidencia`);
for (const r of rows.sort((a, b) => a.cell.localeCompare(b.cell))) {
  const flag = r.topic && r.margin <= 1 ? '?' : ' ';
  console.log(`${r.cell.padEnd(13)} ${String(r.topic || '-').padEnd(12)} ${String(r.margin).padStart(2)}${flag} ${r.why}`);
}

const dist = {};
for (const r of rows) if (r.topic) dist[r.topic] = (dist[r.topic] || 0) + 1;
console.log(`\netiquetadas ${tagged} · sin resolver ${unresolved} · de ${rows.length}`);
console.log('reparto:', Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' · '));
console.log(`ambiguas (margen <=1, marcadas "?"): ${rows.filter((r) => r.topic && r.margin <= 1).length}`);

if (APPLY) {
  const bak = `${SEED}.bak-topictag-${Date.now()}`;
  fs.copyFileSync(SEED, bak);
  fs.writeFileSync(SEED, JSON.stringify(data, null, 2));
  console.log(`\nESCRITO. Copia previa: ${path.basename(bak)}`);
} else {
  console.log('\nSeco. Nada escrito. Anade --apply para escribir.');
}
