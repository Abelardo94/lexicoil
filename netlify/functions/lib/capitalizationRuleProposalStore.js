'use strict';

/**
 * CapitalizationRuleProposal — human queue for case-only corrections (Phase 3).
 * Does NOT write capitalizeNouns.mjs.
 */

const fs = require('fs');
const path = require('path');
const { validateProposal, PROPOSAL_STATUSES } = require('./capitalizationRuleProposalSchema.js');

const INDEX_KEY = 'capitalization_rule_proposals_index';
const INDEX_MAX = 2000;

function proposalKey(id) {
  return `capitalization_rule_proposal:${id}`;
}

function newProposalId() {
  return `crp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function historyEntry(action, user, extra = {}) {
  const ts = new Date().toISOString();
  return { action, user: user || 'unknown', date: ts, timestamp: ts, ...extra };
}

function toSummary(rec) {
  return {
    id: rec.id,
    status: rec.status,
    lemma: rec.lemma,
    action: rec.action,
    contextPattern: (rec.contextPattern || '').slice(0, 80),
    correctionId: rec.correctionId,
    level: rec.level || '',
    module: rec.module || '',
    teil: rec.teil,
    createdAt: rec.createdAt,
    feedbackId: rec.feedbackId || '',
  };
}

async function loadIndex(store) {
  try {
    const index = await store.get(INDEX_KEY, { type: 'json' });
    return Array.isArray(index) ? index : [];
  } catch (_) {
    return [];
  }
}

async function saveIndex(store, index) {
  await store.setJSON(INDEX_KEY, index.slice(-INDEX_MAX));
}

async function loadProposal(store, id) {
  if (!id) return null;
  try {
    return await store.get(proposalKey(id), { type: 'json' });
  } catch (_) {
    return null;
  }
}

async function saveProposal(store, rec) {
  await store.setJSON(proposalKey(rec.id), rec);
  const index = await loadIndex(store);
  const summary = toSummary(rec);
  const i = index.findIndex((r) => r.id === rec.id);
  if (i >= 0) index[i] = summary;
  else index.push(summary);
  await saveIndex(store, index);
  return rec;
}

function buildGuardTemplate(proposal) {
  const lemma = proposal.lemma || '?';
  const act = proposal.action || 'CASE';
  const ctx = (proposal.contextPattern || '').slice(0, 100);
  return (
    `// Review manually — do not auto-merge.\n` +
    `// Proposal ${proposal.id} · ${act} · lemma "${lemma}"\n` +
    `// Context: ${ctx}\n` +
    `// Evidence: ${(proposal.evidence || []).join(' · ')}\n` +
    `// Add to capitalizeNouns.mjs only after corpus test passes.`
  );
}

function appendCorpusEntry(projectRoot, proposal) {
  const root = projectRoot || path.join(__dirname, '..', '..', '..');
  const corpusPath = path.join(root, 'data', 'capitalization-proposal-corpus.jsonl');
  fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    proposalId: proposal.id,
    lemma: proposal.lemma,
    action: proposal.action,
    avoid: proposal.oldSurface,
    prefer: proposal.newSurface,
    contextPattern: proposal.contextPattern,
    correctionId: proposal.correctionId,
    level: proposal.level,
  });
  fs.appendFileSync(corpusPath, `${line}\n`, 'utf8');
  return corpusPath;
}

async function createProposalsFromCorrection(store, correction, changeSpans, ctx = {}) {
  if (!changeSpans?.caseOnly || !Array.isArray(changeSpans.spans) || !changeSpans.spans.length) {
    return { ok: true, created: [], skipped: true };
  }

  const created = [];
  for (const span of changeSpans.spans) {
    const validated = validateProposal({
      lemma: span.lemma,
      action: span.action || 'CASE',
      contextPattern: span.contextPattern,
      evidence: [
        correction.id,
        correction.sourceFile,
        `${correction.module || ''} T${correction.teil || ''}`,
        correction.fieldPath || '',
      ].filter(Boolean),
      oldSurface: span.oldSurface,
      newSurface: span.newSurface,
      correctionId: correction.id,
      sourceFile: correction.sourceFile,
      recordId: correction.recordId || '',
      module: correction.module,
      teil: correction.teil,
      level: correction.level || ctx.level || '',
      fieldPath: correction.fieldPath,
      targetId: correction.targetId,
      feedbackId: ctx.feedbackId || '',
    });
    if (!validated.ok) continue;

    const id = newProposalId();
    const now = new Date().toISOString();
    const rec = {
      id,
      ...validated.value,
      status: 'pending',
      changeSpan: span,
      createdAt: now,
      createdBy: ctx.email || correction.appliedBy || 'system',
      history: [historyEntry('created', ctx.email, { correctionId: correction.id })],
      guardTemplate: '',
    };
    rec.guardTemplate = buildGuardTemplate(rec);
    await saveProposal(store, rec);
    created.push(rec);
  }

  return { ok: true, created, count: created.length };
}

async function listProposals(store, opts = {}) {
  const index = await loadIndex(store);
  let rows = index.slice();
  if (opts.status && opts.status !== 'all') {
    rows = rows.filter((r) => r.status === opts.status);
  }
  if (opts.correctionId) {
    rows = rows.filter((r) => r.correctionId === opts.correctionId);
  }
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const limit = Math.min(Number(opts.limit) || 200, 500);
  const slice = rows.slice(0, limit);
  const full = [];
  for (const s of slice) {
    const rec = await loadProposal(store, s.id);
    if (rec) full.push(rec);
  }
  return { ok: true, proposals: full, count: full.length, total: rows.length };
}

async function decideProposal(store, id, decision, ctx = {}) {
  const rec = await loadProposal(store, id);
  if (!rec) return { ok: false, error: 'not_found' };
  const d = String(decision || '').toLowerCase();
  if (!['approve', 'reject', 'corpus_only'].includes(d)) {
    return { ok: false, error: 'invalid_decision' };
  }

  const hist = Array.isArray(rec.history) ? [...rec.history] : [];
  let status = rec.status;
  let corpusPath = null;

  if (d === 'approve') {
    status = 'approved';
    rec.guardTemplate = buildGuardTemplate(rec);
    hist.push(historyEntry('approved', ctx.email, { note: 'guard_template_only_no_auto_merge' }));
  } else if (d === 'reject') {
    status = 'rejected';
    hist.push(historyEntry('rejected', ctx.email, { note: ctx.note || '' }));
  } else if (d === 'corpus_only') {
    status = 'corpus_only';
    try {
      corpusPath = appendCorpusEntry(ctx.projectRoot, rec);
      hist.push(historyEntry('corpus_only', ctx.email, { corpusPath }));
    } catch (err) {
      return { ok: false, error: 'corpus_write_failed', message: err.message };
    }
  }

  const next = {
    ...rec,
    status,
    history: hist,
    decidedAt: new Date().toISOString(),
    decidedBy: ctx.email || 'admin',
  };
  await saveProposal(store, next);
  return { ok: true, proposal: next, corpusPath, guardTemplate: next.guardTemplate };
}

module.exports = {
  PROPOSAL_STATUSES,
  loadProposal,
  listProposals,
  createProposalsFromCorrection,
  decideProposal,
  buildGuardTemplate,
  appendCorpusEntry,
  toSummary,
};
