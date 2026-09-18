#!/usr/bin/env node
/**
 * Fill vocabularyTags on served exam Lesen questions (data/exams/*.json).
 * Usage: node scripts/enrich-served-vocab-tags.mjs --lang de --level B1 --apply
 *
 * SAFETY: sin --apply = dry-run, CERO escrituras a disco.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { extractVocabularyFromText } from './lib/enrichBatchMetadata.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Lemmatizer = require(path.join(ROOT, 'js/engine/validation/lemmatizer.js'));

const STOP = new Set([
  'sein', 'haben', 'werden', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem',
  'und', 'oder', 'aber', 'nicht', 'auch', 'sie', 'er', 'es', 'wir', 'ihr', 'ich', 'du', 'man', 'mit', 'von',
  'zu', 'auf', 'in', 'an', 'für', 'bei', 'nach', 'vor', 'über', 'unter', 'durch', 'als', 'wenn', 'weil', 'dass',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    lang: args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'de',
    level: args.includes('--level') ? String(args[args.indexOf('--level') + 1]).toUpperCase() : 'B1',
    // Require explicit --apply to write; --dry / --dry-run accepted as aliases but not required
    dry: !args.includes('--apply'),
  };
}

function loadLemmaSet(lang, level) {
  const file = path.join(ROOT, 'library', 'vocab', lang, `${level}.json`);
  if (!fs.existsSync(file)) return new Set();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Set((data.lemmas || []).map((w) => String(w).toLowerCase()));
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zäöüß\-]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function extractTags(text, lang, lemmaSet, max = 6) {
  // Mismo pipeline DE (v2 lemma/caps) que enrich-bank-vocab-tags.mjs. La ruta
  // legacy de abajo producia tags que no casaban con los del banco -- minusculas
  // (`vorschlag` vs `Vorschlag`) y funcionales que su STOP recortada no filtra
  // (`sich`) -- y la personalizacion cruza ambas fuentes.
  if (String(lang || 'de').toLowerCase().startsWith('de')) {
    return extractVocabularyFromText(text, max).map((w) => String(w));
  }
  const scored = new Map();
  for (const tok of tokenize(text)) {
    const low = tok.toLowerCase();
    if (STOP.has(low)) continue;
    const lem = Lemmatizer.normalizeLemma(low, lang);
    if (!lem || STOP.has(lem)) continue;
    let score = lem.length >= 6 ? 2 : 1;
    if (lemmaSet.has(lem)) score += 3;
    scored.set(lem, Math.max(scored.get(lem) || 0, score));
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, max)
    .map(([w]) => w);
}

function collectPassageTexts(exam) {
  const map = new Map();
  for (const part of exam.lesenParts || []) {
    if (part.text) map.set(part.passageId || part.textTitle || `lesen-t${part.teil}`, part.text);
    for (const pp of part.passages || []) {
      if (pp.text) map.set(pp.passageId || pp.id, pp.text);
    }
    for (const ad of part.ads || []) {
      const t = typeof ad === 'string' ? ad : ad?.text || ad?.title || '';
      if (t) map.set(`ad-${ad.key || t.slice(0, 12)}`, t);
    }
  }
  return map;
}

const OPTION_KEY_RE = /^\s*([A-Za-z])\s*[).\-:\]]/;

/** En matching, las opciones son los anuncios del bloque entero; solo la correcta es de esta pregunta. */
function matchingAnswerText(q) {
  const key = String(q?.correct ?? q?.correctAnswer ?? '').trim().toUpperCase();
  if (!key) return null;
  for (const opt of q?.options || []) {
    const text = typeof opt === 'string' ? opt : opt?.text;
    if (!text) continue;
    const m = OPTION_KEY_RE.exec(text);
    if (m && m[1].toUpperCase() === key) return text;
  }
  return null;
}

/**
 * `own` es lo que distingue a esta pregunta; `context` (el pasaje) solo desempata.
 * Metido en el mismo blob gana por volumen y todas las preguntas de la parte
 * acaban con los mismos tags.
 */
function enrichQuestion(q, own, context, lang, lemmaSet) {
  if ((q.vocabularyTags || []).length >= 3) return false;
  const tags = extractTags(own, lang, lemmaSet, 6);
  if (tags.length < 3) {
    for (const w of extractTags(context, lang, lemmaSet, 6)) {
      if (tags.length >= 3) break;
      if (!tags.includes(w)) tags.push(w);
    }
  }
  if (tags.length < 3) return false;
  q.vocabularyTags = tags.slice(0, 6);
  return true;
}

function walkLesenQuestions(exam, lang, lemmaSet) {
  const passages = collectPassageTexts(exam);
  let updated = 0;
  for (const part of exam.lesenParts || []) {
    const partText = [part.text, part.textTitle, part.instruction].filter(Boolean).join(' ');
    const enrich = (q, extra = '') => {
      const own = [q.question, q.statement, q.signText, q.text];
      if (String(q?.type || '').toLowerCase().startsWith('match')) {
        const answer = matchingAnswerText(q);
        if (answer) own.push(answer);
      } else {
        (q.options || []).forEach((o) => own.push(typeof o === 'string' ? o : o?.text));
      }
      const context = [extra, partText].filter(Boolean).join(' ');
      if (enrichQuestion(q, own.filter(Boolean).join(' '), context, lang, lemmaSet)) updated += 1;
    };
    for (const q of part.questions || []) enrich(q, partText);
    for (const pp of part.passages || []) {
      for (const q of pp.questions || []) enrich(q, pp.text || '');
    }
    for (const item of part.items || []) {
      if (!item.question && !item.statement && item.type === 'matching') continue;
      enrich(item, item.signText || item.text || '');
    }
  }
  return updated;
}

function main() {
  const { lang, level, dry } = parseArgs();
  const file = path.join(ROOT, 'data', 'exams', `${lang}_${level}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}`);
    process.exit(1);
  }
  const exams = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(exams)) {
    console.error('Expected served exams array');
    process.exit(1);
  }
  const lemmaSet = loadLemmaSet(lang, level);
  let total = 0;
  for (const exam of exams) {
    total += walkLesenQuestions(exam, lang, lemmaSet);
  }
  console.log(`Enriched ${total} Lesen question(s) in ${lang}_${level} served`);
  if (dry || total === 0) return;
  fs.writeFileSync(file, `${JSON.stringify(exams, null, 2)}\n`, 'utf8');
}

main();
