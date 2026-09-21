/**
 * Level UI status — exam availability manifest (primary) + question bank / live-AI fallback.
 */
const LevelAvailability = (() => {
  const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const LANGS = ['de', 'en', 'es'];
  const EXAM_AVAIL_PATH = 'data/exams/availability.json';

  /** Combos where full AI exam generation is enabled without a servable question bank. */
  const LIVE_AI_ALLOWLIST = Object.freeze({
    de: [],
    en: [],
    es: [],
  });

  let examAvailCache = null;

  /** Mirrors ExamLibrary.betaLevelsOptIn — see there for why localStorage is used. */
  function betaLevelsOptIn() {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('lc_show_beta') === '1';
    } catch (_) {
      return false;
    }
  }

  function showBetaExamLevels() {
    if (typeof ExamLibrary !== 'undefined' && ExamLibrary.showBetaLevels) {
      return ExamLibrary.showBetaLevels();
    }
    if (typeof window !== 'undefined' && window.LEXICOIL_SHOW_BETA_LEVELS === true) return true;
    if (betaLevelsOptIn()) return true;
    if (typeof process !== 'undefined' && process.env && process.env.LEXICOIL_SHOW_BETA_LEVELS === '1') {
      return true;
    }
    return false;
  }

  function loadExamAvailabilitySync() {
    if (examAvailCache) return examAvailCache;
    if (typeof ExamLibrary !== 'undefined' && ExamLibrary.getManifestSync) {
      examAvailCache = ExamLibrary.getManifestSync();
      if (examAvailCache) return examAvailCache;
    }
    if (typeof module !== 'undefined') {
      try {
        const fs = require('fs');
        const path = require('path');
        const p = path.join(process.cwd(), EXAM_AVAIL_PATH);
        if (fs.existsSync(p)) {
          examAvailCache = JSON.parse(fs.readFileSync(p, 'utf8'));
          return examAvailCache;
        }
      } catch (_) {}
    }
    return null;
  }

  function getExamAvailabilityEntry(lang, level) {
    const manifest = loadExamAvailabilitySync();
    if (!manifest) return null;
    return manifest[lang]?.[level] || null;
  }

  /**
   * Whether AI personalized generation (flashcards / section practice) is enabled for a level.
   * Reads data/exams/availability.json — defaults to true when flag omitted (B1-safe).
   * To enable A2 personalized later: set de.A2.personalized to true in availability.json.
   */
  function isPersonalizedAllowed(lang, level) {
    const entry = getExamAvailabilityEntry(lang, level);
    if (!entry) return true;
    if (entry.personalized === false) return false;
    return true;
  }

  function personalizedUnavailableMessage(lang, level) {
    const lv = String(level || '').toUpperCase();
    return `Personalized practice for ${lv} is coming soon — use official and practice exams for now.`;
  }

  function levelFeatureFlag(lang, level, key, defaultValue) {
    const entry = getExamAvailabilityEntry(lang, level);
    if (!entry || entry[key] === undefined) return defaultValue;
    return entry[key];
  }

  function isQuickModuleAllowed(lang, level) {
    return levelFeatureFlag(lang, level, 'quickModules', true) !== false;
  }

  function isAiFeatureAllowed(lang, level) {
    return levelFeatureFlag(lang, level, 'aiFeatures', true) !== false;
  }

  function poolPreviewLimitFor(lang, level) {
    const entry = getExamAvailabilityEntry(lang, level);
    if (entry?.poolPreview == null) return null;
    const n = Number(entry.poolPreview);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function quickModulesUnavailableMessage(lang, level) {
    const lv = String(level || '').toUpperCase();
    return `Quick modules for ${lv} are coming soon — use official or practice exams for now.`;
  }

  function getExamAvailabilityStatus(lang, level) {
    const manifest = loadExamAvailabilitySync();
    if (!manifest) return null;
    return manifest[lang]?.[level]?.status || 'hidden';
  }

  function isExamLevelOffered(lang, level) {
    const st = getExamAvailabilityStatus(lang, level);
    if (st === 'live') return true;
    if (st === 'beta' && showBetaExamLevels()) return true;
    return false;
  }

  function globalLiveAiKillSwitch() {
    if (typeof window !== 'undefined') {
      if (window.LC_DISABLE_LIVE_AI === false) return false;
      if (window.LC_DISABLE_LIVE_AI === true) return true;
    }
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.LC_DISABLE_LIVE_AI === '0') return false;
      if (process.env.LC_DISABLE_LIVE_AI === '1') return true;
    }
    return false;
  }

  function isLiveAiAllowed(lang, level) {
    if (!lang || !level) return false;
    const list = LIVE_AI_ALLOWLIST[lang];
    return Array.isArray(list) && list.includes(level);
  }

  function isLiveAiEnabled(lang, level) {
    if (globalLiveAiKillSwitch()) return false;
    return isLiveAiAllowed(lang, level);
  }

  function isServableFromProbe(lang, level) {
    if (typeof LibraryLoader !== 'undefined') {
      if (typeof LibraryLoader.getServabilityReport === 'function') {
        const report = LibraryLoader.getServabilityReport(lang, level);
        if (report) return !!report.servable;
      }
      if (typeof LibraryLoader.hasLibrary === 'function') {
        const probed =
          typeof LibraryLoader.probeLevel === 'function' &&
          LibraryLoader.AVAIL &&
          LibraryLoader.AVAIL[`${lang}_${level}`] !== undefined;
        if (probed) return LibraryLoader.hasLibrary(lang, level);
      }
    }
    return null;
  }

  function isServableFromDisk(lang, level) {
    if (typeof module === 'undefined') return false;
    try {
      const fs = require('fs');
      const path = require('path');
      const ContentServable = require('./contentServable.js');
      const LibraryCatalog = require('./libraryCatalog.js');
      const root = process.cwd();
      const base = path.join(root, 'library', lang, level);
      const qPath = path.join(base, 'questions.json');
      if (!fs.existsSync(qPath)) return false;
      const questionsBank = JSON.parse(fs.readFileSync(qPath, 'utf8'));
      const passagesPath = path.join(base, 'passages.json');
      const wsPath = path.join(base, 'writing-speaking.json');
      const passagesFile = fs.existsSync(passagesPath)
        ? JSON.parse(fs.readFileSync(passagesPath, 'utf8'))
        : null;
      const wsFile = fs.existsSync(wsPath) ? JSON.parse(fs.readFileSync(wsPath, 'utf8')) : null;
      const bpId = LibraryCatalog.blueprintId(lang, level);
      const bpPath = bpId ? path.join(root, 'library/blueprints', `${bpId}.json`) : null;
      const blueprint = bpPath && fs.existsSync(bpPath) ? JSON.parse(fs.readFileSync(bpPath, 'utf8')) : null;
      ContentServable.loadThresholdsSync(fs.readFileSync, root);
      const passages = ContentServable.mergePassages(questionsBank.passages, passagesFile?.passages);
      return ContentServable.assessLevel({
        lang,
        level,
        questions: questionsBank.questions,
        passages,
        writingSpeaking: wsFile || { writing: [], speaking: [] },
        blueprint,
      }).servable;
    } catch (_) {
      return false;
    }
  }

  function isLevelServable(lang, level) {
    const probed = isServableFromProbe(lang, level);
    if (probed !== null) return probed;
    return isServableFromDisk(lang, level);
  }

  /**
   * @returns {'ready'|'live'|'soon'}
   */
  function getLevelUiStatus(lang, level) {
    const manifest = loadExamAvailabilitySync();
    if (manifest) {
      const examSt = manifest[lang]?.[level]?.status || 'hidden';
      if (examSt === 'live') return 'ready';
      if (examSt === 'beta' && showBetaExamLevels()) return 'ready';
      return 'soon';
    }
    if (isLevelServable(lang, level)) return 'ready';
    if (isLiveAiEnabled(lang, level)) return 'live';
    return 'soon';
  }

  function isLevelSelectable(lang, level) {
    return getLevelUiStatus(lang, level) !== 'soon';
  }

  function advertisedLevels(lang) {
    if (typeof LibraryCatalog !== 'undefined' && LibraryCatalog.advertisedLevels) {
      return LibraryCatalog.advertisedLevels(lang);
    }
    return [...LEVELS];
  }

  function selectableLevels(lang) {
    return advertisedLevels(lang).filter((level) => isLevelSelectable(lang, level));
  }

  function firstSelectableLevel(lang) {
    const sel = selectableLevels(lang);
    return sel[0] || advertisedLevels(lang)[0] || 'B1';
  }

  function liveAiDisabled(lang, level) {
    return !isLiveAiEnabled(lang, level);
  }

  function levelBadgeHtml(status) {
    if (status === 'soon') {
      const label = 'Coming soon';
      return `<span class="exam-config-badge exam-config-badge--soon">${label}</span>`;
    }
    if (status === 'live') {
      return '<span class="exam-config-badge exam-config-badge--ready">AI</span>';
    }
    const label = 'Ready';
    return `<span class="exam-config-badge exam-config-badge--ready">${label}</span>`;
  }

  return {
    LEVELS,
    LANGS,
    LIVE_AI_ALLOWLIST,
    EXAM_AVAIL_PATH,
    showBetaExamLevels,
    getExamAvailabilityStatus,
    getExamAvailabilityEntry,
    isPersonalizedAllowed,
    personalizedUnavailableMessage,
    isQuickModuleAllowed,
    isAiFeatureAllowed,
    poolPreviewLimitFor,
    quickModulesUnavailableMessage,
    isExamLevelOffered,
    isLiveAiAllowed,
    isLiveAiEnabled,
    isLevelServable,
    getLevelUiStatus,
    isLevelSelectable,
    advertisedLevels,
    selectableLevels,
    firstSelectableLevel,
    liveAiDisabled,
    levelBadgeHtml,
  };
})();

if (typeof window !== 'undefined') window.LevelAvailability = LevelAvailability;
if (typeof window !== 'undefined') {
  window.isPersonalizedAllowed = function (lang, level) {
    return LevelAvailability.isPersonalizedAllowed(lang, level);
  };
  window.isQuickModuleAllowed = function (lang, level) {
    return LevelAvailability.isQuickModuleAllowed(lang, level);
  };
  window.isAiFeatureAllowed = function (lang, level) {
    return LevelAvailability.isAiFeatureAllowed(lang, level);
  };
}
if (typeof module !== 'undefined') module.exports = LevelAvailability;
