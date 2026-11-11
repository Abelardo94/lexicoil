const Auth = (() => {
  const TOKEN_KEY = 'lc_token';
  const GUEST_KEY = 'lc_guest';

  let cloudEnabled = null;
  let localMode = false;
  let supabaseEnabled = false;
  let authConfig = null;
  let authListenerBound = false;

  function isGuest() {
    return localStorage.getItem(GUEST_KEY) === '1';
  }

  function clearGuest() {
    localStorage.removeItem(GUEST_KEY);
  }

  function continueAsGuest() {
    clearGuest();
    localStorage.setItem(GUEST_KEY, '1');
    clearLegacyToken();
    applyUser({
      name: 'Guest',
      email: 'guest@lexicoil.com',
      avatar: 'G',
      plan: 'free',
      pro: false,
      guest: true,
      isAdmin: false,
    });
  }

  function clearLegacyToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  /** @deprecated Do not store JWT in localStorage — HttpOnly cookie is authoritative. Clears legacy token only. */
  function setToken(token) {
    if (!token) clearLegacyToken();
  }

  function authHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    const legacy = getToken();
    if (legacy) h.Authorization = `Bearer ${legacy}`;
    return h;
  }

  function apiFetch(url, options = {}) {
    return fetch(url, {
      credentials: 'include',
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    });
  }

  async function api(path, options = {}) {
    const res = await apiFetch(`/.netlify/functions/${path}`, options);
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty */
    }
    if (res.status === 401 && data.error === 'token_revoked') {
      handleTokenRevoked();
    }
    return { res, data };
  }

  function handleTokenRevoked() {
    clearLegacyToken();
    clearGuest();
    S.user = null;
    S.plan = 'guest';
    localStorage.removeItem('lc_user');
    api('auth-logout', { method: 'POST' }).catch(() => {});
    if (typeof switchTab === 'function') switchTab('login');
    if (typeof showAuthOverlay === 'function') showAuthOverlay();
    if (typeof lcToast === 'function') {
      lcToast('Session expired. Please sign in again.', 'warn');
    }
  }

  async function loadAuthConfig() {
    if (authConfig) return authConfig;
    try {
      const { res, data } = await api('auth-config');
      authConfig = res.ok ? data : { enabled: false };
    } catch {
      authConfig = { enabled: false };
    }
    cloudEnabled = Boolean(authConfig.enabled);
    localMode = !cloudEnabled;
    supabaseEnabled = Boolean(authConfig.supabase);
    return authConfig;
  }

  async function checkCloudAuth() {
    if (cloudEnabled !== null) return cloudEnabled;
    await loadAuthConfig();
    return cloudEnabled;
  }

  function applyUser(user) {
    if (!user) return;
    if (typeof applyUserFromServer === 'function') {
      applyUserFromServer(user);
      return;
    }
    const plan = user.guest
      ? 'guest'
      : user.plan === 'pro_max'
        ? 'pro_max'
        : user.pro || user.plan === 'pro'
          ? 'pro'
          : user.plan || 'free';
    const avatar = (user.name || user.email || '?')[0].toUpperCase();
    const prevAdmin = !!(typeof S !== 'undefined' && S.user && S.user.isAdmin);
    const prevCanEdit =
      typeof S !== 'undefined' && S.user && S.user.canEditContent === true;
    const prevRole = typeof S !== 'undefined' && S.user ? S.user.adminRole : null;
    const isAdmin = user.guest
      ? false
      : user.isAdmin === undefined || user.isAdmin === null
        ? prevAdmin
        : user.isAdmin === true || user.isAdmin === 'true' || user.isAdmin === 1;
    const canEditContent = user.guest
      ? false
      : user.canEditContent === undefined || user.canEditContent === null
        ? prevCanEdit || isAdmin
        : user.canEditContent === true || user.canEditContent === 'true' || user.canEditContent === 1;
    const adminRole =
      user.adminRole !== undefined && user.adminRole !== null
        ? user.adminRole
        : prevRole || (isAdmin ? 'admin' : null);
    saveUser({
      name: user.name || 'User',
      email: user.email,
      avatar,
      plan: user.guest ? 'free' : plan,
      memberSince: user.memberSince || null,
      isAdmin,
      adminRole,
      canEditContent,
    });
    if (typeof S !== 'undefined') S.plan = plan;
    if (typeof applyServerQuota === 'function') {
      applyServerQuota({
        used: user.quota?.used,
        max: user.quota?.max,
        plan,
        aiUsed: user.aiCredits?.used,
        aiMax: user.aiCredits?.max,
        aiRemaining: user.aiCredits?.remaining,
        aiTotalPool: user.aiCredits?.totalPool,
        aiRollover: user.aiCredits?.rollover,
        aiTopups: user.aiCredits?.creditTopups,
        aiTrialActive: user.aiCredits?.trialActive,
      });
    }
    if (typeof applyFreeCombo === 'function') applyFreeCombo(user);
  }

  function pendingComboPayload() {
    if (typeof readRegisterComboFromForm !== 'function') return {};
    const combo = readRegisterComboFromForm();
    return { lang: combo.lang, level: combo.level };
  }

  async function exchangeSupabaseSession(accessToken, comboExtra) {
    const combo = comboExtra || pendingComboPayload();
    const { res, data } = await api('auth-supabase-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken, ...combo }),
    });
    if (!res.ok) throw new Error(mapAuthError(data.error));
    clearGuest();
    clearLegacyToken();
    applyUser(data.user);
    await pullSync();
    const { res: meRes, data: meData } = await api('auth-me');
    if (meRes.ok) applyUser(meData.user);
    return data.user;
  }

  function localSyncSnapshot() {
    const read = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    };
    return {
      flashcards: Array.isArray(S.flashcards) ? S.flashcards : read('lc_fc', []),
      deletedFlashcards: Array.isArray(S.deletedFlashcards) ? S.deletedFlashcards : read('lc_fc_del', []),
      history: Array.isArray(S.history) ? S.history : read('lc_hist', []),
      savedExams: Array.isArray(S.savedExams) ? S.savedExams : read('lc_saved', []),
      deletedSavedExams: Array.isArray(S.deletedSavedExams) ? S.deletedSavedExams : read('lc_saved_del', []),
      savedQuizzes: Array.isArray(S.savedQuizzes) ? S.savedQuizzes : read('lc_saved_quizzes', []),
      deletedSavedQuizzes: Array.isArray(S.deletedSavedQuizzes) ? S.deletedSavedQuizzes : read('lc_saved_quizzes_del', []),
      activityLog: Array.isArray(S.activityLog) ? S.activityLog : read('lc_activity', []),
      studyTime:
        S.studyTime && typeof S.studyTime === 'object'
          ? S.studyTime
          : read('lc_time', typeof ActivityTrack !== 'undefined' ? ActivityTrack.defaultStudyTime() : {}),
      mastery:
        typeof AnalyticsStore !== 'undefined'
          ? AnalyticsStore.exportSnapshot()
          : read('lc_mastery', { profiles: {} }),
      burned:
        typeof BurnedRegistry !== 'undefined'
          ? BurnedRegistry.toPayload()
          : read('lc_burned', { v: 1, keys: [], ids: [] }),
      goals: Array.isArray(S.goals) ? S.goals : read('lc_goals', []),
      activeGoalId: S.activeGoalId || localStorage.getItem('lc_active_goal') || null,
      notebook: S.notebook && typeof S.notebook === 'object' ? S.notebook : read('lc_notes', { tabs: [] }),
      activeSessions:
        typeof exportActiveSessionsForSync === 'function'
          ? exportActiveSessionsForSync()
          : read('lc_active_sessions', {}),
    };
  }

  async function pullSync() {
    if (localMode || isGuest()) return;
    const localBefore = localSyncSnapshot();
    const { res, data } = await api('user-sync');
    if (!res.ok) return;
    const server = data.data || {};
    const merged =
      typeof mergeSyncPayload === 'function'
        ? mergeSyncPayload(localBefore, server)
        : {
            flashcards: Array.isArray(server.flashcards) ? server.flashcards : localBefore.flashcards,
            deletedFlashcards: Array.isArray(server.deletedFlashcards) ? server.deletedFlashcards : localBefore.deletedFlashcards,
            history: Array.isArray(server.history) ? server.history : localBefore.history,
            savedExams: Array.isArray(server.savedExams) ? server.savedExams : localBefore.savedExams,
            deletedSavedExams: Array.isArray(server.deletedSavedExams) ? server.deletedSavedExams : localBefore.deletedSavedExams,
            savedQuizzes: Array.isArray(server.savedQuizzes) ? server.savedQuizzes : localBefore.savedQuizzes,
            deletedSavedQuizzes: Array.isArray(server.deletedSavedQuizzes) ? server.deletedSavedQuizzes : localBefore.deletedSavedQuizzes,
            activityLog: Array.isArray(server.activityLog) ? server.activityLog : localBefore.activityLog,
            studyTime: server.studyTime && typeof server.studyTime === 'object' ? server.studyTime : localBefore.studyTime,
            mastery: server.mastery && typeof server.mastery === 'object' ? server.mastery : localBefore.mastery,
            burned: server.burned && typeof server.burned === 'object' ? server.burned : localBefore.burned,
          };
    S.flashcards = merged.flashcards;
    S.deletedFlashcards = merged.deletedFlashcards || [];
    S.history = merged.history;
    S.savedExams = merged.savedExams;
    S.deletedSavedExams = merged.deletedSavedExams || [];
    S.savedQuizzes = merged.savedQuizzes || [];
    S.deletedSavedQuizzes = merged.deletedSavedQuizzes || [];
    S.activityLog = merged.activityLog || [];
    S.studyTime = merged.studyTime || (typeof ActivityTrack !== 'undefined' ? ActivityTrack.defaultStudyTime() : {});
    if (typeof AnalyticsStore !== 'undefined' && merged.mastery) {
      AnalyticsStore.replaceSnapshot(merged.mastery);
    } else if (merged.mastery) {
      localStorage.setItem('lc_mastery', JSON.stringify(merged.mastery));
    }
    localStorage.setItem('lc_fc', JSON.stringify(S.flashcards));
    localStorage.setItem('lc_fc_del', JSON.stringify(S.deletedFlashcards));
    localStorage.setItem('lc_hist', JSON.stringify(S.history));
    localStorage.setItem('lc_saved', JSON.stringify(S.savedExams));
    localStorage.setItem('lc_saved_del', JSON.stringify(S.deletedSavedExams));
    localStorage.setItem('lc_saved_quizzes', JSON.stringify(S.savedQuizzes));
    localStorage.setItem('lc_saved_quizzes_del', JSON.stringify(S.deletedSavedQuizzes));
    localStorage.setItem('lc_activity', JSON.stringify(S.activityLog));
    localStorage.setItem('lc_time', JSON.stringify(S.studyTime));
    if (merged.burned) { localStorage.setItem('lc_burned', JSON.stringify(merged.burned)); if (typeof S !== 'undefined') S.burned = null; }
    if (Array.isArray(merged.goals)) {
      S.goals = merged.goals;
      localStorage.setItem('lc_goals', JSON.stringify(merged.goals));
    }
    if (merged.activeGoalId) {
      S.activeGoalId = merged.activeGoalId;
      localStorage.setItem('lc_active_goal', merged.activeGoalId);
    }
    if (typeof fixFlashcardLevels === 'function') fixFlashcardLevels();
    if (merged.notebook) {
      S.notebook = merged.notebook;
      localStorage.setItem('lc_notes', JSON.stringify(merged.notebook));
    }
    if (merged.activeSessions && typeof applyActiveSessionsFromSync === 'function') {
      applyActiveSessionsFromSync(merged.activeSessions);
    }
    if (typeof AnalyticsStore !== 'undefined') {
      localStorage.setItem(AnalyticsStore.KEY, JSON.stringify(AnalyticsStore.exportSnapshot()));
    }
    // Apply user preferences from server (translation language, TTS voice)
    const serverPrefs = server.preferences;
    if (serverPrefs) {
      const xlat = Array.isArray(serverPrefs.translationLangs) && serverPrefs.translationLangs[0];
      if (xlat && typeof setVocabUiLang === 'function') {
        setVocabUiLang(xlat);
      } else if (xlat && typeof S !== 'undefined') {
        if (typeof syncUiLangMirrors === 'function') syncUiLangMirrors(xlat);
        else S.fcLang = xlat;
        try { localStorage.setItem('lc_pref_xlat', xlat); localStorage.setItem('lc_ui_lang', xlat); } catch (_) {}
      }
      if (serverPrefs.ttsVoices && typeof setTtsVoicePref === 'function') {
        Object.entries(serverPrefs.ttsVoices || {}).forEach(([lang, voice]) => {
          if (voice) setTtsVoicePref(lang, voice);
        });
      }
    }
    if (typeof updBadges === 'function') updBadges();
    if (typeof updQuotaUI === 'function') updQuotaUI();
    await pushSyncNow();
  }

  const SAVED_EXAM_DATA_SYNC_MAX = 48_000;

  function slimSavedExamsForSync(exams) {
    return (exams || []).map((e) => {
      if (!e || typeof e !== 'object' || !e.data) return e;
      let dataBytes = 0;
      try {
        dataBytes = JSON.stringify(e.data).length;
      } catch (_) {
        dataBytes = SAVED_EXAM_DATA_SYNC_MAX + 1;
      }
      if (dataBytes <= SAVED_EXAM_DATA_SYNC_MAX) return e;
      const { data, ...rest } = e;
      return { ...rest, dataOmitted: true };
    });
  }

  function slimSyncPayloadForPut(data) {
    const src = data && typeof data === 'object' ? data : {};
    return {
      ...src,
      savedExams: slimSavedExamsForSync(src.savedExams),
      activeSessions:
        typeof exportActiveSessionsForSync === 'function'
          ? exportActiveSessionsForSync()
          : src.activeSessions,
    };
  }

  let _pushSyncTimer = null;

  async function pushSyncNow() {
    if (localMode || isGuest()) return;
    const payload = slimSyncPayloadForPut({
      flashcards: S.flashcards,
      deletedFlashcards: S.deletedFlashcards || [],
      history: S.history,
      savedExams: S.savedExams,
      deletedSavedExams: S.deletedSavedExams || [],
      savedQuizzes: S.savedQuizzes || [],
      deletedSavedQuizzes: S.deletedSavedQuizzes || [],
      activityLog: S.activityLog || [],
      studyTime: S.studyTime || {},
      mastery:
        typeof AnalyticsStore !== 'undefined'
          ? AnalyticsStore.exportSnapshot()
          : (() => { try { return JSON.parse(localStorage.getItem('lc_mastery') || '{"profiles":{}}'); } catch (_) { return { profiles: {} }; } })(),
      burned:
        typeof BurnedRegistry !== 'undefined'
          ? BurnedRegistry.toPayload()
          : (() => { try { return JSON.parse(localStorage.getItem('lc_burned') || '{"v":1,"keys":[],"ids":[]}'); } catch (_) { return { v: 1, keys: [], ids: [] }; } })(),
      goals: Array.isArray(S.goals) ? S.goals : [],
      activeGoalId: S.activeGoalId || null,
      notebook: S.notebook && typeof S.notebook === 'object' ? S.notebook : { tabs: [] },
      preferences: {
        translationLangs: [typeof translationLang === 'function' ? translationLang() : S.fcLang || 'en'],
        ttsVoices: (typeof getTtsVoicePref === 'function' && S.subject)
          ? { [S.subject]: getTtsVoicePref(S.subject) }
          : {},
      },
    });
    try {
      let body = JSON.stringify({ data: payload });
      if (body.length > 850_000) {
        payload.savedExams = (payload.savedExams || []).map((e) => {
          if (!e?.data) return e;
          const { data, ...rest } = e;
          return { ...rest, dataOmitted: true };
        });
        body = JSON.stringify({ data: payload });
      }
      await api('user-sync', {
        method: 'PUT',
        headers: authHeaders(),
        body,
      });
    } catch (err) {
      if (typeof lcDebug !== 'undefined') lcDebug.warn('[sync] push failed:', err?.message || err);
    }
  }

  function pushSync() {
    if (localMode || isGuest()) return Promise.resolve();
    if (_pushSyncTimer) clearTimeout(_pushSyncTimer);
    _pushSyncTimer = setTimeout(() => {
      _pushSyncTimer = null;
      void pushSyncNow();
    }, 2000);
    return Promise.resolve();
  }

  async function pushSyncImmediate() {
    if (_pushSyncTimer) {
      clearTimeout(_pushSyncTimer);
      _pushSyncTimer = null;
    }
    await pushSyncNow();
  }

  function isOAuthCallbackUrl() {
    if (typeof window === 'undefined') return false;
    const q = new URLSearchParams(window.location.search);
    return q.has('code') || /access_token|refresh_token/.test(window.location.hash || '');
  }

  async function ensureSupabaseReady() {
    if (!supabaseEnabled || !authConfig) return false;
    await SupabaseAuth.init(authConfig);
    return SupabaseAuth.isReady();
  }

  function setupSupabaseAuthListener() {
    if (authListenerBound || !supabaseEnabled || !SupabaseAuth.isReady()) return;
    authListenerBound = true;
    const sb = SupabaseAuth.getClient();
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        // Ignore passive SIGNED_OUT (e.g. cross-tab storage noise). Auth.logout() clears state.
        return;
      }
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') && session?.access_token) {
        try {
          await exchangeSupabaseSession(session.access_token);
          if (typeof updUserBtn === 'function') updUserBtn();
          if (typeof refreshUserDropdown === 'function') refreshUserDropdown();
          if (typeof restoreAppShellAfterAuth === 'function' && isAppAuthenticated()) {
            const active = typeof getActiveScreenId === 'function' ? getActiveScreenId() : null;
            const ov = document.getElementById('authOverlay');
            const overlayOpen = Boolean(ov && ov.classList.contains('open'));
            if (overlayOpen || !active) restoreAppShellAfterAuth();
            else if (active === 'homeScreen' && typeof renderHomeScreen === 'function') renderHomeScreen();
          }
        } catch {
          /* keep prior token if exchange fails */
        }
      }
    });
  }

  async function waitForSupabaseSession(sb, maxMs = 10000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const { data, error } = await sb.auth.getSession();
      if (error) throw error;
      if (data?.session?.access_token) return data.session;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  function stripOAuthParamsFromUrl() {
    if (typeof window === 'undefined') return;
    try {
      const u = new URL(window.location.href);
      let dirty = false;
      for (const key of ['code', 'error', 'error_description', 'state']) {
        if (u.searchParams.has(key)) {
          u.searchParams.delete(key);
          dirty = true;
        }
      }
      if (/access_token|refresh_token/i.test(u.hash || '')) {
        u.hash = '';
        dirty = true;
      }
      if (dirty) {
        const next = u.pathname + u.search + u.hash;
        window.history.replaceState({}, document.title, next || '/');
      }
    } catch {
      /* ignore */
    }
  }

  async function completeOAuthCallback() {
    if (!isOAuthCallbackUrl()) return false;
    await loadAuthConfig();
    if (!supabaseEnabled) {
      stripOAuthParamsFromUrl();
      throw new Error('Google sign-in is not configured on the server.');
    }
    if (!(await ensureSupabaseReady())) {
      stripOAuthParamsFromUrl();
      throw new Error('Could not connect to Supabase. Refresh and try again.');
    }

    const sb = SupabaseAuth.getClient();
    const params = new URLSearchParams(window.location.search);
    const oauthErr = params.get('error_description') || params.get('error');
    if (oauthErr) {
      stripOAuthParamsFromUrl();
      throw new Error(decodeURIComponent(String(oauthErr).replace(/\+/g, ' ')));
    }

    const code = params.get('code');
    let session = await waitForSupabaseSession(sb, 3000);

    if (!session?.access_token && code) {
      const { data, error } = await sb.auth.exchangeCodeForSession(code);
      if (error) throw new Error(mapSupabaseError(error));
      if (data?.session) session = data.session;
    }
    if (!session?.access_token) {
      session = await waitForSupabaseSession(sb, 10000);
    }
    if (!session?.access_token) {
      stripOAuthParamsFromUrl();
      throw new Error('Session expired or invalid link. Try signing in again.');
    }

    try {
      await exchangeSupabaseSession(session.access_token);
      return true;
    } finally {
      stripOAuthParamsFromUrl();
    }
  }

  async function register(name, email, password) {
    await loadAuthConfig();
    const em = String(email || '').trim().toLowerCase();
    const combo = typeof readRegisterComboFromForm === 'function' ? readRegisterComboFromForm() : null;
    if (combo && typeof savePendingCombo === 'function') savePendingCombo(combo);

    if (supabaseEnabled) {
      if (!(await ensureSupabaseReady())) {
        throw new Error('Supabase auth is unavailable. Refresh the page and try again.');
      }
      const sb = SupabaseAuth.getClient();
      const { data, error } = await sb.auth.signUp({
        email: em,
        password,
        options: {
          data: {
            full_name: String(name || '').trim(),
            free_combo_lang: combo?.lang || 'de',
            free_combo_level: combo?.level || 'B1',
          },
          emailRedirectTo: SupabaseAuth.getEmailRedirectUrl(),
        },
      });
      if (error) throw new Error(mapSupabaseError(error));
      if (data.session?.access_token) {
        await exchangeSupabaseSession(data.session.access_token);
        if (typeof LcAnalytics !== 'undefined') LcAnalytics.trackSignUp();
        return {};
      }
      try {
        await sb.auth.signOut();
      } catch {
        /* ignore */
      }
      return { pendingConfirmation: true, email: em };
    }

    if (localMode) return localRegister(name, email, password);

    const { res, data } = await api('auth-register', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name,
        email: em,
        password,
        lang: combo?.lang,
        level: combo?.level,
      }),
    });
    if (!res.ok) throw new Error(mapAuthError(data.error));
    if (data.pendingConfirmation) {
      return { pendingConfirmation: true, email: data.email || em };
    }
    if (!data.user) throw new Error('Registration failed.');
    clearGuest();
    clearLegacyToken();
    applyUser(data.user);
    await pullSync();
    const { res: meRes, data: meData } = await api('auth-me');
    if (meRes.ok) applyUser(meData.user);
    if (typeof LcAnalytics !== 'undefined') LcAnalytics.trackSignUp();
    return data.user;
  }

  async function login(email, password) {
    await loadAuthConfig();
    const em = String(email || '').trim().toLowerCase();

    if (localMode) return localLogin(email, password);

    // Server-side auth-login handles Netlify Blobs + Supabase (no browser → Supabase fetch).
    const { res, data } = await api('auth-login', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ email: em, password }),
    });
    if (!res.ok) throw new Error(mapAuthError(data.error));
    clearGuest();
    clearLegacyToken();
    applyUser(data.user);
    await pullSync();
    const { res: meRes, data: meData } = await api('auth-me');
    if (meRes.ok) applyUser(meData.user);
    return data.user;
  }

  async function signInWithGoogle() {
    await loadAuthConfig();
    if (!supabaseEnabled) {
      throw new Error('Google sign-in is not configured on the server.');
    }
    if (!(await ensureSupabaseReady())) {
      throw new Error('Could not connect to Supabase. Check your connection and try again.');
    }
    const { error } = await SupabaseAuth.getClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: SupabaseAuth.getOAuthRedirectUrl(),
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) throw error;
  }

  async function resendConfirmationEmail(email) {
    await loadAuthConfig();
    const em = String(email || '').trim().toLowerCase();
    if (!em) throw new Error('Enter your email address.');
    if (!supabaseEnabled) {
      const { res, data } = await api('auth-resend-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: em }),
      });
      if (!res.ok) throw new Error(mapAuthError(data.error));
      return { ok: true };
    }
    if (!(await ensureSupabaseReady())) {
      throw new Error('Supabase auth is unavailable. Refresh the page and try again.');
    }
    const { error } = await SupabaseAuth.getClient().auth.resend({
      type: 'signup',
      email: em,
      options: { emailRedirectTo: SupabaseAuth.getEmailRedirectUrl() },
    });
    if (error) throw new Error(mapSupabaseError(error));
    return { ok: true };
  }

  async function forgotPassword(email) {
    await loadAuthConfig();
    const em = String(email || '').trim().toLowerCase();
    if (!em) throw new Error('Enter your email address.');

    if (supabaseEnabled && SupabaseAuth.isReady()) {
      const sb = SupabaseAuth.getClient();
      const { error } = await sb.auth.resetPasswordForEmail(em, {
        redirectTo: `${SupabaseAuth.getEmailRedirectUrl()}?type=recovery`,
      });
      if (error) throw new Error(mapSupabaseError(error));
      return { ok: true };
    }

    const { res, data } = await api('auth-forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: em }),
    });
    if (!res.ok) throw new Error(mapAuthError(data.error) || 'Could not send reset link.');
    return data;
  }

  function restoreCachedUser() {
    try {
      const raw = localStorage.getItem('lc_user');
      if (!raw) return false;
      const cached = JSON.parse(raw);
      if (!cached?.email) return false;
      applyUser(cached);
      return true;
    } catch {
      return false;
    }
  }

  async function bootstrap() {
    await loadAuthConfig();

    if (!localMode) {
      const { res, data } = await api('auth-me');
      if (res.ok) {
        clearLegacyToken();
        clearGuest();
        applyUser(data.user);
        await pullSync();
        if (supabaseEnabled && (await ensureSupabaseReady())) setupSupabaseAuthListener();
        return true;
      }
      if (res.status === 401 && data.error === 'token_revoked') {
        handleTokenRevoked();
        return false;
      }
      if (res.status !== 401 && restoreCachedUser()) {
        if (supabaseEnabled && (await ensureSupabaseReady())) setupSupabaseAuthListener();
        return true;
      }
    }

    const legacyToken = getToken();
    if (supabaseEnabled && (await ensureSupabaseReady())) {
      setupSupabaseAuthListener();
      const { data } = await SupabaseAuth.getClient().auth.getSession();
      if (data?.session?.access_token) {
        try {
          await exchangeSupabaseSession(data.session.access_token);
          return true;
        } catch {
          if (S.user && restoreCachedUser()) return true;
        }
      }
    }

    if (legacyToken && restoreCachedUser()) {
      if (supabaseEnabled && (await ensureSupabaseReady())) setupSupabaseAuthListener();
      return true;
    }

    if (legacyToken) {
      clearLegacyToken();
      localStorage.removeItem('lc_user');
    }

    if (isGuest()) {
    applyUser({
      name: 'Guest',
      email: 'guest@lexicoil.com',
      avatar: 'G',
      plan: 'free',
      pro: false,
      guest: true,
      isAdmin: false,
    });
      return true;
    }

    if (localMode && S.user) return true;

    S.user = null;
    localStorage.removeItem('lc_user');
    return false;
  }

  function clearLocalUserData() {
    const keys = [
      'lc_user', 'lc_token', 'lc_fc', 'lc_fc_del', 'lc_hist', 'lc_saved', 'lc_saved_del',
      'lc_saved_quizzes', 'lc_saved_quizzes_del', 'lc_activity', 'lc_time', 'lc_mastery',
      'lc_burned', 'lc_goals', 'lc_active_goal', 'lc_notes', 'lc_quota', 'lc_guest', 'lc_demo',
      'lc_pref_xlat', 'lc_ui_lang', 'lc_active_sessions', 'lc_exam_progress_active',
    ];
    keys.forEach((k) => {
      try {
        localStorage.removeItem(k);
      } catch (_) {}
    });
    if (typeof S !== 'undefined') {
      S.user = null;
      S.plan = 'guest';
      S.flashcards = [];
      S.history = [];
      S.savedExams = [];
      S.goals = [];
      S.notebook = { tabs: [] };
      S.activeSessionsByGoal = {};
    }
  }

  async function deleteAccount(confirmPhrase) {
    if (localMode || isGuest()) throw new Error('Sign in to delete your account.');
    const { res, data } = await api('account-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmPhrase }),
    });
    if (!res.ok) {
      const err = new Error(
        data.error === 'confirm_phrase_required'
          ? 'Type DELETE exactly to confirm.'
          : data.error === 'admin_account_protected'
            ? 'Admin accounts cannot be self-deleted.'
            : data.error || 'delete_failed',
      );
      throw err;
    }
    clearLocalUserData();
    await api('auth-logout', { method: 'POST' }).catch(() => {});
    return data;
  }

  async function logout() {
    if (supabaseEnabled && SupabaseAuth.isReady()) {
      try {
        await SupabaseAuth.getClient().auth.signOut({ scope: 'local' });
      } catch {
        /* ignore */
      }
    }
    try {
      await api('auth-logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    clearLegacyToken();
    clearGuest();
    S.user = null;
    S.plan = 'guest';
    localStorage.removeItem('lc_user');
  }

  function hasSession() {
    if (isGuest()) return false;
    return Boolean(S.user && S.user.email && S.user.email !== 'guest@lexicoil.com');
  }

  function mapAuthError(code) {
    const map = {
      email_taken: 'Email already registered.',
      bad_credentials: 'Invalid email or password.',
      email_not_confirmed: 'Please confirm your email before signing in.',
      too_many_registrations: 'Too many accounts created from this network. Try again tomorrow.',
      too_many_attempts: 'Too many attempts — wait 15 minutes.',
      invalid_fields: 'Fill all fields correctly.',
      auth_not_configured: 'Accounts are not configured on the server yet.',
      auth_service_unavailable: 'Sign-in service is temporarily unavailable. Try again in a few minutes, or use "Forgot password" to set a new password.',
      supabase_not_configured: 'Supabase is not configured on the server yet.',
      invalid_supabase_session: 'Session expired. Please sign in again.',
      token_revoked: 'Session expired. Please sign in again.',
    };
    return map[code] || 'Authentication failed.';
  }

  function mapSupabaseError(err) {
    const msg = String(err?.message || '');
    if (/already registered|already exists|user already registered/i.test(msg)) {
      return 'Email already registered.';
    }
    if (/invalid login credentials/i.test(msg)) return 'Invalid email or password.';
    if (/email not confirmed/i.test(msg)) {
      return 'Please confirm your email before signing in.';
    }
    return msg || 'Authentication failed.';
  }

  function localRegister(name, email, password) {
    const u = getUsers();
    const em = email.trim().toLowerCase();
    if (u[em]) throw new Error('Email already registered.');
    u[em] = { nm: name, pw: password, plan: 'free' };
    localStorage.setItem('lc_users', JSON.stringify(u));
    applyUser({ name, email: em, plan: 'free', pro: false, isAdmin: false, freeCombo: readRegisterComboFromForm?.() });
    if (typeof LcAnalytics !== 'undefined') LcAnalytics.trackSignUp();
  }

  function localLogin(email, password) {
    const em = email.trim().toLowerCase();
    const u = getUsers();
    if (!u[em] || u[em].pw !== password) throw new Error('Invalid email or password.');
    applyUser({
      name: u[em].nm,
      email: em,
      plan: u[em].plan || 'free',
      pro: u[em].plan === 'pro' || u[em].plan === 'pro_max',
      isAdmin: false,
    });
  }

  return {
    checkCloudAuth,
    register,
    login,
    signInWithGoogle,
    completeOAuthCallback,
    resendConfirmationEmail,
    forgotPassword,
    bootstrap,
    logout,
    deleteAccount,
    handleTokenRevoked,
    pushSync,
    continueAsGuest,
    clearGuest,
    isGuest,
    hasSession,
    hasToken: () => hasSession() || Boolean(getToken()),
    /** UI-only; admin mutations must still be authorized server-side. */
    isAdmin: () => {
      if (isGuest()) return false;
      if (typeof S === 'undefined' || !S.user) return false;
      const v = S.user.isAdmin;
      return v === true || v === 'true' || v === 1;
    },
    canEditContent: () => {
      if (typeof AdminAccess !== 'undefined' && AdminAccess.canEditContentFromUser) {
        return AdminAccess.canEditContentFromUser(typeof S !== 'undefined' ? S.user : null);
      }
      if (isGuest()) return false;
      if (typeof S === 'undefined' || !S.user) return false;
      if (S.user.canEditContent === true) return true;
      return Auth.isAdmin();
    },
    isFullAdmin: () => {
      if (typeof AdminAccess !== 'undefined' && AdminAccess.isFullAdminFromUser) {
        return AdminAccess.isFullAdminFromUser(typeof S !== 'undefined' ? S.user : null);
      }
      return Auth.isAdmin();
    },
    adminRole: () => {
      if (typeof S === 'undefined' || !S.user) return null;
      return S.user.adminRole || null;
    },
    authHeaders,
    apiFetch,
    isLocalMode: () => localMode,
    usesSupabase: () => supabaseEnabled,
  };
})();

if (typeof window !== 'undefined') {
  window.lcApiFetch = Auth.apiFetch;
  window.lcAuthHeaders = Auth.authHeaders;
}
