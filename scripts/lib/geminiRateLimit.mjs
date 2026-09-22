/**
 * Gemini rate limiter for CLI — global blob CAS when NETLIFY_SITE_ID set, else local file.
 *
 * El store remoto se resuelve solo mirando si hay NETLIFY_SITE_ID y token, sin
 * comprobar que el token sirva. Con un token restringido, Blobs responde 401 y
 * antes ese error subia hasta matar la generacion entera. El contador es una
 * ayuda, no un requisito: si Blobs no contesta, se degrada al fichero local
 * (que es justo lo que hace cuando no hay token) y se avisa una sola vez.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './loadEnv.mjs';
import { resolveGeminiRateLimitStore } from './geminiBlobStore.mjs';

const require = createRequire(import.meta.url);
const core = require('../../netlify/functions/lib/geminiRateLimitCore.js');

export const DailyQuotaError = core.DailyQuotaError;
export const USAGE_FILE = path.join(ROOT, 'batches', '.gemini-usage.json');
export const USAGE_BLOB_KEY = core.USAGE_BLOB_KEY;

/** Una vez caido, no se reintenta Blobs en lo que queda de proceso. */
let blobsDown = false;

export function isDailyQuotaMessage(message) {
  return core.isDailyQuotaMessage(message);
}

/** Un error de cuota diaria es del limitador y debe subir; el resto es Blobs. */
function isQuotaError(err) {
  return err instanceof core.DailyQuotaError || isDailyQuotaMessage(err?.message);
}

function noteBlobsDown(err) {
  if (!blobsDown) {
    blobsDown = true;
    console.warn(
      `Contador global de Gemini no disponible (${err?.message || err}). ` +
        'Se sigue con el contador local: batches/.gemini-usage.json',
    );
  }
}

/** Resuelve el store salvo que ya sepamos que Blobs no responde. */
function storeOrNull() {
  if (blobsDown) return { store: null, backend: 'file' };
  return resolveGeminiRateLimitStore();
}

export async function remainingToday() {
  const { store } = storeOrNull();
  if (store) {
    try {
      const usage = await core.readUsage(store);
      return core.remainingTodayFromUsage(usage);
    } catch (err) {
      if (isQuotaError(err)) throw err;
      noteBlobsDown(err);
    }
  }
  const usage = core.readUsage(null, { filePath: USAGE_FILE });
  return core.remainingTodayFromUsage(usage);
}

/** Wait until RPM/RPD allow one request; then record it (global when Blobs available). */
export async function acquire() {
  const { store } = storeOrNull();
  if (store) {
    try {
      return await core.acquire(store);
    } catch (err) {
      if (isQuotaError(err)) throw err;
      noteBlobsDown(err);
    }
  }
  return core.acquire(null, { filePath: USAGE_FILE });
}

/** Sync read for doctor / diagnostics. */
export async function readUsageSnapshot() {
  const { store, backend } = storeOrNull();
  if (store) {
    try {
      const u = await core.readUsage(store);
      return { ...u, backend };
    } catch (err) {
      if (isQuotaError(err)) throw err;
      noteBlobsDown(err);
    }
  }
  const usage = core.readUsage(null, { filePath: USAGE_FILE });
  return { ...usage, backend: fs.existsSync(USAGE_FILE) ? 'file' : 'file-new' };
}
