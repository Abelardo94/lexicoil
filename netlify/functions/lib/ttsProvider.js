'use strict';

/**
 * TTS provider abstraction — selected by TTS_PROVIDER env var.
 *
 *   none        — default; synthesize() returns null (browser fallback).
 *   stub        — dev/test; minimal silent MP3 buffer.
 *   elevenlabs  — ElevenLabs REST API (ELEVENLABS_API_KEY required).
 *   polly/google — stubs until wired.
 */
const { resolveVoiceId } = require('./ttsVoices.js');

const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';

/**
 * The model every ElevenLabs call uses. Exported because the cache key is voice+textHash only
 * (ttsCacheLib.cacheKey), so a cached MP3 carries no record of the model that produced it —
 * the pregenerate manifest is the only place that can say.
 */
function resolveTtsModel() {
  return process.env.ELEVENLABS_MODEL || ELEVENLABS_DEFAULT_MODEL;
}

const STUB_MP3 = Buffer.from(
  'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2YzU4LjI5LjEwMAAAAAAAAAAAAAAAAAJAAAAAAAAAAAA4T/kAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'base64',
);

async function synthesizePolly(_text, _voice, _lang) {
  return null;
}

async function synthesizeGoogle(_text, _voice, _lang) {
  return null;
}

async function synthesizeElevenLabs(text, voice, lang) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const voiceId = resolveVoiceId(voice, lang);
  if (!voiceId) return null;

  const model = resolveTtsModel();
  // 64 kbps is plenty for speech and halves the default 128 kbps: the de/B1 pool alone is
  // ~8 h of audio. Cost is per character, so the format does not change the price.
  const format = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_64';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: String(text).slice(0, 4000),
      model_id: model,
      voice_settings: {
        stability: Number(process.env.ELEVENLABS_STABILITY || 0.45),
        similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY || 0.75),
      },
    }),
  });

  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 64 ? buf : null;
}

async function synthesizeStub(_text, _voice, _lang) {
  return STUB_MP3.length > 64 ? STUB_MP3 : null;
}

async function synthesize(text, voice, lang) {
  const src = String(text || '').trim();
  if (!src) return null;

  const provider = String(process.env.TTS_PROVIDER || 'none').toLowerCase();

  switch (provider) {
    case 'stub':
      return synthesizeStub(src, voice, lang);
    case 'polly':
      return synthesizePolly(src, voice, lang);
    case 'google':
      return synthesizeGoogle(src, voice, lang);
    case 'elevenlabs':
      return synthesizeElevenLabs(src, voice, lang);
    case 'none':
    default:
      return null;
  }
}

function isProviderConfigured() {
  const p = String(process.env.TTS_PROVIDER || 'none').toLowerCase();
  if (p === 'elevenlabs') return !!process.env.ELEVENLABS_API_KEY;
  return p !== 'none' && p !== '';
}

module.exports = { synthesize, isProviderConfigured, synthesizeElevenLabs, resolveTtsModel };
