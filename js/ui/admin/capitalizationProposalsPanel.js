/**
 * capitalizationProposalsPanel.js — Phase 3 caps rule queue (admin/dev; editor read-only).
 */
(function (global) {
  'use strict';

  let deps = { api: null, esc: (s) => String(s || ''), toast: () => {}, fmtDate: (d) => d || '—', canDecide: false };

  function bind(d) {
    deps = { ...deps, ...d };
  }

  function esc(s) {
    return deps.esc(s);
  }

  async function load() {
    const status = document.getElementById('crpFilterStatus')?.value || 'pending';
    const r = await deps.api('GET', {
      action: 'capitalization_proposals',
      status,
      limit: 100,
    });
    if (!r || r.error) {
      deps.toast('✗ ' + (r?.message || r?.error || 'Error cargando propuestas'));
      return;
    }
    renderList(r.proposals || []);
  }

  function renderList(rows) {
    const el = document.getElementById('crpList');
    const countEl = document.getElementById('crpCount');
    if (countEl) countEl.textContent = String(rows.length);
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<p style="color:var(--muted);font-size:13px">Sin propuestas en este filtro.</p>';
      return;
    }
    el.innerHTML = rows
      .map(function (p) {
        const actions = [];
        if (deps.canDecide && p.status === 'pending') {
          actions.push(
            '<button type="button" class="act approve" data-id="' +
              esc(p.id) +
              '" data-dec="approve">Aprobar (plantilla guard)</button>',
          );
          actions.push(
            '<button type="button" class="act" data-id="' +
              esc(p.id) +
              '" data-dec="corpus_only">Solo corpus</button>',
          );
          actions.push(
            '<button type="button" class="act reject" data-id="' +
              esc(p.id) +
              '" data-dec="reject">Rechazar</button>',
          );
        }
        return (
          '<article class="cc-card open">' +
          '<header class="cc-card-hd">' +
          '<div class="cc-card-title">' +
          '<span class="badge badge-cc-' +
          esc(p.status) +
          '">' +
          esc(p.status) +
          '</span> ' +
          '<b>' +
          esc(p.action) +
          '</b> · lemma <code>' +
          esc(p.lemma) +
          '</code> · ' +
          esc(p.level || '') +
          ' ' +
          esc(p.module || '') +
          ' T' +
          esc(p.teil != null ? p.teil : '') +
          '</div>' +
          '<div class="cc-card-sub">' +
          esc(p.correctionId) +
          ' · ' +
          esc(deps.fmtDate(p.createdAt)) +
          '</div></header>' +
          '<div class="cc-card-body">' +
          '<p><b>Diff:</b> <code>' +
          esc(p.oldSurface) +
          '</code> → <code>' +
          esc(p.newSurface) +
          '</code></p>' +
          '<p class="cc-muted"><b>Contexto:</b> ' +
          esc(p.contextPattern || '') +
          '</p>' +
          (p.feedbackId
            ? '<p class="cc-muted">Generation feedback: <code>' + esc(p.feedbackId) + '</code></p>'
            : '') +
          (p.guardTemplate
            ? '<pre class="crp-guard">' + esc(p.guardTemplate) + '</pre>'
            : '') +
          '<div class="cc-actions">' +
          actions.join('') +
          '</div></div></article>'
        );
      })
      .join('');

    el.querySelectorAll('button[data-dec]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        void decide(btn.getAttribute('data-id'), btn.getAttribute('data-dec'));
      });
    });
  }

  async function decide(id, decision) {
    if (!deps.canDecide || !deps.api) return;
    if (!window.confirm('¿Confirmar ' + decision + ' para ' + id + '?')) return;
    const r = await deps.api('POST', {}, { action: 'decide_capitalization_proposal', id: id, decision: decision });
    if (!r || !r.ok) {
      deps.toast('✗ ' + (r?.message || r?.error || 'decide failed'));
      return;
    }
    deps.toast('✓ ' + decision + (r.corpusPath ? ' · corpus' : ''));
    await load();
  }

  global.CapitalizationProposalsPanel = { bind: bind, load: load, decide: decide };
})(typeof window !== 'undefined' ? window : global);
