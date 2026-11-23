/**
 * Routes content-corrections panel calls to content-corrections API (content_corrector role).
 * Full admins may use admin-api via the primary `api` function.
 */
(function (global) {
  function buildUrl(base, params) {
    const q = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      if (params[k] != null && params[k] !== '') q.set(k, String(params[k]));
    });
    const s = q.toString();
    return s ? base + '?' + s : base;
  }

  function createCorrectionsApiBridge(getToken) {
    const CC = '/.netlify/functions/content-corrections';

    async function ccFetch(method, url, body) {
      const token = typeof getToken === 'function' ? getToken() : '';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (_) {
        return { error: text.slice(0, 120) || 'HTTP ' + res.status };
      }
    }

    return async function correctionsApi(method, params, body) {
      params = params || {};
      body = body || {};
      const action = method === 'GET' ? params.action : body.action;

      if (action === 'content_corrections') {
        return ccFetch(
          'GET',
          buildUrl(CC, {
            status: params.status || 'pending',
            limit: params.limit,
            module: params.module,
            sourceFile: params.sourceFile,
          }),
        );
      }

      if (action === 'update_content_correction') {
        const id = body.id;
        const patch = { ...body };
        delete patch.action;
        delete patch.id;
        return ccFetch('PATCH', buildUrl(CC, { id }), patch);
      }

      if (action === 'reject_content_correction') {
        const id = body.id;
        return ccFetch('DELETE', buildUrl(CC, { id, hard: body.hard ? '1' : '0' }));
      }

      if (action === 'apply_content_correction') {
        const id = body.id;
        const applyAction = body.confirm ? 'apply_correction' : 'apply_correction';
        return ccFetch('POST', CC, {
          action: applyAction,
          id,
          confirm: body.confirm === true,
          syncEnabled: body.syncEnabled,
          confirmPublish: body.confirmPublish === true,
          localOnly: body.localOnly === true,
          skipBlob: body.skipBlob === true,
          skipSeed: body.skipSeed === true,
          skipPublished: body.skipPublished === true,
          lang: body.lang,
          level: body.level,
          skipLearning: body.skipLearning === true,
        });
      }

      if (action === 'dry_run_apply_corrections') {
        if (body.id) {
          return ccFetch('POST', CC, { action: 'apply_correction', id: body.id, confirm: false });
        }
        return ccFetch('POST', CC, {
          action: 'dry_run_apply',
          sourceFile: body.sourceFile,
          module: body.module,
          ids: body.ids,
          limit: body.limit,
        });
      }

      if (action === 'apply_approved_corrections') {
        return ccFetch('POST', CC, {
          action: 'apply_approved',
          confirm: body.confirm === true,
          sourceFile: body.sourceFile,
          module: body.module,
          ids: body.ids,
          limit: body.limit,
          syncEnabled: body.syncEnabled,
          confirmPublish: body.confirmPublish === true,
          localOnly: body.localOnly === true,
          lang: body.lang,
          level: body.level,
        });
      }

      if (action === 'capitalization_proposals' || action === 'list_capitalization_proposals') {
        return ccFetch('POST', CC, {
          action: 'list_capitalization_proposals',
          status: params.status || body.status || 'pending',
          limit: params.limit || body.limit || 100,
        });
      }

      return { error: 'unsupported_action', message: 'Action not available for content editor API bridge: ' + action };
    };
  }

  global.CorrectionsApiBridge = { createCorrectionsApiBridge };
})(typeof window !== 'undefined' ? window : global);
