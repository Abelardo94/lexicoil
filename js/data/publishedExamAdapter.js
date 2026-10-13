/**
 * Load published_exam docs and adapt snapshot payloads → Goethe exam shape (lesenParts, …).
 * Mirrors scripts/audit-pass-2.mjs partRecordToExamPart for browser use.
 */
(function (global) {
  var SUPPORTED = { de: { B1: true, A2: true } };

  function catalogPath(lang, level) {
    return (
      'library/published-exams/' +
      String(lang).toLowerCase() +
      '/' +
      String(level).toUpperCase() +
      '/_catalog.json'
    );
  }

  function examPath(lang, level, examId) {
    return (
      'library/published-exams/' +
      String(lang).toLowerCase() +
      '/' +
      String(level).toUpperCase() +
      '/' +
      examId +
      '.json'
    );
  }

  function supports(subject, level) {
    return !!(SUPPORTED[subject] && SUPPORTED[subject][level]);
  }

  function normPartType(t) {
    var s = String(t || '').toLowerCase();
    if (s === 'multiple' || s === 'mcq') return 'multiple_choice';
    if (s === 'matching' || s === 'ads_matching') return 'matching';
    if (s === 'ja_nein' || s === 'yes_no') return 'ja_nein';
    if (s === 'richtig_falsch' || s === 'true_false') return 'richtig_falsch';
    return t || 'multiple_choice';
  }

  function normPartQuestion(q, module, teil) {
    var correct = q.correct != null ? q.correct : q.correctAnswer;
    return Object.assign({}, q, {
      module: module,
      teil: teil,
      type: normPartType(q.type || q.questionType),
      correct: correct,
      correctAnswer: correct,
      question: q.question || q.signText || q.statement || '',
    });
  }

  function isForumOpinionsRecord(record) {
    var instr = String(record.instruction || '').toLowerCase();
    if (/meinungen.*(?:20|21)|ja oder nein|stimmt die person/i.test(instr)) return true;
    return (record.questions || []).some(function (q) {
      var c = String(q.correct != null ? q.correct : q.correctAnswer || '').trim();
      return (q.signText || q.text) && /^(j|n|ja|nein|yes|no)$/i.test(c);
    });
  }

  function mapForumOpinionItem(q, i, module, teil) {
    var correct = q.correct != null ? q.correct : q.correctAnswer;
    var signText = q.signText || q.text || '';
    var question = q.question || q.statement || '';
    if (signText && question === signText) question = '';
    return {
      id: String(20 + i),
      type: 'ja_nein',
      signText: signText,
      question: question,
      correct: correct,
      correctAnswer: correct,
      explanation: q.explanation,
      module: module,
      teil: teil,
    };
  }

  function parseSprechenPoints(record, q0) {
    if (Array.isArray(record.points) && record.points.length) return record.points;
    if (Array.isArray(record.prompts) && record.prompts.length) return record.prompts;
    const text = String((q0 && q0.question) || record.task || record.instruction || '');
    const teil = Number(record.teil ?? q0?.teil ?? 1);
    const level = String(record.level || q0?.level || '').toUpperCase();
    const type = String(q0?.type || '').toLowerCase();
    if (
      typeof SprechenBriefing !== 'undefined' &&
      SprechenBriefing.isA2GoetheSprechen(text, teil, { level, type })
    ) {
      return [];
    }
    if (typeof require !== 'undefined') {
      try {
        const { parseSprechenBriefing, isA2GoetheSprechen } = require('../engine/sprechenBriefing.js');
        if (isA2GoetheSprechen(text, teil, { level, type })) return [];
        return parseSprechenBriefing(text, teil, { level, type }).bullets;
      } catch (_) {
        /* fallback below */
      }
    }
    return text
      .split('\n')
      .map(function (line) {
        return line.replace(/^\s*[•*\-–]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim();
      })
      .filter(function (line) {
        return line.length > 2 && !/^folgende struktur|^folgende punkte|^diskutieren sie/i.test(line);
      });
  }

  function applySprechenSnapshot(part, record, teil) {
    if (typeof SprechenBriefing !== 'undefined' && SprechenBriefing.enrichSprechenExamPart) {
      SprechenBriefing.enrichSprechenExamPart(part, record);
    } else {
      const q0 = (record.questions || [])[0];
      const situation =
        record.situation ||
        (q0 && q0.question) ||
        record.task ||
        record.instruction ||
        '';
      part.situation = situation;
      part.title = record.title || record.taskFormat || 'Teil ' + teil;
      part.fieldId = record.fieldId || 'speak_bp_' + teil;
      part.instruction = situation;
      part.task = situation;
      part.points = [];
      part.prompts = [];
    }
    part.questions = (record.questions || []).map(function (q) {
      return normPartQuestion(q, 'sprechen', teil);
    });
    return part;
  }

  /**
   * Goethe A2 does not share B1's Teil order (library/blueprints/goethe_A2.json): Lesen T3 is a
   * letter with multiple choice and the ads are T4. Everything below was written for B1 and keyed
   * on the Teil number, so A2 T3 became an ads part with no ads — its questions rendered twice,
   * under B1's "Situationen 13 bis 19 und die Anzeigen a bis j".
   */
  var A2_LESEN_SLOTS = { 3: 'email_mcq', 4: 'ads_matching' };

  /** Official A2 wording. Published A2 parts carry no instruction, and the UI fallback
   *  (synthesizeLesenInstruction) only knows B1 ("Richtig oder Falsch", "Aufgaben 1 bis 6"). */
  var A2_INSTRUCTIONS = {
    lesen: {
      1: 'Lesen Sie den Text und die Aufgaben 1 bis 5. Wählen Sie bei jeder Aufgabe die richtige Lösung a, b oder c.',
      2: 'Lesen Sie den Text und die Aufgaben 6 bis 10. Wählen Sie bei jeder Aufgabe die richtige Lösung a, b oder c.',
      3: 'Lesen Sie den Text und die Aufgaben 11 bis 15. Wählen Sie bei jeder Aufgabe die richtige Lösung a, b oder c.',
      4: 'Lesen Sie die Situationen 16 bis 20 und die Anzeigen a bis f. Welche Anzeige passt zu welcher Situation? Für eine Situation gibt es keine passende Anzeige. In diesem Fall wählen Sie 0.',
    },
    horen: {
      1: 'Wählen Sie bei den Aufgaben 1 bis 5 die richtige Lösung a, b oder c.',
      2: 'Wählen Sie für die Aufgaben 6 bis 10 den passenden Buchstaben.',
      3: 'Wählen Sie bei den Aufgaben 11 bis 15 die richtige Lösung a, b oder c.',
      4: 'Wählen Sie für die Aufgaben 16 bis 20 Ja oder Nein.',
    },
  };

  /** @param {object} record — published part snapshot (seed-shaped payload) */
  function snapshotToExamPart(record) {
    if (!record || typeof record !== 'object') return null;
    var module = String(record.module || '').toLowerCase();
    var teil = Number(record.teil);
    if (!module || !Number.isFinite(teil)) return null;

    var isA2 = String(record.level || '').toUpperCase() === 'A2';
    var part = { teil: teil, instruction: record.instruction || '' };
    if (isA2 && !String(part.instruction).trim() && A2_INSTRUCTIONS[module] && A2_INSTRUCTIONS[module][teil]) {
      part.instruction = A2_INSTRUCTIONS[module][teil];
      // rebuildLesenAdsMatchingInstruction() rewrites German ads instructions from item ids,
      // which on A2 are still raw ("gen-q-4-bc8be82d-1") at that point.
      part._instructionAuthored = true;
    }

    if (module === 'lesen') {
      var passage = record.passage || {};
      if (Array.isArray(passage.passages) && passage.passages.length >= 2) {
        part.passages = passage.passages;
        part.textTitle = passage.title || '';
      } else if (teil === 3 && !isA2) {
        part.text = passage.text || '';
        part.textTitle = passage.title || '';
        part.ads = passage.ads || record.ads || [];
        part.blueprintSlot = 'ads_matching';
        part.slotType = 'ads_matching';
      } else if (teil === 4) {
        if (Array.isArray(record.passages) && record.passages.length > 0) {
          part.passages = record.passages;
        } else if (passage.text) {
          var pid = (record.questions || []).find(function (q) {
            return q.passageId;
          });
          pid = pid ? pid.passageId : null;
          if (pid) {
            part.passages = [{ id: pid, text: passage.text, title: passage.title || '' }];
          } else {
            part.text = passage.text;
            part.textTitle = passage.title || '';
          }
        }
        if (Array.isArray(record.ads)) part.ads = record.ads;
      } else {
        part.text = passage.text || '';
        part.textTitle = passage.title || '';
        part.passageId =
          (record.questions && record.questions[0] && record.questions[0].passageId) ||
          passage.passageId;
      }
      var rawQs = record.questions || [];
      if (teil === 4 && isForumOpinionsRecord(record) && rawQs.length) {
        part.blueprintSlot = 'forum_opinions';
        part.slotType = 'forum_opinions';
        part.items = rawQs
          .filter(function (q) {
            return q && (q.signText || q.text || q.question);
          })
          .map(function (q, i) {
            return mapForumOpinionItem(q, i, module, teil);
          });
        part.questions = rawQs
          .filter(function (q) {
            return q && !q.signText && !q.text;
          })
          .map(function (q) {
            return normPartQuestion(q, module, teil);
          });
      } else {
        part.questions = rawQs.map(function (q) {
          return normPartQuestion(q, module, teil);
        });
      }
      if (record.example) part.example = record.example;
      if (isA2 && A2_LESEN_SLOTS[teil]) {
        part.blueprintSlot = A2_LESEN_SLOTS[teil];
        part.slotType = A2_LESEN_SLOTS[teil];
      }
      if (isA2 && teil === 4) {
        // A2 marks the situation with no matching ad "X"; the UI offers the no-match pill
        // only for "0" (inferLesenT3HasNoMatch), so that item could never be answered right.
        (part.questions || []).forEach(function (q) {
          if (/^x$/i.test(String(q.correct != null ? q.correct : '').trim())) {
            q.correct = '0';
            q.correctAnswer = '0';
          }
        });
      }
      // Lesen T3: missing example → Goethe Modellsatz constant (same as ensureLesenT3Example).
      // Do NOT copy a scored correct="0" question into example (that duplicated Situation 0).
      // B1 only: A2 Teil 3 is a letter with multiple choice, not the ads task.
      if (Number(teil) === 3 && !isA2 && !part.example) {
        var t3Example = null;
        if (typeof require !== 'undefined') {
          try {
            t3Example = require('../library/goetheB1Constants.js').GOETHE_B1_LESEN_T3_EXAMPLE;
          } catch (_) {
            /* optional in some runtimes */
          }
        }
        if (!t3Example && typeof globalThis !== 'undefined' && globalThis.GoetheB1Constants) {
          t3Example = globalThis.GoetheB1Constants.GOETHE_B1_LESEN_T3_EXAMPLE;
        }
        if (!t3Example && typeof window !== 'undefined' && window.GoetheB1Constants) {
          t3Example = window.GoetheB1Constants.GOETHE_B1_LESEN_T3_EXAMPLE;
        }
        if (t3Example) part.example = Object.assign({}, t3Example);
      }
      if (Number(teil) === 3 && !isA2) {
        var hasNoMatchQ = (part.questions || []).some(function (q) {
          return (
            String(q.correct != null ? q.correct : q.correctAnswer || '')
              .trim()
              .toUpperCase() === '0'
          );
        });
        if (hasNoMatchQ) part._t3HasNoMatch = true;
      }
    } else if (module === 'horen') {
      if (Array.isArray(record.segments) && record.segments.length) {
        part.segments = record.segments.map(function (seg) {
          return Object.assign({}, seg, {
            questions: (seg.questions || []).map(function (q) {
              return normPartQuestion(q, module, teil);
            }),
          });
        });
      }
      var hp = record.passage || {};
      part.transcript = hp.transcript || hp.text || record.transcript || '';
      part.questions = (record.questions || []).map(function (q) {
        return normPartQuestion(q, module, teil);
      });
      if (!part.segments || !part.segments.length) {
        var firstPid = (record.questions || []).find(function (q) {
          return q.passageId;
        });
        if (firstPid) part.passageId = firstPid.passageId;
      }
    } else if (module === 'schreiben') {
      var passageSch = record.passage || {};
      var q0w = (record.questions || [])[0];
      part.task =
        record.task ||
        record.instruction ||
        passageSch.text ||
        (q0w && q0w.question) ||
        '';
      part.minWords = record.minWords != null ? record.minWords : teil === 3 ? 40 : 80;
      part.maxWords = record.maxWords != null ? record.maxWords : part.minWords;
      part.fieldId = record.fieldId || 'write_bp_' + teil;
      part.aufgabe = record.aufgabe != null ? record.aufgabe : teil;
      part.taskFormat = record.taskFormat || passageSch.title || record.taskFormat;
      var task = part.task;
      part.questions =
        (record.questions || []).length > 0
          ? record.questions.map(function (q) {
              return normPartQuestion(q, module, teil);
            })
          : [
              {
                id: '1',
                type: 'short_answer',
                question: task,
                correct: 'rubric',
                module: module,
                teil: teil,
              },
            ];
    } else if (module === 'sprechen') {
      applySprechenSnapshot(part, record, teil);
    } else {
      return null;
    }

    return part;
  }

  function sortParts(parts) {
    return (parts || []).slice().sort(function (a, b) {
      return Number(a.teil) - Number(b.teil);
    });
  }

  function publishedDocToServedExam(doc) {
    var lesenParts = [];
    var horenParts = [];
    var schreibenParts = [];
    var sprechenParts = [];

    (doc.parts || []).forEach(function (p) {
      var part = snapshotToExamPart(p.snapshot);
      if (!part) return;
      var level = String(doc.level || (p.snapshot && p.snapshot.level) || '').toUpperCase();
      var partId = p.partId ? String(p.partId) : null;
      var sourceFile = partId && level
        ? 'batches/ready/pool-verified/' + level + '/' + partId
        : null;
      var provenance = {
        sourceFile: sourceFile,
        module: String(p.module || '').toLowerCase(),
        teil: Number(p.teil),
        partId: partId,
        level: level || null,
        examId: doc.examId || null,
        publishedOfficial: true,
        passageId: part.passageId != null ? String(part.passageId) : null,
      };
      part._contentProvenance = provenance;
      part.partId = part.partId || p.partId || null;
      part.sourceFile = part.sourceFile || sourceFile || null;
      (part.questions || []).forEach(function (q) {
        if (!q || typeof q !== 'object') return;
        q._contentProvenance = {
          sourceFile: provenance.sourceFile,
          module: provenance.module,
          teil: provenance.teil,
          questionId: q.id != null ? String(q.id) : '',
          passageId: q.passageId != null ? String(q.passageId) : provenance.passageId,
        };
      });
      (part.items || []).forEach(function (q) {
        if (!q || typeof q !== 'object') return;
        q._contentProvenance = {
          sourceFile: provenance.sourceFile,
          module: provenance.module,
          teil: provenance.teil,
          questionId: q.id != null ? String(q.id) : '',
          passageId: q.passageId != null ? String(q.passageId) : provenance.passageId,
        };
      });
      (part.passages || []).forEach(function (pp) {
        if (!pp || typeof pp !== 'object') return;
        pp._contentProvenance = {
          sourceFile: provenance.sourceFile,
          module: provenance.module,
          teil: provenance.teil,
          partId: provenance.partId,
          passageId:
            pp.passageId != null ? String(pp.passageId) : pp.id != null ? String(pp.id) : null,
        };
      });
      (part.segments || []).forEach(function (seg) {
        (seg.questions || []).forEach(function (q) {
          if (!q || typeof q !== 'object') return;
          q._contentProvenance = {
            sourceFile: provenance.sourceFile,
            module: provenance.module,
            teil: provenance.teil,
            questionId: q.id != null ? String(q.id) : '',
            passageId: q.passageId != null ? String(q.passageId) : provenance.passageId,
          };
        });
      });
      if (p.module === 'lesen') lesenParts.push(part);
      else if (p.module === 'horen') horenParts.push(part);
      else if (p.module === 'schreiben') schreibenParts.push(part);
      else if (p.module === 'sprechen') sprechenParts.push(part);
    });

    return {
      id: doc.examId,
      examId: doc.examId,
      topic: doc.title || 'Official ' + doc.level + ' Exam ' + doc.slot,
      level: doc.level,
      lang: doc.lang,
      slot: doc.slot,
      goetheFormat: true,
      libraryBuilt: true,
      publishedExam: true,
      publishedManifestVersion: doc.manifestVersion,
      publishedAt: doc.publishedAt,
      // Was hard-coded 'goethe-b1' for every level, which put A2 on B1's numbering table.
      blueprintId: 'goethe-' + String(doc.level || 'B1').toLowerCase(),
      blueprintComplete: true,
      official: {
        board: 'Goethe-Institut',
        certificate: 'Goethe-Zertifikat ' + String(doc.level || 'B1').toUpperCase(),
        note:
          'Official curated exam (published snapshot v' +
          doc.manifestVersion +
          ', slot ' +
          doc.slot +
          ').',
      },
      lesenParts: sortParts(lesenParts),
      horenParts: sortParts(horenParts),
      schreibenParts: sortParts(schreibenParts),
      sprechenParts: sortParts(sprechenParts),
    };
  }

  async function loadCatalog(subject, level) {
    var res = await fetch(catalogPath(subject, level), { cache: 'no-store' });
    if (!res.ok) throw new Error('Published catalog not found (HTTP ' + res.status + ')');
    return res.json();
  }

  async function loadPublishedExamDoc(subject, level, examId) {
    var res = await fetch(examPath(subject, level, examId), { cache: 'no-store' });
    if (!res.ok) throw new Error('Published exam not found: ' + examId);
    return res.json();
  }

  async function loadExams(subject, level) {
    var catalog = await loadCatalog(subject, level);
    var entries = (catalog.exams || []).filter(function (e) {
      return e.status === 'live';
    });
    if (!entries.length) {
      throw new Error('No live published exams for ' + subject + ' ' + level);
    }
    entries.sort(function (a, b) {
      return Number(a.slot || 0) - Number(b.slot || 0);
    });
    var exams = [];
    for (var i = 0; i < entries.length; i++) {
      var doc = await loadPublishedExamDoc(subject, level, entries[i].examId);
      exams.push(publishedDocToServedExam(doc));
    }
    return exams;
  }

  async function probeLevel(subject, level) {
    try {
      var res = await fetch(catalogPath(subject, level), { method: 'HEAD', cache: 'no-store' });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  async function getExamCount(subject, level) {
    try {
      var catalog = await loadCatalog(subject, level);
      return (catalog.exams || []).filter(function (e) {
        return e.status === 'live';
      }).length;
    } catch (_) {
      return 0;
    }
  }

  global.PublishedExamAdapter = {
    supports: supports,
    catalogPath: catalogPath,
    examPath: examPath,
    snapshotToExamPart: snapshotToExamPart,
    publishedDocToServedExam: publishedDocToServedExam,
    loadExams: loadExams,
    probeLevel: probeLevel,
    getExamCount: getExamCount,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.PublishedExamAdapter;
  }
})(typeof window !== 'undefined' ? window : globalThis);
