'use strict';

/**
 * TTS voice registry — ElevenLabs IDs + legacy locale aliases.
 * Override defaults via ELEVENLABS_VOICES_DE (comma-separated voice IDs).
 */
// de: voces ALEMANAS NATIVAS de la biblioteca (requieren plan de pago; en el gratuito
// la API devuelve 402 paid_plan_required). Antes eran Adam/George/Daniel, inglesas
// nativas hablando aleman. El indice 0 es el narrador: LEGACY_VOICE_INDEX mapea el
// alias 'de-DE' a esta posicion y es la que mas clips usa.
//   Christian tlaozmPwSPrjhdNidYEO (m, sereno) · Emma RqAMJpZ689MpxoPI49H6 (f, calida)
//   Jonas xlbJQnFFGB01bv7HK5CZ (m, joven)
// Tiene que coincidir con VOICES en js/bootstrap/listeningScript.js o la clave del
// cache deja de acertar.
const DEFAULT_VOICES = {
  de: ['tlaozmPwSPrjhdNidYEO', 'RqAMJpZ689MpxoPI49H6', 'xlbJQnFFGB01bv7HK5CZ'],
  en: ['Xb7hH8MSUJpSbSDYk0k2', 'JBFqnCBsd6RMkjVDRZzb', 'pNInz6obpgDQGcFmaJgB'],
  es: ['ErXwobaYiN019PkySvjV', 'JBFqnCBsd6RMkjVDRZzb', 'pNInz6obpgDQGcFmaJgB'],
};

const LOCALE_DEFAULT = {
  de: 'de-DE',
  en: 'en-GB',
  es: 'es-ES',
};

/** Azure Neural names (phase 13e) → ElevenLabs slot index. */
const LEGACY_VOICE_INDEX = {
  'de-DE-KatjaNeural': 0,
  'de-DE-ConradNeural': 1,
  'de-DE-AmalaNeural': 2,
  'en-GB-SoniaNeural': 0,
  'en-GB-RyanNeural': 1,
  'en-GB-LibbyNeural': 2,
  'es-ES-ElviraNeural': 0,
  'es-ES-AlvaroNeural': 1,
  'es-ES-AbrilNeural': 2,
  'de-DE': 0,
  'en-GB': 0,
  'es-ES': 0,
  default: 0,
};

function envVoiceList(lang) {
  const key = `ELEVENLABS_VOICES_${String(lang || '').toUpperCase()}`;
  const raw = process.env[key];
  if (!raw) return null;
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function voicesForLang(lang) {
  const l = String(lang || 'en').slice(0, 2).toLowerCase();
  return envVoiceList(l) || DEFAULT_VOICES[l] || DEFAULT_VOICES.en;
}

function isElevenLabsVoiceId(voice) {
  return /^[A-Za-z0-9]{16,24}$/.test(String(voice || ''));
}

function resolveVoiceId(voice, lang) {
  const src = String(voice || '').trim();
  const list = voicesForLang(lang);
  if (isElevenLabsVoiceId(src)) return src;
  const idx = LEGACY_VOICE_INDEX[src] ?? LEGACY_VOICE_INDEX.default;
  return list[idx % list.length];
}

function defaultVoiceForLang(lang) {
  return resolveVoiceId(LOCALE_DEFAULT[String(lang || 'en').slice(0, 2).toLowerCase()] || 'en-GB', lang);
}

function assignSpeakerVoices(segments, lang) {
  const list = voicesForLang(lang);
  const map = {};
  let vi = 0;
  return segments.map((seg) => {
    if (!map[seg.speaker]) {
      map[seg.speaker] = list[vi % list.length];
      vi++;
    }
    return { ...seg, voice: map[seg.speaker] };
  });
}

module.exports = {
  DEFAULT_VOICES,
  voicesForLang,
  resolveVoiceId,
  defaultVoiceForLang,
  assignSpeakerVoices,
  isElevenLabsVoiceId,
};
