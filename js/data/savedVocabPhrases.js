// Saved AI phrase sets — persist locally, replay gap + order without credits.
(function () {
  const LS_KEY = 'lc_saved_phrases';
  const LS_DEL_KEY = 'lc_saved_phrases_del';
  const MAX_SETS = 25;

  function hasState() {
    return typeof S !== 'undefined' && !!S;
  }

  function ts(entry) {
    return Number(entry?.updatedAt) || Number(entry?.createdAt) || 0;
  }

  function normLevel(level) {
    return typeof normalizeGoalLevel === 'function'
      ? normalizeGoalLevel(level)
      : String(level || '').trim().toUpperCase();
  }

  function matchesGoal(entry, goal) {
    if (!entry || !goal) return false;
    if (entry.goalId && goal.id && entry.goalId === goal.id) return true;
    return entry.lang === goal.subject && normLevel(entry.level) === normLevel(goal.level);
  }

  function forGoal(goal) {
    if (!hasState() || !goal) return [];
    return (S.savedPhrases || [])
      .filter((e) => matchesGoal(e, goal))
      .sort((a, b) => ts(b) - ts(a));
  }

  function getById(id) {
    if (!hasState() || !id) return null;
    return (S.savedPhrases || []).find((e) => String(e.id) === String(id)) || null;
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
      translations: fc.translations || null,
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
          id: s.id || `vpsnap_${key}`,
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

  function title(saved) {
    const n = saved.phraseCount || saved.phrases?.length || 0;
    const words = saved.wordCount || saved.wordSnapshots?.length || n;
    const langName =
      typeof SubjectMeta !== 'undefined'
        ? SubjectMeta.langName(saved.lang)
        : String(saved.lang || '').toUpperCase();
    return `${words} words · ${saved.level} ${langName} · ${n} phrases`;
  }

  function metaLine(saved) {
    const date =
      typeof formatAppDate === 'function' ? formatAppDate(saved.createdAt) : '';
    const parts = [];
    if (date) parts.push('Created ' + date);
    if (saved.playCount > 0) {
      parts.push(
        saved.playCount === 1 ? 'Played once' : `Played ${saved.playCount} times`,
      );
    }
    if (saved.lastScore != null) {
      parts.push(`Last ${saved.lastScore}%`);
    }
    if (saved.bestScore != null) {
      parts.push(`Best ${saved.bestScore}%`);
    }
    return parts.join(' · ') || 'Saved phrases';
  }

  function saveAll() {
    if (!hasState()) return;
    const write = () => localStorage.setItem(LS_KEY, JSON.stringify(S.savedPhrases || []));
    try {
      write();
    } catch (_) {
      const sorted = [...(S.savedPhrases || [])].sort((a, b) => ts(a) - ts(b));
      while (sorted.length > 6 && (S.savedPhrases || []).length > 6) {
        const drop = sorted.shift();
        S.savedPhrases = S.savedPhrases.filter((e) => e.id !== drop.id);
      }
      try {
        write();
      } catch (_2) {
        if (typeof lcToast === 'function') {
          lcToast('Could not save phrases — storage full. Delete old saved sets.', 'error', 6500);
        }
      }
    }
    if (typeof Auth !== 'undefined' && Auth.pushSync) Auth.pushSync();
  }

  function persistAfterGeneration(opts) {
    if (!hasState()) return null;
    const { goal, subject, level, uiLang, phrases, pool } = opts || {};
    if (!Array.isArray(phrases) || !phrases.length) return null;
    const now = Date.now();
    const id = `vp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const wordSnapshots = (pool || []).map(snapshotWord).filter(Boolean);
    const entry = {
      id,
      goalId: goal?.id || null,
      lang: subject || goal?.subject || 'de',
      level: normLevel(level || goal?.level || 'B1'),
      uiLang: uiLang || 'en',
      phrases,
      wordSnapshots,
      wordCount: wordSnapshots.length,
      phraseCount: phrases.length,
      createdAt: now,
      updatedAt: now,
      lastPlayedAt: null,
      lastScore: null,
      bestScore: null,
      playCount: 0,
    };
    if (!Array.isArray(S.savedPhrases)) S.savedPhrases = [];
    S.savedPhrases.unshift(entry);
    if (S.savedPhrases.length > MAX_SETS) {
      S.savedPhrases = S.savedPhrases.slice(0, MAX_SETS);
    }
    saveAll();
    if (typeof SavedVocabPractice !== 'undefined') SavedVocabPractice.refreshDom(goal || null);
    return id;
  }

  function recordResult(id, scorePct) {
    const e = getById(id);
    if (!e) return;
    const now = Date.now();
    const pct = Math.max(0, Math.min(100, Math.round(Number(scorePct) || 0)));
    e.lastScore = pct;
    e.lastPlayedAt = now;
    e.updatedAt = now;
    e.playCount = (Number(e.playCount) || 0) + 1;
    if (e.bestScore == null || pct > e.bestScore) e.bestScore = pct;
    saveAll();
    const goal = typeof getActiveGoal === 'function' ? getActiveGoal() : null;
    if (typeof SavedVocabPractice !== 'undefined') SavedVocabPractice.refreshDom(goal);
  }

  function deleteSaved(id) {
    if (!hasState() || !id) return;
    if (!confirm('Remove this saved phrase set? Generate a new one anytime (1 credit).')) return;
    S.savedPhrases = (S.savedPhrases || []).filter((x) => String(x.id) !== String(id));
    if (!Array.isArray(S.deletedSavedPhrases)) S.deletedSavedPhrases = [];
    S.deletedSavedPhrases.push({ id: String(id), deletedAt: Date.now() });
    try {
      localStorage.setItem(LS_DEL_KEY, JSON.stringify(S.deletedSavedPhrases));
    } catch (_) {}
    saveAll();
    const goal = typeof getActiveGoal === 'function' ? getActiveGoal() : null;
    if (typeof SavedVocabPractice !== 'undefined') SavedVocabPractice.refreshDom(goal);
    if (typeof refreshVocabHubPanel === 'function') refreshVocabHubPanel();
  }

  function beginRetakeSession(saved, fromVocab) {
    if (!saved?.phrases?.length) {
      if (typeof lcToast === 'function') lcToast('This saved set has no phrases.', 'warn');
      return;
    }
    S.vpPhrases = saved.phrases;
    S.vpPool = poolFromSnapshots(saved);
    S.vpIndex = 0;
    S.vpPhase = 'gap';
    S.vpScore = 0;
    S.vpGapScore = 0;
    S.vpOrderScore = 0;
    S.vpFromVocab = !!fromVocab;
    S.vpRetakePhraseId = saved.id;
    S.vpSavedPhraseSetId = null;
    S.vpActivityWords = null;
    // Phrase content carries its own language; do not change global Interface lang on retake.
    if (typeof hideAll === 'function') hideAll();
    if (typeof show === 'function') show('vocabPhrasesScreen');
    if (typeof applyVocabPhrasesChrome === 'function') applyVocabPhrasesChrome();
    const vt = typeof vocabT === 'function' ? vocabT() : null;
    const lede = document.getElementById('vpLede');
    if (lede) {
      const goal = typeof getActiveGoal === 'function' ? getActiveGoal() : null;
      const gl = goal && typeof goalLabel === 'function' ? goalLabel(goal) : title(saved);
      lede.textContent = gl + ' · Saved phrases · Replay (no credits)';
    }
    if (typeof ActivityTrack !== 'undefined') {
      ActivityTrack.beginSession('vocab_phrases', saved.goalId, 'Saved phrase practice');
    }
    if (typeof renderVpPhrase === 'function') renderVpPhrase();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function retakeSaved(id, fromVocab) {
    const saved = getById(id);
    if (!saved) {
      if (typeof lcToast === 'function') lcToast('Saved phrase set not found.', 'warn');
      return;
    }
    beginRetakeSession(saved, fromVocab);
  }

  function renderCardsHtml(goal, fromVocab) {
    if (!goal) return '';
    const list = forGoal(goal);
    if (!list.length) return '';
    const retakeFrom = fromVocab !== false;
    return list
      .map((e) => {
        const pct = e.bestScore != null ? e.bestScore : null;
        const scoreBadge =
          pct != null
            ? `<span class="svq-score${pct >= 70 ? ' svq-score--good' : pct >= 50 ? ' svq-score--mid' : ''}">${pct}% best</span>`
            : '';
        return (
          `<article class="svq-card" data-vps-id="${esc(e.id)}">` +
          `<div class="svq-card-main">` +
          `<h4 class="svq-card-title">${esc(title(e))}</h4>` +
          `<p class="svq-card-meta">${esc(metaLine(e))}</p>` +
          `</div>` +
          `<div class="svq-card-actions">` +
          scoreBadge +
          `<button type="button" class="btn-sm accent" onclick="retakeSavedPhrases('${esc(e.id)}',${retakeFrom})">Replay</button>` +
          `<button type="button" class="btn-sm" onclick="deleteSavedPhrases('${esc(e.id)}')" aria-label="Delete">Delete</button>` +
          `</div>` +
          `</article>`
        );
      })
      .join('');
  }

  window.SavedVocabPhrases = {
    LS_KEY,
    MAX_SETS,
    forGoal,
    getById,
    persistAfterGeneration,
    recordResult,
    deleteSaved,
    retakeSaved,
    renderCardsHtml,
    title,
  };
  window.retakeSavedPhrases = retakeSaved;
  window.deleteSavedPhrases = deleteSaved;
})();
