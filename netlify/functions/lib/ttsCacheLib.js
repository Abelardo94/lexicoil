'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO_MAX_BYTES = 2 * 1024 * 1024;
const MIN_REAL_AUDIO_BYTES = 1024;

/** Whitespace/symbol cleanup shared with front (normalizeTtsQueryText) and pregenerate scripts. */
function normalizeTtsInput(text) {
  return String(text || '')
    .replace(/[■●▲►◆]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(text) {
  return normalizeTtsInput(text).toLowerCase();
}

function textHash(text) {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 16);
}

function cacheKey(voice, text) {
  const v = String(voice || 'default').trim().slice(0, 32);
  return `tts:${v}:${textHash(text)}`;
}

function cacheFileName(voice, hash) {
  const v = String(voice || 'default').trim().slice(0, 32);
  return `${v}_${hash}.mp3`;
}

function cacheRoots(fromDir = __dirname) {
  return [
    path.join(fromDir, '..', 'library', 'tts-cache'),
    path.join(fromDir, '..', '..', 'library', 'tts-cache'),
    path.join(fromDir, '..', '..', '..', 'library', 'tts-cache'),
  ];
}

function bundledAudioPath(voice, hash, fromDir = __dirname) {
  const name = cacheFileName(voice, hash);
  for (const dir of cacheRoots(fromDir)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function cacheFilePath(voice, text, fromDir = __dirname) {
  const hash = textHash(text);
  const name = cacheFileName(voice, hash);
  for (const dir of cacheRoots(fromDir)) {
    if (fs.existsSync(dir)) return path.join(dir, name);
  }
  return path.join(cacheRoots(fromDir)[1], name);
}

function readBundledAudioBuffer(voice, text, lang, resolveVoiceId, fromDir = __dirname) {
  const hash = textHash(text);
  const candidates = [];
  const addVoice = (v) => {
    const s = String(v || '').trim().slice(0, 32);
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  addVoice(voice);
  if (typeof resolveVoiceId === 'function') {
    addVoice(resolveVoiceId(voice, lang));
  }
  const l = String(lang || 'en').slice(0, 2).toLowerCase();
  if (l === 'de') addVoice('de-DE');
  else if (l === 'es') addVoice('es-ES');
  else addVoice('en-GB');
  for (const v of candidates) {
    const file = bundledAudioPath(v, hash, fromDir);
    if (!file) continue;
    try {
      const buf = fs.readFileSync(file);
      // The stub provider writes a 296-byte silent MP3. All 114 clips committed under
      // library/tts-cache/ were such stubs, so a cache hit served silence instead of
      // falling through to the browser voice. A real one-word clip is ~6 KB at 64 kbps.
      if (buf.length >= MIN_REAL_AUDIO_BYTES && buf.length <= AUDIO_MAX_BYTES) return buf;
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

module.exports = {
  AUDIO_MAX_BYTES,
  MIN_REAL_AUDIO_BYTES,
  normalizeTtsInput,
  normalizeText,
  textHash,
  cacheKey,
  cacheFileName,
  cacheFilePath,
  bundledAudioPath,
  readBundledAudioBuffer,
  cacheRoots,
};
