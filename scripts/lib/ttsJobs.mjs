/**
 * ttsJobs.mjs — enumera los clips de Hören que la app va a pedir, para un examen.
 *
 * Vivia dentro de pregenerate-tts.mjs. Se saca aqui porque el subidor a Blobs
 * necesita exactamente la misma lista: el clip solo sirve si su clave coincide con
 * la que calcula examRunner, y la unica forma de garantizarlo es que el texto y la
 * voz salgan de un unico sitio. Si esto se duplica, el cache vuelve a fallar en
 * silencio — que es como ya se perdieron los clips una vez.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT } from './loadEnv.mjs';
import { normalizeTtsText, ttsTextHash } from './ttsCache.mjs';

const require = createRequire(import.meta.url);
const ListeningScript = require(path.join(ROOT, 'js/bootstrap/listeningScript.js'));

/** Voz base por idioma cuando el examen no trae pista: es un locale, no una voz. */
export function ttsVoiceForLang(lang) {
  const l = String(lang || 'en').slice(0, 2).toLowerCase();
  if (l === 'de') return 'de-DE';
  if (l === 'es') return 'es-ES';
  return 'en-GB';
}

export function sanitizeTtsText(text) {
  return normalizeTtsText(text);
}

/** Collect playable Hören texts exactly as examRunner + fetchTtsAudio resolve them. */
export function collectExamTtsJobs(exam, lang) {
  const jobs = [];
  const seen = new Set();

  function addJob(text, voiceHint, meta) {
    const src = sanitizeTtsText(text);
    if (!src) return;
    const baseVoice = voiceHint || ttsVoiceForLang(lang);
    const prepared = ListeningScript.prepare(src, lang);
    if (prepared.length > 1) {
      for (const seg of prepared) {
        const voice = seg.voice || baseVoice;
        pushSingle(sanitizeTtsText(seg.text), voice, { ...meta, speaker: seg.speaker, multiVoice: true });
      }
      return;
    }
    // Same voice examRunner asks for: a single labelled turn is cast by gender.
    pushSingle(ListeningScript.singleVoiceText(src), ListeningScript.singleVoiceFor(src, lang, baseVoice), meta);
  }

  function pushSingle(text, voice, meta) {
    const key = `${voice}:${ttsTextHash(text)}`;
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push({ text, voice, lang, meta });
  }

  for (const part of exam.horenParts || []) {
    if (Array.isArray(part.segments) && part.segments.length) {
      part.segments.forEach((seg, si) => {
        addJob(seg.transcript, seg.ttsVoice || part.ttsVoice, {
          exam: exam.topic || exam.id,
          teil: part.teil,
          kind: 'segment',
          index: si,
        });
      });
    } else {
      addJob(part.transcript, part.ttsVoice, {
        exam: exam.topic || exam.id,
        teil: part.teil,
        kind: 'part',
      });
    }
  }

  if (exam.horen?.transcript) {
    addJob(exam.horen.transcript, exam.horen.ttsVoice, {
      exam: exam.topic || exam.id,
      kind: 'legacy',
    });
  }

  return jobs;
}
