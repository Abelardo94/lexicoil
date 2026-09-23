/**
 * semanticValidator.test.mjs — SEM-1 acceptance criteria
 *
 * All LLM calls are mocked via _setLlmFn.
 * No network calls, no API keys needed.
 *
 * Fixtures:
 *   F1 — correctness fail  → issue 'correctness', ok=false, CRITICAL in isPartPoolReady
 *   F2 — ambiguity         → issue 'ambiguity',   ok=false, CRITICAL in isPartPoolReady
 *   F3 — absurd distractor → issue 'distractor',  ok=false, IMPORTANT in isPartPoolReady
 *   F4 — explanation fail  → issue 'explanation', ok=false, IMPORTANT in isPartPoolReady
 *   F5 — template repeat   → issue 'template',    ok=false, IMPORTANT on 2nd similar part
 *   F6 — clean part        → ok=true, no issues
 *   F7 — cache: 2nd call on same part skips LLM (spy counter stays at 1)
 *   F8 — isPartPoolReady({semantic:true}) integrates SEM findings into blocking[]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validatePartSemantics,
  clearSemanticCache,
  clearTemplateRegistry,
  buildPromptForPart,
  isSelfContradictorySemIssue,
  _setLlmFn,
} from '../semanticValidator.mjs';
import { isPartPoolReady } from '../../audit-pass-2.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeLlmFn(issues = [], themeTags = ['wohnen', 'nachbarn', 'einzug']) {
  // Add confidence to mock issues if not already present (mirrors real LLM output)
  const withConf = issues.map((i) => ({ confidence: 0.9, ...i }));
  return async (_prompt) => JSON.stringify({ themeTags, issues: withConf });
}

let llmCallCount = 0;
function spyLlmFn(issues = [], themeTags = ['sport', 'verein', 'training']) {
  llmCallCount = 0;
  return async (_prompt) => {
    llmCallCount++;
    return JSON.stringify({ themeTags, issues });
  };
}

/** A valid Lesen T1 MCQ part (structurally clean, only semantics vary via mock) */
function makeLesenPart(id = 'test-part-01') {
  const PASSAGE =
    'Viele Städte in Deutschland fördern heute das Fahrradfahren. ' +
    'Neue Radwege werden gebaut und Leihfahrräder sind günstig verfügbar. ' +
    'Experten sagen, dass der Verkehr dadurch deutlich abnimmt.';
  return {
    id,
    lang: 'de',
    level: 'B1',
    module: 'lesen',
    teil: 1,
    complete: true,
    verified: true,
    passage: { title: 'Fahrräder in der Stadt', text: PASSAGE },
    questions: [
      {
        id: `${id}-q1`,
        module: 'lesen',
        teil: 1,
        type: 'richtig_falsch',
        question: 'Neue Radwege werden in deutschen Städten gebaut.',
        options: [],
        correct: 'Richtig',
        correctAnswer: 'Richtig',
        explanation:
          'Im Text steht: "Neue Radwege werden gebaut", was die Aussage direkt bestätigt.',
      },
      {
        id: `${id}-q2`,
        module: 'lesen',
        teil: 1,
        type: 'richtig_falsch',
        question: 'Das Fahrradfahren wird von Städten nicht unterstützt.',
        options: [],
        correct: 'Falsch',
        correctAnswer: 'Falsch',
        explanation:
          'Der Text sagt, dass Städte das Fahrradfahren "fördern", also das Gegenteil.',
      },
    ],
  };
}

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}`); failed++; }
}

// ─── Tests ───────────────────────────────────────────────────────────────────
(async () => {
  // F1 — Correctness failure
  console.log('\nF1: clave incorrecta → issue "correctness", ok=false, confidence presente');
  clearSemanticCache(); clearTemplateRegistry();
  _setLlmFn(makeLlmFn([
    { kind: 'correctness', itemId: 'test-f1-q1', detail: 'La opción marcada no está respaldada por el texto.', confidence: 0.95 },
  ]));
  {
    const result = await validatePartSemantics(makeLesenPart('test-f1'));
    ok(!result.ok, 'ok=false con correctness issue');
    ok(result.issues.length === 1, 'exactamente 1 issue');
    ok(result.issues[0].kind === 'correctness', 'kind=correctness');
    ok(result.issues[0].itemId === 'test-f1-q1', 'itemId correcto');
    ok(typeof result.issues[0].confidence === 'number', 'confidence es número');
    ok(result.issues[0].confidence === 0.95, 'confidence=0.95 preservado');
  }

  // F2 — Ambiguity (2 valid answers)
  console.log('\nF2: dos respuestas válidas → issue "ambiguity", ok=false');
  clearSemanticCache(); clearTemplateRegistry();
  _setLlmFn(makeLlmFn([
    { kind: 'ambiguity', itemId: 'test-f2-q1', detail: 'Tanto "a" como "c" pueden defenderse con el texto.' },
  ]));
  {
    const result = await validatePartSemantics(makeLesenPart('test-f2'));
    ok(!result.ok, 'ok=false con ambiguity');
    ok(result.issues[0].kind === 'ambiguity', 'kind=ambiguity');
  }

  // F3 — Absurd distractor
  console.log('\nF3: distractor absurdo → issue "distractor", ok=false');
  clearSemanticCache(); clearTemplateRegistry();
  _setLlmFn(makeLlmFn([
    { kind: 'distractor', itemId: 'test-f3-q2', detail: 'La opción b es imposible según cualquier contexto real.' },
  ]));
  {
    const result = await validatePartSemantics(makeLesenPart('test-f3'));
    ok(!result.ok, 'ok=false con distractor issue');
    ok(result.issues[0].kind === 'distractor', 'kind=distractor');
  }

  // F4 — Confidence threshold: issues below 0.85 are discarded
  console.log('\nF4: conf<0.85 → descartado; conf≥0.85 → bloqueante');
  clearSemanticCache(); clearTemplateRegistry();
  _setLlmFn(async (_prompt) => JSON.stringify({
    themeTags: ['test'],
    issues: [
      { kind: 'distractor', itemId: 'f4-q1', detail: 'Ruido bajo confianza.', confidence: 0.60 },
      { kind: 'correctness', itemId: 'f4-q2', detail: 'Error real alto confianza.', confidence: 0.92 },
    ],
  }));
  {
    const result = await validatePartSemantics(makeLesenPart('test-f4'));
    ok(!result.ok, 'ok=false — el issue de alta confianza bloquea');
    ok(result.issues.length === 1, 'solo 1 issue (conf≥0.85)');
    ok(result.issues[0].kind === 'correctness', 'issue de alta confianza es correctness');
    ok(result.issues[0].confidence === 0.92, 'confidence 0.92 preservado');
    ok(!result.issues.some((i) => i.confidence < 0.85), 'ningún issue de baja confianza en resultado');
  }

  // F5 — Template repetition (two parts with similar theme tags)
  console.log('\nF5: dos partes con molde temático similar → issue "template" en la 2ª');
  clearSemanticCache(); clearTemplateRegistry();
  const COMMON_TAGS = ['wohnen', 'einzug', 'nachbarn', 'gemeinschaft'];
  // First part: LLM returns no issues, registers the template
  _setLlmFn(makeLlmFn([], COMMON_TAGS));
  {
    const r1 = await validatePartSemantics(makeLesenPart('test-f5-a'));
    ok(r1.ok, 'primera parte: ok=true (no template issue)');
    ok(r1.issues.length === 0, 'sin issues en la primera');
  }
  // Second part with same theme tags: LLM also returns no issues from LLM side,
  // but the template registry should detect the repeat
  _setLlmFn(makeLlmFn([], COMMON_TAGS));
  {
    const r2 = await validatePartSemantics(makeLesenPart('test-f5-b'));
    ok(!r2.ok, 'segunda parte con mismo molde: ok=false');
    ok(r2.issues.some((i) => i.kind === 'template'), 'issue kind=template en la segunda');
  }

  // F6 — Clean part
  console.log('\nF6: parte correcta → ok=true, sin issues');
  clearSemanticCache(); clearTemplateRegistry();
  _setLlmFn(makeLlmFn([], ['fahrrad', 'verkehr', 'stadt']));
  {
    const result = await validatePartSemantics(makeLesenPart('test-f6'));
    ok(result.ok, 'ok=true parte limpia');
    ok(result.issues.length === 0, 'issues vacío');
  }

  // F7 — Cache: second call on same part doesn't invoke LLM again
  console.log('\nF7: cache — segunda llamada sobre la misma parte no llama al LLM');
  clearSemanticCache(); clearTemplateRegistry();
  const spy = spyLlmFn([], ['arbeit', 'beruf', 'kollegin']);
  _setLlmFn(spy);
  {
    const part = makeLesenPart('test-f7');
    await validatePartSemantics(part); // first call → LLM invoked
    ok(llmCallCount === 1, 'primera llamada: LLM invocado una vez');
    await validatePartSemantics(part); // second call → cache hit
    ok(llmCallCount === 1, 'segunda llamada: LLM NO invocado de nuevo (cache hit)');
  }

  // F8 — Integration: isPartPoolReady({semantic:true}) merges SEM findings into blocking[]
  // Uses a structurally-clean batch (6 richtig_falsch for lesen T1) so the structural
  // gate passes and the semantic layer actually runs.
  console.log('\nF8: isPartPoolReady({semantic:true}) integra SEM findings en blocking[]');
  clearSemanticCache(); clearTemplateRegistry();
  _setLlmFn(makeLlmFn([
    { kind: 'correctness', itemId: 'f8-q1', detail: 'Clave incorrecta según el texto.' },
    { kind: 'distractor', itemId: 'f8-q2', detail: 'Distractor absurdo.' },
  ], ['fahrrad', 'stadt', 'pendler']));
  {
    // Passage ≥140 B1-level words (CHK-15 lesen-1: min 140, max 260)
    const PASSAGE_TEXT =
      'Ich fahre jeden Tag mit dem Fahrrad zur Arbeit. Das Fahrrad ist gut für die ' +
      'Gesundheit und für die Umwelt. In meiner Stadt gibt es viele neue Radwege. ' +
      'Ich finde das sehr schön. Am Morgen ist der Weg kurz und macht Spaß. Im Winter ' +
      'fahre ich manchmal nicht Fahrrad, weil es kalt und nass ist. Dann nehme ich den ' +
      'Bus oder die Bahn. Aber im Frühling und im Sommer fahre ich immer mit dem ' +
      'Fahrrad zur Arbeit. Meine Arbeit ist fünf Kilometer weit von meiner Wohnung. ' +
      'Das ist nicht zu weit für das Fahrrad. Viele meiner Kollegen fahren auch mit ' +
      'dem Fahrrad. Wir kommen zusammen an der Arbeit an. Das macht Spaß. Die Stadt ' +
      'hilft uns. Es gibt jetzt mehr Radwege als früher. Das ist gut für alle. Ich ' +
      'freue mich darüber sehr. Das Fahrrad kostet wenig Geld. Ich muss kein Benzin ' +
      'kaufen. Das spart Geld und ist gut für die Natur. Ich bin fit und gesund. Das ' +
      'Fahrrad ist mein Freund. Ich rate jedem, Fahrrad zu fahren, wenn es möglich ist.';
    const EXPL = 'Im Text steht direkt, dass diese Aussage korrekt ist und dem Textinhalt entspricht.';
    const makeRF = (i, correct) => ({
      id: `f8-q${i}`, module: 'lesen', teil: 1, type: 'richtig_falsch',
      question: `Aussage ${i}: In deutschen Städten wird Radfahren gefördert.`,
      options: [], correct, correctAnswer: correct, explanation: EXPL, passageId: 'f8-p',
    });
    const batch = {
      passages: [{ id: 'f8-p', module: 'lesen', teil: 1, title: 'Fahrräder', text: PASSAGE_TEXT }],
      questions: [
        makeRF(1, 'Richtig'), makeRF(2, 'Falsch'), makeRF(3, 'Richtig'),
        makeRF(4, 'Falsch'), makeRF(5, 'Richtig'), makeRF(6, 'Falsch'),
      ],
    };
    const gate = await isPartPoolReady(batch, { semantic: true });
    ok(!gate.ok, 'gate.ok=false con findings SEM');
    ok(gate.blocking.some((f) => f.id === 'SEM-CORRECTNESS'), 'SEM-CORRECTNESS en blocking');
    ok(gate.blocking.some((f) => f.id === 'SEM-DISTRACTOR'), 'SEM-DISTRACTOR en blocking');
    const criticalSem = gate.blocking.find((f) => f.id === 'SEM-CORRECTNESS');
    ok(criticalSem?.severity === 'CRITICAL', 'correctness → severity CRITICAL');
    const importantSem = gate.blocking.find((f) => f.id === 'SEM-DISTRACTOR');
    ok(importantSem?.severity === 'IMPORTANT', 'distractor → severity IMPORTANT');
  }

  // F8b — Schreiben part skips semantic (no MCQ), returns ok:true
  console.log('\nF8b: Schreiben part → semantic skipped, ok=true directo');
  clearSemanticCache(); clearTemplateRegistry();
  let schreibenLlmCalled = false;
  _setLlmFn(async (_p) => { schreibenLlmCalled = true; return '{"themeTags":[],"issues":[]}'; });
  {
    const schreiben = {
      id: 'test-schreiben-01',
      lang: 'de', level: 'B1', module: 'schreiben', teil: 1,
      complete: true, verified: true,
      task: 'Schreiben Sie eine E-Mail an Ihre Freundin.',
      passage: { text: 'Schreiben Sie eine E-Mail an Ihre Freundin.' },
      questions: [{ id: '1', module: 'schreiben', teil: 1, type: 'short_answer',
        question: 'Schreiben Sie eine E-Mail.', correct: 'rubric', correctAnswer: 'rubric' }],
    };
    const result = await validatePartSemantics(schreiben);
    ok(result.ok, 'Schreiben: ok=true sin LLM');
    ok(!schreibenLlmCalled, 'Schreiben: LLM NO invocado');
  }

  // F9 — T3 "0" key: prompt documents Goethe convention; uppercase A–J resolves ad text
  console.log('\nF9: T3 clave "0" → prompt SEM documenta convención Goethe');
  clearSemanticCache(); clearTemplateRegistry();
  {
    const ADS = [
      'A) Repair — Kleingeräte.',
      'B) Tech — Laptops.',
      'C) Flex — PKW leihen.',
      'D) Glanz — Auto wäschen.',
      'E) AutoWest — PKW Kauf/Miete.',
      'F) Reisen — Pauschalreisen.',
      'G) Physik — Nachhilfe.',
      'H) PC — Hausbesuch.',
      'I) Schreib — Korrespondenz.',
      'J) Kochen — Abendkurs.',
    ];
    const makeT3Q = (n, question, correct) => ({
      id: `t3-q-${n}`, module: 'lesen', teil: 3, type: 'matching',
      question, options: ADS, correct, correctAnswer: correct,
      explanation: correct === '0' ? 'Keine Anzeige passt.' : 'Siehe Anzeige.',
    });
    const t3Part = {
      id: 'test-t3-zero',
      lang: 'de', level: 'B1', module: 'lesen', teil: 3,
      questions: [
        makeT3Q(1, 'Drucker kaputt, Hilfe zuhause.', 'H'),
        makeT3Q(7, 'Steuererklärung Beratung gesucht.', '0'),
      ],
    };
    const prompt = buildPromptForPart(t3Part);
    ok(prompt.includes('clave "0"'), 'prompt menciona clave "0"');
    ok(prompt.includes('ningún anuncio encaja'), 'prompt explica significado de "0"');
    ok(prompt.includes('NO la marques como clave inválida'), 'prompt prohíbe FP en "0"');
    ok(prompt.includes('Clave: 0 → ningún anuncio'), 'línea clave 0 formateada');
    ok(prompt.includes('Clave: H →'), 'línea clave A–J incluye texto del anuncio');
  }

  // F10 — Batch 063-style: mock LLM approves (regression guard for "0" parts)
  console.log('\nF10: batch 063 con "0" → validatePartSemantics ok=true (mock LLM)');
  clearSemanticCache(); clearTemplateRegistry();
  _setLlmFn(makeLlmFn([], ['reparatur', 'auto', 'nachhilfe']));
  {
    const batchPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../batches/generated/lesen-t3-gemini-063.json',
    );
    if (fs.existsSync(batchPath)) {
      const batch = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
      batch.id = 'verify-063';
      batch.module = 'lesen';
      batch.teil = 3;
      batch.lang = 'de';
      batch.level = 'B1';
      const result = await validatePartSemantics(batch, { skipTemplate: true });
      ok(result.ok, '063 mock: ok=true sin issues SEM');
    } else {
      console.log('  ⚠ lesen-t3-gemini-063.json no encontrado — F10 skipped');
    }
  }

  // F11 — L2 self-contradiction filter (071-style FP vs 073-style real)
  console.log('\nF11: isSelfContradictorySemIssue — 071 FP vs 073 real');
  {
    const fp = { kind: 'correctness', detail: 'Clave correcta. Evidencia: \'von überall aus zu lernen\'.' };
    const real = {
      kind: 'correctness',
      detail: 'Las opciones b) y c) son idénticas en significado. Falta diferenciación clara.',
    };
    ok(isSelfContradictorySemIssue(fp), '071-style «Clave correcta» → filtrado');
    ok(!isSelfContradictorySemIssue(real), '073-style opciones duplicadas → NO filtrado');
  }

  // F12 — Simulated 071 LLM response → ok after filter
  console.log('\nF12: respuesta LLM 071 simulada → ok=true tras filtro');
  clearSemanticCache(); clearTemplateRegistry();
  _setLlmFn(async () => JSON.stringify({
    themeTags: ['technik', 'smart home', 'schule'],
    issues: [
      { kind: 'correctness', itemId: 'q1', detail: 'Clave correcta. Evidencia: \'Komfort\'.', confidence: 0.95 },
    ],
  }));
  {
    const part = makeLesenPart('test-l2-fp');
    part.teil = 2;
    part.questions[0].type = 'multiple_choice';
    part.questions[0].options = ['a) eins', 'b) zwei', 'c) drei'];
    const result = await validatePartSemantics(part, { skipTemplate: true });
    ok(result.ok, '071 simulado: ok=true (issue filtrado)');
    ok(result.issues.length === 0, 'sin issues tras filtro');
  }

  // ── forced_vocab (23 sep 2026): replaces the lexical vocab-coherence gate ──
  console.log('\n── forced_vocab: solo Lesen T1 con vocabulario usado ──');
  {
    const plain = makeLesenPart('test-fv-plain');
    ok(!/forced_vocab/.test(buildPromptForPart(plain)), 'sin userVocabFeedback: el prompt no pide forced_vocab');

    const withVocab = { ...makeLesenPart('test-fv-vocab'), userVocabFeedback: { used: ['radweg', 'verkehr'] } };
    const p = buildPromptForPart(withVocab);
    ok(/"forced_vocab"/.test(p) && /radweg, verkehr/.test(p), 'Lesen T1 con vocab: pide forced_vocab y lista las palabras');

    const teil3 = { ...withVocab, teil: 3, questions: withVocab.questions.map((q) => ({ ...q, teil: 3 })) };
    ok(!/forced_vocab/.test(buildPromptForPart(teil3)), 'Lesen T3 con vocab: no pide forced_vocab');

    clearSemanticCache(); clearTemplateRegistry();
    _setLlmFn(makeLlmFn([{ kind: 'forced_vocab', itemId: 'passage', detail: '«Ein Stadtplan ist praktisch.» — stadtplan metida sin relación' }]));
    const r = await validatePartSemantics(withVocab, { skipTemplate: true });
    ok(!r.ok, 'forced_vocab bloquea (ok=false)');
    ok(/^vocabulario forzado: /.test(r.issues[0]?.detail || ''), 'forced_vocab lleva el prefijo que reconoce la nota de corrección');

    // Same content, different vocab: the verdict must not come from the cache.
    _setLlmFn(makeLlmFn([]));
    const r2 = await validatePartSemantics({ ...withVocab, userVocabFeedback: { used: ['fahrrad'] } }, { skipTemplate: true });
    ok(r2.ok, 'otro vocabulario sobre el mismo texto no reutiliza el veredicto cacheado');
  }

  console.log('\n── A2 Lesen T1/T2: sin check "template" (formato uniforme) ──');
  {
    const a2 = (teil) => {
      const part = makeLesenPart(`test-a2-t${teil}`);
      delete part.level; delete part.module; delete part.teil; // shape of a generated batch
      part.questions = part.questions.map((q) => ({ ...q, level: 'A2', teil, type: 'multiple_choice', options: ['a) x', 'b) y', 'c) z'], correct: 'a' }));
      return part;
    };
    ok(!/molde narrativo/.test(buildPromptForPart(a2(1))), 'A2 T1 (lote generado): sin check de molde');
    ok(!/molde narrativo/.test(buildPromptForPart(a2(2))), 'A2 T2 (lote generado): sin check de molde');
    ok(/molde narrativo/.test(buildPromptForPart(a2(3))), 'A2 T3: conserva el check de molde');
    ok(/molde narrativo/.test(buildPromptForPart(makeLesenPart('test-b1-t1'))), 'B1 T1: conserva el check de molde');

    clearSemanticCache(); clearTemplateRegistry();
    _setLlmFn(makeLlmFn([{ kind: 'template', itemId: 'passage', detail: 'molde narrativo genérico' }]));
    const r = await validatePartSemantics(a2(2), { skipTemplate: true });
    ok(r.ok, 'A2 T2: un "template" del LLM se filtra aunque lo devuelva');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n══ semanticValidator tests: ${passed} passed, ${failed} failed ══\n`);
  _setLlmFn(null); // restore real LLM
  process.exit(failed > 0 ? 1 : 0);
})();
