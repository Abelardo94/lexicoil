'use strict';

const PROPOSAL_STATUSES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'corpus_only',
]);

const CAP_ACTIONS = Object.freeze(['CAP', 'DECAP', 'CASE']);

const CONTENT_EDITOR_LEVELS = Object.freeze(['A2', 'B1', 'B2']);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function validateProposal(raw, opts = {}) {
  const partial = !!opts.partial;
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['body must be an object'] };

  const requireField = (key, test, err) => {
    if (partial && raw[key] === undefined) return;
    if (!test(raw[key])) errors.push(err);
  };

  requireField('lemma', (v) => typeof v === 'string' && v.trim().length >= 1, 'missing_lemma');
  requireField('action', (v) => CAP_ACTIONS.includes(String(v)), 'invalid_action');
  requireField('correctionId', (v) => typeof v === 'string' && v.length >= 3, 'missing_correctionId');

  if (raw.status !== undefined && !PROPOSAL_STATUSES.includes(String(raw.status))) {
    errors.push('invalid_status');
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      lemma: String(raw.lemma).trim().toLowerCase(),
      action: String(raw.action),
      contextPattern: String(raw.contextPattern || '').slice(0, 400),
      evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String) : [],
      oldSurface: String(raw.oldSurface || '').slice(0, 120),
      newSurface: String(raw.newSurface || '').slice(0, 120),
      correctionId: String(raw.correctionId),
      sourceFile: String(raw.sourceFile || ''),
      recordId: raw.recordId != null ? String(raw.recordId) : '',
      module: raw.module != null ? String(raw.module).toLowerCase() : '',
      teil: raw.teil != null ? Number(raw.teil) : null,
      level: raw.level != null ? String(raw.level).toUpperCase() : '',
      fieldPath: String(raw.fieldPath || ''),
      targetId: String(raw.targetId || ''),
      feedbackId: raw.feedbackId != null ? String(raw.feedbackId) : '',
      status: raw.status ? String(raw.status) : 'pending',
      guardTemplate: raw.guardTemplate != null ? String(raw.guardTemplate).slice(0, 2000) : '',
    },
  };
}

module.exports = {
  PROPOSAL_STATUSES,
  CAP_ACTIONS,
  CONTENT_EDITOR_LEVELS,
  validateProposal,
};
