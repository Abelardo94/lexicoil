/**
 * Parse listening transcripts into multi-speaker segments for TTS (phase 13e).
 */
const ListeningScript = (() => {
  const SPEAKER_RE = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .'-]{0,40}):\s*(.+)$/;

  const VOICES = {
    de: ['pNInz6obpgDQGcFmaJgB', 'JBFqnCBsd6RMkjVDRZzb', 'onwK4e9ZLuTAKqWW03F9'],
    en: ['Xb7hH8MSUJpSbSDYk0k2', 'JBFqnCBsd6RMkjVDRZzb', 'pNInz6obpgDQGcFmaJgB'],
    es: ['ErXwobaYiN019PkySvjV', 'JBFqnCBsd6RMkjVDRZzb', 'pNInz6obpgDQGcFmaJgB'],
  };

  function defaultVoices(lang) {
    return VOICES[lang] || VOICES.en;
  }

  /** A speaker label only counts at a boundary: string start, newline, segment
   *  marker, or the end of the previous sentence. Without the boundary the old
   *  pattern started mid-sentence and swallowed the tail of the previous turn
   *  ("...keep going. Interviewer"), producing a >30 char speaker that
   *  segmentsLookBroken then collapsed to a single narrator voice. Periods stay
   *  out of the name for the same reason. */
  const INLINE_SPEAKER_RE =
    /(?:^|[\n\r]|[■●▲►◆•]\s*|[.!?…]["'”»]?\s+)["'«„“‹]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 '-]{0,24}?):\s+/g;
  const SPEAKER_MAX_WORDS = 3;

  function parseSegmentsInline(text) {
    const src = String(text || '').trim();
    const re = new RegExp(INLINE_SPEAKER_RE.source, 'g');
    const matches = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      const speaker = m[1].trim();
      // Reject prose that merely contains a colon ("...erfüllen muss: Brauchen Sie").
      if (!speaker || speaker.split(/\s+/).length > SPEAKER_MAX_WORDS) continue;
      matches.push({ speaker, labelAt: m.index, textAt: m.index + m[0].length });
      re.lastIndex = m.index + m[0].length;
    }
    if (matches.length < 2) return null;
    const segments = [];
    for (let i = 0; i < matches.length; i++) {
      const end = i + 1 < matches.length ? matches[i + 1].labelAt : src.length;
      segments.push({
        speaker: matches[i].speaker,
        text: src.slice(matches[i].textAt, end).trim(),
      });
    }
    return segments.filter((s) => s.text);
  }

  function parseSegments(text) {
    const lines = String(text || '')
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const segments = [];
    let currentSpeaker = null;
    let buffer = [];

    function flush() {
      if (!buffer.length) return;
      segments.push({
        speaker: currentSpeaker || 'Narrator',
        text: buffer.join(' ').trim(),
      });
      buffer = [];
    }

    for (const line of lines) {
      const m = line.match(SPEAKER_RE);
      if (m) {
        flush();
        currentSpeaker = m[1].trim();
        buffer.push(m[2].trim());
      } else {
        buffer.push(line);
      }
    }
    flush();

    if (segments.length <= 1) {
      const inline = parseSegmentsInline(text);
      if (inline?.length > 1) return inline;
    }

    // One labelled turn ("Man: It's freezing…") parses fine — keep it. Falling
    // through to the Narrator branch below would hand the raw line to TTS, which
    // then reads the label out loud.
    if (segments.length === 1 && segments[0].speaker !== 'Narrator') {
      return segments;
    }

    if (segments.length <= 1 && text) {
      return [{ speaker: 'Narrator', text: String(text).trim() }];
    }
    return segments;
  }

  function assignVoices(segments, lang) {
    const voices = defaultVoices(lang);
    const map = {};
    let vi = 0;
    return segments.map((seg) => {
      if (!map[seg.speaker]) {
        map[seg.speaker] = voices[vi % voices.length];
        vi++;
      }
      return { ...seg, voice: map[seg.speaker] };
    });
  }

  function segmentsLookBroken(segments) {
    return segments.some(
      (s) =>
        !String(s.text || '').trim() ||
        String(s.speaker || '').length > 30 ||
        /^(n|im|moment)$/i.test(String(s.speaker || '').trim()),
    );
  }

  /** Text handed to a single-voice TTS job. When the whole transcript is one
   *  labelled turn ("Man: It's freezing outside today!"), the label must not reach
   *  the synthesizer — it gets read out loud. Unlabelled transcripts (Teil 3/4
   *  announcements) pass through untouched. Callers that resolve TTS text outside
   *  prepare() must use this so the cache key matches what was pregenerated. */
  function singleVoiceText(text, segments) {
    const segs = segments || parseSegments(text);
    if (segs.length === 1) return String(segs[0].text || '').trim();
    return String(text || '').trim();
  }

  function prepare(text, lang) {
    const segments = parseSegments(text);
    if (segments.length <= 1 && text) {
      const voices = defaultVoices(lang);
      return [{
        speaker: segments[0]?.speaker || 'Narrator',
        text: singleVoiceText(text, segments),
        voice: voices[0],
      }];
    }
    const assigned = assignVoices(segments, lang);
    if (segmentsLookBroken(assigned) || assigned.length > 24) {
      const voices = defaultVoices(lang);
      return [{ speaker: 'Narrator', text: String(text).trim(), voice: voices[0] }];
    }
    return assigned;
  }

  function isMultiVoice(text, lang = 'de') {
    return prepare(text, lang).length > 1;
  }

  return { parseSegments, assignVoices, prepare, isMultiVoice, defaultVoices, singleVoiceText };
})();

if (typeof window !== 'undefined') window.ListeningScript = ListeningScript;
if (typeof module !== 'undefined') module.exports = ListeningScript;
