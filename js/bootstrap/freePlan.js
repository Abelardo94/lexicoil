/** Free plan — one certification combo, 5 official mocks/month. */
(function (global) {
  const LS_COMBO = 'lc_pending_combo';
  const DEFAULT = { lang: 'de', level: 'B1' };

  function isGuest() {
    return typeof Auth !== 'undefined' && Auth.isGuest && Auth.isGuest();
  }

  function isFreeAccount() {
    return typeof S !== 'undefined' && S.plan === 'free' && !isGuest();
  }

  function normalizeCombo(raw) {
    const lang = String(raw?.lang || raw?.subject || '').trim().toLowerCase();
    const level = String(raw?.level || '').trim().toUpperCase();
    if (['de', 'en', 'es'].includes(lang) && ['A2', 'B1', 'B2', 'C1'].includes(level)) {
      return { lang, level };
    }
    return { ...DEFAULT };
  }

  function comboLabel(combo) {
    const c = normalizeCombo(combo);
    if (typeof ExamProfile !== 'undefined') return ExamProfile.certLabel(c.lang, c.level);
    if (c.lang === 'de') return `Goethe ${c.level}`;
    if (c.lang === 'es') return `DELE ${c.level}`;
    return `Cambridge ${c.level}`;
  }

  function getFreeCombo() {
    if (typeof S !== 'undefined' && S.freeCombo) return normalizeCombo(S.freeCombo);
    return null;
  }

  function readPendingCombo() {
    try {
      const raw = localStorage.getItem(LS_COMBO);
      if (!raw) return null;
      return normalizeCombo(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  function savePendingCombo(combo) {
    localStorage.setItem(LS_COMBO, JSON.stringify(normalizeCombo(combo)));
  }

  function clearPendingCombo() {
    localStorage.removeItem(LS_COMBO);
  }

  function readRegisterComboFromForm() {
    const certEl = document.getElementById('rCert');
    const levelEl = document.getElementById('rLevel');
    if (certEl && levelEl) {
      return normalizeCombo({ lang: certEl.value, level: levelEl.value });
    }
    const active =
      typeof ExamProfile !== 'undefined' ? ExamProfile.getActive() : null;
    if (active) return normalizeCombo({ lang: active.subject, level: active.level });
    return readPendingCombo() || { ...DEFAULT };
  }

  function lockProfilesToCombo(combo) {
    if (typeof ExamProfile === 'undefined') return;
    const c = normalizeCombo(combo);
    const id = `${c.lang}_${c.level}`;
    const profile = {
      id,
      subject: c.lang,
      level: c.level,
      label: comboLabel(c),
      createdAt: Date.now(),
    };
    localStorage.setItem('lc_profiles', JSON.stringify([profile]));
    localStorage.setItem('lc_active_profile', id);
    localStorage.setItem('lc_goal', JSON.stringify({ subject: c.lang, level: c.level }));
    if (typeof S !== 'undefined') {
      S.subject = c.lang;
      S.level = c.level;
    }
    if (typeof renderProfileBar === 'function') renderProfileBar();
  }

  function applyFreeCombo(user) {
    if (!user || user.guest || user.pro || user.plan === 'pro') {
      if (typeof S !== 'undefined') S.freeCombo = null;
      return;
    }
    const combo = normalizeCombo(user.freeCombo || readPendingCombo() || DEFAULT);
    if (typeof S !== 'undefined') S.freeCombo = combo;
    lockProfilesToCombo(combo);
    clearPendingCombo();
  }

  function canAccessCombo(lang, level) {
    if (!isFreeAccount()) return true;
    const fc = getFreeCombo() || DEFAULT;
    return fc.lang === lang && fc.level === level;
  }

  function requireProForCombo(lang, level, opts) {
    if (canAccessCombo(lang, level)) return true;
    const msg =
      (opts && opts.message) ||
      `Free accounts include one certification (${comboLabel(getFreeCombo())}). Upgrade to Pro for all languages and levels.`;
    if (typeof notify === 'function') notify(msg, 'warn', 6000);
    else if (typeof lcToast === 'function') lcToast(msg, 'warn', 6000);
    if (typeof showUpgrade === 'function') showUpgrade();
    return false;
  }

  global.FREE_COMBO_DEFAULT = DEFAULT;
  global.readRegisterComboFromForm = readRegisterComboFromForm;
  global.savePendingCombo = savePendingCombo;
  global.clearPendingCombo = clearPendingCombo;
  global.applyFreeCombo = applyFreeCombo;
  global.isFreeAccount = isFreeAccount;
  global.getFreeCombo = getFreeCombo;
  global.canAccessCombo = canAccessCombo;
  global.requireProForCombo = requireProForCombo;
  global.freeComboLabel = comboLabel;
})(typeof window !== 'undefined' ? window : globalThis);
