/**
 * pushSeedBlobStrict.mjs — fail-closed blob reads for push-seed-to-blobs.
 *
 * Distinguishes:
 *   • índice OK + 0 entradas  → tienda vacía real (upload permitido)
 *   • error de red/list/get   → abort (salvo --allow-empty-index en el script)
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildUpdatedPayload } from './mergeSeedBlobPayload.mjs';
import { comparePayloadSemantic } from './verifyBlobContent.mjs';
import { mapWithConcurrency } from './mapWithConcurrency.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { partPayloadKey: defaultPartPayloadKey } =
  require(path.join(ROOT, 'netlify/functions/lib/reusablePartsStore.js'));

export class BlobStoreReadError extends Error {
  constructor(message, { cause, module, id, phase } = {}) {
    super(message);
    this.name = 'BlobStoreReadError';
    this.cause = cause;
    this.module = module;
    this.id = id;
    this.phase = phase;
  }
}

const DEFAULT_MODULES = ['lesen', 'horen', 'schreiben', 'sprechen'];

/**
 * Blob reads run in parallel up to this many at a time. Override with
 * BLOBS_CONCURRENCY when Netlify is rate-limiting or when debugging: 1 restores
 * the old strictly-sequential behaviour.
 */
export const DEFAULT_CONCURRENCY = Math.max(
  1,
  Number(process.env.BLOBS_CONCURRENCY) || 12,
);

/**
 * Load blob index — throws BlobStoreReadError on any list/get failure.
 * @returns {{ blobIndex: Map, indexStats: object }}
 */
export async function loadBlobIndexStrict(
  store,
  {
    lang = 'de',
    level = 'B1',
    modules = DEFAULT_MODULES,
    partPayloadKey = defaultPartPayloadKey,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = null,
  } = {},
) {
  const blobIndex = new Map();
  const indexStats = { total: 0, modules: {}, readOk: true };

  for (const mod of modules) {
    const prefix = `reusable_part_idx:${lang}:${level}:${mod}:`;
    let listed;
    try {
      listed = await store.list({ prefix });
    } catch (err) {
      throw new BlobStoreReadError(
        `No se pudo leer el índice de blobs (${mod}): ${err.message}`,
        { cause: err, module: mod, phase: 'index-list' },
      );
    }

    const blobs = listed?.blobs ?? [];
    indexStats.modules[mod] = { listed: blobs.length, indexed: 0 };

    // One network round-trip per index entry. Sequentially that is ~958 of them
    // for de/B1 with nothing printed in between, which is indistinguishable from
    // a hang; mapWithConcurrency keeps the fail-closed behaviour and adds progress.
    const rows = await mapWithConcurrency(
      blobs,
      concurrency,
      async (blob) => {
        try {
          return await store.get(blob.key, { type: 'json' });
        } catch (err) {
          throw new BlobStoreReadError(
            `No se pudo leer entrada de índice ${blob.key}: ${err.message}`,
            { cause: err, module: mod, phase: 'index-row' },
          );
        }
      },
      { onProgress: onProgress && ((d, t) => onProgress(mod, d, t)) },
    );

    for (const row of rows) {
      if (row?.partKey && row?.id) {
        blobIndex.set(row.id, { ...row, module: mod });
        indexStats.modules[mod].indexed++;
        indexStats.total++;
      }
    }
  }

  return { blobIndex, indexStats };
}

/**
 * Fetch one payload — throws on network error or missing payload for indexed id.
 */
export async function fetchBlobPayloadStrict(
  store,
  lang,
  level,
  mod,
  id,
  { partPayloadKey = defaultPartPayloadKey } = {},
) {
  const key = partPayloadKey(lang, level, mod, id);
  let payload;
  try {
    payload = await store.get(key, { type: 'json' });
  } catch (err) {
    throw new BlobStoreReadError(
      `No se pudo leer payload de ${id}: ${err.message}`,
      { cause: err, module: mod, id, phase: 'payload-fetch' },
    );
  }
  if (!payload) {
    throw new BlobStoreReadError(
      `Payload ausente para ${id} (presente en índice, key=${key})`,
      { module: mod, id, phase: 'payload-missing' },
    );
  }
  return payload;
}

/**
 * Every payload the seed needs from blobs, fetched in parallel.
 *
 * Fail-closed is preserved: mapWithConcurrency rethrows the first failing item's
 * error and returns nothing, so a caller can never proceed with a half-filled
 * cache and report the rest as matching.
 */
async function prefetchBlobPayloads(
  seedArr,
  store,
  blobIndex,
  { lang, level, partPayloadKey, concurrency, onProgress },
) {
  const wanted = [];
  for (const seedPart of seedArr) {
    const id = seedPart.partId || seedPart.id;
    if (!id || !blobIndex.has(id)) continue;
    wanted.push({ id, mod: seedPart.module || blobIndex.get(id)?.module || 'lesen' });
  }

  const payloads = await mapWithConcurrency(
    wanted,
    concurrency,
    ({ id, mod }) => fetchBlobPayloadStrict(store, lang, level, mod, id, { partPayloadKey }),
    { onProgress: onProgress && ((d, t) => onProgress('payloads', d, t)) },
  );

  const cache = new Map();
  wanted.forEach((w, i) => cache.set(w.id, payloads[i]));
  return cache;
}

function diffObjects(a, b, prefix = '') {
  const diffs = [];
  const allKeys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of allKeys) {
    if (key === 'servedCount' || key === 'createdAt' || key === 'disabled') continue;
    const pa = `${prefix}${key}`;
    const av = a?.[key];
    const bv = b?.[key];
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      if (typeof av === 'object' && typeof bv === 'object' && av && bv && !Array.isArray(av)) {
        diffs.push(...diffObjects(av, bv, `${pa}.`));
      } else {
        diffs.push({
          path: pa,
          from: JSON.stringify(av)?.slice(0, 80),
          to: JSON.stringify(bv)?.slice(0, 80),
        });
      }
    }
  }
  return diffs;
}

function countKeyDiffs(seedPart, blobPart) {
  const sqs = seedPart.questions || [];
  const bqs = blobPart.questions || [];
  let count = 0;
  for (let i = 0; i < sqs.length; i++) {
    const sq = sqs[i];
    const bq = bqs[i];
    if (!bq) continue;
    const sv = String(sq.correct ?? sq.correctAnswer ?? '');
    const bv = String(bq.correct ?? bq.correctAnswer ?? '');
    if (sv.toLowerCase() !== bv.toLowerCase() || sv !== bv) count++;
  }
  return count;
}

/**
 * Compare seed parts vs blobs. Payload fetch failures throw (never → MISSING).
 */
export async function planPushOperations(
  seedArr,
  store,
  blobIndex,
  {
    normalizeKeys = false,
    lang = 'de',
    level = 'B1',
    partPayloadKey = defaultPartPayloadKey,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = null,
  } = {},
) {
  const missing = [];
  const differs = [];
  const matching = [];
  const mergeErrors = [];

  // Fetch every payload we need up front, in parallel. The comparison below is
  // pure CPU and stays exactly as it was, in seed order; only the waiting moves.
  const blobCache = await prefetchBlobPayloads(seedArr, store, blobIndex, {
    lang, level, partPayloadKey, concurrency, onProgress,
  });

  for (const seedPart of seedArr) {
    const id = seedPart.partId || seedPart.id;
    if (!id) continue;

    if (!blobIndex.has(id)) {
      missing.push({ id, seedPart });
      continue;
    }

    const blobPart = blobCache.get(id);

    let payload;
    try {
      payload = buildUpdatedPayload(blobPart, seedPart, { normalizeKeys });
    } catch (err) {
      mergeErrors.push({ id, message: err.message, details: err.details || [] });
      differs.push({
        id,
        seedPart,
        blobPart,
        payload: null,
        diffs: [{ path: 'merge', from: 'error', to: err.message }],
        keyDiffs: 0,
      });
      continue;
    }

    const diffs = diffObjects(payload, blobPart);
    if (diffs.length > 0) {
      differs.push({
        id,
        seedPart,
        blobPart,
        payload,
        diffs,
        keyDiffs: countKeyDiffs(payload, blobPart),
      });
    } else {
      matching.push({ id, seedPart, blobPart, payload });
    }
  }

  return { missing, differs, matching, mergeErrors, blobCache };
}

export function abortMessage(err, { allowEmptyIndex = false, mode = 'push' } = {}) {
  const lines = [
    '',
    `✗ ABORT (fail-closed): no se pudo leer el estado real de blobs${mode === 'verify' ? ' para verify' : ''}.`,
    `  ${err.message}`,
  ];
  if (err.phase) lines.push(`  fase: ${err.phase}`);
  if (mode === 'verify') {
    lines.push('  No se reportan divergencias — el resultado sería engañoso.');
    lines.push('  Reintenta cuando Netlify responda: node scripts/verify-blobs-vs-seed.mjs');
  } else {
    lines.push('  No se ha escrito nada en producción.');
  }
  if (!allowEmptyIndex) {
    lines.push('');
    if (mode === 'verify') {
      lines.push('  • Error de red/list/get → ABORT (no comparar seed vs backup local).');
      lines.push('  • Índice OK con 0 entradas → verify legítimo (todo LOCAL_ONLY).');
    } else {
      lines.push('  • Índice OK con 0 entradas → upload permitido (tienda vacía real).');
      lines.push('  • Error de red/list/get → reintenta cuando Netlify responda.');
      lines.push('  • Primer push pese a error de red (solo si estás seguro): --allow-empty-index');
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function abortVerifyMessage(err) {
  return abortMessage(err, { mode: 'verify' });
}

/**
 * Compare seed vs live blobs. Payload fetch failures throw (never → LOCAL_ONLY silencioso).
 * @returns {{ results, mergeFailures, keySeqChangedInBlob, keySeqChecked }}
 */
export async function runVerifyComparison(
  seedArr,
  store,
  blobIndex,
  {
    lang = 'de',
    level = 'B1',
    partPayloadKey = defaultPartPayloadKey,
    buildPayload = buildUpdatedPayload,
    backupById = null,
    keySeqForPartFn = null,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = null,
  } = {},
) {
  const results = {
    LOCAL_ONLY: [],
    CONTENT_DIFFERS: [],
    COSMETIC: [],
    KEY_FORMAT: [],
    OK: [],
  };
  const mergeFailures = [];
  let keySeqChangedInBlob = 0;
  let keySeqChecked = 0;

  const blobCache = await prefetchBlobPayloads(seedArr, store, blobIndex, {
    lang, level, partPayloadKey, concurrency, onProgress,
  });

  for (const seedPart of seedArr) {
    const id = seedPart.partId || seedPart.id;
    if (!id) continue;

    if (!blobIndex.has(id)) {
      results.LOCAL_ONLY.push({ id, seedPart });
      continue;
    }

    const blobPart = blobCache.get(id);

    let expected;
    try {
      expected = buildPayload(blobPart, seedPart);
    } catch (err) {
      mergeFailures.push({ id, message: err.message });
      results.CONTENT_DIFFERS.push({ id, seedPart, blobPart, fields: ['merge-error'], realFields: ['merge-error'] });
      continue;
    }

    const { hasRealDiff, realFields, cosmeticFields } = comparePayloadSemantic(expected, blobPart);

    if (hasRealDiff) {
      results.CONTENT_DIFFERS.push({
        id,
        seedPart,
        blobPart,
        fields: realFields,
        realFields,
        cosmeticFields,
      });
      continue;
    }

    if (cosmeticFields.length) {
      results.COSMETIC.push({ id, cosmeticFields });
    }

    if (backupById && keySeqForPartFn) {
      const seedSeq = keySeqForPartFn(seedPart);
      const blobSeq = keySeqForPartFn(blobPart);
      if (seedSeq && backupById.has(id)) {
        const preSeq = keySeqForPartFn(backupById.get(id));
        keySeqChecked++;
        if (preSeq !== blobSeq && seedSeq === blobSeq) keySeqChangedInBlob++;
      }
    }

    const blobQs = blobPart.questions || [];
    const hasUpperKey = blobQs.some((q) => {
      const type = String(q.type || '').toLowerCase();
      const c = String(q.correct ?? q.correctAnswer ?? '');
      return (type === 'multiple_choice' || type === 'multiple') && /^[A-Z]$/.test(c);
    });
    if (hasUpperKey) {
      const upperKeys = blobQs
        .filter((q) => /^[A-Z]$/.test(String(q.correct ?? '')))
        .map((q) => q.correct)
        .join(',');
      results.KEY_FORMAT.push({ id, blobPart, upperKeys });
      continue;
    }

    results.OK.push({ id });
  }

  return { results, mergeFailures, keySeqChangedInBlob, keySeqChecked };
}
