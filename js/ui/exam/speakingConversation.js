/**
 * Pro Sprechen: turn-based AI partner conversation (v1).
 * Mic → editable transcript → speaking-chat → partner text (+ optional TTS).
 */
const SpeakingConversation = (() => {
  const _state = Object.create(null);

  function personalities() {
    const level =
      typeof S !== 'undefined' && S.level
        ? S.level
        : typeof SpeakingModes?.normalizeLevel === 'function'
          ? SpeakingModes.normalizeLevel('B1')
          : 'B1';
    if (typeof SpeakingModes?.personalitiesForLevel === 'function') {
      return SpeakingModes.personalitiesForLevel(level);
    }
    return SpeakingModes?.REALTIME_PERSONALITIES || [];
  }

  function partKey(part) {
    return part.fieldId || `speak_bp_${part.teil || 1}`;
  }

  function stateFor(part) {
    const k = partKey(part);
    if (!_state[k]) {
      _state[k] = {
        personaId: 'balanced',
        inputMode: SpeakingModes?.INPUT_MODES?.PARTNER || 'partner',
        uiMode: 'text',
        sessionId: null,
        transcript: '',
        turns: [],
        consent: false,
        situation: part.situation || '',
        teil: Number(part.teil) || 1,
      };
    }
    return _state[k];
  }

  function renderTurnsHtml(fieldId, turns) {
    if (!turns?.length) return '';
    return turns
      .map((t) => {
        const who = t.role === 'partner' ? 'Partner' : 'Du';
        const cls = t.role === 'partner' ? 'speak-turn--partner' : 'speak-turn--user';
        return `<div class="speak-turn ${cls}"><b>${esc(who)}:</b> ${esc(t.text || '')}</div>`;
      })
      .join('');
  }

  function renderPartShell(part, ui) {
    const k = partKey(part);
    const de = ui?.lang === 'de';
    const personas = personalities();
    const st = stateFor(part);
    st.situation = part.situation || st.situation || '';
    const pills = personas
      .map((p) => {
        const active = st.personaId === p.id ? ' active' : '';
        const lbl = de ? p.labelDe : p.label;
        return `<button type="button" class="speak-persona-pill${active}" data-persona="${esc(p.id)}" onclick="SpeakingConversation.selectPersona('${esc(k)}','${esc(p.id)}')">${esc(lbl)}</button>`;
      })
      .join('');

    const level = (typeof S !== 'undefined' && S.level) || 'B1';
    const persona = SpeakingModes?.personalityById(st.personaId, level);
    const personaDesc = persona ? (de ? persona.descDe : persona.desc) : '';
    const creditSuffix =
      typeof aiCreditCostSuffix === 'function' ? aiCreditCostSuffix('speaking_realtime') : ' (4 credits)';

    const aiPath = `
      <div class="speak-path speak-path--ai">
        <div class="speak-path-head">${de ? 'Mit KI-Partner' : 'With AI partner'}</div>
        <p class="speak-path-lead">${de ? 'Kim, Alex oder Leo — Gespräch Zug um Zug (Mikrofon → Text → Antwort).' : 'Kim, Alex or Leo — turn-based chat (mic → text → reply).'}</p>
        <div class="speak-persona-picker" role="group" aria-label="${de ? 'Gesprächspartner' : 'Conversation partner'}">${pills}</div>
        <p class="speak-persona-desc" id="speakPersonaDesc_${esc(k)}">${esc(personaDesc)}</p>
        <div class="speak-mode-tabs" id="speakModeTabs_${esc(k)}" hidden>
          <button type="button" class="speak-mode-tab active" data-mode="text" onclick="SpeakingConversation.setUiMode('${esc(k)}','text')">${de ? 'Text-Chat' : 'Text chat'}</button>
          <button type="button" class="speak-mode-tab" data-mode="voice" onclick="SpeakingConversation.setUiMode('${esc(k)}','voice')">${de ? 'Stimme' : 'Voice'}</button>
        </div>
        <div id="speakTextMode_${esc(k)}">
        <label class="speak-consent" id="speakConsentWrap_${esc(k)}">
          <input type="checkbox" id="speakConsent_${esc(k)}" onchange="SpeakingConversation.setConsent('${esc(k)}', this.checked)">
          ${de ? 'Ich stimme zu, dass mein Gesprächstext für diese Übungssitzung gespeichert wird (löschbar).' : 'I agree that my conversation text is stored for this practice session (deletable).'}
        </label>
        <div class="speak-conv-panel" id="speakConv_${esc(k)}">
          <div class="speak-conv-status" id="speakConvStatus_${esc(k)}">${de ? 'Partner wählen, zustimmen und starten.' : 'Pick a partner, consent, then start.'}</div>
          <div class="speak-conv-transcript-live" id="speakConvLive_${esc(k)}"></div>
          <div class="speak-conv-actions">
            <button type="button" class="btn-sm accent" id="speakConvStart_${esc(k)}" onclick="SpeakingConversation.startSession('${esc(k)}')">${de ? 'Gespräch starten' : 'Start conversation'}${creditSuffix}</button>
            <button type="button" class="btn-sm" id="speakConvDelete_${esc(k)}" style="display:none" onclick="SpeakingConversation.deleteSession('${esc(k)}')">${de ? 'Sitzung löschen' : 'Delete session'}</button>
          </div>
          <div class="speak-turn-compose" id="speakTurnCompose_${esc(k)}" hidden>
            <div class="speak-path-hint">${de ? 'Sprich oder tippe, prüfe den Text, dann senden.' : 'Speak or type, check the text, then send.'}</div>
            ${typeof renderSpeakingMicHtml === 'function' ? renderSpeakingMicHtml(k + '_turn', typeof S !== 'undefined' ? S.subject : ui?.lang || 'de') : `<textarea class="write-field" id="${esc(k)}_turn" style="min-height:100px"></textarea>`}
            <button type="button" class="btn-sm accent" id="speakConvSend_${esc(k)}" onclick="SpeakingConversation.sendTurn('${esc(k)}')">${de ? 'Zug senden' : 'Send turn'}</button>
          </div>
        </div>
        </div>
        ${typeof SpeakingLiveVoice !== 'undefined' ? SpeakingLiveVoice.renderPanel(k, ui) : ''}
      </div>`;

    const soloPath = `
      <div class="speak-path speak-path--solo" id="speakSoloPath_${esc(k)}">
        <div class="speak-path-head">${de ? 'Nur Aufnahme' : 'Record only'}</div>
        <p class="speak-path-hint">${(typeof escKeepBold==='function'?escKeepBold:esc)(ui.speakFmt || (de ? 'Sprich ins Mikrofon — dein Text erscheint unten.' : 'Speak into the mic — your words appear below.'))}</p>
        ${typeof renderSpeakingMicHtml === 'function' ? renderSpeakingMicHtml(k, typeof S !== 'undefined' ? S.subject : ui?.lang || 'de') : `<textarea class="write-field" id="${esc(k)}" style="min-height:160px"></textarea>`}
      </div>`;

    return `
      <div class="speak-path-stack">
        ${aiPath}
        ${soloPath}
      </div>
      <textarea class="speak-conv-meta" id="${esc(k)}_meta" aria-hidden="true" tabindex="-1"></textarea>
    `;
  }

  function selectPersona(fieldId, personaId) {
    const st = _state[fieldId];
    if (!st) return;
    st.personaId = personaId;
    const root = document.querySelector(`.speak-part[data-field-id="${fieldId}"]`);
    if (root) {
      root.querySelectorAll('.speak-persona-pill').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.persona === personaId);
      });
    }
    const level = typeof S !== 'undefined' && S.level ? S.level : 'B1';
    const persona = SpeakingModes?.personalityById(personaId, level);
    const descEl = document.getElementById('speakPersonaDesc_' + fieldId);
    if (descEl && persona) {
      const de = typeof S !== 'undefined' && S.subject === 'de';
      descEl.textContent = de ? persona.descDe : persona.desc;
    }
    syncMeta(fieldId);
    if (typeof SpeakingLiveVoice !== 'undefined') SpeakingLiveVoice.setPersona(fieldId, personaId);
  }

  function setUiMode(fieldId, mode) {
    const st = _state[fieldId];
    if (!st) return;
    st.uiMode = mode === 'voice' ? 'voice' : 'text';
    const tabs = document.getElementById('speakModeTabs_' + fieldId);
    tabs?.querySelectorAll('.speak-mode-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === st.uiMode);
    });
    const textWrap = document.getElementById('speakTextMode_' + fieldId);
    if (textWrap) textWrap.hidden = st.uiMode === 'voice';
    if (typeof SpeakingLiveVoice !== 'undefined') {
      if (st.uiMode === 'voice') SpeakingLiveVoice.showPanel(fieldId);
      else SpeakingLiveVoice.hidePanel(fieldId);
    }
    syncMeta(fieldId);
  }

  async function upgradePilotUi(fieldId, part) {
    if (typeof SpeakingVoicePilot === 'undefined') return;
    await SpeakingVoicePilot.load();
    if (!SpeakingVoicePilot.isEligible()) return;
    const tabs = document.getElementById('speakModeTabs_' + fieldId);
    if (tabs) tabs.hidden = false;
    if (typeof SpeakingLiveVoice !== 'undefined') {
      SpeakingLiveVoice.initPart(fieldId, part, _state[fieldId]?.personaId);
    }
  }

  function setLiveVoiceResult(fieldId, { sessionId, turns, transcript, inputMode }) {
    const st = _state[fieldId];
    if (!st) return;
    st.sessionId = sessionId || st.sessionId;
    st.turns = turns || [];
    st.transcript = transcript || '';
    st.inputMode = inputMode || SpeakingModes?.INPUT_MODES?.VOICE_LIVE || 'voice_live';
    st.uiMode = 'voice';
    renderLive(fieldId);
    syncMeta(fieldId);
  }

  function setConsent(fieldId, checked) {
    const st = _state[fieldId];
    if (!st) return;
    st.consent = !!checked;
    syncMeta(fieldId);
  }

  function syncMeta(fieldId) {
    const st = _state[fieldId];
    const meta = document.getElementById(fieldId + '_meta');
    if (!meta || !st) return;
    const fullTranscript = (st.turns || [])
      .map((t) => `${t.role === 'partner' ? 'Partner' : 'Ich'}: ${t.text}`)
      .join('\n');
    st.transcript = fullTranscript;
    const hidden = document.getElementById(fieldId);
    if (
      hidden &&
      hidden !== document.querySelector(`#speakSoloPath_${fieldId} textarea`) &&
      (hidden.offsetParent === null || hidden.getAttribute('aria-hidden') === 'true')
    ) {
      hidden.value = fullTranscript;
    }
    meta.value = JSON.stringify({
      inputMode: st.inputMode,
      uiMode: st.uiMode,
      personaId: st.personaId,
      sessionId: st.sessionId,
      consent: st.consent,
      transcript: fullTranscript,
      turns: st.turns,
    });
    if (typeof updProg === 'function') updProg();
  }

  function renderLive(fieldId) {
    const st = _state[fieldId];
    const live = document.getElementById('speakConvLive_' + fieldId);
    if (live && st) live.innerHTML = renderTurnsHtml(fieldId, st.turns);
    syncMeta(fieldId);
  }

  function showTranscriptFallback(fieldId) {
    const st = _state[fieldId];
    if (st) st.inputMode = SpeakingModes?.INPUT_MODES?.TRANSCRIPT || 'transcript';
    const solo = document.getElementById('speakSoloPath_' + fieldId);
    solo?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (typeof initSpeakingMic === 'function') initSpeakingMic(fieldId, S?.subject);
    syncMeta(fieldId);
  }

  async function startSession(fieldId) {
    const st = _state[fieldId];
    if (!st) return;
    const status = document.getElementById('speakConvStatus_' + fieldId);
    const btn = document.getElementById('speakConvStart_' + fieldId);
    const level = (typeof S !== 'undefined' && S.level) || 'B1';
    const persona = SpeakingModes?.personalityById(st.personaId, level);
    const de = S?.subject === 'de';

    if (typeof isPaidPlan === 'function' && !isPaidPlan()) {
      if (typeof requireProOnlyAction === 'function') requireProOnlyAction('speaking_realtime');
      return;
    }
    if (!st.consent) {
      if (typeof lcToast === 'function') {
        lcToast(de ? 'Bitte Zustimmung zur Speicherung der Sitzung.' : 'Please consent to session storage.', 'warn');
      }
      return;
    }
    if (typeof requireAiCredits === 'function' && !requireAiCredits('speaking_realtime')) return;

    if (status) status.textContent = de ? 'Starte Gespräch…' : 'Starting…';
    if (btn) btn.disabled = true;

    try {
      const endpoint = SpeakingModes?.PARTNER_CHAT?.endpoint || '/.netlify/functions/speaking-chat';
      const res = await lcFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          consent: true,
          personaId: st.personaId,
          verbosity: persona?.verbosity,
          teil: st.teil,
          subject: S?.subject,
          level: S?.level,
          examId: S?.examData?.examId || S?.examData?.id,
          fieldId,
          situation: st.situation,
          requestId: `speak-${fieldId}-${Date.now()}`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (status) status.textContent = de ? 'Start fehlgeschlagen.' : 'Could not start.';
        if (typeof lcToast === 'function') lcToast(data.error || res.statusText, 'error');
        return;
      }
      st.sessionId = data.session?.sessionId || null;
      st.turns = data.session?.turns || [];
      st.whoStarts = data.whoStarts || data.session?.whoStarts || (st.turns[0]?.role === 'partner' ? 'partner' : 'user');
      st.inputMode = SpeakingModes?.INPUT_MODES?.PARTNER || 'partner';
      renderLive(fieldId);
      const compose = document.getElementById('speakTurnCompose_' + fieldId);
      if (compose) {
        compose.hidden = false;
        if (typeof initSpeakingMic === 'function') initSpeakingMic(fieldId + '_turn', S?.subject);
      }
      const del = document.getElementById('speakConvDelete_' + fieldId);
      if (del) del.style.display = 'inline-flex';
      if (status) {
        if (st.whoStarts === 'user') {
          status.textContent = de
            ? `Du beginnst — die Aufgabe steht oben. Sprich oder tippe zuerst, dann sende.`
            : `You start — the task is above. Speak or type first, then send.`;
        } else {
          status.textContent = de
            ? `Gespräch mit ${persona?.displayName || 'Partner'} — sprich, prüfe, sende.`
            : `Chat with ${persona?.displayName || 'partner'} — speak, check, send.`;
        }
      }
      const last = st.turns[st.turns.length - 1];
      if (
        last?.role === 'partner' &&
        st.uiMode !== 'voice' &&
        typeof speak === 'function' &&
        last.text
      ) {
        try {
          speak(last.text, S?.subject === 'de' ? 'de-DE' : 'en-GB');
        } catch (_) {}
      }
    } catch (e) {
      if (status) status.textContent = de ? 'Verbindung fehlgeschlagen.' : 'Connection failed.';
      if (typeof lcToast === 'function') lcToast(String(e.message || e), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function sendTurn(fieldId) {
    const st = _state[fieldId];
    if (!st?.sessionId) return;
    const de = S?.subject === 'de';
    const ta = document.getElementById(fieldId + '_turn');
    const text = (ta?.value || '').trim();
    if (!text) {
      if (typeof lcToast === 'function') lcToast(de ? 'Kein Text zum Senden.' : 'Nothing to send.', 'warn');
      return;
    }
    const status = document.getElementById('speakConvStatus_' + fieldId);
    const sendBtn = document.getElementById('speakConvSend_' + fieldId);
    if (sendBtn) sendBtn.disabled = true;
    if (status) status.textContent = de ? 'Partner antwortet…' : 'Partner is replying…';

    try {
      const endpoint = SpeakingModes?.PARTNER_CHAT?.endpoint || '/.netlify/functions/speaking-chat';
      const res = await lcFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'turn', sessionId: st.sessionId, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (typeof lcToast === 'function') lcToast(data.error || 'turn_failed', 'error');
        return;
      }
      st.turns = data.session?.turns || st.turns;
      if (ta) ta.value = '';
      renderLive(fieldId);
      const last = st.turns[st.turns.length - 1];
      if (
        last?.role === 'partner' &&
        st.uiMode !== 'voice' &&
        typeof speak === 'function' &&
        last.text
      ) {
        try {
          speak(last.text, S?.subject === 'de' ? 'de-DE' : 'en-GB');
        } catch (_) {}
      }
      if (status) status.textContent = de ? 'Dein Zug — weiter sprechen oder senden.' : 'Your turn — speak or send again.';
    } catch (e) {
      if (typeof lcToast === 'function') lcToast(String(e.message || e), 'error');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  async function deleteSession(fieldId) {
    const st = _state[fieldId];
    if (!st?.sessionId) return;
    const de = S?.subject === 'de';
    try {
      const endpoint = SpeakingModes?.PARTNER_CHAT?.endpoint || '/.netlify/functions/speaking-chat';
      await lcFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', sessionId: st.sessionId }),
      });
    } catch (_) {}
    st.sessionId = null;
    st.turns = [];
    st.transcript = '';
    renderLive(fieldId);
    const compose = document.getElementById('speakTurnCompose_' + fieldId);
    if (compose) compose.hidden = true;
    const del = document.getElementById('speakConvDelete_' + fieldId);
    if (del) del.style.display = 'none';
    const status = document.getElementById('speakConvStatus_' + fieldId);
    if (status) status.textContent = de ? 'Sitzung gelöscht.' : 'Session deleted.';
    if (typeof lcToast === 'function') lcToast(de ? 'Sitzung gelöscht.' : 'Session deleted.', 'ok');
  }

  function initPart(part, subject) {
    const k = partKey(part);
    stateFor(part);
    syncMeta(k);
    upgradePilotUi(k, part);
    if (typeof initSpeakingMic === 'function') initSpeakingMic(k, subject);
  }

  function collectPartAnswer(part) {
    const k = partKey(part);
    const st = _state[k];
    if (st?.inputMode === (SpeakingModes?.INPUT_MODES?.VOICE_LIVE || 'voice_live') && st.transcript) {
      syncMeta(k);
      return {
        fieldId: k,
        inputMode: SpeakingModes?.INPUT_MODES?.VOICE_LIVE || 'voice_live',
        personaId: st.personaId,
        sessionId: st.sessionId,
        transcript: st.transcript,
        turns: st.turns,
      };
    }
    const soloTa = document.querySelector(`#speakSoloPath_${k} textarea, #speakSoloPath_${k} .write-field`);
    const soloText = soloTa?.value?.trim() || '';
    if (soloText && !st?.sessionId) {
      return {
        fieldId: k,
        inputMode: SpeakingModes?.INPUT_MODES?.TRANSCRIPT || 'transcript',
        personaId: st?.personaId,
        transcript: soloText,
      };
    }
    if (st?.inputMode === (SpeakingModes?.INPUT_MODES?.TRANSCRIPT || 'transcript')) {
      const ta = document.getElementById(k);
      if (ta?.value?.trim()) {
        return {
          fieldId: k,
          inputMode: SpeakingModes?.INPUT_MODES?.TRANSCRIPT || 'transcript',
          personaId: st?.personaId,
          transcript: ta.value.trim(),
        };
      }
    }
    syncMeta(k);
    return {
      fieldId: k,
      inputMode: SpeakingModes?.INPUT_MODES?.PARTNER || 'partner',
      personaId: st?.personaId,
      sessionId: st?.sessionId,
      transcript: st?.transcript || '',
      turns: st?.turns || [],
    };
  }

  return {
    renderPartShell,
    selectPersona,
    setConsent,
    setUiMode,
    setLiveVoiceResult,
    upgradePilotUi,
    showTranscriptFallback,
    startSession,
    sendTurn,
    deleteSession,
    initPart,
    initForExam(parts, subject) {
      (parts || []).forEach((p) => initPart(p, subject));
    },
    collectPartAnswer,
  };
})();

if (typeof window !== 'undefined') window.SpeakingConversation = SpeakingConversation;
