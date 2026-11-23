// Saved AI vocabulary quizzes — persist, sync, retake without credits.
(function () {
  const LS_KEY = 'lc_saved_quizzes';
  const LS_DEL_KEY = 'lc_saved_quizzes_del';
  const MAX_QUIZZES = 30;

  function hasState() {
    return typeof S !== 'undefined' && !!S;
  }

  function savedQuizTs(q) {
    return Number(q?.updatedAt) || Number(q?.createdAt) || 0;
  }

  function normLevel(level) {
    return typeof normalizeGoalLevel === 'function'
      ? normalizeGoalLevel(level)
      : String(level || '').trim().toUpperCase();
  }

  function quizMatchesGoal(q, goal) {
    if (!q || !goal) return false;
    if (q.goalId && goal.id && q.goalId === goal.id) return true;
    return q.lang === goal.subject && normLevel(q.level) === normLevel(goal.level);
  }

  function quizzesForGoal(goal) {
    if (!hasState() || !goal) return [];
    return (S.savedQuizzes || [])
      .filter((q) => quizMatchesGoal(q, goal))
      .sort((a, b) => savedQuizTs(b) - savedQuizTs(a));
  }

  function getById(id) {
    if (!hasState() || !id) return null;
    return (S.savedQuizzes || []).find((q) => String(q.id) === String(id)) || null;
  }

  function snapshotWord(fc) {
    if (!fc) return null;
    const word = String(fc.word || '').trim();
    if (!word) return null;
    return {
      id: fc.id || null,
      word,
      gender: fc.gender || '',
      article: fc.article || '',
      type: fc.type || fc.pos || '',
      translations: fc.translations || fc.trans || null,
      sourceLang: fc.sourceLang || fc.lang || '',
    };
  }

  function poolFromSnapshots(saved) {
    const snaps = saved?.wordSnapshots || [];
    const lang = saved?.lang || 'de';
    const level = saved?.level || 'B1';
    return snaps
      .map((s) => {
        const w = String(s.word || '').trim();
        if (!w) return null;
        const key = w.toLowerCase();
        const live = (S.flashcards || []).find(
          (f) =>
            String(f.word || '').trim().toLowerCase() === key &&
            (f.sourceLang || f.lang || '') === (s.sourceLang || lang),
        );
        if (live) return live;
        return {
          id: s.id || `vqsnap_${key}`,
          word: w,
          gender: s.gender,
          article: s.article,
          type: s.type,
          translations: s.translations,
          sourceLang: s.sourceLang || lang,
          profileId: `${lang}_${level}`,
        };
      })
      .filter(Boolean);
  }

  function quizTitle(saved) {
    const langName =
      typeof SubjectMeta !== 'undefined'
        ? SubjectMeta.langName(saved.lang)
        : String(saved.lang || '').toUpperCase();
    const n = saved.questionCount || saved.questions?.length || 0;
    const words = saved.wordCount || saved.wordSnapshots?.length || n;
    return `${words} words · ${saved.level} ${langName} · ${n} questions`;
  }

  function quizMetaLine(saved) {
    const date =
      typeof formatAppDate === 'function'
        ? formatAppDate(saved.createdAt)
        : '';
    const parts = [];
    if (date) parts.push('Created ' + date);
    if (saved.playCount > 0) {
      parts.push(
        saved.playCount === 1
          ? 'Played once'
          : `Played ${saved.playCount} times`,
      );
    }
    if (saved.lastScore != null && saved.questionCount) {
      parts.push(`Last score ${saved.lastScore}/${saved.questionCount}`);
    }
    if (saved.bestScore != null && saved.questionCount) {
      const pct = Math.round((saved.bestScore / saved.questionCount) * 100);
      parts.push(`Best ${pct}%`);
    }
    return parts.join(' · ') || 'Saved quiz';
  }

  function saveQuizzes() {
    if (!hasState()) return;
    const write = () => localStorage.setItem(LS_KEY, JSON.stringify(S.savedQuizzes || []));
    try {
      write();
    } catch (_) {
      const sorted = [...(S.savedQuizzes || [])].sort(
        (a, b) => savedQuizTs(a) - savedQuizTs(b),
      );
      while (sorted.length > 8 && (S.savedQuizzes || []).length > 8) {
        const drop = sorted.shift();
        S.savedQuizzes = S.savedQuizzes.filter((q) => q.id !== drop.id);
      }
      try {
        write();
      } catch (_2) {
        if (typeof lcToast === 'function') {
          lcToast(
            'Could not save quiz — browser storage is full. Delete old saved quizzes.',
            'error',
            6500,
          );
        }
        return;
      }
    }
    if (typeof Auth !== 'undefined' && Auth.pushSync) Auth.pushSync();
  }

  function persistAfterGeneration(opts) {
    if (!hasState()) return null;
    const {
      goal,
      subject,
      level,
      hintLang,
      hintLanguageMode,
      questions,
      pool,
      questionCount,
    } = opts || {};
    if (!Array.isArray(questions) || !questions.length) return null;
    const now = Date.now();
    const id = `vq_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const wordSnapshots = (pool || [])
      .map(snapshotWord)
      .filter(Boolean);
    const entry = {
      id,
      goalId: goal?.id || null,
      lang: subject || goal?.subject || 'de',
      level: normLevel(level || goal?.level || 'B1'),
      hintLang: hintLang || 'en',
      hintLanguageMode: hintLanguageMode || 'interface',
      questions,
      wordSnapshots,
      wordCount: wordSnapshots.length,
      questionCount: questionCount || questions.length,
      createdAt: now,
      updatedAt: now,
      lastPlayedAt: null,
      lastScore: null,
      bestScore: null,
      playCount: 0,
    };
    if (!Array.isArray(S.savedQuizzes)) S.savedQuizzes = [];
    S.savedQuizzes.unshift(entry);
    if (S.savedQuizzes.length > MAX_QUIZZES) {
      S.savedQuizzes = S.savedQuizzes.slice(0, MAX_QUIZZES);
    }
    saveQuizzes();
    refreshSavedQuizzesDom(goal || null);
    return id;
  }

  function recordResult(id, score, total) {
    const q = getById(id);
    if (!q) return;
    const now = Date.now();
    q.lastScore = score;
    q.lastPlayedAt = now;
    q.updatedAt = now;
    q.playCount = (Number(q.playCount) || 0) + 1;
    if (q.bestScore == null || score > q.bestScore) q.bestScore = score;
    saveQuizzes();
    const goal =
      typeof getActiveGoal === 'function' ? getActiveGoal() : null;
    refreshSavedQuizzesDom(goal);
  }

  function deleteSavedQuiz(id) {
    if (!hasState() || !id) return;
    const q = getById(id);
    if (!q) return;
    if (
      !confirm('Remove this saved quiz? You can generate a new one anytime (2 credits).')
    ) {
      return;
    }
    S.savedQuizzes = (S.savedQuizzes || []).filter(
      (x) => String(x.id) !== String(id),
    );
    if (!Array.isArray(S.deletedSavedQuizzes)) S.deletedSavedQuizzes = [];
    S.deletedSavedQuizzes.push({ id: String(id), deletedAt: Date.now() });
    try {
      localStorage.setItem(LS_DEL_KEY, JSON.stringify(S.deletedSavedQuizzes));
    } catch (_) {}
    saveQuizzes();
    const goal =
      typeof getActiveGoal === 'function' ? getActiveGoal() : null;
    refreshSavedQuizzesDom(goal);
    if (typeof refreshVocabHubPanel === 'function') refreshVocabHubPanel();
  }

  function beginRetakeSession(saved, fromVocab) {
    if (!saved?.questions?.length) {
      if (typeof lcToast === 'function') {
        lcToast('This saved quiz has no questions.', 'warn');
      }
      return;
    }
    S.veScore = 0;
    S.veIndex = 0;
    S.veQuestions = saved.questions;
    S.vePool = poolFromSnapshots(saved);
    S.veRetakeQuizId = saved.id;
    S.veSavedQuizId = null;
    // Hint language lives on each saved question; do not change global Interface lang.
    if (typeof setVeHintLangMode === 'function') {
      setVeHintLangMode(saved.hintLanguageMode || 'interface');
    }
    if (typeof _vocabHub !== 'undefined') {
      _vocabHub.veFromVocab = !!fromVocab;
    }
    if (typeof hideAll === 'function') hideAll();
    if (typeof show === 'function') show('vocabExamScreen');
    if (typeof applyVocabExamChrome === 'function') applyVocabExamChrome();
    const titleEl = document.getElementById('veTitle');
    if (titleEl) {
      titleEl.textContent =
        (saved.questionCount || saved.questions.length) + ' questions';
    }
    const lede = document.getElementById('veLede');
    if (lede) {
      const goal =
        typeof getActiveGoal === 'function' ? getActiveGoal() : null;
      const gl = goal ? goalLabel(goal) : quizTitle(saved);
      lede.innerHTML =
        esc(gl) +
        ' · Saved quiz · Retake (no credits)';
    }
    if (typeof ActivityTrack !== 'undefined') {
      ActivityTrack.beginSession(
        'vocab_quiz',
        saved.goalId,
        'Saved vocabulary quiz',
      );
    }
    if (typeof renderVEQ === 'function') renderVEQ();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function retakeSavedQuiz(id, fromVocab) {
    const saved = getById(id);
    if (!saved) {
      if (typeof lcToast === 'function') lcToast('Saved quiz not found.', 'warn');
      return;
    }
    beginRetakeSession(saved, fromVocab);
  }

  function renderCardsHtml(goal, fromVocab) {
    if (!goal) return '';
    const list = quizzesForGoal(goal);
    if (!list.length) return '';
    const retakeFrom = fromVocab !== false;
    return list
      .map((q) => {
        const pct =
          q.bestScore != null && q.questionCount
            ? Math.round((q.bestScore / q.questionCount) * 100)
            : null;
        const scoreBadge =
          pct != null
            ? `<span class="svq-score${pct >= 70 ? ' svq-score--good' : pct >= 50 ? ' svq-score--mid' : ''}">${pct}% best</span>`
            : '';
        return (
          `<article class="svq-card" data-svq-id="${esc(q.id)}">` +
          `<div class="svq-card-main">` +
          `<h4 class="svq-card-title">${esc(quizTitle(q))}</h4>` +
          `<p class="svq-card-meta">${esc(quizMetaLine(q))}</p>` +
          `</div>` +
          `<div class="svq-card-actions">` +
          scoreBadge +
          `<button type="button" class="btn-sm accent" onclick="retakeSavedQuiz('${esc(q.id)}',${retakeFrom})">Retake</button>` +
          `<button type="button" class="btn-sm" onclick="deleteSavedQuiz('${esc(q.id)}')" aria-label="Delete saved quiz">Delete</button>` +
          `</div>` +
          `</article>`
        );
      })
      .join('');
  }

  function renderSavedQuizzesHtml(goal, fromVocab) {
    const cards = renderCardsHtml(goal, fromVocab);
    if (!cards) return '';
    return (
      `<div class="ws-panel vv-saved-quizzes-panel">` +
      `<p class="ws-seclbl">Saved quizzes</p>` +
      `<p class="svq-lede">AI quizzes you generated are saved here — retake anytime without spending credits.</p>` +
      `<div class="svq-list">${cards}</div>` +
      `</div>`
    );
  }

  function refreshSavedQuizzesDom(goal) {
    if (typeof SavedVocabPractice !== 'undefined' && SavedVocabPractice.refreshDom) {
      SavedVocabPractice.refreshDom(goal);
      return;
    }
    if (typeof document === 'undefined') return;
    const g =
      goal ||
      (typeof getActiveGoal === 'function' ? getActiveGoal() : null);
    const hubHtml = g ? renderSavedQuizzesHtml(g, true) : '';
    const deckHtml = g ? renderSavedQuizzesHtml(g, false) : '';
    const hub = document.getElementById('wsPanelVocabulary');
    if (hub && g) {
      const existing = hub.querySelector('.vv-saved-quizzes-panel');
      if (hubHtml) {
        if (existing) existing.outerHTML = hubHtml;
        else hub.insertAdjacentHTML('beforeend', hubHtml);
      } else if (existing) existing.remove();
    }
    const deckEl = document.getElementById('fcSavedQuizzes');
    if (deckEl) {
      deckEl.innerHTML = deckHtml;
    }
  }

  function isSavedQuizTombstoned(q, tombstones) {
    const id = q?.id;
    if (!id) return true;
    const ts = savedQuizTs(q);
    for (const t of tombstones || []) {
      if (String(t.id) === String(id) && Number(t.deletedAt) >= ts) return true;
    }
    return false;
  }

  function mergeSavedQuizzes(local, server, tombstones) {
    const map = new Map();
    for (const q of [...(server || []), ...(local || [])]) {
      if (!q?.id) continue;
      const sid = String(q.id);
      const prev = map.get(sid);
      const ts = savedQuizTs(q);
      const prevTs = prev ? savedQuizTs(prev) : 0;
      if (!prev || ts >= prevTs) map.set(sid, q);
    }
    return [...map.values()]
      .filter((q) => !isSavedQuizTombstoned(q, tombstones))
      .slice(0, MAX_QUIZZES);
  }

  window.SavedVocabQuizzes = {
    LS_KEY,
    LS_DEL_KEY,
    MAX_QUIZZES,
    savedQuizTs,
    quizMatchesGoal,
    quizzesForGoal,
    getById,
    persistAfterGeneration,
    recordResult,
    deleteSavedQuiz,
    retakeSavedQuiz,
    renderSavedQuizzesHtml,
    renderCardsHtml,
    refreshSavedQuizzesDom,
    mergeSavedQuizzes,
    isSavedQuizTombstoned,
  };
  window.retakeSavedQuiz = retakeSavedQuiz;
  window.deleteSavedQuiz = deleteSavedQuiz;
})();
