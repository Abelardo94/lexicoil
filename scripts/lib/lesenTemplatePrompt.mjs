import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './loadEnv.mjs';
import { applyVocabPreferenceToTemplate, reinforceVocabOptionalBlock } from './userVocabPrompt.mjs';
import { injectT5PromptVariants, injectT4PromptVariants } from './lesenSubtypeRotation.mjs';
import { filterPromptTargetWords, isBlacklistedLemma } from './lexicalCheck.mjs';
import { buildExcludedPremisesPromptBlock } from './excludedPremises.mjs';
import { appendGenerationFeedback } from './resolveGenerationFeedback.mjs';
import { buildLesenT3NamesPromptBlock } from './lesenT3NamesBank.mjs';
import { buildLesenT2OpeningsPromptBlock } from './lesenT2OpeningsBank.mjs';
import { buildTopicPromptBlock } from './topicRotation.mjs';
import {
  assemblePrompt,
  buildVocabVariableBlock,
  extractAutorrevisionSection,
  stripAutorrevisionSection,
  stripVocabSectionFromTemplate,
} from './promptAssembly.mjs';
import { GENERATED_DIR, nextNumberedBatchBasename } from './batchPaths.mjs';
import { buildLengthBiasRepairSpec, buildMcqLengthRulePrompt, mcqCorrectLetter, mcqOptionBody } from './mcqLengthBias.mjs';
import { finalizeRepairPrompt } from './germanExplanationPromptRules.mjs';

function formatForbiddenNgramsBlock(ngrams) {
  const list = (ngrams || []).filter(Boolean).slice(0, 40);
  if (!list.length) return '';
  return (
    `- N-GRAMAS PROHIBIDOS del pasaje/audio (≥4 palabras seguidas — NO repetir en opción correcta ni enunciado):\n` +
    `${list.map((g) => `  · «${g}»`).join('\n')}\n`
  );
}

const PLACEHOLDER =
  /<<< pon aquí 8-12 palabras alemanas separadas por comas, p\. ej\.: bibliothek, ausleihen, frist, gebühr >>>/;
const WORDS_BLOCK = /<<<[^>]+>>>/;

const LESEN_TEMPLATE_DIRS = {
  A2: 'plantillas-lesen-a2',
  B1: 'plantillas-lesen-b1',
  B2: 'plantillas-lesen-b2',
};

function resolveLesenTemplateDir(level = 'B1') {
  const lv = String(level || 'B1').trim().toUpperCase();
  return path.join(ROOT, LESEN_TEMPLATE_DIRS[lv] || LESEN_TEMPLATE_DIRS.B1);
}

const TEMPLATE_DIR = path.join(ROOT, 'plantillas-lesen-b1');

/** CEFR + blueprint word bounds injected into every generation prompt. */
const TEIL_LENGTH_RULES = {
  1: {
    target: '165-200',
    min: 150,
    max: 220,
    scope: 'passages[0].text',
    note: '1 blog/e-mail en 1ª persona (ich).',
  },
  2: {
    target: '165-195 cada uno',
    min: 150,
    max: 195,
    scope: 'cada passages[i].text (2 textos) — gate CEFR: SUMA ≤400',
    note: '2 textos de prensa; el ingest cuenta AMBOS juntos (máx 400 palabras total, no 400 por texto).',
  },
  3: {
    target: '25-45',
    min: 20,
    max: 60,
    scope: 'cada anuncio en options (A-J)',
    note: '10 anuncios telegram-style; sin pasaje prose.',
  },
  4: {
    target: 'intro 50-70 + 7 opiniones ~25-35',
    min: 150,
    max: 400,
    scope: 'passages[0].text + todos los signText (suma total ≤400, ≥150)',
    note: 'Cada pregunta ja_nein lleva signText con la opinión (sin repetir el nombre al inicio).',
  },
  5: {
    target: '185-230',
    min: 180,
    max: 250,
    scope: 'passages[0].text',
    note: 'Hausordnung / Regeln con bullets o párrafos cortos.',
  },
};

/** Goethe A2 Lesen — alineado a library/blueprints/goethe_A2.json */
const A2_TEIL_LENGTH_RULES = {
  1: {
    target: '120-200',
    min: 120,
    max: 200,
    scope: 'passages[0].text',
    note: 'Medientext / Zeitungsnotiz, 5 MCQ a/b/c.',
  },
  2: {
    target: '80-150',
    min: 80,
    max: 150,
    scope: 'passages[0].text (Informationstafel / Plan)',
    note: 'Plano de edificio o tablero informativo, 5 MCQ situacionales Stock/Etage.',
  },
  3: {
    target: '100-180',
    min: 100,
    max: 180,
    scope: 'passages[0].text (E-Mail)',
    note: 'Correo con Anrede + Gruß, 5 MCQ a/b/c.',
  },
  4: {
    target: '20-60 por anuncio',
    min: 20,
    max: 60,
    scope: 'cada passages[i].text (6 Anzeigen a–f)',
    note: '6 anuncios + 5 matching; opciones ["a"…"f","X"].',
  },
};

/** Goethe B2 Lesen — alineado a library/blueprints/goethe_B2.json */
const B2_TEIL_LENGTH_RULES = {
  1: {
    target: '80-180',
    min: 80,
    max: 180,
    scope: 'cada passages[i].text (4 Personen A–D)',
    note: 'Forum-Beiträge; Fase A solo pasajes; Fase B 9 matching.',
  },
  2: {
    target: '280-360',
    min: 250,
    max: 400,
    scope: 'passages[0].text (1 Zeitschrift-Artikel)',
    note: 'Sätze einfügen: 6 Lücken (21)–(26), 8 Sätze A–H, 6 matching.',
  },
  3: {
    target: '400-450',
    min: 350,
    max: 500,
    scope: 'passages[0].text (1 Zeitungsartikel)',
    note: '6× MCQ a/b/c; instrucción oficial en Q1.',
  },
  4: {
    target: '55-85',
    min: 40,
    max: 100,
    scope: 'cada passages[i].text (Meinungsäußerung Zeitschrift)',
    note: '6 opiniones + 8 Überschriften A–H; 6 matching; 2 titulares sobrantes.',
  },
  5: {
    target: '260-320',
    min: 200,
    max: 350,
    scope: 'passages[0].text (Studienordnung)',
    note: '3 Paragrafen (31)–(33) + 7 Überschriften A–G; 3 matching; 4 sobrantes.',
  },
};

const B2_CEFR_VOCAB_HINT =
  'Nivel B2: léxico abstracto moderado permitido en pasajes (Digitalisierung, Regulierung, Nachhaltigkeit). ' +
  'Preguntas/explicaciones: claras B2, sin C1 académico. grammarTags solo vía post-proceso (6 categorías oficiales).';

function loadLesenTemplateB2ForumPhase(phase) {
  const raw = fs.readFileSync(lesenTemplatePath(1, 'B2'), 'utf8');
  const dash = raw.indexOf('\n---\n');
  const body = dash >= 0 ? raw.slice(dash + 5) : raw;
  const markerA = '---FASE-A---';
  const markerB = '---FASE-B---';
  const iA = body.indexOf(markerA);
  const iB = body.indexOf(markerB);
  if (iA < 0 || iB < 0) throw new Error('plantillas-lesen-b2/lesen-teil1.md: faltan marcadores FASE-A / FASE-B');
  const p = String(phase || '').toLowerCase();
  if (p === 'passage' || p === 'a') {
    return body.slice(iA + markerA.length, iB).trim();
  }
  if (p === 'questions' || p === 'b') {
    return body.slice(iB + markerB.length).trim();
  }
  throw new Error(`forumPhase inválida: ${phase} (usa passage|questions)`);
}

export function buildLesenB2ForumFixedPassagesBlock(passages) {
  const slim = (passages || []).map((p) => ({
    id: p.id,
    personKey: p.personKey,
    title: p.title,
    text: p.text,
  }));
  return (
    `\n\n## FORO FIJO (NO modificar — genera solo questions)\n` +
    `Usa exactamente estos 4 Beiträge; no reescribas passages en la salida (devuelve "passages": []).\n` +
    `\`\`\`json\n${JSON.stringify(slim, null, 2)}\n\`\`\`\n`
  );
}

const CEFR_VOCAB_HINT =
  'Prefiere léxico B1 frecuente: Bewohner, Nachbarn, Stadt, Programm, Organisation, Erfahrungen, ' +
  'Familie, Kinder, Schule, Arbeit, Transport, Kurs, Projekt, Freizeit, Bericht, Termin. ' +
  'Evita rarezas (Begabung, künstlerisch, Denkmuster…) salvo en PALABRAS OBJETIVO. ' +
  'Evita términos C1/académicos (kontextualisieren, Polyphonie, Paradigma, Manifestation, Epistemologie…). ' +
  'ANTI-ANGLICISMOS: NUNCA escribas verbos/sustantivos ingleses sin traducir — ' +
  'gardening→Gartenarbeit/Gärtnern, jogging→Joggen, hiking→Wandern, cycling→Radfahren. ' +
  'Préstamos aceptados (Deadline, Meeting, Team, Computer, E-Mail, App, Blog, Event) ' +
  'SOLO si van capitalizados como sustantivos alemanes: «die Deadline», «das Meeting». ' +
  'ORTOGRAFÍA OBLIGATORIA: todos los sustantivos en MAYÚSCULA — también tras kein/keine, ' +
  'mit/für/von/ohne, en listas y enumeraciones ' +
  '(«Blumen und Pflanzen», «keine Hypothese», no «blumen», no «keine hypothese»). ' +
  'Repasa cada sustantivo antes de enviar. ' +
  'LÍMITE INVERSO — NUNCA capitalices a mitad de frase palabras que NO sean sustantivos ni nombres propios: ' +
  'adjetivos (schwierig, persönlich, zugänglich, einfach, möglich), ' +
  'cuantificadores (viele, wenige, einige), ' +
  'adverbios (lange, eher, leider, trotzdem, natürlich) ' +
  'y verbos conjugados (ich glaube, ich stimme, ich denke) van en MINÚSCULA a mitad de frase. ' +
  'Solo SUSTANTIVOS y nombres propios llevan mayúscula. ' +
  'Ejemplos correctos: «viele Menschen» (NO «Viele»), «in der Praxis schwierig» (NO «Schwierig»), ' +
  '«ich glaube» (NO «Glaube»), «ich stimme zu» (NO «Stimme»), «leicht zugänglich» (NO «Zugänglich»).';

/** Anti-patterns: fake authority sources + AI-emotional tone (audit 2026-07-10). */
const STYLE_ANTI_PATTERNS =
  'ANTI-MULETILLAS DE FUENTE FICTICIA: no abuses de «Ein Bericht zeigt…», «Eine Studie zeigt…», ' +
  '«Eine Umfrage ergab/zeigt…», «Experten erklären…», «Ein Artikel lobt…» como muleta repetida. ' +
  'Como máximo UNA mención de fuente por pasaje, y varía (Zeitung, Nachbar, eigene Erfahrung, Zahlen der Stadt). ' +
  'Si no hay dato concreto, escribe el hecho directamente sin inventar estudio/informe. ' +
  'ANTI-TONO EMOCIONAL/IA: PROHIBIDO fórmulas como «könnte/wäre ein kleines Wunder…», ' +
  '«verändert mein Leben für immer», «magische Erfahrung», hipérboles sentimentales. ' +
  'Prefiere registro neutro/informativo típico Goethe B1 (hechos, reglas, opiniones mesuradas).';

const CEFR_A2_VOCAB_HINT =
  'Prefiere léxico A2 frecuente (Familie, Wohnung, Arbeit, Freizeit, Einkaufen, Termin, Stadt, Kurs). ' +
  'Evita términos B1+ (Herausforderung, Weiterbildung, Investition…) salvo en PALABRAS OBJETIVO. ' +
  'ANTI-ANGLICISMOS A2: PROHIBIDO inglés crudo sin traducir — gardening→Gartenarbeit, jogging→Joggen, ' +
  'hiking→Wandern, cycling→Radfahren, **Workshop→Kurs/Seminar/Werkstatt** (nunca «Workshop» ni «Kreativ-Workshop»). ' +
  'Préstamos aceptados (Computer, E-Mail, App, Blog, Podcast) capitalizados como sustantivo alemán.';

function teilLengthBlock(teil, level = 'B1') {
  const lv = String(level || 'B1').trim().toUpperCase();
  const rules =
    lv === 'A2' ? A2_TEIL_LENGTH_RULES : lv === 'B2' ? B2_TEIL_LENGTH_RULES : TEIL_LENGTH_RULES;
  const r = rules[teil];
  if (!r) return '';
  const t2Extra =
    Number(teil) === 2 && lv === 'A2'
      ? '\n- **CRÍTICO T2 A2 Informationstafel (CEFR):** prosa con oraciones completas — NO solo rótulos telegráficos.\n' +
        '  · Apertura: «Willkommen im…! Hier finden Sie…» (≥2 oraciones).\n' +
        '  · Por local: **«Nombre: oración completa A2.»** (ej. «Bäckerei Müller: Frisches Brot und Kuchen.»).\n' +
        '  · PROHIBIDO: «Erdgeschoss: Bäckerei, Café» / líneas sueltas sin verbo ni punto.\n' +
        '  · Integra PALABRAS OBJETIVO en las descripciones (cobertura CEFR ≥55%).\n' +
        '  · Objetivo: 12–18 oraciones cortas A2 en 80–150 palabras.\n'
      : Number(teil) === 2 && lv !== 'A2' && lv !== 'B2'
        ? '\n- **CRÍTICO T2:** suma passages[0].text + passages[1].text ≤ **400 palabras** (gate CEFR). ' +
          'Objetivo **330-390 total** (~165-195 por texto). Si cada texto tiene ~220 palabras, FALLARÁS el ingest.\n' +
          '- Cuenta ambos textos antes de enviar; recorta relleno si la suma supera 390.\n'
        : '';
  const vocabHint =
    lv === 'A2' ? CEFR_A2_VOCAB_HINT : lv === 'B2' ? B2_CEFR_VOCAB_HINT : CEFR_VOCAB_HINT;
  const coverageNote =
    lv === 'A2'
      ? '- Cobertura léxica A2 objetivo: **≥55%** (texto demasiado complejo penaliza).\n'
      : lv === 'B2'
        ? '- Cobertura léxica B2: usa bank B2; evita C1 en preguntas.\n'
        : '- Cobertura léxica B1 objetivo: **≥75%** (palabras fuera de lista B1 frecuente penalizan).\n';
  return (
    `\n\n## LONGITUD CEFR (OBLIGATORIO — ingest RECHAZA si fallas)\n` +
    `- Ámbito: **${r.scope}** (${r.note})\n` +
    `- Objetivo: **${r.target} palabras**.\n` +
    `- Mínimo absoluto del gate: **${r.min}** · máximo blueprint: **${r.max}**.\n` +
    t2Extra +
    `- **CUENTA las palabras antes de responder.** Si estás por debajo, añade 2-4 frases nuevas con contenido (no relleno con adjetivos).\n` +
    `- El ejemplo JSON puede ser más corto por legibilidad; **tu salida NO puede ser más corta que el mínimo**.\n` +
    `- ${vocabHint}\n` +
    `- ${STYLE_ANTI_PATTERNS}\n` +
    coverageNote
  );
}

export function lesenTemplatePath(teil, level = 'B1') {
  const t = Number(teil);
  if (!Number.isFinite(t) || t < 1 || t > 5) {
    throw new Error(`Teil inválido: ${teil} (usa 1-5)`);
  }
  const lv = String(level || 'B1').trim().toUpperCase();
  const dir = resolveLesenTemplateDir(lv);
  const file = path.join(dir, `lesen-teil${t}.md`);
  if (!fs.existsSync(file)) {
    if (lv === 'A2') {
      const fallback = path.join(TEMPLATE_DIR, `lesen-teil${t}.md`);
      if (fs.existsSync(fallback)) return fallback;
    }
    throw new Error(`Plantilla no encontrada: ${path.relative(ROOT, file)}`);
  }
  return file;
}

export function loadLesenTemplate(teil, level = 'B1') {
  return fs.readFileSync(lesenTemplatePath(teil, level), 'utf8');
}

/** Quita la cabecera humana (# Plantilla… / Pega TODO…) y deja el prompt para la IA. */
export function stripHumanHeader(markdown) {
  const dash = String(markdown).indexOf('\n---\n');
  return (dash >= 0 ? markdown.slice(dash + 5) : markdown).trim();
}

export function injectTargetWords(markdown, words) {
  return applyVocabPreferenceToTemplate(markdown, words);
}

export function buildFewShotLesenBlock(teil, examples = [], level = 'B1') {
  if (!examples?.length) return '';
  const lv = String(level || 'B1').trim().toUpperCase();
  const blocks = examples.map((ex, i) => {
    const slim = {
      passages: (ex.passages || []).map((p) => ({
        title: p.title,
        text: p.text,
        topicTag: p.topicTag,
      })),
      questions: (ex.questions || []).map((q) => ({
        question: q.question,
        correct: q.correct,
        explanation: q.explanation,
      })),
    };
    return `### Ejemplo verificado ${i + 1} (T${teil}, tema ${ex.topicTag || ex._requestedTopic || lv})\n\`\`\`json\n${JSON.stringify(slim, null, 2)}\n\`\`\``;
  });
  return (
    `\n\n## EJEMPLOS VERIFICADOS (imita nivel ${lv}, parafraseo, estilo — NO copies contenido ni IDs)\n` +
    `Genera UNA parte **nueva** con el mismo nivel de calidad que estos ejemplos del pool:\n\n` +
    blocks.join('\n\n') +
    `\n\n`
  );
}

function buildLesenQuestionJsonKeyRule() {
  return (
    `- En questions[] el enunciado va SIEMPRE en la clave JSON "question" ` +
    `(PROHIBIDO text, questionText, statement u otros alias).\n`
  );
}

function buildLesenMcqChk34Rule(minWords = 6) {
  return (
    `- explanation (MCQ, CHK-34): alemán ≥${minWords} Wörter; explica por qué encaja con el texto; ` +
    `**PROHIBIDO** citar entre comillas el texto literal de la opción correcta ni «Option a/b/c)» — el orden puede reordenarse.\n`
  );
}

function buildLesenChecklistBlockA2(teil, options = {}) {
  const { minimalRules } = options;
  if (minimalRules) {
    return (
      `\n\nCHECKLIST FINAL (mínima — calidad vía plantilla A2):\n` +
      `- JSON válido único; IDs con el prefijo de esta generación.\n` +
      `- level:"A2" en passage y questions.\n` +
      buildLesenQuestionJsonKeyRule() +
      (Number(teil) === 1
        ? `- (T1 A2) Medientext 3ª persona/reportaje; **5 MCQ** a/b/c; PROHIBIDO ich-Blog y richtig_falsch.\n` +
          `- (T1 A2) PROHIBIDO correct:"true"/"false"/"Richtig"/"Falsch" — correct solo letra a/b/c; options[] obligatorio (3 strings).\n` +
          buildLesenMcqChk34Rule(6) +
          buildMcqLengthRulePrompt('A2')
        : '') +
      (Number(teil) === 2
        ? `- (T2 A2) Informationstafel + 5 MCQ a/b/c.\n` +
          `- (T2 A2) **Pasaje en prosa:** apertura + «Nombre: oración A2.» por local (NO listado telegráfico).\n` +
          `- (T2 A2) **GATE 4/5:** enunciado "question" con «Stock» o «Etage» en ≥4 preguntas.\n` +
          `- (T2 A2) **GATE 4/5:** opción «in einem anderen Stock» / «anderer Stock» en ≥4 preguntas.\n` +
          `- (T2 A2) **mcq_distinct:** 3 pisos mutuamente excluyentes; formato corto «im N. Stock»; **PROHIBIDO repetir el mismo piso en dos opciones** (ni parafrasear: im Erdgeschoss ≠ Erdgeschoss).\n` +
          buildLesenMcqChk34Rule(6) +
          buildMcqLengthRulePrompt('A2')
        : '') +
      (Number(teil) === 3
        ? `- (T3 A2) E-Mail/Korrespondenz + 5 MCQ a/b/c.\n` +
          `- (T3 A2) CEFR ingest: **≤12% Nebensätze** (Hauptsätze kurz; max. 1–2 «weil/dass/wenn»).\n` +
          `- (T3 A2) MCQ: options «a) …» «b) …» «c) …»; **correct === correctAnswer** (letra a/b/c).\n` +
          buildLesenMcqChk34Rule(6) +
          buildMcqLengthRulePrompt('A2')
        : '') +
      (Number(teil) === 4
        ? `- (T4 A2) 6 Anzeigen (passages a–f) + 5 matching; opciones ["a"…"f","X"]; exactamente 1 correct:"X".\n` +
          `- (T4 A2) Cada passage: **title** (titular) + **text** (20–60 Wörter) — CHK-29 exige 6 títulos.\n` +
          `- (T4 A2) Mini-situación con persona concreta en "question" (no genérico «Welche Anzeige passt?» solo).\n` +
          `- (T4 A2) PROHIBIDO «Workshop» en títulos/textos — usa Kurs, Seminar o Werkstatt.\n`
        : '') +
      `- Vocabulario preguntas/explicaciones ≤ A2; sin jerga B1+.\n` +
      `- Responde SOLO con el objeto JSON.\n`
    );
  }
  return (
    `\n\nCHECKLIST FINAL (Goethe A2 + CEFR):\n` +
    `- Cumple la plantilla A2 de esta parte (formato oficial Goethe A2).\n` +
    `- Anti–word-matching: parafraseo, no emparejar palabras sueltas.\n` +
    `- Longitud: cumple el mínimo CEFR de arriba (cuenta palabras).\n` +
    `- El batch debe pasar validate-batch + calidad pedagógica + ingest sin errores.\n` +
    `- VOCABULARIO SUGERIDO: integra palabras solo si encajan; omite las que no encajen.\n` +
    buildLesenQuestionJsonKeyRule() +
    (Number(teil) === 1
      ? `- (T1 A2) **Medientext** informativo en 3ª persona; título de prensa; **5× multiple_choice** a/b/c.\n` +
        `- (T1 A2) PROHIBIDO: blog en «ich», richtig_falsch, registro B1 (Organisation, Gemeinschaft, Investition…).\n` +
        `- (T1 A2) PROHIBIDO correct:"true"/"false"/"Richtig"/"Falsch" — correct solo letra a/b/c; **options[] obligatorio** (3 strings «a) …» «b) …» «c) …»).\n` +
        buildLesenMcqChk34Rule(6) +
        buildMcqLengthRulePrompt('A2')
      : '') +
    (Number(teil) === 2
      ? `- (T2 A2) Texto de informationstafel + 5 MCQ a/b/c; topicTag coherente.\n` +
        `- (T2 A2) **CEFR pasaje:** Willkommen + descripciones «Nombre: oración completa.» por piso; integrar vocab objetivo (≥55% cobertura).\n` +
        `- (T2 A2) **GATE 4/5 Stock/Etage:** ≥4 enunciados con «In welchem Stock…» / «Auf welcher Etage…» (palabra Stock o Etage en "question").\n` +
        `- (T2 A2) **GATE 4/5 anderer Stock:** ≥4 preguntas con c) «in einem anderen Stock» (o «anderes Stockwerk»).\n` +
        `- (T2 A2) **mcq_distinct (CHK-28):** a) im X. Stock, b) im Y. Stock (X≠Y), c) in einem anderen Stock — **PROHIBIDO repetir el mismo piso en dos opciones**.\n` +
        `- (T2 A2) PROHIBIDO: 3 pisos concretos sin «anderer Stock»; preguntas solo de horario/entrada sin Stock/Etage.\n` +
        buildLesenMcqChk34Rule(6) +
        buildMcqLengthRulePrompt('A2')
      : '') +
    (Number(teil) === 3
      ? `- (T3 A2) E-Mail/Korrespondenz + 5 MCQ a/b/c.\n` +
        `- (T3 A2) CEFR ingest: **≤12% Nebensätze** (Hauptsätze kurz; max. 1–2 «weil/dass/wenn»).\n` +
        `- (T3 A2) MCQ: options «a) …» «b) …» «c) …»; **correct === correctAnswer** (letra a/b/c).\n` +
        buildLesenMcqChk34Rule(6) +
        buildMcqLengthRulePrompt('A2')
      : '') +
    (Number(teil) === 4
      ? `- (T4 A2) 6 Anzeigen + 5 matching; opciones ["a"…"f","X"]; 1× correct:"X"; enunciados con persona en "question".\n` +
        `- (T4 A2) Cada passage con **title** + **text** (6 titulares distintos).\n` +
        `- (T4 A2) PROHIBIDO «Workshop» — usa Kurs, Seminar o Werkstatt en anuncios.\n`
      : '') +
    `- Responde SOLO con el objeto JSON (sin markdown, sin \`\`\`, sin texto antes ni después).`
  );
}

function buildLesenChecklistBlock(teil, options = {}) {
  const level = String(options.level || 'B1').trim().toUpperCase();
  if (level === 'A2') return buildLesenChecklistBlockA2(teil, options);
  if (level === 'B2' && Number(teil) === 1) {
    const phase = String(options.forumPhase || '').toLowerCase();
    return (
      `\n\nCHECKLIST FINAL (Goethe B2 Lesen T1 — ${phase === 'questions' || phase === 'b' ? 'Fase B' : 'Fase A'}):\n` +
      `- JSON válido; level:"B2"; instrucción oficial del foro respetada en espíritu.\n` +
      buildLesenQuestionJsonKeyRule() +
      (phase === 'questions' || phase === 'b'
        ? `- Exactamente **9** matching; options ["A","B","C","D"]; repetición de personas permitida.\n` +
          `- passageId coherente con la persona correcta; sin hechos inventados.\n`
        : `- Exactamente **4** passages (Personen A–D); **questions: []**.\n`) +
      `- grammarTags omitidos o [].\n` +
      `- Responde SOLO con el objeto JSON.\n`
    );
  }
  if (level === 'B2' && Number(teil) === 2) {
    return (
      `\n\nCHECKLIST FINAL (Goethe B2 Lesen T2 — Sätze einfügen):\n` +
      buildLesenQuestionJsonKeyRule() +
      `- 1 passage 250–400 Wörter; marcadores (21)…(26); 6 questions matching.\n` +
      `- 8 options A–H idénticas en cada pregunta; 6 letras correctas distintas; 2 sobrantes.\n` +
      `- Instrucción oficial en question[0]; sin ambigüedad entre Lücken.\n` +
      `- grammarTags omitidos o [].\n` +
      `- Responde SOLO con el objeto JSON.\n`
    );
  }
  if (level === 'B2' && Number(teil) === 3) {
    return (
      `\n\nCHECKLIST FINAL (Goethe B2 Lesen T3 — Zeitungsartikel MCQ):\n` +
      buildLesenQuestionJsonKeyRule() +
      `- 1 passage 350–500 Wörter; 6× multiple_choice a/b/c; NO anuncios B1 A–J.\n` +
      `- Instrucción oficial en question[0]; passageId en cada pregunta.\n` +
      `- Anti word-matching; MCQ longitud comparable; explanation CHK-34 (sin citar opción literal).\n` +
      `- grammarTags omitidos o [].\n` +
      `- Responde SOLO con el objeto JSON.\n`
    );
  }
  if (level === 'B2' && Number(teil) === 4) {
    return (
      `\n\nCHECKLIST FINAL (Goethe B2 Lesen T4 — Meinung ↔ Überschrift):\n` +
      buildLesenQuestionJsonKeyRule() +
      `- 6 passages (Meinungsäußerungen 40–100 Wörter); 6 matching; NO ja_nein/foro B1.\n` +
      `- 8 Überschriften A–H idénticas en cada pregunta; 6 letras correctas distintas; 2 sobrantes.\n` +
      `- Instrucción oficial en question[0]; passageId por Meinung; sin ambigüedad entre titulares.\n` +
      `- grammarTags omitidos o [].\n` +
      `- Responde SOLO con el objeto JSON.\n`
    );
  }
  if (level === 'B2' && Number(teil) === 5) {
    return (
      `\n\nCHECKLIST FINAL (Goethe B2 Lesen T5 — Studienordnung ↔ Überschriften):\n` +
      buildLesenQuestionJsonKeyRule() +
      `- 1 Studienordnung 200–350 Wörter; marcadores (31)(32)(33); 3 matching; NO MCQ B1.\n` +
      `- 7 Überschriften A–G idénticas; 3 letras correctas distintas; 4 sobrantes.\n` +
      `- Instrucción oficial en question[0]; sin ambigüedad entre encabezados.\n` +
      `- grammarTags omitidos o [].\n` +
      `- Responde SOLO con el objeto JSON.\n`
    );
  }
  const { minimalRules, debateSeed, debateDef } = options;
  if (minimalRules) {
    return (
      `\n\nCHECKLIST FINAL (mínima — calidad vía ejemplos verificados arriba):\n` +
      `- JSON válido único; IDs con el prefijo de esta generación.\n` +
      buildLesenQuestionJsonKeyRule() +
      `- Tema B1 pedido; parafraseo B1 (máx. 2 palabras de contenido iguales al pasaje por afirmación).\n` +
      `- Vocabulario preguntas/explications ≤ B1; sin jerga B2/C1.\n` +
      (Number(teil) === 1 ? `- (T1) Blog en ich; 6 RF; misma persona (sie O er) en todas las afirmaciones.\n` : '') +
      (Number(teil) === 2
        ? `- (T2) ANTI-ATAJO MCQ: opciones a/b/c con longitud y especificidad comparable; la correcta NO debe ser la más larga ni la única detallada.\n`
        : '') +
      (Number(teil) === 5
        ? `- (T5) ANTI-ATAJO MCQ: opciones a/b/c con longitud y especificidad comparable; la correcta NO debe ser la más larga ni la única detallada.\n` +
          `- (T5) Umformulierung: korrekte Option darf keine ≥5 Wörter am Stück aus dem Regeltext übernehmen.\n`
        : '') +
      `- Imita **estilo y dificultad** de los ejemplos verificados; contenido **nuevo**.\n` +
      `- Responde SOLO con el objeto JSON.\n`
    );
  }
  return (
    `\n\nCHECKLIST FINAL (Goethe Hard Mode + CEFR):\n` +
    `- Cumple la sección «Goethe Hard Mode» de esta plantilla.\n` +
    `- Anti–word-matching: parafraseo, no emparejar palabras sueltas.\n` +
    `- Longitud: cumple el mínimo CEFR de arriba (cuenta palabras).\n` +
    `- El batch debe pasar check-lesen-batch-quality.mjs y check-lesen-batch-ingest.mjs sin errores.\n` +
    `- VOCABULARIO SUGERIDO: integra palabras solo si encajan; omite las que no encajen.\n` +
    buildLesenQuestionJsonKeyRule() +
    `- Anti word-matching: máx. 2 palabras de contenido iguales al pasaje por afirmación/pregunta.\n` +
    `- Parafraseo B1 (T1/T2): vocabulario de preguntas/opciones/explanations ≤ B1 — sinónimo NO más difícil que el pasaje. ` +
    `PROHIBIDO modifizieren, Gelassenheit, Angehörige, elektronische Mitteilungen, sich austauschen, jerga B2.\n` +
    `- CEFR: evita Eigenregie, empfand, faszinierend, gebucht, Smartphone — usa léxico simple.\n` +
    (Number(teil) === 1
      ? `- (T1) Misma referencia sie/ihre O er/seine en todas las afirmaciones — nunca mezclar.\n` +
        `- (T1) APERTURA ESTRUCTURAL (blog/e-mail 1ª persona): NO abras siempre con «Ich habe…» / ` +
        `«Ich wollte…» / «Ich lebe seit…». Variá el primer movimiento: situación concreta ya en curso, ` +
        `motivo reciente, contraste pasado/presente, o decisión ya tomada + consecuencia. ` +
        `Seguí en ich-Form B1; el resto del texto no debe ser una lista de «Ich…» en cada frase.\n`
      : '') +
    (Number(teil) === 2
      ? `- (T2) Los DOS textos deben tratar el TEMA OBLIGATORIO; topicTag idéntico en ambos passages.\n` +
        `- (T2) Textos de prensa B1: PROHIBIDO lenguaje corporativo/marketing/negocios ` +
        `(«Marke stärken», «die eigene Marke», «Branding», «Image pflegen», «Reichweite», ` +
        `«Zielgruppe», «Marketing», «Corporate»). Usa lenguaje cotidiano de periódico local.\n` +
        `- (T2) MCQ: las 3 opciones a/b/c deben ser **mutuamente excluyentes**. PROHIBIDO que dos ` +
        `opciones parafraseen el mismo hecho con sinónimos (p. ej. verbessern / besser machen, ` +
        `Unterstützung / Betreuung). Los distractores incorrectos deben usar **otro dato del pasaje ` +
        `mal aplicado o incompleto**, no otra formulación de la respuesta correcta.\n` +
        `- (T2) Opción correcta: PROHIBIDO copiar ≥4 palabras seguidas del pasaje; máx. 3 palabras ` +
        `de contenido (≥4 letras) iguales al pasaje — parafrasea con sinónimos B1.\n` +
        `- (T2) ANTI-ATAJO MCQ (objetivo): ningún candidato debe poder identificar la respuesta correcta ` +
        `sin comprender el contenido del texto — ni por longitud, ni porque un distractor sea obviamente ` +
        `más simple/genérico/vago, ni por cueing léxico (la clave reusa una palabra específica del pasaje ` +
        `que ningún distractor comparte). La longitud pareja y el léxico de especificidad comparable son ` +
        `formas de lograrlo, no objetivos en sí. Si la clave necesita más detalle o un término del texto ` +
        `para ser precisa, agregá detalle/especificidad EQUIVALENTE (no el mismo contenido ni la misma ` +
        `palabra-gancho) a los distractores, de modo que ninguno se descarte sin leer y ninguna opción ` +
        `sea la única que «suena como el texto». ` +
        `Ejemplo INCORRECTO (longitud): correcta detallada «Am Sonntag durchgehend und an Wochentagen in der Mittagszeit sowie nachts.» ` +
        `vs distractores tan cortos/genéricos que se descartan a ojo («Nur an Feiertagen.» / «Nach 20 Uhr.»). ` +
        `Ejemplo INCORRECTO (cueing léxico): pasaje con «Kurzzeitparken für Besucher (maximal 2 Stunden)…» ` +
        `→ correcta «Kurzzeitparken für Besucher ist nur tagsüber für maximal zwei Stunden erlaubt.» ` +
        `vs distractores genéricos sin ese léxico («Besucher dürfen jederzeit kostenlos parken.» / ` +
        `«Nur die öffentlichen Parkplätze an der Straße nutzen.») — se marca por coincidencia de palabras. ` +
        `Ejemplo CORRECTO: tres opciones con el mismo nivel de detalle/especificidad y léxico comparable, ` +
        `p. ej. «Am Sonntag und nachts.» / «Nur an Feiertagen und abends.» / «Von Montag bis Samstag nach 20 Uhr.» ` +
        `— hay que leer el texto para elegir.\n` +
        `- (T2) DISTRACTOR COHERENTE: cada distractor debe relacionarse temáticamente con el artículo/noticia. ` +
        `Si una palabra objetivo no encaja de forma natural y coherente en un distractor, OMITÍLA — no la fuerces. ` +
        `Ejemplo INCORRECTO: en un reportaje sobre Stadtgärten / Grünflächen, la opción «Man muss einen Dolmetscher bestellen.» ` +
        `(nada que ver con el tema del artículo) es un non-sequitur. ` +
        `Ejemplo CORRECTO: distractores falsos pero del mismo ámbito periodístico (quién organiza, dónde, cuándo, para quién) — ` +
        `si la palabra objetivo no encaja ahí, OMÍTELA.\n` +
        `- (T2) APERTURA ESTRUCTURAL: variá el arranque del lead periodístico — NO siempre «In vielen Städten…» / ` +
        `«Immer mehr Menschen…» / «Die Stadtverwaltung startet…». Alterná: hecho concreto + lugar, ` +
        `anuncio de un proyecto/verein nombrado, contraste (Früher… / Heute…), o pregunta retórica breve B1. ` +
        `Los DOS textos del archivo deben abrir con estructuras distintas entre sí.\n`
      : '') +
    (Number(teil) === 4 && (debateSeed || debateDef)
      ? `- (T4) El foro debate el Vorschlag fijado y debe tratar del **tema B1 pedido** (topicTag); ` +
        `no debates genéricos de otro ámbito (p. ej. Homeoffice si el tema es Technik).\n` +
        `- (T4) APERTURA ESTRUCTURAL del Vorschlag / intro del foro: variá cómo se presenta la propuesta — ` +
        `NO siempre el mismo molde «In unserer Stadt gibt es einen neuen Vorschlag: …». ` +
        `Alterná: contexto breve + propuesta, pregunta al lector, o anuncio de medida concreta. ` +
        `Las opiniones (signText) empiezan con postura, no con el nombre del autor.\n`
      : '') +
    (Number(teil) === 5
      ? `- (T5) Texto normativo B1 (Hausordnung/Regeln): opción correcta MCQ NO puede copiar ≥5 palabras ` +
        `seguidas del pasaje; máx. 3 palabras de contenido iguales — parafrasea la regla con otras palabras B1.\n` +
        `- (T5) DISTRACTOR COHERENTE: cada distractor debe relacionarse temáticamente con la regla/norma del pasaje. ` +
        `Si una palabra objetivo no encaja de forma natural y coherente en un distractor, OMITÍLA — no la fuerces. ` +
        `Ejemplo INCORRECTO: en una Hausordnung sobre Mülltrennung, la opción «Man muss einen Dolmetscher bestellen.» ` +
        `(nada que ver con basura/horarios) es un non-sequitur. ` +
        `Ejemplo CORRECTO: distractores falsos pero del mismo ámbito (horario, contenedor, día de recogida) — ` +
        `si la palabra objetivo no encaja ahí, OMÍTELA.\n` +
        `- (T5) APERTURA ESTRUCTURAL: NO abras siempre con «Liebe Bewohnerinnen und Bewohner, um … zu … bitten wir…». ` +
        `Variá: título/contexto del lugar (Haus / Viertel / Zentrum) + propósito, lista de reglas sin saludo, ` +
        `o aviso breve + detalle. Registro normativo B1, no carta personal.\n` +
        `- (T5) ANTI-ATAJO MCQ (objetivo): ningún candidato debe poder identificar la respuesta correcta ` +
        `sin comprender la norma del texto — ni por longitud, ni porque un distractor sea obviamente ` +
        `más simple/genérico, ni por cueing léxico (la clave reusa terminología específica de la norma ` +
        `que ningún distractor comparte). Longitud pareja y especificidad léxica comparable son formas ` +
        `de lograrlo, no el objetivo en sí. Si la clave usa un término del texto (p. ej. Kurzzeitparken, ` +
        `Sammelstelle), al menos un distractor debe sonar igual de «técnico/específico» (otro dato falso ` +
        `del mismo registro), no genérico. ` +
        `Ejemplo INCORRECTO (longitud): correcta «Der Müll muss spätestens bis 20 Uhr in den dafür vorgesehenen Behältern stehen.» ` +
        `vs distractores tan cortos que se descartan sin leer («Nur am Wochenende.» / «Immer nach 22 Uhr.»). ` +
        `Ejemplo INCORRECTO (cueing léxico, caso real T5): pasaje «Kurzzeitparken für Besucher (maximal 2 Stunden)…» ` +
        `→ correcta «Kurzzeitparken für Besucher ist nur tagsüber für maximal zwei Stunden erlaubt.» ` +
        `vs distractores sin ese léxico («Besucher können jederzeit kostenlos auf den privaten Parkplätzen parken.» / ` +
        `«Besucher dürfen nur die öffentlichen Parkplätze an der Straße nutzen, ohne Zeitbegrenzung.»). ` +
        `Ejemplo CORRECTO: tres opciones con especificidad similar, p. ej. «Spätestens bis 20 Uhr in den Behältern.» / ` +
        `«Nur samstags vor dem Haus abstellen.» / «Immer erst nach 22 Uhr hinausstellen.» — hay que leer la Hausordnung.\n`
      : '') +
    (Number(teil) === 3
      ? `- (T3) NOMBRE DEL BUSCADOR: variá el nombre en cada generación, usando el banco sugerido — ` +
        `NO reutilices «Herr Ott» ni los apellidos ya sobrerrepresentados en el pool ` +
        `(Ott, Schmidt, Weber, Müller, Held, Berg, Falk, Stein, Bachs, Roth — ver lista de exclusión).\n`
      : '') +
    `- explanation: ≥10 palabras para multiple_choice (CHK-18 rechaza si es más corta). Usa frases completas que justifiquen la respuesta.\n` +
    (Number(teil) === 2 || Number(teil) === 5
      ? `- explanation (MCQ T2/T5): NUNCA digas "Option a/b/c)" ni "la opción X es correcta" — el orden a/b/c puede reordenarse después. Explica el contenido de la respuesta correcta en prosa.\n`
      : '') +
    `- Responde SOLO con el objeto JSON (sin markdown, sin \`\`\`, sin texto antes ni después).`
  );
}

/** Cacheable prefix — identical for every generation of the same Teil. */
export function buildLesenStaticCore(teil, options = {}) {
  const level = options.level || 'B1';
  const lv = String(level).trim().toUpperCase();
  let raw;
  if (lv === 'B2' && Number(teil) === 1 && options.forumPhase) {
    raw = loadLesenTemplateB2ForumPhase(options.forumPhase);
  } else {
    raw = stripHumanHeader(loadLesenTemplate(teil, level));
  }
  let body = stripVocabSectionFromTemplate(raw);
  body = stripAutorrevisionSection(body);
  let core =
    body.trim() +
    teilLengthBlock(Number(teil), level) +
    buildLesenChecklistBlock(Number(teil), options);
  if (lv === 'B2' && Number(teil) === 1 && options.fixedForumPassages?.length) {
    core += buildLesenB2ForumFixedPassagesBlock(options.fixedForumPassages);
  }
  return core;
}

/** Per-request tail — topic, vocab, IDs, few-shot, etc. */
export function buildLesenVariableSuffix(teil, words, options = {}) {
  const {
    idSuffix,
    textSubtype,
    subtypeDef,
    excludeMolds,
    debateTopic,
    debateDef,
    debateSeed,
    topicTag,
    fewShotExamples,
    topic,
    retryNote,
    forumNamesBlock,
    institutionSeed,
    bankEscalation,
    mandatedTitle,
  } = options;
  const raw = stripHumanHeader(loadLesenTemplate(teil, options.level || 'B1'));
  let suffix = '';

  let variantScaffold = '## AUTORREVISIÓN\n';
  if (Number(teil) === 5 && subtypeDef && String(options.level || 'B1').toUpperCase() !== 'B2') {
    variantScaffold = injectT5PromptVariants(variantScaffold, {
      textSubtype,
      subtypeDef,
      excludeMolds,
      institutionSeed,
      bankEscalation,
      mandatedTitle,
    });
  }
  if (Number(teil) === 4 && (debateSeed || debateDef) && String(options.level || 'B1').toUpperCase() !== 'B2') {
    variantScaffold = injectT4PromptVariants(variantScaffold, {
      debateTopic,
      debateDef,
      debateSeed,
      excludeMolds,
      topicTag,
      mandatedTitle,
    });
  }
  suffix += variantScaffold.replace(/^## AUTORREVISIÓN\n/, '');

  const resolvedTopic = topic || topicTag || null;
  suffix += buildTopicPromptBlock(resolvedTopic);

  let vocabBlock = buildVocabVariableBlock(words);
  vocabBlock = reinforceVocabOptionalBlock(vocabBlock);
  suffix += vocabBlock;

  if (fewShotExamples?.length) {
    suffix += buildFewShotLesenBlock(Number(teil), fewShotExamples, options.level || 'B1');
  } else {
    const autorrevision = extractAutorrevisionSection(raw);
    if (autorrevision) suffix += `\n${autorrevision}`;
  }

  if (idSuffix) {
    suffix +=
      `\n\nIMPORTANTE — IDs de esta generación:\n` +
      `- Prefijo de passages: gen-l${teil}-${idSuffix}\n` +
      `- Prefijo de preguntas: gen-q-${teil}-${idSuffix}-\n` +
      `No reutilices IDs del ejemplo ni del banco existente.`;
  }

  if (Number(teil) === 1 || Number(teil) === 2) {
    suffix += buildExcludedPremisesPromptBlock();
  }
  if (Number(teil) === 2 && String(options.level || 'B1').toUpperCase() === 'B1') {
    suffix += buildLesenT2OpeningsPromptBlock({
      mandatedOpening: options.mandatedLesenT2Opening,
      topic: resolvedTopic,
    });
  }
  if (Number(teil) === 3) {
    suffix += buildLesenT3NamesPromptBlock();
  }
  if (forumNamesBlock) suffix += forumNamesBlock;
  if (retryNote) suffix += retryNote;

  return suffix.trim();
}

export function buildLesenPrompt(teil, words, options = {}) {
  const staticCore = buildLesenStaticCore(teil, options);
  const variableSuffix = buildLesenVariableSuffix(teil, words, options);
  let prompt = assemblePrompt(staticCore, variableSuffix);

  // PASO 7/8 — separate quality block (feature-flagged / feedbackMode)
  const fb = appendGenerationFeedback(prompt, {
    rules: options.feedbackRules,
    enabled: options.generationFeedbackEnabled,
    feedbackMode: options.feedbackMode,
    maxRules: options.maxFeedbackRules,
  });
  if (options.feedbackMetaOut && typeof options.feedbackMetaOut === 'object') {
    Object.assign(options.feedbackMetaOut, {
      ...fb.generationMetadata,
      feedbackRulesApplied: fb.feedbackRulesApplied,
    });
  }
  return fb.prompt;
}

/**
 * Reparación word-copy: T2/T5 — parafrasear opción correcta (y opcionalmente enunciado).
 */
export function buildMcqWordCopyRepairPrompt(ctx) {
  const passage = ctx.passage || {};
  const q = ctx.question || {};
  const body = String(passage.text || '').trim();
  const minWords = ctx.minWords ?? 4;
  if (!body) throw new Error('word-copy repair: pasaje sin texto');

  const opts = (q.options || []).map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`).join('\n');
  const issues = (ctx.findings || []).map((f) => `- ${f.detail || 'word-copy'}`).join('\n');
  const forbidden = (ctx.forbiddenTokens || []).slice(0, 20).join(', ');
  const ngramBlock = formatForbiddenNgramsBlock(ctx.forbiddenNgrams);

  return finalizeRepairPrompt(
    `Eres examinador Goethe B1 Lesen Teil ${ctx.teil || 2}. El PASAJE está aprobado — NO lo modifiques.\n` +
    `Reescribe SOLO esta pregunta MCQ: parafrasea la opción CORRECTA para que NO copie ≥${minWords} palabras seguidas del pasaje.\n\n` +
    `## Pasaje (NO cambiar)\n` +
    `passageId: "${passage.id || '?'}"\n${body}\n\n` +
    `## Pregunta [${q.id || '?'}]\n` +
    `Enunciado: ${q.question || ''}\n` +
    `Clave correcta: ${q.correct ?? q.correctAnswer ?? '?'}\n` +
    `Opciones actuales:\n${opts || '(vacías)'}\n` +
    `Explanation: ${q.explanation || '(ninguna)'}\n\n` +
    `## Error del checker\n${issues}\n\n` +
    `## Reglas\n` +
    `- Mantén la MISMA clave correcta (misma letra a/b/c).\n` +
    `- La opción correcta debe seguir siendo la única respuesta válida según el pasaje.\n` +
    `- Parafrasea con vocabulario B1; máx. 3 palabras de contenido (≥4 letras) iguales al pasaje en la opción correcta.\n` +
    (forbidden
      ? `- EVITA estas palabras frecuentes del pasaje en la opción correcta (usa sinónimos B1): ${forbidden}\n`
      : '') +
    ngramBlock +
    `- Distractores: datos distintos del pasaje, no sinónimos de la correcta.\n` +
    `- explanation ≥10 palabras.\n\n` +
    `Devuelve SOLO JSON:\n` +
    `{ "id": "${q.id || 'gen-q-repair'}", "question": "...", "options": ["a) ...", "b) ...", "c) ..."], ` +
    `"correct": "${q.correct ?? q.correctAnswer ?? 'a'}", "correctAnswer": "${q.correctAnswer ?? q.correct ?? 'a'}", ` +
    `"explanation": "..." }`
  );
}

/**
 * T2 batch: reescribe TODAS las preguntas con word-copy en una sola llamada (pasajes fijos).
 */
export function buildT2McqWordCopyBatchRepairPrompt(ctx) {
  const passages = ctx.passages || [];
  const items = ctx.items || [];
  const minWords = ctx.minWords ?? 4;
  if (!items.length) throw new Error('T2 batch word-copy repair: sin preguntas');

  const passageBlocks = passages
    .map((p) => `### passageId: "${p.id || '?'}"\n${String(p.text || '').trim()}`)
    .join('\n\n');

  const questionBlocks = items
    .map(({ question, passage, findings }) => {
      const opts = (question.options || [])
        .map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`)
        .join('\n');
      const issues = (findings || []).map((f) => `- ${f.detail || 'word-copy'}`).join('\n');
      return (
        `## Pregunta [${question.id || '?'}] · passageId "${passage?.id || question.passageId || '?'}"\n` +
        `Enunciado: ${question.question || ''}\n` +
        `Clave correcta: ${question.correct ?? question.correctAnswer ?? '?'}\n` +
        `Opciones actuales:\n${opts || '(vacías)'}\n` +
        `Explanation: ${question.explanation || '(ninguna)'}\n` +
        (issues ? `Errores:\n${issues}\n` : '')
      );
    })
    .join('\n');

  const literalLines = (ctx.literalSnippets || [])
    .slice(0, 6)
    .map((s) => `  · «${s}»`)
    .join('\n');
  const forbidden = (ctx.forbiddenTokens || []).slice(0, 25).join(', ');
  const ngramBlock = formatForbiddenNgramsBlock(ctx.forbiddenNgrams);
  const examLabel = ctx.examLabel || 'Goethe B1 Lesen Teil 2';

  return finalizeRepairPrompt(
    `Eres examinador ${examLabel}. Los PASAJES están aprobados — NO los modifiques.\n` +
    `Reescribe ${items.length} pregunta(s) MCQ en UNA respuesta: parafrasea cada opción CORRECTA para que NO copie ≥${minWords} palabras seguidas del pasaje.\n\n` +
    `## Pasajes (NO cambiar)\n${passageBlocks}\n\n` +
    `## Preguntas a reparar\n${questionBlocks}\n` +
    (literalLines
      ? `## Frases literales detectadas (NO repetir en opción correcta)\n${literalLines}\n\n`
      : '') +
    `## Reglas\n` +
    `- Devuelve TODAS las preguntas listadas con el MISMO id y la MISMA clave correcta.\n` +
    `- Parafrasea con vocabulario B1; máx. 2 palabras de contenido (≥4 letras) iguales al pasaje en pregunta Y opción correcta.\n` +
    (forbidden
      ? `- EVITA estas palabras frecuentes del pasaje en opciones correctas: ${forbidden}\n`
      : '') +
    ngramBlock +
    `- Distractores: datos distintos del pasaje, no sinónimos de la correcta.\n` +
    `- explanation ≥10 palabras por pregunta.\n\n` +
    `Ejemplo:\n` +
    `❌ MALO: «Die Miete ist niedriger als auf dem freien Markt» (copia ≥4 palabras del pasaje).\n` +
    `✅ BUENO: «Die Wohnungen sind günstiger als üblich, dank städtischer Förderung.»\n\n` +
    `Devuelve SOLO JSON:\n` +
    `{ "questions": [ { "id": "...", "question": "...", "options": ["a) ...", "b) ...", "c) ..."], ` +
    `"correct": "a", "correctAnswer": "a", "explanation": "..." }, ... ] }`
  );
}

/**
 * T2: acorta ambos pasajes en UNA llamada (preguntas fijas, gate CEFR suma ≤400).
 */
export function buildT2PassageLengthRepairPrompt(ctx) {
  const passages = ctx.passages || [];
  const questions = ctx.questions || [];
  if (passages.length < 2) throw new Error('T2 passage-length repair: se requieren 2 pasajes');

  const passageBlocks = passages
    .map((p) => {
      const wc = String(p.text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      return (
        `### passageId: "${p.id || '?'}" · título: ${p.title || '(sin título)'} · ${wc} palabras\n` +
        `${String(p.text || '').trim()}`
      );
    })
    .join('\n\n');

  const qSummary = questions
    .map((q) => `- [${q.id}] passageId="${q.passageId || '?'}" · ${q.question || ''}`)
    .join('\n');

  const vocab = (ctx.vocabWords || []).filter(Boolean);
  const vocabBlock = vocab.length
    ? `\n## Palabras objetivo (mantener en el texto)\n${vocab.map((w) => `- ${w}`).join('\n')}\n`
    : '';

  const combinedBefore = ctx.combinedBefore ?? 0;
  const targetMax = ctx.targetMax ?? 395;
  const maxAllowed = ctx.maxAllowed ?? 400;

  return finalizeRepairPrompt(
    `Eres examinador Goethe B1 Lesen Teil 2. Las PREGUNTAS MCQ están aprobadas — NO las modifiques.\n` +
    `Acorta AMBOS pasajes de prensa para que la SUMA sea ≤${targetMax} palabras (máx absoluto ${maxAllowed}).\n` +
    `Ahora: ${combinedBefore} palabras en total — debes recortar ~${Math.max(0, combinedBefore - targetMax)}.\n\n` +
    `## Pasajes actuales (acortar, mismo tema${ctx.topicTag ? `: ${ctx.topicTag}` : ''})\n${passageBlocks}\n` +
    vocabBlock +
    `\n## Preguntas vinculadas (NO cambiar — conserva hechos que justifican las respuestas)\n${qSummary}\n\n` +
    `## Reglas\n` +
    `- Parafrasea y elimina relleno; NO borres datos que las MCQ necesitan (cifras, causas, ventajas).\n` +
    `- Cada pasaje: mínimo ~140 palabras, ideal 165-195; SUMA total ≤${targetMax}.\n` +
    `- Mantén 2-3 párrafos por pasaje, registro informativo B1, sustantivos en MAYÚSCULA.\n` +
    `- Conserva passageId y título de cada pasaje.\n` +
    (vocab.length ? `- Mantén las palabras objetivo listadas (formas flexionadas OK).\n` : '') +
    `\nDevuelve SOLO JSON:\n` +
    `{ "passages": [ { "id": "...", "title": "...", "text": "..." }, { "id": "...", "title": "...", "text": "..." } ] }`
  );
}

function formatLengthBiasMetricsBlock(question, level) {
  const spec = buildLengthBiasRepairSpec(question, level);
  if (!spec.needsRepair) return '';
  const lines = (question.options || [])
    .slice(0, 3)
    .map((o, i) => {
      const L = String.fromCharCode(97 + i);
      const len = mcqOptionBody(o).length;
      const tag = L === spec.letter ? ' ← CORRECTA (demasiado larga)' : '';
      return `  ${L}) ${len} chars${tag}`;
    })
    .join('\n');
  return (
    `### Medición sesgo (obligatorio)\n` +
    `Longitudes actuales:\n${lines}\n` +
    `Δ +${spec.diffChars} chars, +${spec.diffPct}% vs media distractores (umbral ${spec.thresholdPct}%/${spec.thresholdChars}ch).\n` +
    `META: la opción ${spec.letter} debe quedar en ≤${spec.targetCorrectMax} chars ` +
    `(recorta ~${spec.trimChars} chars) O alarga cada distractor hasta ~${spec.targetViaDistractors} chars. ` +
    `PROHIBIDO alargar la opción correcta.\n`
  );
}

/**
 * MCQ length bias — acortar opción correcta o alargar distractores (fuente fija).
 */
export function buildMcqLengthBiasBatchRepairPrompt(ctx) {
  const items = ctx.items || [];
  const sourceLabel = ctx.sourceLabel || 'pasaje';
  const module = ctx.module || 'lesen';
  const teil = ctx.teil || 2;
  const level = ctx.level || 'B1';

  const blocks = items
    .map(({ question, sourceText, letter, correctBody }) => {
      const opts = (question.options || [])
        .map((o, i) => `${String.fromCharCode(97 + i)}) ${mcqOptionBody(o)}`)
        .join('\n');
      return (
        `## [${question.id}] · clave ${letter}\n` +
        `Enunciado: ${question.question || ''}\n` +
        formatLengthBiasMetricsBlock(question, level) +
        `Opción correcta actual (${letter}): ${correctBody}\n` +
        `Opciones:\n${opts}\n` +
        `## ${sourceLabel} (NO cambiar)\n${String(sourceText).trim().slice(0, 3500)}`
      );
    })
    .join('\n\n');

  return finalizeRepairPrompt(
    `Eres examinador Goethe B1 ${module === 'horen' ? 'Hören' : 'Lesen'} Teil ${teil}.\n` +
    `El ${sourceLabel} está aprobado — NO lo modifiques.\n` +
    `Corrige ${items.length} pregunta(s) MCQ: la opción CORRECTA NO puede ser la más larga (sesgo de longitud).\n` +
    `Prioriza ACORTAR la opción correcta hasta la META numérica indicada; solo alarga distractores si no puedes acortar sin perder sentido.\n\n` +
    `${blocks}\n\n` +
    `## Reglas\n` +
    `- Mantén la MISMA clave correcta y el mismo sentido factual.\n` +
    `- explanation ≥10 palabras si la devuelves.\n` +
    `- NO copies ≥4 palabras seguidas del ${sourceLabel} en la opción correcta.\n` +
    `- Tras editar, la correcta NO debe superar en longitud a ningún distractor.\n` +
    `- explanation: NUR Deutsch B1; VERBOTEN spanische Meta-Phrasen ("La opción", "El pasaje indica", "ha sido acortada", "Según el pasaje"); begründe nur die korrekte Option — keine Reparatur-Narration.\n\n` +
    `Devuelve SOLO JSON:\n` +
    `{ "questions": [ { "id": "...", "options": ["a) ...", "b) ...", "c) ..."], "explanation": "..." }, ... ] }`
  );
}

/**
 * Regeneración puntual de UNA pregunta MCQ por sesgo de longitud (pasaje fijo).
 */
export function buildMcqLengthBiasRegenPrompt(ctx) {
  const passage = ctx.passage || {};
  const q = ctx.question || {};
  const body = String(ctx.sourceText || passage.text || passage.transcript || '').trim();
  const teil = ctx.teil || 2;
  const module = ctx.module || 'lesen';
  const level = ctx.level || 'B1';
  const sourceLabel = ctx.sourceLabel || (module === 'horen' ? 'transcripción/audio' : 'pasaje');
  const letter = mcqCorrectLetter(q) || String(q.correct ?? q.correctAnswer ?? 'a').replace(/[^a-c]/g, '');
  const opts = (q.options || [])
    .map((o, i) => `${String.fromCharCode(97 + i)}) ${mcqOptionBody(o)}`)
    .join('\n');

  return finalizeRepairPrompt(
    `Eres examinador Goethe B1 ${module === 'horen' ? 'Hören' : 'Lesen'} Teil ${teil}.\n` +
    `El ${sourceLabel} está aprobado — NO lo modifiques.\n` +
    `Reescribe COMPLETA esta pregunta MCQ: elimina el sesgo de longitud (la correcta no puede ser la más larga).\n\n` +
    `## ${sourceLabel} (NO cambiar)\n` +
    `passageId: "${passage.id || '?'}"\n${body.slice(0, 3500)}\n\n` +
    `## Pregunta [${q.id || '?'}]\n` +
    `Enunciado: ${q.question || ''}\n` +
    `Clave correcta: ${letter}\n` +
    formatLengthBiasMetricsBlock(q, level) +
    `Opciones actuales:\n${opts || '(vacías)'}\n` +
    `Explanation: ${q.explanation || '(ninguna)'}\n\n` +
    `## Reglas\n` +
    `- Mantén clave ${letter} y el mismo hecho correcto según el ${sourceLabel}.\n` +
    `- Cumple la META numérica: correcta ≤ longitud del distractor más largo.\n` +
    `- Parafrasea con vocabulario B1; explanation ≥10 palabras.\n` +
    `- explanation: NUR Deutsch B1; VERBOTEN spanische Meta-Phrasen ("La opción", "El pasaje indica", "ha sido acortada", "Según el pasaje"); begründe nur die korrekte Option — keine Reparatur-Narration.\n\n` +
    `Devuelve SOLO JSON:\n` +
    `{ "id": "${q.id || 'gen-q-repair'}", "question": "...", "options": ["a) ...", "b) ...", "c) ..."], ` +
    `"correct": "${letter}", "correctAnswer": "${letter}", "explanation": "..." }`
  );
}

/**
 * Léxico B2+ — sustituir términos marcados solo en campos indicados.
 */
export function buildLexicoBatchRepairPrompt(ctx) {
  const findings = ctx.findings || [];
  const module = ctx.module || 'lesen';
  const level = String(ctx.level || ctx.batch?.level || ctx.batch?.questions?.[0]?.level || 'B1').toUpperCase();
  const targetLevel = level === 'A2' ? 'A2' : 'B1';
  const ceilingLabel = level === 'A2' ? 'B1+' : 'B2+';
  const passageFindings = findings.filter((f) => f.field === 'passageText' || f.field === 'passageTitle');
  const questionFindings = findings.filter((f) => f.field !== 'passageText' && f.field !== 'passageTitle');
  const questions = (ctx.batch?.questions || []).filter((q) =>
    questionFindings.some((f) => f.itemId === q.id),
  );
  const passages = (ctx.batch?.passages || []).filter((p) =>
    passageFindings.some((f) => f.itemId === p.id),
  );
  const passagesOnly = passageFindings.length > 0 && questionFindings.length === 0;

  const findingBlock = findings
    .map((f) => `- [${f.itemId || '?'}] ${f.field}: «${f.term}» → «${f.suggestion}»`)
    .join('\n');

  const qBlock = questions
    .map((q) => {
      const opts = (q.options || []).map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`).join('\n');
      return (
        `## [${q.id}]\n` +
        `question: ${q.question || ''}\n` +
        (opts ? `options:\n${opts}\n` : '') +
        `explanation: ${q.explanation || ''}`
      );
    })
    .join('\n\n');

  const pBlock = passages
    .map((p) => {
      const flags = passageFindings.filter((f) => f.itemId === p.id);
      const fields = flags.map((f) => f.field).join(', ');
      return (
        `## passageId [${p.id}] (corrige: ${fields})\n` +
        `title: ${p.title || ''}\n` +
        `text: ${p.text || ''}`
      );
    })
    .join('\n\n');

  const scopeIntro = passagesOnly
    ? `Corrige SOLO los campos de anuncio/passage marcados (title/text). Las preguntas matching NO las modifiques.\n`
    : `Los pasajes/transcripciones no marcados están aprobados — NO los modifiques.\n` +
      `Sustituye SOLO los términos marcados por alternativas de nivel ${targetLevel} (evita léxico ${ceilingLabel}).\n`;

  const jsonShape = passagesOnly
    ? `{ "passages": [ { "passageId": "...", "title": "...", "text": "..." } ] }`
    : `{ "questions": [ { "id": "...", "question": "...", "options": [...], "explanation": "..." } ]` +
      (passageFindings.length ? `, "passages": [ { "passageId": "...", "title": "...", "text": "..." } ]` : '') +
      ` }`;

  return finalizeRepairPrompt(
    `Eres corrector Goethe ${level} (${module}).\n` +
    scopeIntro +
    `\n## Hallazgos léxicos\n${findingBlock}\n\n` +
    (qBlock ? `## Preguntas a corregir\n${qBlock}\n\n` : '') +
    (pBlock ? `## Anuncios/passages a corregir\n${pBlock}\n\n` : '') +
    `Devuelve SOLO JSON:\n${jsonShape}`
  );
}

/**
 * Reparación SEM-2 mcq_distinct: solo opciones a/b/c + explanation de UNA pregunta MCQ L2.
 */
export function buildL2McqDistinctRepairPrompt(ctx) {
  const passage = ctx.passage || {};
  const q = ctx.question || {};
  const level = String(ctx.level || 'B1').toUpperCase();
  const body = String(passage.text || '').trim();
  if (!body) throw new Error('L2 mcq repair: pasaje sin texto');

  const opts = (q.options || []).map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`).join('\n');
  const issues = (ctx.findings || []).map((f) => `- ${f.detail || f.message || 'opciones duplicadas'}`).join('\n');
  const a2Rules =
    level === 'A2'
      ? `- **A2 Informationstafel:** usa formato corto obligatorio:\n` +
        `  a) im {X}. Stock\n  b) im {Y}. Stock (X≠Y, pisos del plano)\n` +
        `  c) in einem anderen Stock\n` +
        `- PROHIBIDO descripciones largas «im Stock wo…»; PROHIBIDO duplicar el mismo piso.\n` +
        `- **PROHIBIDO repetir el mismo piso en dos opciones** (p. ej. «im Erdgeschoss» + «Erdgeschoss»).\n`
      : '';

  return finalizeRepairPrompt(
    `Eres examinador Goethe ${level} Lesen Teil 2. El PASAJE está aprobado — NO lo modifiques.\n` +
    `Reescribe SOLO las 3 opciones a/b/c y la explanation de esta pregunta MCQ.\n\n` +
    `## Pasaje (NO cambiar)\n` +
    `passageId: "${passage.id || '?'}"\n${body}\n\n` +
    `## Pregunta [${q.id || '?'}] (mantener id y clave correcta)\n` +
    `Enunciado: ${q.question || ''}\n` +
    `Clave correcta actual: ${q.correct ?? q.correctAnswer ?? '?'}\n` +
    `Opciones actuales:\n${opts || '(vacías)'}\n` +
    `Explanation actual: ${q.explanation || '(ninguna)'}\n\n` +
    `## Error del juez\n${issues}\n\n` +
    `## Reglas\n` +
    `- Las 3 opciones deben ser mutuamente excluyentes.\n` +
    `- PROHIBIDO que dos opciones parafraseen el mismo hecho (sinónimos).\n` +
    `- Distractores incorrectos: otro dato del pasaje mal aplicado o incompleto.\n` +
    a2Rules +
    `- Vocabulario ${level}; NO cambies la clave correcta salvo que esté objetivamente mal (raro).\n` +
    `- explanation ≥10 palabras, justifica la clave.\n\n` +
    `Devuelve SOLO JSON:\n` +
    `{ "id": "${q.id || 'gen-q-2-repair'}", "options": ["texto a", "texto b", "texto c"], ` +
    `"correct": "${q.correct ?? q.correctAnswer ?? 'a'}", "correctAnswer": "${q.correctAnswer ?? q.correct ?? 'a'}", ` +
    `"explanation": "..." }`
  );
}

export function pickRandomWords(pool, min = 8, max = 12) {
  const src = [...new Set((pool || []).map((w) => String(w).trim()).filter(Boolean))];
  if (!src.length) return [];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const n = lo === hi ? Math.min(src.length, lo) : Math.min(src.length, lo + Math.floor(Math.random() * (hi - lo + 1)));
  const copy = [...src];
  const out = [];
  while (copy.length && out.length < n) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

/** Lemas que suelen bajar cobertura CEFR si se fuerzan en el pasaje. */
const CEFR_RISKY_LEMMA = new Set([
  'design', 'begabung', 'ästhetik', 'ästhetisch', 'empfand', 'faszinierend', 'eigenregie',
  'smartphone', 'authentisch', 'literarisch', 'juris', 'therapie', 'künstlerisch',
  'denkmuster', 'reputation', 'image', 'inspiration', 'inspirieren',
]);

export function loadVocabBankLemmas(lang, level) {
  const file = path.join(ROOT, 'library', 'vocab', lang, `${level}.json`);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = data.lemmas || data.words || [];
  return raw.map((w) => String(w).trim().toLowerCase()).filter(Boolean);
}

/**
 * Elige palabras objetivo para generación Lesen.
 * @param {{ lang?: string, level?: string, count?: number, source?: 'bank'|'weak'|'auto', safe?: boolean }} opts
 */
export function pickTargetWords(opts = {}) {
  const lang = opts.lang || 'de';
  const level = opts.level || 'B1';
  const count = Math.max(1, Number(opts.count) || 10);
  const source = opts.source || 'auto';
  const safe = opts.safe !== false;

  let pool = null;
  if (source === 'weak' || source === 'auto') {
    pool = loadWeakLemmas(lang, level);
  }
  if ((!pool || pool.length < count) && (source === 'bank' || source === 'auto')) {
    pool = loadVocabBankLemmas(lang, level);
  }
  if (!pool?.length) {
    throw new Error(
      `Sin pool de lemas para ${lang}/${level}. Ejecuta vocab-coverage-report.mjs o revisa library/vocab/${lang}/${level}.json`,
    );
  }

  let filtered = pool.map((w) => w.toLowerCase());
  if (safe) {
    filtered = filtered.filter((w) => !CEFR_RISKY_LEMMA.has(w));
    if (filtered.length < count) filtered = pool.map((w) => w.toLowerCase());
  }
  filtered = filtered.filter((w) => w.length >= 4);
  filtered = filterPromptTargetWords(filtered, { log: false, lang, level, requireBank: true });
  if (filtered.length < count) {
    filtered = pool
      .map((w) => String(w).trim().toLowerCase())
      .filter(Boolean)
      .filter((w) => !isBlacklistedLemma(w));
    filtered = filterPromptTargetWords(filtered, { log: false, lang, level, requireBank: true });
  }

  const picked = pickRandomWords(filtered, count, count);
  if (!picked.length) throw new Error('No se pudieron elegir palabras objetivo');
  return picked;
}

export function buildLesenPromptHeader(teil) {
  return (
    `# Prompt generado — Lesen B1 · Teil ${teil}\n` +
    `Copia TODO (desde la línea ---) y pégalo en Gemini/ChatGPT. Devuelve SOLO JSON.\n` +
    `Regenerar otro sorteo: npm run lesen:prompt:t${teil}\n\n---\n\n`
  );
}

export function buildLesenPromptFull(teil, words, options = {}) {
  return buildLesenPromptHeader(teil) + buildLesenPrompt(teil, words, options);
}

export function loadWeakLemmas(lang, level) {
  const file = path.join(ROOT, 'data', 'coverage', `weak-${lang}_${level}.json`);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data.weakLemmas || [];
}

/**
 * Segunda pasada: solo reescribe las 6 afirmaciones T1 manteniendo el pasaje.
 * @param {{ passage: object, idSuffix: string, forbiddenTokens?: string[], qualityIssues?: string[] }} ctx
 */
export function buildT1QuestionsRepairPrompt(ctx) {
  const passage = ctx.passage || {};
  const body = String(passage.text || '').trim();
  if (!body) throw new Error('T1 repair: pasaje sin texto');
  const forbidden = (ctx.forbiddenTokens || []).slice(0, 30).join(', ');
  const issues = (ctx.qualityIssues || []).slice(0, 6).map((i) => `- ${i}`).join('\n');
  const pid = passage.id || `gen-l1-${ctx.idSuffix || 'repair'}`;
  return finalizeRepairPrompt(
    `Eres examinador Goethe B1 Lesen Teil 1. El PASAJE ya está aprobado — NO lo modifiques.\n` +
    `Reescribe SOLO las 6 afirmaciones Richtig/Falsch (type "richtig_falsch").\n\n` +
    `## Pasaje (NO cambiar)\n` +
    `passageId: "${pid}"\n` +
    `${body}\n\n` +
    `## Reglas (rechazo si fallas)\n` +
    `- Máx. 2 palabras de contenido (≥4 letras) iguales al pasaje por afirmación.\n` +
    `- Parafrasea con vocabulario B1 (≤ nivel del pasaje); sinónimo NO más difícil. ` +
    `PROHIBIDO: modifizieren, Gelassenheit, Angehörige, elektronische Mitteilungen, sich austauschen.\n` +
    `- 2+ correct Richtig, 2+ correct Falsch.\n` +
    `- ≥2 Falsch con alle/jede/jeder/immer/nie/nur/ausschließlich/täglich/komplett.\n` +
    `- Misma referencia sie/ihre O er/seine en todas — nunca mezclar.\n` +
    (forbidden
      ? `- PROHIBIDO usar estas palabras del pasaje en afirmaciones: ${forbidden}\n`
      : '') +
    (issues ? `\n## Errores del checker anterior\n${issues}\n` : '') +
    `\n## Salida\n` +
    `Devuelve SOLO JSON: { "questions": [ 6 objetos ] }\n` +
    `- Cada pregunta: id gen-q-1-${ctx.idSuffix || 'repair'}-N, module "lesen", teil 1, lang "de", level "B1",\n` +
    `  type "richtig_falsch", passageId "${pid}", question, correct, correctAnswer, explanation.\n` +
    `- options: [] · Sin markdown.`
  );
}

export function nextOutputBasename(teil, tag = 'gemini') {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  // Scans generated + pool-verified + ready staging/siblings (not only generated/).
  return nextNumberedBatchBasename(`lesen-t${teil}-${tag}`);
}
