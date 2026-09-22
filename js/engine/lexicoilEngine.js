/**
 * LexiCoil Content Engine facade — browser entry point
 */
const LexiCoilEngine = (() => {
  async function buildExamSpec(subject, level, topic, extra) {
    const Domain = window.LexiCoilDomain;
    const KE = window.KnowledgeEngine;
    const lang = Domain.languageFromSubjectCode(subject);
    const provider = { de: 'goethe', en: 'cambridge', es: 'dele' }[subject];
    return KE.buildSpec({
      language: lang,
      level,
      provider,
      contentType: 'Exam',
      topic,
      ...(extra || {}),
    });
  }

  async function generateExam(subject, level, topic, hooks, options) {
    const spec = await buildExamSpec(subject, level, topic, options?.specExtra);
    return window.ExamGenerator.generate(spec, hooks, options);
  }

  async function generateQuickExercise(subject, level, mod, topic, hooks) {
    const Domain = window.LexiCoilDomain;
    const KE = window.KnowledgeEngine;
    const ct = window.ExerciseGenerator.contentTypeForQuickMod(mod);
    const spec = await KE.buildSpec({
      language: Domain.languageFromSubjectCode(subject),
      level,
      contentType: ct,
      topic,
    });
    return window.ExerciseGenerator.generate(spec, hooks, { quickMod: mod });
  }

  async function generatePersonalExam(subject, level, words, skills, hooks, options = {}) {
    const Domain = window.LexiCoilDomain;
    const KE = window.KnowledgeEngine;
    const provider = { de: 'goethe', en: 'cambridge', es: 'dele' }[subject];
    const userVocabRequested = [...(words || [])];
    let targetWords = [...userVocabRequested];
    if (typeof ManualVocab !== 'undefined' && ManualVocab.canonicalizeForGeneration) {
      const canon = await ManualVocab.canonicalizeForGeneration(targetWords, subject, level);
      targetWords = canon.words;
      if (canon.corrections?.length && typeof notify === 'function') {
        const sample = canon.corrections.slice(0, 2).map((c) => `"${c.from}"→"${c.to}"`).join(', ');
        notify(`Spelling corrected for generation: ${sample}${canon.corrections.length > 2 ? '…' : ''}`, 'info', 5000);
      }
      if (canon.excluded?.length && typeof notify === 'function') {
        notify(
          `Words skipped (not in the library): ${canon.excluded.slice(0, 3).join(', ')}${canon.excluded.length > 3 ? '…' : ''}`,
          'warn',
          6000,
        );
      }
    }

    let userVocabMeta = null;
    if (typeof VocabPrefilter !== 'undefined' && VocabPrefilter.classifyUserVocab) {
      userVocabMeta = VocabPrefilter.classifyUserVocab(targetWords, { lang: subject, level });
      targetWords = userVocabMeta.prompted;
      if (userVocabMeta.warnings?.length && typeof notify === 'function') {
        const sample = userVocabMeta.warnings
          .slice(0, 2)
          .map((w) => w.word)
          .join(', ');
        notify(
          `Some words are not in the B1 list (${sample}${userVocabMeta.warnings.length > 2 ? '…' : ''}) — the generator may omit them if they do not fit.`,
          'info',
          7000,
        );
      }
      if (userVocabMeta.excluded?.length && typeof notify === 'function') {
        const sample = userVocabMeta.excluded
          .slice(0, 3)
          .map((e) => `${e.word} (${e.band})`)
          .join(', ');
        notify(
          `Advanced-level words excluded from generation: ${sample}${userVocabMeta.excluded.length > 3 ? '…' : ''}`,
          'warn',
          8000,
        );
      }
    }

    let topic = 'Personal vocabulary review';
    if (options.topic) {
      const canon =
        typeof B1Topics !== 'undefined' && B1Topics.normalizeB1Topic
          ? B1Topics.normalizeB1Topic(options.topic)
          : null;
      if (canon) topic = canon;
      else if (typeof lcDebug !== 'undefined') {
        lcDebug.warn('[personal] invalid B1 topic ignored:', options.topic);
      }
    }

    const skillList = skills || ['lesen'];
    const isGenSuggestionModule = skillList.some((s) =>
      ['schreiben', 'writing', 'sprechen', 'speaking'].includes(String(s).toLowerCase()),
    );

    const spec = await KE.buildSpec({
      language: Domain.languageFromSubjectCode(subject),
      level,
      provider,
      contentType: 'VocabularyExercise',
      targetWords,
      topic,
      skills: skillList,
      vocabPolicy: {
        targetWords,
        preferCoverage: !isGenSuggestionModule,
        maximizeCoverage: false,
        suggestionOnly: isGenSuggestionModule,
      },
      metadata: {
        userVocabRequested,
        userVocabExcluded: userVocabMeta?.excluded || [],
      },
    });
    let blueprint = options.blueprint;
    if (
      !blueprint &&
      typeof ExamBlueprint !== 'undefined' &&
      ExamBlueprint.hasBlueprint?.(subject, level)
    ) {
      try {
        blueprint = await ExamBlueprint.load(subject, level);
      } catch (e) {
        if (typeof lcDebug !== 'undefined') lcDebug.warn('[personal] blueprint load failed:', e);
      }
    }
    if (blueprint) {
      spec.metadata = { ...(spec.metadata || {}), blueprint };
    }
    if (options.teilFilter != null) {
      spec.personalTeilFilter = options.teilFilter;
    }
    if (options.poolServedTeils) {
      spec.poolServedTeils = options.poolServedTeils;
    }
    return window.ExamGenerator.generatePersonal(spec, hooks, { ...options, blueprint });
  }

  async function generateFromSpec(spec, hooks, options) {
    return window.ContentGenerator.generate(spec, hooks, options);
  }

  /** Random exam topic from knowledge/languages/{lang}.json */
  async function pickTopic(subject, level) {
    return window.KnowledgeEngine.pickRandomTopic(subject, level);
  }

  async function listTopics(subject, level) {
    return window.KnowledgeEngine.listTopics(subject, level);
  }

  async function listB1Topics() {
    if (typeof B1Topics !== 'undefined') return [...B1Topics.B1_TOPICS];
    return [];
  }

  return Object.freeze({
    buildExamSpec,
    generateExam,
    generateQuickExercise,
    generatePersonalExam,
    generateFromSpec,
    pickTopic,
    listTopics,
    listB1Topics,
  });
})();

if (typeof window !== 'undefined') window.LexiCoilEngine = LexiCoilEngine;
