/**
 * Exam generation source cascade — pool → question library → exam library → AI.
 */
(function (global) {
  var CASCADE_ORDER = ['pool', 'questionLibrary', 'examLibrary'];

  function defaultDeps() {
    return {
      fetchExamFromPool: typeof fetchExamFromPool === 'function' ? fetchExamFromPool : null,
      QuestionLibrary: typeof QuestionLibrary !== 'undefined' ? QuestionLibrary : null,
      ExamLibrary: typeof ExamLibrary !== 'undefined' ? ExamLibrary : null,
      normalizeExam: typeof normalizeExam === 'function' ? normalizeExam : null,
      validateExamCandidate:
        typeof validateExamCandidate === 'function' ? validateExamCandidate : null,
      isExamRenderable: typeof isExamRenderable === 'function' ? isExamRenderable : null,
      lcStrategyBEnabled:
        typeof lcStrategyBEnabled === 'function'
          ? function (opts) {
              return lcStrategyBEnabled(opts);
            }
          : function () {
              return false;
            },
      setLoaderStep: typeof setLoaderStep === 'function' ? setLoaderStep : function () {},
      lcDebug: typeof lcDebug !== 'undefined' ? lcDebug : { warn: function () {} },
    };
  }

  function validateCandidate(raw, deps, opts) {
    if (deps.validateExamCandidate) return deps.validateExamCandidate(raw, opts);
    var normalized = deps.normalizeExam ? deps.normalizeExam(raw) : raw;
    if (!normalized) return { ok: false, normalized: null };
    if (deps.isExamRenderable && !deps.isExamRenderable(normalized)) {
      return { ok: false, normalized: normalized };
    }
    return { ok: true, normalized: normalized };
  }

  async function fromPool(ctx, deps) {
    deps = deps || defaultDeps();
    if (typeof canUsePoolExam === 'function' && !canUsePoolExam()) {
      return null;
    }
    if (!deps.fetchExamFromPool) return null;
    deps.setLoaderStep('Loading curated exam\u2026', 'Finding a matching exam\u2026');
    var seen = ctx.seenIds || [];
    var excludeAttempts = seen.length ? [seen, []] : [[]];
    for (var ei = 0; ei < excludeAttempts.length; ei++) {
      try {
        var pooled = await deps.fetchExamFromPool(ctx.subject, ctx.level, excludeAttempts[ei]);
        if (!pooled || !pooled.found || !pooled.exam) continue;
        if (
          typeof BurnedRegistry !== 'undefined' &&
          BurnedRegistry.examTouchesBurned(pooled.exam) &&
          ei === 0
        ) {
          continue;
        }
        var check = validateCandidate(pooled.exam, deps, { source: 'pool' });
        if (!check.ok) continue;
        return {
          source: 'pool',
          examData: check.normalized,
          topic: pooled.topic || check.normalized.topic || 'Curated exam',
          poolId: pooled.id || null,
          provenance: pooled.exam.provenance || null,
          poolSource: true,
        };
      } catch (err) {
        deps.lcDebug.warn('[exam] pool fetch failed:', err);
      }
    }
    return null;
  }

  async function fromQuestionLibrary(ctx, deps) {
    deps = deps || defaultDeps();
    if (!deps.QuestionLibrary || !deps.QuestionLibrary.hasLibrary(ctx.subject, ctx.level)) {
      return null;
    }
    deps.setLoaderStep('Assembling exam\u2026', 'Building your exam from the question bank\u2026');
    var burnedAttempts = [true, false];
    for (var bi = 0; bi < burnedAttempts.length; bi++) {
      try {
        var raw = await deps.QuestionLibrary.buildExam(ctx.subject, ctx.level, {
          applyBurned: burnedAttempts[bi],
        });
        var check = validateCandidate(raw, deps, { source: 'question-library' });
        if (!check.ok) continue;
        return {
          source: 'question-library',
          examData: check.normalized,
          topic: check.normalized.topic || null,
        };
      } catch (err) {
        deps.lcDebug.warn('[exam] question library build failed:', err);
      }
    }
    return null;
  }

  function toastExamLibraryUnavailable(err, deps) {
    var msg = err && err.message ? err.message : 'Exam library unavailable.';
    if (typeof lcToast === 'function') lcToast(msg, 'warn', 6000);
    else if (typeof notify === 'function') notify(msg, 'warn', 6000);
    deps.lcDebug.warn('[exam] library unavailable:', err);
  }

  async function fromExamLibrary(ctx, deps) {
    deps = deps || defaultDeps();
    if (!deps.ExamLibrary) return null;
    if (typeof deps.ExamLibrary.ensureManifest === 'function') {
      await deps.ExamLibrary.ensureManifest();
    }
    if (!deps.ExamLibrary.hasLibrary(ctx.subject, ctx.level)) {
      return null;
    }
    deps.setLoaderStep('Loading exam\u2026', 'Selecting a prepared exam\u2026');
    var raw;
    var recycled = false;
    try {
      if (
        typeof BurnedRegistry !== 'undefined' &&
        typeof deps.ExamLibrary.pickExamExcluding === 'function'
      ) {
        raw = await deps.ExamLibrary.pickExamExcluding(ctx.subject, ctx.level, function (e) {
          return BurnedRegistry.examTouchesBurned(e);
        });
        if (!raw) {
          // Todos vistos/quemados: reciclamos uno ya visto en vez de dejar al usuario sin examen.
          // La IA NUNCA genera examenes completos; el completo sale siempre del pool/biblioteca.
          raw = await deps.ExamLibrary.pickExam(ctx.subject, ctx.level);
          recycled = true;
        }
      } else {
        raw = await deps.ExamLibrary.pickExam(ctx.subject, ctx.level);
      }
    } catch (err) {
      if (err && err.code === 'exam_library_unavailable') {
        toastExamLibraryUnavailable(err, deps);
        return null;
      }
      throw err;
    }
    if (!raw) return null;
    var normalized = deps.normalizeExam ? deps.normalizeExam(raw) : raw;
    if (!normalized || (deps.isExamRenderable && !deps.isExamRenderable(normalized))) {
      throw new Error('The exam library entry is incomplete.');
    }
    return {
      source: 'library',
      examData: normalized,
      topic: normalized.topic || null,
      recycled: recycled,
    };
  }

  /**
   * Run non-AI sources in fixed order. Returns { status: 'hit', ... } or { status: 'continue' }
   * or { status: 'blocked', message } for Strategy B with genuinely no library.
   */
  async function runExamSourceCascade(ctx, deps) {
    deps = deps || defaultDeps();

    // Published official exams (e.g. de B1): single immutable catalog — skip pool/QL shuffle.
    if (
      deps.ExamLibrary &&
      typeof deps.ExamLibrary.usesPublishedExams === 'function' &&
      deps.ExamLibrary.usesPublishedExams(ctx.subject, ctx.level)
    ) {
      var publishedHit = await fromExamLibrary(ctx, deps);
      if (publishedHit) return { status: 'hit', result: publishedHit };
      return {
        status: 'blocked',
        message:
          'No official published exam is available for this level yet. Try again later or use personalized practice.',
      };
    }

    var poolHit = await fromPool(ctx, deps);
    if (poolHit) return { status: 'hit', result: poolHit };

    var hadLibrary =
      deps.QuestionLibrary &&
      typeof deps.QuestionLibrary.hasLibrary === 'function' &&
      deps.QuestionLibrary.hasLibrary(ctx.subject, ctx.level);

    var qlHit = await fromQuestionLibrary(ctx, deps);
    if (qlHit) return { status: 'hit', result: qlHit };

    var libHit = await fromExamLibrary(ctx, deps);
    if (libHit) return { status: 'hit', result: libHit };

    if (deps.lcStrategyBEnabled({ subject: ctx.subject, level: ctx.level })) {
      if (hadLibrary) {
        return {
          status: 'blocked',
          message:
            'We couldn\u2019t assemble a complete exam right now. Please try again later.',
        };
      }
      return {
        status: 'blocked',
        message:
          'No curated exam is available for this level yet. Personalized vocabulary exams from your flashcards still work.',
      };
    }

    var liveAiOff =
      typeof liveAiDisabled === 'function'
        ? liveAiDisabled(ctx.subject, ctx.level)
        : false;
    if (liveAiOff) {
      return {
        status: 'blocked',
        message:
          'Content is being prepared for this level. Try another language/level or use personalized exams from your flashcards.',
      };
    }

    return { status: 'continue' };
  }

  global.CASCADE_ORDER = CASCADE_ORDER;
  global.fromPool = fromPool;
  global.fromQuestionLibrary = fromQuestionLibrary;
  global.fromExamLibrary = fromExamLibrary;
  global.runExamSourceCascade = runExamSourceCascade;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CASCADE_ORDER: CASCADE_ORDER,
      fromPool: fromPool,
      fromQuestionLibrary: fromQuestionLibrary,
      fromExamLibrary: fromExamLibrary,
      runExamSourceCascade: runExamSourceCascade,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
