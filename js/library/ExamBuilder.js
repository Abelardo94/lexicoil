/* Assembles official-format exams from pre-generated question library */
const ExamBuilder = (() => {
  const CERT = {
    de: {
      A1: { certificate: 'Goethe-Zertifikat A1', board: 'Goethe-Institut' },
      A2: { certificate: 'Goethe-Zertifikat A2', board: 'Goethe-Institut' },
      B1: { certificate: 'Goethe-Zertifikat B1', board: 'Goethe-Institut' },
      B2: { certificate: 'Goethe-Zertifikat B2', board: 'Goethe-Institut' },
      C1: { certificate: 'Goethe-Zertifikat C1', board: 'Goethe-Institut' },
      C2: { certificate: 'Goethe-Zertifikat C2', board: 'Goethe-Institut' },
    },
    en: {
      A1: { certificate: 'A1 Movers', board: 'Cambridge Assessment English' },
      A2: { certificate: 'A2 Key (KET)', board: 'Cambridge Assessment English' },
      B1: { certificate: 'B1 Preliminary (PET)', board: 'Cambridge Assessment English' },
      B2: { certificate: 'B2 First (FCE)', board: 'Cambridge Assessment English' },
      C1: { certificate: 'C1 Advanced (CAE)', board: 'Cambridge Assessment English' },
      C2: { certificate: 'C2 Proficiency (CPE)', board: 'Cambridge Assessment English' },
    },
    es: {
      A1: { certificate: 'DELE A1', board: 'Instituto Cervantes' },
      A2: { certificate: 'DELE A2', board: 'Instituto Cervantes' },
      B1: { certificate: 'DELE B1', board: 'Instituto Cervantes' },
      B2: { certificate: 'DELE B2', board: 'Instituto Cervantes' },
      C1: { certificate: 'DELE C1', board: 'Instituto Cervantes' },
      C2: { certificate: 'DELE C2', board: 'Instituto Cervantes' },
    },
  };

  const MODULE_TIME = {
    de: { lesen: '65 Minuten', horen: '40 Minuten', schreiben: '60 Minuten', sprechen: '15 Minuten' },
    en: { lesen: '75 minutes', horen: '40 minutes', schreiben: '80 minutes', sprechen: '15 minutes' },
    es: { lesen: '70 min', horen: '40 min', schreiben: '80 min', sprechen: '20 min' },
  };

  const DIFFICULTY_RANGE = {
    A1: [1, 3],
    A2: [2, 4],
    B1: [3, 5],
    B2: [4, 7],
    C1: [6, 9],
    C2: [7, 10],
  };

  function defaultDifficultyRange(level) {
    return DIFFICULTY_RANGE[String(level || '').toUpperCase()] || [3, 6];
  }

  const MODULE_TITLE = {
    de: { lesen: 'Lesen', horen: 'Hören', schreiben: 'Schreiben', sprechen: 'Sprechen' },
    en: { lesen: 'Reading', horen: 'Listening', schreiben: 'Writing', sprechen: 'Speaking' },
    es: { lesen: 'Comprensión de lectura', horen: 'Comprensión auditiva', schreiben: 'Expresión escrita', sprechen: 'Expresión oral' },
  };

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pickQuestions(pool, count, filterFn) {
    const filtered = filterFn ? pool.filter(filterFn) : pool;
    if (!filtered.length) return shuffle(pool).slice(0, count);
    return shuffle(filtered).slice(0, Math.min(count, filtered.length));
  }

  function questionMatchesTags(q, grammarTags, topicTags) {
    if (grammarTags?.length) {
      const g = q.grammarTags || [];
      if (!grammarTags.some((t) => g.includes(t))) return false;
    }
    if (topicTags?.length) {
      const t = q.topicTags || [];
      if (!topicTags.some((x) => t.includes(x))) return false;
    }
    return true;
  }

  function questionContainsWords(q, bank, words) {
    if (!words?.length) return false;
    const lowerWords = words.map((w) => String(w).toLowerCase().trim()).filter(Boolean);
    const vTags = (q.vocabularyTags || []).map((t) => String(t).toLowerCase());
    if (vTags.some((t) => lowerWords.some((w) => t === w || t.includes(w) || w.includes(t)))) return true;
    const passage =
      typeof PassageResolver !== 'undefined'
        ? PassageResolver.resolvePassageForQuestion(bank, q)
        : typeof LibraryLoader !== 'undefined'
          ? LibraryLoader.getPassage(bank, q.passageId)
          : (bank.passages || []).find((p) => p.id === q.passageId) || null;
    const blob = [q.question, q.transcript, passage?.text].filter(Boolean).join(' ').toLowerCase();
    return lowerWords.some((w) => blob.includes(w));
  }

  function applyExamDifficulty(exam, bank, lang, level) {
    if (typeof DifficultyScorer === 'undefined' || !exam) return exam;
    exam.difficulty = DifficultyScorer.deriveExamDifficulty(exam, lang, level);
    const scoreParts = (parts) => {
      (parts || []).forEach((part) => {
        if (part.questions?.length) {
          part.questions = DifficultyScorer.applyToQuestions(part.questions, bank, level, lang);
        }
      });
    };
    scoreParts(exam.lesenParts);
    scoreParts(exam.horenParts);
    scoreParts(exam.schreibenParts);
    scoreParts(exam.sprechenParts);
    scoreParts(exam.grammatikParts);
    scoreParts(exam.useOfEnglishParts);
    return exam;
  }

  function annotateCurationNeeds(exam, bank, blueprint) {
    if (!exam || typeof exam !== 'object') return exam;
    const reasons = [];
    const PR = typeof PassageResolver !== 'undefined' ? PassageResolver : null;
    const levelMin = { A1: 25, A2: 60, B1: 150, B2: 250, C1: 350, C2: 450 };
    const minWords = levelMin[String(exam.level || '').toUpperCase()] || 0;

    (exam.lesenParts || []).forEach((part, i) => {
      if (PR && !PR.partHasReadingText(part)) reasons.push(`no_passage_for_part:lesenParts[${i}]`);
    });
    (exam.horenParts || []).forEach((part, i) => {
      if (PR && !PR.partHasListeningTranscript(part)) reasons.push(`no_transcript_for_part:horenParts[${i}]`);
    });
    if (PR && minWords && PR.longestReadingWords(exam) > 0 && PR.longestReadingWords(exam) < minWords) {
      reasons.push(`passage_too_short:longest=${PR.longestReadingWords(exam)},min=${minWords}`);
    }
    if (blueprint && typeof ExamValidator !== 'undefined') {
      const check = new ExamValidator().validate(exam, { blueprint, strict: true });
      if (!check.valid) reasons.push(...check.errors);
    }

    if (blueprint?.modules) {
      const minWordsFromBlueprint = (modId) => {
        const mod = blueprint.modules.find((m) => m.id === modId);
        if (!mod) return 0;
        let min = 0;
        (mod.parts || []).forEach((p) => {
          const w = p.wordsPerPassage?.min || p.wordsTarget?.min || p.wordsPerText?.min;
          if (w != null) min = Math.max(min, w);
        });
        return min;
      };
      const bpLesenMin = minWordsFromBlueprint('lesen') || minWordsFromBlueprint('reading');
      if (bpLesenMin && PR && PR.longestReadingWords(exam) > 0 && PR.longestReadingWords(exam) < bpLesenMin) {
        reasons.push(`passage_too_short:longest=${PR.longestReadingWords(exam)},blueprintMin=${bpLesenMin}`);
      }
    }

    if (reasons.length) {
      exam.needsCuration = true;
      exam.curationReasons = [...new Set(reasons)];
    } else {
      delete exam.needsCuration;
      delete exam.curationReasons;
    }
    return exam;
  }

  function toExamQuestion(q, idx) {
    const out = {
      id: `ql_${q.id || idx}`,
      type: q.type || 'multiple',
      question: q.question,
      correct: q.correct != null ? q.correct : q.correctAnswer,
      correctAnswer: q.correctAnswer != null ? q.correctAnswer : q.correct,
      explanation: q.explanation || '',
      grammarTags: q.grammarTags || [],
      topicTags: q.topicTags || [],
      difficulty: q.difficulty,
    };
    // audit-pass-2 CHK-LEVEL (a publish gate) requires level on every question; dropping it
    // here made every library-built exam unpublishable.
    if (q.level) out.level = q.level;
    if (q.origin) out.origin = q.origin;
    if (q.options?.length) out.options = [...q.options];
    // Cambridge Reading P6: the other words a gap accepts. Dropping it here marked them wrong.
    if (Array.isArray(q.acceptedAnswers) && q.acceptedAnswers.length) out.acceptedAnswers = [...q.acceptedAnswers];
    const pid =
      typeof PassageResolver !== 'undefined' ? PassageResolver.passageIdFromQuestion(q) : q.passageId;
    if (pid) out.passageId = pid;
    return out;
  }

  function resolvePassage(bank, q) {
    if (typeof PassageResolver !== 'undefined') {
      return PassageResolver.resolvePassageForQuestion(bank, q);
    }
    return q.passageId ? LibraryLoader.getPassage(bank, q.passageId) : null;
  }

  function adsMatchingEngine() {
    if (typeof AdsMatching !== 'undefined') return AdsMatching;
    if (typeof ExamBlueprint !== 'undefined' && ExamBlueprint.buildAdsMatchingLesenPart) return ExamBlueprint;
    if (typeof globalThis !== 'undefined' && globalThis.AdsMatching) return globalThis.AdsMatching;
    return null;
  }

  function buildLesenParts(bank, selected) {
    const enriched =
      typeof PassageResolver !== 'undefined'
        ? PassageResolver.enrichQuestionPassageIds(selected)
        : selected;
    const AM = adsMatchingEngine();
    const matchingT3 = enriched.filter((q) => {
      const teil = typeof q.teil === 'string' ? Number(q.teil) : q.teil;
      const type = String(q.type || q.questionType || '').toLowerCase();
      return q.module === 'lesen' && teil === 3 && (type === 'matching' || type === 'match');
    });
    const rest = matchingT3.length ? enriched.filter((q) => !matchingT3.includes(q)) : enriched;
    const parts = [];
    if (matchingT3.length && AM?.buildAdsMatchingLesenPart) {
      parts.push(
        AM.buildAdsMatchingLesenPart(
          {
            teil: 3,
            slotType: 'ads_matching',
            instruction:
              bank.meta?.language === 'de'
                ? 'Lesen Sie die Situationen und die Anzeigen a bis j. Welche Anzeige passt zu welcher Situation?'
                : 'Read the situations and ads a–j. Which ad matches each situation?',
          },
          matchingT3,
          toExamQuestion,
        ),
      );
    }
    const byPassage = {};
    rest.forEach((q) => {
      const pid =
        (typeof PassageResolver !== 'undefined'
          ? PassageResolver.passageIdFromQuestion(q)
          : q.passageId) || 'default';
      if (!byPassage[pid]) byPassage[pid] = [];
      byPassage[pid].push(q);
    });
    let teil = parts.length ? 2 : 1;
    Object.entries(byPassage).forEach(([pid, qs]) => {
      const shared =
        typeof PassageResolver !== 'undefined'
          ? PassageResolver.resolvePassageForQuestions(bank, qs)
          : resolvePassage(bank, qs[0]);
      const part = {
        teil: qs[0].teil || teil,
        instruction: shared
          ? bank.meta.language === 'de'
            ? 'Lesen Sie den Text und beantworten Sie die Fragen.'
            : bank.meta.language === 'es'
              ? 'Lea el texto y responda las preguntas.'
              : 'Read the text and answer the questions.'
          : 'Answer the following questions.',
        questions: qs.map((q, i) => toExamQuestion(q, i)),
      };
      if (shared?.text) {
        part.textTitle = shared.title || '';
        part.text = shared.text;
        part.passageId = shared.id;
        if (shared.translations) part.translations = { ...shared.translations };
      }
      parts.push(part);
      teil++;
    });
    return parts;
  }

  function buildHorenParts(bank, selected) {
    const enriched =
      typeof PassageResolver !== 'undefined'
        ? PassageResolver.enrichQuestionPassageIds(selected)
        : selected;
    const bySegment = {};
    enriched.forEach((q) => {
      const key =
        (typeof PassageResolver !== 'undefined'
          ? PassageResolver.passageIdFromQuestion(q)
          : q.passageId) || q.segmentLabel || 'default';
      if (!bySegment[key]) bySegment[key] = [];
      bySegment[key].push(q);
    });
    const parts = [];
    let teil = 1;
    Object.entries(bySegment).forEach(([key, qs]) => {
      const shared =
        typeof PassageResolver !== 'undefined'
          ? PassageResolver.resolvePassageForQuestions(bank, qs)
          : resolvePassage(bank, qs[0]);
      const transcript = shared?.text || qs[0].transcript || '';
      const part = {
        teil: qs[0].teil || teil,
        instruction:
          bank.meta.language === 'de'
            ? 'Hören Sie die Aufnahme und beantworten Sie die Fragen.'
            : bank.meta.language === 'es'
              ? 'Escuche la grabación y responda las preguntas.'
              : 'Listen to the recording and answer the questions.',
        transcript: transcript || undefined,
        segments: [
          {
            id: `seg_${teil}`,
            label: qs[0].segmentLabel || `Recording ${teil}`,
            transcript,
            passageId: shared?.id,
            questions: qs.map((q, i) => toExamQuestion(q, i)),
            translations: shared?.translations ? { ...shared.translations } : undefined,
          },
        ],
      };
      parts.push(part);
      teil++;
    });
    return parts;
  }

  function collectTopicTags(questions) {
    const tags = new Set();
    questions.forEach((q) => (q.topicTags || []).forEach((t) => tags.add(t)));
    return [...tags];
  }

  function blueprintEngine() {
    if (typeof ExamBlueprint !== 'undefined') return ExamBlueprint;
    if (typeof globalThis !== 'undefined' && globalThis.ExamBlueprint) return globalThis.ExamBlueprint;
    if (typeof window !== 'undefined' && window.ExamBlueprint) return window.ExamBlueprint;
    return null;
  }

  function buildFromBlueprint(lang, level, bank, blueprint, options = {}) {
    const {
      mode = 'standard',
      grammarTags = [],
      topicTags = [],
      targetWords = [],
      skills = ['lesen', 'horen', 'schreiben', 'sprechen'],
      assembled: preAssembled = null,
      difficultyRange = defaultDifficultyRange(level),
      personalizedSplit = null,
      calibration = null,
    } = options;

    const BP = blueprintEngine();
    if (!BP && !preAssembled) throw new Error('ExamBlueprint engine not loaded');

    const tagFilter =
      mode === 'weakness' && (grammarTags.length || topicTags.length)
        ? (q) => questionMatchesTags(q, grammarTags, topicTags)
        : null;

    const assembleOpts = { filter: tagFilter, difficultyRange, calibration, excludeIds: options.excludeIds, applyBurned: options.applyBurned };

    let assembled = preAssembled || BP.assemble(bank, blueprint, assembleOpts);

    if (!preAssembled && tagFilter) {
      const covFirst = BP.coverageSummary(assembled.coverage);
      if (covFirst.ratio < 1) {
        assembled = BP.assemble(bank, blueprint, { filter: null, difficultyRange, calibration, excludeIds: options.excludeIds, applyBurned: options.applyBurned });
        assembled.coverageRelaxed = true;
      }
    }

    if (mode === 'personal' && targetWords.length) {
      const vocabFilter = (q) => questionContainsWords(q, bank, targetWords);
      const vocabAssembled = BP.assemble(bank, blueprint, { ...assembleOpts, filter: vocabFilter });
      if ((vocabAssembled.selected || []).length >= 1) {
        assembled = vocabAssembled;
      }
    }

    let { lesenParts, horenParts, grammatikParts, useOfEnglishParts, schreibenParts, sprechenParts, selected, coverage } = assembled;

    if (!skills.includes('lesen')) lesenParts = [];
    if (!skills.includes('horen')) horenParts = [];
    if (!skills.includes('schreiben')) schreibenParts = [];
    if (!skills.includes('sprechen')) sprechenParts = sprechenParts || [];

    const cert = CERT[lang]?.[level] || { certificate: `${level} Exam`, board: 'Goethe-Institut' };
    const topicTagList = collectTopicTags(selected);
    const cov = BP ? BP.coverageSummary(coverage) : { total: coverage.length, complete: 0, ratio: 0 };
    const topicLabel =
      mode === 'personal'
        ? `Personal: ${targetWords.slice(0, 3).join(', ')}${targetWords.length > 3 ? '…' : ''}`
        : mode === 'personalized'
          ? `Personalized: ${grammarTags.slice(0, 2).join(', ') || topicTags.slice(0, 2).join(', ')}`
          : mode === 'weakness'
            ? `Weakness focus: ${grammarTags.slice(0, 2).join(', ')}`
            : topicTagList[0] || `${cert.certificate} practice`;

    // Normalize schreibenParts: ensure `teil` is always set (source field is `aufgabe`).
    // DESIGN NOTE — Schreiben theme choice: the real Goethe B1 exam offers 2 theme
    // alternatives per Teil 1 and 2. This implementation uses 3 fixed tasks with no
    // choice. This is an intentional simplification for the practice mode; when the
    // bank grows to include paired alternatives, add `alternatives: [taskA, taskB]`
    // to each schreiben slot and update the renderer to show the choice UI.
    (schreibenParts || []).forEach((p, idx) => {
      if (p.teil == null) {
        p.teil = (typeof p.aufgabe === 'number') ? p.aufgabe : idx + 1;
      }
    });

    // Normalize Hören T1 segment labels by position (not source id), in the exam's
    // own language — same wording as ExamBlueprint.buildHorenPart.
    const recWord = lang === 'de' ? 'Aufnahme' : lang === 'es' ? 'Grabación' : 'Recording';
    const h1Part = (horenParts || []).find((p) => p.teil === 1);
    if (h1Part && Array.isArray(h1Part.segments)) {
      h1Part.segments.forEach((seg, idx) => { seg.label = `${recWord} ${idx + 1}`; });
    }

    const exam = {
      topic: topicLabel,
      level,
      lang,
      goetheFormat: true,
      libraryBuilt: true,
      blueprintId: blueprint.id,
      blueprintCoverage: coverage,
      blueprintComplete: cov.ratio >= 1,
      libraryVersion: bank.meta?.version || 1,
      topicTags: topicTagList,
      difficulty: typeof DifficultyScorer !== 'undefined' ? DifficultyScorer.LEVEL_MID[level] || 5 : 5,
      official: {
        board: cert.board,
        certificate: cert.certificate,
        note: 'Assembled from question library using official exam blueprint (no runtime AI).',
      },
      modules: {
        lesen: { title: MODULE_TITLE[lang]?.lesen || 'Lesen', time: MODULE_TIME[lang]?.lesen || '' },
        horen: { title: MODULE_TITLE[lang]?.horen || 'Hören', time: MODULE_TIME[lang]?.horen || '' },
        schreiben: { title: MODULE_TITLE[lang]?.schreiben || 'Schreiben', time: MODULE_TIME[lang]?.schreiben || '' },
        sprechen: { title: MODULE_TITLE[lang]?.sprechen || 'Sprechen', time: MODULE_TIME[lang]?.sprechen || '' },
      },
      lesenParts,
      horenParts,
      schreibenParts,
      sprechenParts: sprechenParts || [],
    };
    if (grammatikParts.length) exam.grammatikParts = grammatikParts;
    if (useOfEnglishParts?.length) exam.useOfEnglishParts = useOfEnglishParts;
    if (personalizedSplit) exam.personalizedSplit = personalizedSplit;
    if (mode === 'personal') exam.vocabPersonal = true;
    if (mode === 'personalized') exam.personalizedExam = true;
    if (options.vocabMatchFound != null) exam.vocabMatchFound = options.vocabMatchFound;
    if (options.vocabMatchCount != null) exam.vocabMatchCount = options.vocabMatchCount;
    if (blueprint.examType === 'cambridge') exam.cambridgeFormat = true;
    if (lang === 'es' && typeof normalizeSpanishExam === 'function') {
      return applyExamDifficulty(annotateCurationNeeds(normalizeSpanishExam(exam), bank, blueprint), bank, lang, level);
    }
    return applyExamDifficulty(annotateCurationNeeds(exam, bank, blueprint), bank, lang, level);
  }

  function build(lang, level, bank, options = {}) {
    const {
      mode = 'standard',
      grammarTags = [],
      topicTags = [],
      targetWords = [],
      skills = ['lesen', 'horen'],
      difficultyRange = null,
    } = options;

    const filter = (q) => {
      if (!questionMatchesTags(q, grammarTags, topicTags)) return false;
      if (difficultyRange && q.difficulty != null) {
        if (q.difficulty < difficultyRange[0] || q.difficulty > difficultyRange[1]) return false;
      }
      return true;
    };

    let lesenPool = LibraryLoader.questionsByModule(bank, 'lesen');
    let horenPool = LibraryLoader.questionsByModule(bank, 'horen');
    {
      const exIds = options.excludeIds;
      const applyBurned = options.applyBurned;
      const notBurned = (q) =>
        !(exIds && exIds.has(q.id)) &&
        !(applyBurned !== false && typeof BurnedRegistry !== 'undefined' && BurnedRegistry.isBankQuestionBurned(bank, q));
      lesenPool = lesenPool.filter(notBurned);
      horenPool = horenPool.filter(notBurned);
    }

    if (mode === 'weakness' && grammarTags.length) {
      const weakLesen = lesenPool.filter((q) => filter(q));
      const weakHoren = horenPool.filter((q) => filter(q));
      if (weakLesen.length) lesenPool = weakLesen;
      if (weakHoren.length) horenPool = weakHoren;
    }

    if (mode === 'personal' && targetWords.length) {
      const vocabLesen = lesenPool.filter((q) => questionContainsWords(q, bank, targetWords));
      const vocabHoren = horenPool.filter((q) => questionContainsWords(q, bank, targetWords));
      if (vocabLesen.length >= 2) lesenPool = vocabLesen;
      if (vocabHoren.length >= 2) horenPool = vocabHoren;
    }

    const lesenCount = Math.max(3, Math.min(6, lesenPool.length));
    const horenCount = Math.max(2, Math.min(4, horenPool.length));

    const lesenSel = skills.includes('lesen') ? pickQuestions(lesenPool, lesenCount, mode === 'standard' ? null : filter) : [];
    const horenSel = skills.includes('horen') ? pickQuestions(horenPool, horenCount, mode === 'standard' ? null : filter) : [];

    const cert = CERT[lang]?.[level] || { certificate: `${level} Exam`, board: 'Official' };
    const topicTagList = collectTopicTags([...lesenSel, ...horenSel]);
    const topicLabel =
      mode === 'personal'
        ? `Personal: ${targetWords.slice(0, 3).join(', ')}${targetWords.length > 3 ? '…' : ''}`
        : mode === 'weakness'
          ? `Weakness focus: ${grammarTags.slice(0, 2).join(', ')}`
          : topicTagList[0] || `${cert.certificate} practice`;

    const exam = {
      topic: topicLabel,
      level,
      lang,
      goetheFormat: true,
      libraryBuilt: true,
      libraryVersion: bank.meta?.version || 1,
      topicTags: topicTagList,
      difficulty: typeof DifficultyScorer !== 'undefined' ? DifficultyScorer.LEVEL_MID[level] || 3 : 3,
      official: {
        board: cert.board,
        certificate: cert.certificate,
        note: 'Assembled from pre-generated question library (no runtime AI).',
      },
      modules: {
        lesen: { title: MODULE_TITLE[lang]?.lesen || 'Reading', time: MODULE_TIME[lang]?.lesen || '' },
        horen: { title: MODULE_TITLE[lang]?.horen || 'Listening', time: MODULE_TIME[lang]?.horen || '' },
      },
      lesenParts: buildLesenParts(bank, lesenSel),
      horenParts: buildHorenParts(bank, horenSel),
    };

    if (mode === 'personal' && targetWords.length && typeof TargetUsage !== 'undefined') {
      exam.targetUsage = TargetUsage.deriveTargetUsage(exam, targetWords);
    }

    if (lang === 'es' && typeof normalizeSpanishExam === 'function') {
      return applyExamDifficulty(annotateCurationNeeds(normalizeSpanishExam(exam), bank, null), bank, lang, level);
    }
    return applyExamDifficulty(annotateCurationNeeds(exam, bank, null), bank, lang, level);
  }

  return { build, buildFromBlueprint, questionContainsWords, questionMatchesTags, defaultDifficultyRange };
})();

if (typeof window !== 'undefined') window.ExamBuilder = ExamBuilder;
if (typeof module !== 'undefined') module.exports = ExamBuilder;
