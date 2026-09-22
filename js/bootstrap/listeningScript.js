/**
 * Parse listening transcripts into multi-speaker segments for TTS (phase 13e).
 */
const ListeningScript = (() => {
  const SPEAKER_RE = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .'-]{0,40}):\s*(.+)$/;

  // Flat list: [0] is the narrator / single-voice default. Kept for callers that only need
  // one voice; multi-speaker turns are cast by gender from VOICES_BY_GENDER below.
  const VOICES = {
    de: ['pNInz6obpgDQGcFmaJgB', 'JBFqnCBsd6RMkjVDRZzb', 'onwK4e9ZLuTAKqWW03F9'],
    en: ['Xb7hH8MSUJpSbSDYk0k2', 'JBFqnCBsd6RMkjVDRZzb', 'pNInz6obpgDQGcFmaJgB'],
    es: ['ErXwobaYiN019PkySvjV', 'JBFqnCBsd6RMkjVDRZzb', 'pNInz6obpgDQGcFmaJgB'],
  };

  // ElevenLabs premade voices. Casting by order of appearance gave the first speaker the
  // first voice whatever their gender: every German woman spoke with a male voice (all
  // three German voices were male) and English "Man:" openings got Alice.
  //   Matilda XrExE9yKIg1WjnnlVkGX · Alice Xb7hH8MSUJpSbSDYk0k2 · Lily pFZP5JQG7iQjIQuC4Bku (f)
  //   (Sarah EXAVitQu4vr4xnSDxMaL no longer exists on the account: voice_not_found, Sep 2026.)
  //   Adam pNInz6obpgDQGcFmaJgB · George JBFqnCBsd6RMkjVDRZzb · Daniel onwK4e9ZLuTAKqWW03F9 (m)
  const VOICES_BY_GENDER = {
    de: { f: ['XrExE9yKIg1WjnnlVkGX', 'Xb7hH8MSUJpSbSDYk0k2'], m: ['pNInz6obpgDQGcFmaJgB', 'JBFqnCBsd6RMkjVDRZzb', 'onwK4e9ZLuTAKqWW03F9'] },
    en: { f: ['Xb7hH8MSUJpSbSDYk0k2', 'pFZP5JQG7iQjIQuC4Bku'], m: ['JBFqnCBsd6RMkjVDRZzb', 'onwK4e9ZLuTAKqWW03F9'] },
  };

  const ROLE_GENDER = {
    frau: 'f', mutter: 'f', tochter: 'f', moderatorin: 'f', oma: 'f', schwester: 'f', lehrerin: 'f', professorin: 'f',
    woman: 'f', girl: 'f', mother: 'f', daughter: 'f', mrs: 'f', ms: 'f', miss: 'f',
    herr: 'm', mann: 'm', vater: 'm', sohn: 'm', moderator: 'm', opa: 'm', bruder: 'm', lehrer: 'm', professor: 'm',
    man: 'm', boy: 'm', father: 'm', son: 'm', mr: 'm',
  };
  // Every first name found in the served exams and the reusable pool (de + en, Sep 2026).
  const NAME_GENDER = (() => {
    const f = 'anna sophie hannah lena emma laura jana aylin marie dana nele lisa sofia mara mira sarah mia zara amina alina johanna helena melina julia anke martina elena lily kate emily maria monika petra';
    const m = 'tim erik ben jonas paul max markus lukas omar jan niklas florian leon mark noah felix moritz tobias tom emil dominik fabian thomas andreas klaus boris marc peter jack david marco';
    const out = {};
    f.split(' ').forEach((n) => { out[n] = 'f'; });
    m.split(' ').forEach((n) => { out[n] = 'm'; });
    return out;
  })();

  /** Label → 'f' | 'm' | null. Reads role words and first names; strips decoration
   *  ("● MARC", "«Lena", "Lena (Tochter, 12 Jahre)", "Moderator Müller"). */
  function speakerGender(label) {
    const clean = String(label || '')
      .replace(/\(([^)]*)\)/g, ' $1 ')
      .replace(/[^A-Za-zÀ-ÿ .'-]/g, ' ')
      .toLowerCase();
    const words = clean.split(/[\s.]+/).filter(Boolean);
    for (const w of words) if (ROLE_GENDER[w]) return ROLE_GENDER[w];
    for (const w of words) if (NAME_GENDER[w]) return NAME_GENDER[w];
    return null;
  }

  // First words that open a sentence, not a name: "Zum Schluss möchte ich betonen:",
  // "Und nun der Verkehr:", "Heute diskutieren wir:" were being read as speaker labels,
  // and the label is stripped before synthesis — those words vanished from the audio.
  const NOT_A_SPEAKER_START = new Set(
    'zum und heute nur schön wir zuerst außerdem denken zu am im in bei für mit nach das der die ein eine so also then and today first finally now'.split(' '),
  );
  function looksLikeSpeaker(label) {
    const core = String(label || '').replace(/\([^)]*\)/g, ' ').replace(/[^A-Za-zÀ-ÿ0-9 .'-]/g, ' ').trim();
    if (!core) return false;
    const words = core.split(/\s+/);
    if (NOT_A_SPEAKER_START.has(words[0].toLowerCase())) return false;
    // Names and roles are capitalised; a lowercase word means prose ("Denken Sie daran").
    return words.every((w) => /^[A-ZÀ-Ý0-9]/.test(w));
  }

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
      if (!speaker || speaker.split(/\s+/).length > SPEAKER_MAX_WORDS || !looksLikeSpeaker(speaker)) continue;
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
      if (m && looksLikeSpeaker(m[1])) {
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
    const byGender = VOICES_BY_GENDER[lang];
    if (!byGender) {
      // No gendered cast for this language (es): keep order-of-appearance casting.
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
    // Cast in order of appearance within each gender. Speakers with no readable gender
    // (Interviewer, Presenter, "A", a bare surname) take the gender with fewer speakers so
    // far, so a two-person dialogue still gets two distinct, contrasting voices.
    const map = {};
    const used = { f: 0, m: 0 };
    const genderOf = {};
    for (const seg of segments) {
      if (genderOf[seg.speaker] !== undefined) continue;
      genderOf[seg.speaker] = speakerGender(seg.speaker);
    }
    for (const seg of segments) {
      if (map[seg.speaker]) continue;
      let g = genderOf[seg.speaker];
      if (!g) g = used.f < used.m ? 'f' : 'm';
      const list = byGender[g];
      map[seg.speaker] = list[used[g] % list.length];
      used[g]++;
    }
    return segments.map((seg) => ({ ...seg, voice: map[seg.speaker] }));
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
      const speaker = segments[0]?.speaker || 'Narrator';
      // A single labelled turn ("Man: It's freezing…") still has a gender to honour.
      const g = speaker !== 'Narrator' ? speakerGender(speaker) : null;
      const cast = g && VOICES_BY_GENDER[lang] ? VOICES_BY_GENDER[lang][g][0] : voices[0];
      return [{
        speaker,
        text: singleVoiceText(text, segments),
        voice: cast,
      }];
    }
    const assigned = assignVoices(segments, lang);
    if (segmentsLookBroken(assigned) || assigned.length > 24) {
      const voices = defaultVoices(lang);
      return [{ speaker: 'Narrator', text: String(text).trim(), voice: voices[0] }];
    }
    return assigned;
  }

  /** Voice for a single-voice clip. An unlabelled announcement keeps `fallback` (the
   *  locale alias the cache has always used); a single labelled turn with a known gender
   *  ("Man: It's freezing…") gets a voice of that gender. examRunner and pregenerate-tts
   *  both call this, so the cache key they compute is the same. */
  function singleVoiceFor(text, lang, fallback) {
    const segs = parseSegments(text);
    if (segs.length !== 1 || segs[0].speaker === 'Narrator') return fallback;
    const g = speakerGender(segs[0].speaker);
    return g && VOICES_BY_GENDER[lang] ? VOICES_BY_GENDER[lang][g][0] : fallback;
  }

  function isMultiVoice(text, lang = 'de') {
    return prepare(text, lang).length > 1;
  }

  return { parseSegments, assignVoices, prepare, isMultiVoice, defaultVoices, singleVoiceText, singleVoiceFor, speakerGender, looksLikeSpeaker };
})();

if (typeof window !== 'undefined') window.ListeningScript = ListeningScript;
if (typeof module !== 'undefined') module.exports = ListeningScript;
