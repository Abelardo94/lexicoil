import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './loadEnv.mjs';
import {
  pickTargetWords,
  stripHumanHeader,
} from './lesenTemplatePrompt.mjs';
import { reinforceVocabOptionalBlock } from './userVocabPrompt.mjs';
import { buildExcludedPremisesPromptBlock } from './excludedPremises.mjs';
import { buildHorenT2OpeningsPromptBlock } from './horenOpeningsBank.mjs';
import { buildHorenT2ActivitySchedulePromptBlock } from './horenT2ActivityScheduleBank.mjs';
import { buildDialogueNamesPromptBlock } from './dialogueNamesBank.mjs';
import { buildHorenT1OpeningsPromptBlock } from './horenT1OpeningsBank.mjs';
import { buildHorenT1NamesPromptBlock } from './horenT1NamesBank.mjs';
import { buildHorenPremiseExcludePromptBlock } from './horenPremiseDedup.mjs';
import { buildSchreibenT3NamesPromptBlock } from './schreibenT3NamesBank.mjs';
import { buildHorenT3OpeningsPromptBlock } from './horenT3OpeningsBank.mjs';
import { buildHorenT3NamesPromptBlock } from './horenT3NamesBank.mjs';
import { buildHorenT4OpeningsPromptBlock } from './horenT4OpeningsBank.mjs';
import { buildSprechenPremiseExcludePromptBlock } from './sprechenPremiseDedup.mjs';
import { buildSchreibenT3PremiseExcludePromptBlock } from './schreibenT3PremiseDedup.mjs';
import { appendGenerationFeedback } from './resolveGenerationFeedback.mjs';
import { buildTopicPromptBlock } from './topicRotation.mjs';
import {
  assemblePrompt,
  buildVocabVariableBlock,
  stripVocabSectionFromTemplate,
} from './promptAssembly.mjs';
import { B2_ANGLICISM_PROMPT_HINT } from './anglicismPolicy.mjs';

export { pickTargetWords };

const MODULE_DIRS = {
  horen: 'plantillas-horen-b1',
  schreiben: 'plantillas-schreiben-b1',
  sprechen: 'plantillas-sprechen-b1',
};

const HOREN_MODULE_DIRS = {
  A2: 'plantillas-horen-a2',
  B1: 'plantillas-horen-b1',
  B2: 'plantillas-horen-b2',
};

const SPRECHEN_MODULE_DIRS = {
  A2: 'plantillas-sprechen-a2',
  B1: 'plantillas-sprechen-b1',
  B2: 'plantillas-sprechen-b2',
};

const SCHREIBEN_MODULE_DIRS = {
  A2: 'plantillas-schreiben-a2',
  B1: 'plantillas-schreiben-b1',
  B2: 'plantillas-schreiben-b2',
};

function resolveModuleDir(module, level) {
  const mod = String(module || '').toLowerCase();
  const lv = String(level || 'B1').trim().toUpperCase();
  if (mod === 'horen') return HOREN_MODULE_DIRS[lv] || HOREN_MODULE_DIRS.B1;
  if (mod === 'sprechen') return SPRECHEN_MODULE_DIRS[lv] || SPRECHEN_MODULE_DIRS.B1;
  if (mod === 'schreiben') return SCHREIBEN_MODULE_DIRS[lv] || SCHREIBEN_MODULE_DIRS.B1;
  return MODULE_DIRS[mod];
}

export function isSprechenPerTeil(module, level) {
  const mod = String(module || '').toLowerCase();
  const lv = String(level || 'B1').trim().toUpperCase();
  return mod === 'sprechen' && (lv === 'A2' || lv === 'B2');
}

export function isSprechenA2PerTeil(module, level) {
  return isSprechenPerTeil(module, level) && String(level || 'B1').trim().toUpperCase() === 'A2';
}

export function isSchreibenPerTeil(module, level) {
  const mod = String(module || '').toLowerCase();
  const lv = String(level || 'B1').trim().toUpperCase();
  return mod === 'schreiben' && (lv === 'A2' || lv === 'B2');
}

/** Goethe length + batch rules injected into every prompt. */
/** CHK-34 — MCQ explanations must not quote the correct option literally. */
const MCQ_CHK34_EXPLANATION_RULE =
  `- explanation (MCQ, CHK-34): alemán ≥10 Wörter; explica **por qué** encaja con el audio/texto; ` +
  `**PROHIBIDO** citar entre comillas el texto literal de la opción correcta ni «Option a/b/c)» — el orden puede reordenarse.\n`;

const EXAM_LENGTH_RULES = {
  horen: {
    A2: {
      1: {
        target: '20–70',
        min: 15,
        max: 80,
        scope: 'cada passages[i].text (5 monólogos s1–s5)',
        note: '5 segmentos × 1 MCQ a/b/c; escucha 2×; PROHIBIDO Richtig/Falsch (no es B1).',
      },
      2: {
        target: '80–150',
        min: 70,
        max: 160,
        scope: 'passages[0].text (diálogo 2 personas)',
        note: '9 actividades en pictures[] (a–i) + 5 matching por día (Montag–Freitag), letras únicas, escucha 1×.',
      },
      3: {
        target: '15–50 por segmento',
        min: 12,
        max: 55,
        scope: 'cada passages[i].text (5 diálogos cortos s1–s5)',
        note: '5 segmentos + 5 MCQ a/b/c con segmentLabel. NO 7 Richtig/Falsch.',
      },
      4: {
        target: '150–250',
        min: 140,
        max: 260,
        scope: 'passages[0].text (Radiointerview)',
        note: '5× ja_nein; options: []. NO matching M/A/B.',
      },
    },
    B2: {
      1: {
        target: '45–75',
        min: 30,
        max: 90,
        scope: 'cada passages[i].text (Gespräch/Äußerung)',
        note: '5 segmentos × (RF + MCQ) = 10 ítems; escucha 1×.',
      },
      2: {
        target: '320–360',
        min: 280,
        max: 400,
        scope: 'passages[0].text (Radiointerview Wissenschaft)',
        note: '6 MCQ a/b/c; escucha 2×; NO monólogo B1 5 preguntas.',
      },
      3: {
        target: '300–340',
        min: 250,
        max: 380,
        scope: 'passages[0].text (Radiogespräch Panel)',
        note: '4 hablantes; 6 matching A–D; escucha 1×.',
      },
      4: {
        target: '360–420',
        min: 300,
        max: 450,
        scope: 'passages[0].text (Vortrag)',
        note: '8 MCQ a/b/c; escucha 2×; NO matching debate B1.',
      },
    },
    1: {
      target: '50–85 por segmento',
      min: 40,
      max: 90,
      scope: 'cada passages[i].text (5 segmentos s1–s5)',
      note: '10 preguntas: por segmento 1× richtig_falsch + 1× multiple (a/b/c). Lenguaje hablado.',
    },
    2: {
      target: '240–300',
      min: 220,
      max: 320,
      scope: 'passages[0].text (monólogo/Vortrag)',
      note: '5 preguntas multiple_choice, escucha 1×.',
    },
    3: {
      target: '270–330',
      min: 250,
      max: 350,
      scope: 'passages[0].text (diálogo Name:/Name: — 2 hablantes)',
      note: '7 preguntas richtig_falsch, escucha 1×.',
    },
    4: {
      target: '320–400',
      min: 300,
      max: 420,
      scope: 'passages[0].text (debate Moderator + 2 Gäste)',
      note: '8 preguntas matching speaker; options idénticas M/A/B en las 8.',
    },
  },
  schreiben: {
    A2: {
      1: {
        target: '20–30',
        min: 0,
        max: 0,
        scope: 'question Teil 1 (SMS)',
        note: '1 consigna SMS informal a Freund/in, 3 bullet points.',
      },
      2: {
        target: '30–40',
        min: 0,
        max: 0,
        scope: 'question Teil 2 (E-Mail al Chef)',
        note: '1 consigna E-Mail semiformal: Dank + Zusage mit Begleitung + Wegfrage. OBLIGATORIO «Chef».',
      },
    },
    B2: {
      1: {
        target: '150–200',
        min: 0,
        max: 0,
        scope: 'question Teil 1 (Forumsbeitrag)',
        note: 'Forumsbeitrag: Meinung, Gründe, Vorschläge, Vor- und Nachteile; mindestens 150 Wörter.',
      },
      2: {
        target: '100–140',
        min: 0,
        max: 0,
        scope: 'question Teil 2 (Nachricht an Vorgesetzten)',
        note: 'Situation, Verständnis, Vorschlag, Verständnis zeigen; mindestens 100 Wörter; Anrede/Gruß.',
      },
    },
    all: {
      target: 'T1 ~80, T2 ~80, T3 ~40 palabras (consigna)',
      min: 0,
      max: 0,
      scope: 'question de cada teil (consigna, no respuesta modelo)',
      note: '1 batch = 3 preguntas (teil 1+2+3), passages: []. correct: "rubric".',
    },
  },
  sprechen: {
    A2: {
      1: {
        target: '4 Karten + instrucción paarweise',
        min: 0,
        max: 0,
        scope: 'question (Teil 1 personal_questions)',
        note: '1 pregunta · Geburtstag/Wohnort/Beruf/Hobby · 4+4 Fragen sin Vorbereitung. passages: [].',
      },
      2: {
        target: '1 Karte temática + monólogo',
        min: 0,
        max: 0,
        scope: 'question (Teil 2 about_self)',
        note: '1 pregunta · Von sich erzählen · tema concreto en Karte. passages: [].',
      },
      3: {
        target: 'plan + 2 agendas horarias',
        min: 0,
        max: 0,
        scope: 'question (Teil 3 plan_together)',
        note: '1 pregunta · Gemeinsam planen · zwei Wochenpläne + Termin finden. passages: [].',
      },
    },
    B2: {
      1: {
        target: 'Vortrag + Partner',
        min: 0,
        max: 0,
        scope: 'question (Teil 1 presentation)',
        note: '1 consigna · Vortrag Thema Ihrer Wahl + Gespräch mit Partner/in. passages: [].',
      },
      2: {
        target: 'Diskussion kontrovers',
        min: 0,
        max: 0,
        scope: 'question (Teil 2 discussion)',
        note: '1 consigna · Standpunkte zu kontroversem Thema. passages: [].',
      },
    },
    all: {
      target: 'consignas claras con tiempos oficiales',
      min: 0,
      max: 0,
      scope: 'question de cada teil',
      note: '1 batch = 3 tareas (planung + präsentation + feedback). passages: []. correct: "rubric".',
    },
  },
};

const CEFR_B2_VOCAB_HINT =
  'Prefiere léxico B2 (argumentación, trabajo, sociedad, medios). Evita términos C1/académicos extremos (kontextualisieren, Polyphonie, Paradigma…) y meta-texto. ' +
  'REGLA ORTOGRÁFICA: sustantivos alemanes en MAYÚSCULA; adjetivos/adverbios/verbos en minúscula a mitad de frase.';

const CEFR_A2_VOCAB_HINT =
  'Prefiere léxico A2 frecuente (vida cotidiana: Familie, Wohnung, Arbeit, Freizeit, Einkaufen, Termin). ' +
  'Evita términos B1+ académicos o de planificación compleja (Ehrenamt, Konferenz, Präsentation, Feedback, Workshop…). ' +
  'REGLA ORTOGRÁFICA: sustantivos alemanes en MAYÚSCULA.';

const CEFR_VOCAB_HINT =
  'Prefiere léxico B1 frecuente (≤B1 CEFR). Evita meta-texto («Dieser Text hat 280 Wörter…») y términos C1/académicos (kontextualisieren, Polyphonie, Paradigma, Manifestation…). ' +
  'REGLA ANTI-ANGLICISMOS: NUNCA escribas verbos/sustantivos ingleses sin traducir — ' +
  'gardening→Gartenarbeit/Gärtnern, jogging→Joggen, hiking→Wandern, cycling→Radfahren, ' +
  'shopping→Einkaufen, cooking→Kochen, Workshop→Kurs/Seminar/Werkstatt. ' +
  'Préstamos aceptados en alemán moderno (Deadline, Meeting, Team, Job, Computer, Internet, ' +
  'E-Mail, Video, Blog, Podcast, App, Design, Event, Check-in, Feedback) son válidos ' +
  'SOLO si van capitalizados como sustantivos: «die Deadline», «das Meeting», «das Team». ' +
  'REGLA ORTOGRÁFICA OBLIGATORIA: en alemán TODOS los sustantivos van en MAYÚSCULA — ' +
  'también en enumeraciones y después de «kein/keine» ' +
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

const GERMAN_OUTPUT_LANGUAGE_RULE =
  'IDIOMA DE SALIDA OBLIGATORIO: TODO el contenido del examen (passages, questions, options, explanation) ' +
  'debe estar 100% en ALEMÁN. PROHIBIDO español/inglés/otro idioma en preguntas u opciones. ' +
  'lang:"de" en cada ítem. El checker Q5 rechaza automáticamente cualquier texto no alemán.';

export function examTemplatePath(module, teil, level = 'B1') {
  const mod = String(module || '').toLowerCase();
  const dirName = resolveModuleDir(mod, level);
  if (!dirName) throw new Error(`Módulo inválido: ${module} (horen|schreiben|sprechen)`);

  let fileName;
  if (mod === 'horen') {
    const t = Number(teil);
    if (!Number.isFinite(t) || t < 1 || t > 4) throw new Error(`Hören teil inválido: ${teil}`);
    fileName = `horen-teil${t}.md`;
  } else if (mod === 'sprechen' && isSprechenPerTeil(mod, level)) {
    const t = Number(teil);
    const maxT = String(level || 'B1').trim().toUpperCase() === 'B2' ? 2 : 3;
    if (!Number.isFinite(t) || t < 1 || t > maxT) {
      throw new Error(`Sprechen ${String(level).toUpperCase()} teil inválido: ${teil}`);
    }
    fileName = `sprechen-teil${t}.md`;
  } else if (mod === 'schreiben' && isSchreibenPerTeil(mod, level)) {
    const t = Number(teil);
    if (!Number.isFinite(t) || t < 1 || t > 2) throw new Error(`Schreiben ${String(level).toUpperCase()} teil inválido: ${teil}`);
    fileName = `schreiben-teil${t}.md`;
  } else {
    fileName = `${mod}-b1.md`;
  }

  const file = path.join(ROOT, dirName, fileName);
  if (!fs.existsSync(file)) {
    throw new Error(`Plantilla no encontrada: ${path.relative(ROOT, file)}`);
  }
  return file;
}

export function loadExamTemplate(module, teil, level = 'B1') {
  return fs.readFileSync(examTemplatePath(module, teil, level), 'utf8');
}

function lengthBlock(module, teil, level = 'B1') {
  const modRules = EXAM_LENGTH_RULES[module];
  const lv = String(level || 'B1').trim().toUpperCase();
  const levelRules = modRules?.[lv] || modRules;
  const key =
    module === 'horen'
      ? Number(teil)
      : (module === 'sprechen' || module === 'schreiben') && (lv === 'A2' || lv === 'B2')
        ? Number(teil)
        : 'all';
  const r = levelRules?.[key] ?? levelRules?.all;
  if (!r) return '';

  const vocabHint =
    lv === 'A2' ? CEFR_A2_VOCAB_HINT : lv === 'B2' ? `${CEFR_B2_VOCAB_HINT} ${B2_ANGLICISM_PROMPT_HINT}` : CEFR_VOCAB_HINT;

  if (module === 'schreiben' || module === 'sprechen') {
    const vocabLine =
      module === 'sprechen'
        ? lv === 'A2'
          ? `- VOCABULARIO SUGERIDO: léxico A2 del bloque variable; frase forzada = rechazo.`
          : `- VOCABULARIO SUGERIDO: OPCIONAL — solo si suena 100% natural en una consigna oral B1; frase forzada = rechazo.`
        : `- Integra PALABRAS OBJETIVO en las consignas y vocabulario sugerido, no en respuestas modelo.`;
    return (
      `\n\n## LONGITUD / FORMATO OFICIAL (OBLIGATORIO)\n` +
      `- ${r.note}\n` +
      `- Ámbito: **${r.scope}**\n` +
      `- Objetivo: **${r.target}**\n` +
      `- ${vocabHint}\n` +
      `- ${GERMAN_OUTPUT_LANGUAGE_RULE}\n` +
      vocabLine
    );
  }

  return (
    `\n\n## LONGITUD CEFR (OBLIGATORIO — ingest RECHAZA si fallas)\n` +
    `- Ámbito: **${r.scope}** (${r.note})\n` +
    `- Objetivo: **${r.target} palabras**.\n` +
    `- Mínimo absoluto: **${r.min}** · máximo: **${r.max}**.\n` +
    `- **CUENTA las palabras antes de responder.** Transcript = lenguaje **hablado**, no ensayo escrito.\n` +
    `- ${vocabHint}\n` +
    `- ${GERMAN_OUTPUT_LANGUAGE_RULE}\n` +
    `- VOCABULARIO SUGERIDO: OPCIONAL — solo si suena natural en el transcript; si no encaja, OMÍTELA (nunca fuerces términos académicos/meta-gramaticales).`
  );
}

function checklistBlock(module, teil, level = 'B1') {
  const t = Number(teil);
  const lv = String(level || 'B1').trim().toUpperCase();
  const levelLabel = lv === 'A2' ? 'A2' : lv === 'B2' ? 'B2' : 'B1';
  const common =
    `\n\nCHECKLIST FINAL (Goethe ${levelLabel} — debe pasar validate-batch.mjs):\n` +
    `- Responde SOLO JSON: { "passages": [...], "questions": [...] } — sin markdown, sin \`\`\`.\n` +
    `- correct === correctAnswer en todas las preguntas.\n` +
    `- module correcto en cada question; lang:"de", level:"${levelLabel}".\n` +
    `- ${GERMAN_OUTPUT_LANGUAGE_RULE}\n` +
    `- IDs únicos con el prefijo indicado arriba (no reutilizar el ejemplo).\n` +
    `- explanation en alemán en cada pregunta (nunca vacía; ≥10 palabras para multiple_choice — CHK-18 rechaza si es más corta).\n` +
    `- VOCABULARIO SUGERIDO: integra palabras solo si encajan; omite las que no encajen.\n` +
    `- MAYÚSCULAS: TODO sustantivo alemán en mayúscula — también tras kein/keine/mit/für/von/ohne, en enumeraciones y listas. ¡Compruébalo antes de enviar!\n` +
    `- ANTI-ANGLICISMOS: CERO palabras inglesas sin traducir (gardening, jogging, hiking, cycling, Workshop…). Préstamos aceptados (Deadline, Meeting, Team, Computer, E-Mail, App, Blog, Podcast, Event) SOLO capitalizados. Workshop SIEMPRE → Kurs/Seminar/Werkstatt.\n`;

  if (module === 'horen' && t === 1) {
    if (lv === 'B2') {
      return (
        common +
        `- 5 passages (s1–s5) 35–85 W (gate max 90) + 10 questions (por segmento: RF luego MCQ).\n` +
        `- PREGUNTAS/OPCIONES: vocabulario B1 (ANTI-B2+ en enunciados); audio puede ser B2.\n` +
        `- Instrucción oficial Modellsatz en question[0].\n` +
        `- segmentLabel Aufnahme 1…5; escucha 1×; NO pool B1 monólogo-anuncios.\n` +
        `- explanation MCQ: prosa CHK-34 (sin «Option a/b/c)»).\n`
      );
    }
    if (lv === 'A2') {
      return (
        common +
        `- 5 passages (s1–s5), cada uno **20–70 palabras** (monólogo A2 hablado).\n` +
        `- **5 preguntas** exactas — **1 MCQ a/b/c por segmento** (PROHIBIDO richtig_falsch — no es B1).\n` +
        `- segmentLabel «Text 1»…«Text 5» en cada question; passageId al segmento correcto.\n` +
        `- Cada passage: **audio[]** con 1 turno monólogo para TTS.\n` +
        `- SOLO MONÓLOGO — PROHIBIDO diálogo, Gespräch o turnos «Name: …».\n` +
        `- MCQ: options a)/b)/c); correct solo letra; varía a/b/c; anti word-matching (≥4 palabras seguidas del transcript = FAIL).\n` +
        `- LONGITUD MCQ (gate RECHAZA): en cada pregunta la opción correcta **NO puede ser la más larga** ` +
        `(el gate A2 falla si supera la media de los distractores en ≥20% y ≥8 caracteres). ` +
        `Que la correcta sea la más corta o la del medio, variando entre preguntas; si necesita un dato más, ` +
        `da a los distractores un dato equivalente (otra hora, otro lugar, otro precio). ` +
        `CUENTA los caracteres de las tres opciones antes de responder.\n` +
        `  Ejemplo INCORRECTO: «Um 8 Uhr.» / «Am Montag.» / «Am Dienstag um 10 Uhr im Rathaus.» ← correcta, se adivina sin escuchar.\n` +
        `  Ejemplo CORRECTO: «Am Montag um 9 Uhr.» / «Am Freitag um 14 Uhr.» ← correcta / «Am Dienstag um 10 Uhr.»\n` +
        `- REGISTRO A2 T1: PROHIBIDO Beratungsgespräche/Vorstellungsgespräch/Personalabteilung/Herausforderung/Experte; max 1 «… zu …» por segmento.\n` +
        `- difficulty: entero 2–4 en cada question (nunca 5).\n` +
        MCQ_CHK34_EXPLANATION_RULE
      );
    }
    return (
      common +
      `- 5 passages (s1–s5) + 10 questions (sN-q1 RF, sN-q2 MCQ).\n` +
      `- segmentLabel en cada pregunta (Aufnahme 1 … 5).\n` +
      `- MCQ: options a)/b)/c); correct solo letra; varía a/b/c.\n` +
      `- DISTRACTOR COHERENTE (MCQ): cada distractor debe relacionarse temáticamente con el segmento. Si una palabra objetivo no encaja de forma natural y coherente en un distractor, OMITÍLA — no la fuerces (ver regla de vocabulario arriba).\n` +
      `- LONGITUD MCQ: la opción correcta y los 2 distractores deben tener longitud COMPARABLE ` +
      `(palabras/caracteres) — ninguno conspicuamente más largo o más detallado, o se puede adivinar ` +
      `sin escuchar el audio. Si la correcta necesita más detalle para ser precisa, agregá detalle ` +
      `equivalente (no el mismo contenido) a los distractores. ` +
      `Ejemplo INCORRECTO: correcta «Die Anmeldung endet am Freitag, den 12. Mai.» ` +
      `vs distractores cortos «Online.» / «Im Büro.» ` +
      `Ejemplo CORRECTO: tres opciones de longitud similar, p. ej. «Persönlich im Büro bis Freitag.» / ` +
      `«Nur online bis Montagabend.» / «Per E-Mail ohne Frist.».\n` +
      `- APERTURA POR TIPO: cada segmento es un tipo monológico distinto (Durchsage / Telefonat-Anrufbeantworter / Radio-Tipp / Hinweis-Ansage). Elegí apertura del banco del tipo correspondiente; variá entre los 5 segmentos del archivo y respecto a lo ya generado. Ver bloque de aperturas arriba.\n` +
      `- SOLO MONÓLOGO (formato oficial Goethe B1 T1): PROHIBIDO diálogo, Gespräch, Kurzgespräch o turnos «Name: …». Cada segmento = una sola voz (Durchsage, Ansage, Anrufbeantworter, Radio-Tipp, Hinweis).\n` +
      `- RF ≠ MCQ (dato distinto): en cada segmento, el Richtig/Falsch y el MCQ deben evaluar DATOS distintos del audio — no la misma información parafraseada. Ejemplo INCORRECTO: RF «geöffnet Di+Do» + MCQ «wann nachmittags? → Di+Do». Ejemplo CORRECTO: RF sobre horario + MCQ sobre Notfallnummer / Gebühr / Anmeldung.\n` +
      `- NOMBRES: variá Herr/Frau + Apellido entre segmentos y archivos; no reuses apellidos excluidos/sobrerrepresentados. Ver bloque de nombres arriba.\n` +
      `- explanation (MCQ): NUNCA digas "Option a/b/c)" ni "la opción X es correcta" — el orden a/b/c puede reordenarse después. Explica el contenido de la respuesta correcta en prosa.\n`
    );
  }
  if (module === 'horen' && t === 2) {
    if (lv === 'B2') {
      return (
        common +
        `- 1 Interview Radio Wissenschaft 280–400 W + 6 MCQ (NO 5 MCQ monólogo B1).\n` +
        `- Instrucción oficial en question[0]; escucha 2× implícita.\n` +
        `- Turnos entrevista; anti word-copy; MCQ longitud comparable.\n`
      );
    }
    if (lv === 'A2') {
      return (
        common +
        `- 1 passage diálogo (2 hablantes «Name:») + pictures[9] en el passage (banco estándar a–i: Fahrrad, Deutschkurs, Freunde, Sport, Museum, Kino, Lernen, Einkaufen, Kochen).\n` +
        `- 5 preguntas matching: enunciado = «Was macht {Name} am {Montag|Dienstag|Mittwoch|Donnerstag|Freitag}?» (hablante + día obligatorios).\n` +
        `- correct = letra a–i de la actividad que ESE hablante dice hacer ESE día; 5 letras distintas.\n` +
        `- SIN options en preguntas; PROHIBIDO monólogo (eso es B1 T2).\n`
      );
    }
    return (
      common +
      `- 1 passage + 5 MCQ; distractores plausibles.\n` +
      `\n## ANTI-COPIA DE AUDIO (Hören MCQ) — OBLIGATORIO\n` +
      `MAL ❌ Transcripción: «…der Wohnungsmarkt ist momentan sehr angespannt…»\n` +
      `     Pregunta: «Der Wohnungsmarkt ist momentan sehr angespannt.»\n` +
      `     → FAIL: copia ≥4 palabras seguidas.\n` +
      `BIEN ✅ Pregunta: «Wie ist die Lage auf dem Wohnungsmarkt laut dem Gespräch?»\n` +
      `     Opción correcta: «Es ist schwierig, eine Wohnung zu finden.»\n` +
      `     → Parafraseo B1; máx. 3 palabras de contenido iguales al audio.\n` +
      `\n## ANTI-SESGO DE LONGITUD MCQ — OBLIGATORIO\n` +
      `En el JSON, cada option es UN string con UNA sola etiqueta minúscula al inicio («a) …», «b) …», «c) …»). ` +
      `NUNCA repitas la letra dentro del texto («a) A) …» está PROHIBIDO).\n` +
      `MAL ❌ Opción 1: «Nur am Wochenende.» (22 chars)\n` +
      `     Opción 2: «Immer nach 22 Uhr.» (19 chars)\n` +
      `     Opción 3: «Am Sonntag und nachts sowie an Wochentagen in der Mittagszeit.» (66 chars) ← correcta\n` +
      `     → FAIL: correcta es 3× más larga; se elige sin escuchar.\n` +
      `BIEN ✅ Opción 1: «Am Sonntag und in der Nacht.» (32 chars)\n` +
      `     Opción 2: «Nur an Feiertagen und abends.» (31 chars)\n` +
      `     Opción 3: «Von Montag bis Samstag nach 20 Uhr.» (38 chars) ← correcta\n` +
      `     → Longitudes comparables (~30–40 chars); hay que entender el audio.\n` +
      `- DISTRACTOR COHERENTE: cada distractor debe relacionarse temáticamente con el pasaje. Si una palabra objetivo no encaja de forma natural y coherente en un distractor, OMITÍLA — no la fuerces (ver regla de vocabulario arriba).\n` +
      `- ANTI-ATAJO MCQ (objetivo): ningún candidato debe poder identificar la respuesta correcta ` +
      `sin comprender el audio — ni por longitud, ni porque un distractor sea obviamente más simple/genérico, ` +
      `ni por cueing léxico (la clave reusa una palabra específica del monólogo que ningún distractor comparte). ` +
      `Longitud pareja y léxico de especificidad comparable son formas de lograrlo, no el objetivo en sí. ` +
      `Si la clave necesita más detalle o un término del audio, agregá detalle/especificidad EQUIVALENTE ` +
      `(no el mismo contenido ni la misma palabra-gancho) a los distractores. ` +
      `Ejemplo INCORRECTO (longitud): correcta «Sie sollen das Medikament dreimal täglich nach dem Essen einnehmen.» ` +
      `vs distractores tan cortos/genéricos que se descartan sin escuchar («Nur morgens.» / «Vor dem Schlafen.»). ` +
      `Ejemplo INCORRECTO (cueing léxico): audio «Kurzzeitparken für Besucher (maximal 2 Stunden)…» ` +
      `→ correcta que repite «Kurzzeitparken…maximal…» vs distractores genéricos sin ese léxico. ` +
      `Ejemplo CORRECTO: tres opciones con el mismo nivel de detalle, p. ej. «Dreimal täglich nach dem Essen.» / ` +
      `«Nur morgens und abends vor dem Essen.» / «Einmal täglich vor dem Schlafengehen.» — hay que oír el monólogo.\n` +
      `- APERTURA: prohibido usar "Guten Tag, liebe Zuhörerinnen und Zuhörer" (sobreusada). Ver bloque de aperturas sugeridas arriba en el prompt.\n` +
      `- explanation (MCQ): NUNCA digas "Option a/b/c)" ni "la opción X es correcta" — el orden a/b/c puede reordenarse después. Explica el contenido de la respuesta correcta en prosa.\n`
    );
  }
  if (module === 'horen' && t === 3) {
    if (lv === 'B2') {
      return (
        common +
        `- 1 Panel 4 hablantes 250–380 W + 6 matching A–D (options idénticas).\n` +
        `- Instrucción «Wer sagt das?» en question[0]; escucha 1×.\n` +
        `- NO 7× RF diálogo B1; distribución A–D; anti-ambigüedad hablante.\n`
      );
    }
    if (lv === 'A2') {
      return (
        common +
        `- 5 passages (s1–s5), cada uno diálogo corto 15–50 palabras, 2 hablantes «Name:».\n` +
        `- 5× multiple_choice a/b/c; cada question con segmentLabel «Text 1»…«Text 5» y passageId.\n` +
        `- Cada passage: **audio[]** con turnos de diálogo (2 voiceId) para TTS.\n` +
        `- PROHIBIDO: 1 diálogo largo + 7 Richtig/Falsch (eso es B1).\n` +
        MCQ_CHK34_EXPLANATION_RULE
      );
    }
    return (
      common +
      `- Cada passage: "module":"horen". Cada question: "module":"horen","teil":3,"lang":"de","level":"B1","correctAnswer" (= correct).\n` +
      `- Diálogo informal B1 con exactamente 2 hablantes; formato «Name: …» alternando (nombres de pila reales, NO «Person A:/Person B:»).\n` +
      `- NOMBRES: ver bloque de pares sugeridos / excluidos en el prompt (variedad; no Anna+Ben ni Lena/Markus).\n` +
      `- APERTURA: ver bloque de aperturas sugeridas — evitar el estereotipo «Hallo/Hey [Name], wie geht's / Wochenende».\n` +
      `- 7× richtig_falsch; mezcla Richtig/Falsch; al menos 2 inferencia/paráfrasis.\n`
    );
  }
  if (module === 'horen' && t === 4) {
    if (lv === 'B2') {
      return (
        common +
        `- 1 Vortrag 300–450 W + 8 MCQ a/b/c (NO 8 matching debate B1).\n` +
        `- Instrucción oficial en question[0]; escucha 2×.\n` +
        `- Monólogo; explanation CHK-34 friendly.\n`
      );
    }
    if (lv === 'A2') {
      return (
        common +
        `- 1 Radiointerview 150–250 palabras; presentador + invitado/a.\n` +
        `- 5× ja_nein; correct "Ja"/"Nein"; options: [].\n` +
        `- passages[0].audio[] obligatorio (2 voiceId: Moderator + invitado/a) para TTS.\n` +
        `- PROHIBIDO: 8 matching M/A/B (eso es B1 T4).\n` +
        `- REGISTRO A2 T4: entrevista sencilla; PROHIBIDO Experte/Herausforderung/herzlich willkommen zu unserer Sendung/kritisch zu sein; max 3 «… zu …» en el transcript.\n` +
        `- difficulty: entero 2–4 en cada question (nunca 5).\n`
      );
    }
    return (
      common +
      `- 1 debate; 8× matching; options **idénticas** en las 8: ["M) Moderator","A) …","B) …"].\n` +
      `- correct ∈ {M,A,B}; reparte M/A/B (no todo en A).\n` +
      `- PROHIBIDO gap_fill o matching sin options.\n` +
      `- APERTURA DEL MODERADOR: prohibido el estereotipo «Herzlich willkommen zu \"… im Fokus\"». Ver bloque de aperturas sugeridas arriba.\n` +
      `- NOMBRES DE INVITADOS: usar el bloque de rotación de nombres (nameRotation) — no Dana/Florian de plantilla.\n`
    );
  }
  if (module === 'schreiben') {
    if (lv === 'A2') {
      return (
        common +
        `\n## FORMATO JSON Schreiben A2 — OBLIGATORIO\n` +
        `- passages: [] · **1 question** por Teil generado (teil 1 o 2).\n` +
        `- type:"short_answer", correct:"rubric", options:[].\n` +
        (t === 1
          ? `- T1 SMS 20–30 Wörter a Freund/in, 3 bullet points.\n`
          : `- T2 E-Mail semiformal 30–40 Wörter **an Ihren Chef**: Dank + kommen mit Begleitung + Wegfrage. OBLIGATORIO «Chef».\n`) +
        `- PROHIBIDO Forum/Forumpost/Meinung (formato B1).\n`
      );
    }
    if (lv === 'B2') {
      return (
        common +
        `\n## FORMATO JSON Schreiben B2 — OBLIGATORIO\n` +
        `- passages: [] · **1 question** por Teil generado (teil 1 o 2).\n` +
        `- type:"short_answer", correct:"rubric", options:[].\n` +
        (t === 1
          ? `- T1 Forumsbeitrag mindestens 150 Wörter; Meinung, Gründe, Vorschläge, Vor- und Nachteile.\n`
          : `- T2 Nachricht an Vorgesetzten mindestens 100 Wörter; Situation, Verständnis, Vorschlag; Anrede/Gruß.\n`) +
        `- PROHIBIDO batch B1 (3 Teile / ~80 Wörter) o SMS A2.\n`
      );
    }
    return (
      common +
      `\n## FORMATO JSON Schreiben — OBLIGATORIO\n` +
      `MAL ❌ Responder con un solo objeto task sin array:\n` +
      `     { "passages": [...], "task": "..." }  → FAIL: falta array questions\n` +
      `BIEN ✅ Raíz SIEMPRE con ambos arrays:\n` +
      `     { "passages": [{ "id": "...", "text": "..." }],\n` +
      `       "questions": [{ "id": "...", "module": "schreiben", "teil": 2, ... }] }\n` +
      `     → El checker rechaza cualquier respuesta sin "questions": [...]\n` +
      `- passages: [] · exactamente 3 questions (teil 1,2,3).\n` +
      `- type:"short_answer", correct:"rubric", options:[].\n` +
      `- T1 E-Mail Freund/in ~80W · T2 Forumpost ~80W con cita · T3 nota semiformal ~40W.\n` +
      `- PROHIBIDO placeholders entre corchetes ([Name], [Name des Freundes/der Freundin], [Dein Name]). ` +
      `La consigna NO incluye Anrede pre-escrita con corchetes — el alumno elige Anrede/Gruß.\n` +
      `- explanation: usa SOLO la plantilla canónica Goethe (4 criterios); no inventes otra estructura.\n`
    );
  }
  if (module === 'sprechen' && lv === 'A2' && t === 1) {
    return (
      common +
      `- passages: [] · exactamente **1** question con "teil":1.\n` +
      `- type canónico: **personal_questions** · difficulty:3.\n` +
      `- OBLIGATORIO: 4 Karten **Geburtstag, Wohnort, Beruf, Hobby** numeradas.\n` +
      `- OBLIGATORIO: interacción paarweise (4 Fragen + 4 Antworten), sin Vorbereitung.\n` +
      `- PROHIBIDO Planungsaufgabe B1 / Präsentation / Feedback.\n`
    );
  }
  if (module === 'sprechen' && lv === 'A2' && t === 2) {
    return (
      common +
      `- passages: [] · exactamente **1** question con "teil":2.\n` +
      `- type canónico: **about_self** · difficulty:3.\n` +
      `- OBLIGATORIO: 1 Karte con tema concreto («…») + instrucción **erzählen**.\n` +
      `- PROHIBIDO Präsentation / 5 Punkte / 3 Minuten (formato B1).\n`
    );
  }
  if (module === 'sprechen' && lv === 'A2' && t === 3) {
    return (
      common +
      `- passages: [] · exactamente **1** question con "teil":3.\n` +
      `- type canónico: **plan_together** · difficulty:3.\n` +
      `- OBLIGATORIO: situación concreta + **zwei Wochenpläne/Agenden** + Termin finden.\n` +
      `- PROHIBIDO Feedback/Rückmeldung sobre Präsentation (eso es B1 T3).\n` +
      `- Partner/Partnerin; PROHIBIDO Kandidat* / Prüfer / 1ª persona examinador.\n`
    );
  }
  if (module === 'sprechen' && lv === 'B2' && t === 1) {
    return (
      common +
      `- passages: [] · exactamente **1** question con "teil":1.\n` +
      `- type canónico: **short_answer** · correct:"rubric" · difficulty:5.\n` +
      `- OBLIGATORIO: frase oficial Modellsatz Vortrag («Halten Sie einen kurzen Vortrag zu einem Thema Ihrer Wahl…»).\n` +
      `- Tema B2 concreto + guía Gliederung + interacción Partner/in tras el Vortrag.\n` +
      `- PROHIBIDO batch B1 (3 Teile) / 4 Karten A2 / Planungsaufgabe B1.\n`
    );
  }
  if (module === 'sprechen' && lv === 'B2' && t === 2) {
    return (
      common +
      `- passages: [] · exactamente **1** question con "teil":2.\n` +
      `- type canónico: **short_answer** · correct:"rubric" · difficulty:5.\n` +
      `- OBLIGATORIO: Diskussion/Standpunkte sobre tema controvertido B2 + interacción Partner/in.\n` +
      `- PROHIBIDO batch B1 (3 Teile) / Feedback T3 B1 / Präsentation monólogo A2.\n`
    );
  }
  if (module === 'sprechen') {
    return (
      common +
      `- passages: [] · exactamente 3 questions con "teil":1, "teil":2, "teil":3 (una por Aufgabe).\n` +
      `- type canónico: T1 planungsaufgabe · T2 praesentation · T3 feedback_diskussion · difficulty:5.\n` +
      `- T2 OBLIGATORIO en question: palabra «Präsentation» o «Thema» + ≥5 puntos numerados 1.–5. ` +
      `(Einleitung, Erfahrung/Details, Vor- und Nachteile, Meinung/Schluss).\n` +
      `- T3 OBLIGATORIO: «Feedback» o «Rückmeldung» + «Stellen Sie … Fragen» (o «2-3 Fragen») + línea «Beispielfragen:».\n` +
      `- Sie obligatorio; T2 tema CONCRETO entre comillas; puntos sin * / •.\n` +
      `- PROHIBIDO 1ª persona del examinador / «für den Prüfer» / «die Kandidaten».\n` +
      `- PROHIBIDO usar "Kandidat/Kandidatin" para referirse al compañero de examen en T3 — usar siempre "Partner/Partnerin" (registro entre candidatos, no de examinador).\n` +
      `- correct:"rubric" · T3 referencia el tema concreto de T2.\n`
    );
  }
  return common;
}

/** Cacheable prefix — identical for every generation of the same module/teil/level. */
export function buildExamStaticCore(module, teil, level = 'B1') {
  const raw = stripHumanHeader(loadExamTemplate(module, teil, level));
  const body = stripVocabSectionFromTemplate(raw);
  return body.trim() + lengthBlock(module, teil, level) + checklistBlock(module, teil, level);
}

/** Per-request tail — topic, vocab, openings, IDs, etc. */
export function buildExamVariableSuffix(module, teil, words, options = {}) {
  const { idSuffix, topic, schreibenT3Surname, retryNote } = options;
  let suffix = buildTopicPromptBlock(topic);

  if (module === 'sprechen') {
    let vocab = buildVocabVariableBlock(words, { oral: true });
    vocab = reinforceVocabOptionalBlock(vocab, { oral: true });
    suffix += vocab;
  } else if (module === 'horen') {
    let vocab = buildVocabVariableBlock(words, { horen: true });
    vocab = reinforceVocabOptionalBlock(vocab, { horen: true });
    suffix += vocab;
    if (Number(teil) === 1) {
      suffix += buildHorenT1OpeningsPromptBlock();
      if (options.dialogueNamePairs?.length) {
        suffix += buildDialogueNamesPromptBlock({
          pairs: options.dialogueNamePairs,
          count: options.dialogueNamePairs.length,
        });
      } else {
        suffix += buildHorenT1NamesPromptBlock();
      }
      suffix += buildHorenPremiseExcludePromptBlock(1);
    }
    if (Number(teil) === 2) {
      suffix += buildHorenT2OpeningsPromptBlock({
        mandatedOpening: options.horenT2Opening || null,
      });
      if (options.horenT2ActivitySchedule) {
        suffix += buildHorenT2ActivitySchedulePromptBlock({
          mandatedSchedule: options.horenT2ActivitySchedule,
        });
      }
      if (options.dialogueNamePairs?.length === 1) {
        suffix += buildDialogueNamesPromptBlock({ pairs: options.dialogueNamePairs, count: 1 });
      }
      suffix += buildHorenPremiseExcludePromptBlock(2);
    }
    if (Number(teil) === 3) {
      suffix += buildHorenT3OpeningsPromptBlock();
      if (options.dialogueNamePairs?.length) {
        suffix += buildDialogueNamesPromptBlock({
          pairs: options.dialogueNamePairs,
          count: options.dialogueNamePairs.length,
        });
      } else if (String(options.level || 'B1').toUpperCase() !== 'B2') {
        suffix += buildHorenT3NamesPromptBlock();
      }
    }
    if (Number(teil) === 4 && String(options.level || 'B1').toUpperCase() !== 'B2') {
      suffix += buildHorenT4OpeningsPromptBlock();
    }
  } else {
    suffix += buildVocabVariableBlock(words);
  }

  if (module === 'schreiben') {
    const lv = String(options.level || 'B1').trim().toUpperCase();
    if (lv === 'B1') {
      suffix += buildSchreibenT3PremiseExcludePromptBlock();
      suffix += buildSchreibenT3NamesPromptBlock(schreibenT3Surname || null);
    }
  }

  if (module === 'sprechen') {
    suffix += buildExcludedPremisesPromptBlock();
    suffix += buildSprechenPremiseExcludePromptBlock();
  }

  if (idSuffix) {
    const mod = module === 'horen' ? 'h' : module === 'schreiben' ? 's' : 'sp';
    if (module === 'horen') {
      suffix +=
        `\n\nIMPORTANTE — IDs de esta generación:\n` +
        `- Passages T${teil}: gen-p-h${teil}-${idSuffix}-sN (N=1…5 solo T1)\n` +
        `- Preguntas: gen-q-h${teil}-${idSuffix}-…\n`;
    } else if (module === 'sprechen' && isSprechenPerTeil(module, options.level)) {
      suffix +=
        `\n\nIMPORTANTE — IDs de esta generación:\n` +
        `- Pregunta: gen-q-sp-t${Number(teil)}-${idSuffix}-q1\n`;
    } else if (module === 'schreiben' && isSchreibenPerTeil(module, options.level)) {
      suffix +=
        `\n\nIMPORTANTE — IDs de esta generación:\n` +
        `- Pregunta: gen-q-s-t${Number(teil)}-${idSuffix}-q1\n`;
    } else {
      suffix +=
        `\n\nIMPORTANTE — IDs de esta generación:\n` +
        `- Preguntas: gen-q-${mod}-t{1,2,3}-${idSuffix}-q1\n`;
    }
    suffix += `No reutilices IDs del ejemplo ni del banco existente.`;
  }

  if (retryNote) suffix += retryNote;
  return suffix.trim();
}

export function buildExamPrompt(module, teil, words, options = {}) {
  const level = options.level || 'B1';
  const staticCore = buildExamStaticCore(module, teil, level);
  const variableSuffix = buildExamVariableSuffix(module, teil, words, options);
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

export function buildExamPromptHeader(module, teil, level = 'B1') {
  const lv = String(level || 'B1').trim().toUpperCase();
  const label =
    module === 'horen'
      ? `Hören ${lv} · Teil ${teil}`
      : module === 'schreiben'
        ? isSchreibenPerTeil(module, lv)
          ? `Schreiben ${lv} · Teil ${teil}`
          : `Schreiben ${lv} · Teile 1–3`
        : isSprechenPerTeil(module, lv)
          ? `Sprechen ${lv} · Teil ${teil}`
          : 'Sprechen B1 · Teile 1–3';
  const regen =
    module === 'horen'
      ? `npm run horen:prompt:t${teil}`
      : module === 'sprechen' && isSprechenPerTeil(module, lv)
        ? `build-exam-prompt --module sprechen --level ${lv} --teil ${teil}`
        : module === 'schreiben' && isSchreibenPerTeil(module, lv)
          ? `build-exam-prompt --module schreiben --level ${lv} --teil ${teil}`
          : `${module}:prompt`;
  return (
    `# Prompt generado — ${label}\n` +
    `Copia TODO (desde la línea ---) y pégalo en Gemini/ChatGPT. Devuelve SOLO JSON.\n` +
    `Regenerar otro sorteo: npm run ${regen}\n\n---\n\n`
  );
}

export function buildExamPromptFull(module, teil, words, options = {}) {
  return buildExamPromptHeader(module, teil) + buildExamPrompt(module, teil, words, options);
}

export function teileForModule(module, allTeile = false, level = 'B1') {
  const mod = String(module).toLowerCase();
  const lv = String(level || 'B1').trim().toUpperCase();
  if (mod === 'horen') return allTeile ? [1, 2, 3, 4] : null;
  if (mod === 'sprechen' && lv === 'A2') return allTeile ? [1, 2, 3] : null;
  if (mod === 'schreiben' && (lv === 'A2' || lv === 'B2')) return allTeile ? [1, 2] : null;
  if (mod === 'schreiben' || mod === 'sprechen') return ['all'];
  throw new Error(`Módulo inválido: ${module}`);
}
