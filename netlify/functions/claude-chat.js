'use strict';

const { checkQuota, incrementQuota, decrementQuota, getQuotaState, checkPersonalPoolQuota, incrementPersonalPoolQuota } = require('./lib/quotaLib.js');
const { corsHeaders, jsonResponse } = require('./lib/http.js');
const { validateGeneratedExam, verifyAnswerKeysWithAI, verifyAndSanitizePersonalExam } = require('./lib/examQualityGate.js');
const {
  isAllowLiveGenEnabled,
  liveGenDisabledResponse,
  verifyUnavailableResponse,
} = require('./lib/liveGenGate.js');
const { verifyTopicCoherenceExam } = require('./lib/topicCoherenceGate.js');
const { resolveBlueprint } = require('../../js/engine/validation/blueprintResolver.js');
const {
  extractJsonObject,
  certName,
  requireProPlan,
  requireActionAccess,
  feedbackLevelForPlan,
  callAnthropicJson,
} = require('./lib/proAiModes.js');
const { getAiCredits, checkAiCredits, confirmAiCreditConsumption, releaseAiCreditConsumption } = require('./lib/aiCredits.js');
const { getStoreForEvent } = require('./lib/blobStore.js');
const { checkIpRateLimit, recordIpRateLimitHit } = require('./lib/ipRateLimit.js');
const { gatePersonalExamChunk } = require('./lib/webPartGate.js');
const { casWriteJson } = require('./lib/casBlob.js');
const { linkTicketQuotaCharge, releaseGenerationQuota, deliverGenerationQuota, renewGenerationTicket, ticketSubForQuotaState, assertGenerationTicketOwner } = require('./lib/releaseGeneration.js');
const { parseRequestId } = require('./lib/requestId.js');
const {
  validateQuizOptionsQuality,
  repairQuizOptions,
  weightedPickQuizTargets,
} = require('./lib/vocabQuizUtils.js');
const {
  normalizeSeparablePhraseItem,
  buildSeparablePromptRules,
  isSeparableTarget,
} = require('./lib/vocabPhrasesUtils.js');
const { synthesize } = require('./lib/ttsProvider.js');
const { resolveVoiceId } = require('./lib/ttsVoices.js');
const {
  detectAppearedWords,
  pickWordsForPassage,
  validateListeningPassage,
  shouldBillListeningAiSession,
  pickWeaveForRound,
  listeningE2ePassageForRound,
  LISTENING_AI_ROUND_COUNT,
} = require('./lib/listeningGameUtils.js');
const {
  callGeminiProductJson,
  rejectMissingGeminiKey,
  productGeminiModel,
} = require('./lib/geminiProductJson.js');
const { getJwtSecret, emailToUserId } = require('./lib/authLib.js');
const {
  createGenTicket,
  verifyGenTicket,
  TICKETED_SCOPES,
  MAX_CHUNKS_ALLOWED,
} = require('./lib/genTicket.js');
const sb = require('./lib/supabaseAdmin.js');
const {
  readAnthropicKey,
  anthropicKeyFingerprint,
  rejectBadAnthropicKey,
} = require('./lib/anthropicKey.js');
const {
  runProductionEval,
  writingCorrectionPrompt,
  writingScoreExtensionPrompt,
  normalizeSchreibenItem,
} = require('./lib/productionEval.js');

async function consumeGenTicketChunk(event, genTicket) {
  const secret = getJwtSecret();
  if (!secret) return { error: 'misconfigured', status: 503 };
  const ticketPayload = verifyGenTicket(genTicket, secret);
  if (!ticketPayload) return { error: 'ticket_invalid', status: 403 };
  if (!TICKETED_SCOPES.has(ticketPayload.scope)) {
    return { error: 'ticket_scope_invalid', status: 403 };
  }
  const store = getStoreForEvent(event);
  const ticketKey = `gentk:${ticketPayload.nonce}`;
  const counterResult = await casWriteJson(
    store,
    ticketKey,
    (current) => {
      const used = (current?.chunksUsed || 0) + 1;
      if (used > ticketPayload.maxChunks) {
        return { skip: true, result: { error: 'chunks_exceeded', used, max: ticketPayload.maxChunks } };
      }
      return {
        payload: { chunksUsed: used, maxChunks: ticketPayload.maxChunks },
        result: { ok: true, chunksUsed: used, payload: ticketPayload },
      };
    },
    { logTag: '[gentk-prod-eval]' },
  ).catch((err) => {
    console.error('[claude-chat] prod eval chunk counter error:', err.message);
    return { error: 'counter_error', status: 503 };
  });
  if (counterResult?.error) {
    return { error: counterResult.error, status: 403, used: counterResult.used, max: counterResult.max };
  }
  return { ok: true, payload: counterResult.result?.payload || ticketPayload };
}

async function logExamGenChunk(event, genTicketPayload, body, { ok, model, usage }) {
  if (!sb.isConfigured()) return;
  try {
    let email = null;
    let userId = null;
    const qState = await getQuotaState(event).catch(() => null);
    if (qState?.ok && qState.authenticated) {
      email = qState.email;
    } else if (genTicketPayload?.sub && !String(genTicketPayload.sub).startsWith('guest:')) {
      email = genTicketPayload.sub;
    }
    if (email) {
      const profile = await sb.getUserProfileByEmail(email);
      userId = profile?.id || emailToUserId(email);
    }
    await sb.insertGeneration({
      user_id: userId,
      email,
      lang: body.lang || null,
      level: body.level || null,
      source: 'ai',
      model: model || null,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      valid: !!ok,
    });
  } catch (err) {
    console.error('[claude-chat] insertGeneration failed:', err.message);
  }
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
// Exam generation defaults to Sonnet; override with CLAUDE_EXAM_MODEL.
const EXAM_MODEL = 'claude-sonnet-4-6';
const MAX_PROMPT_LEN = 16000;
const MAX_TOKENS = 16384;

async function refundExamQuota(quotaCheck, requestId) {
  if (!quotaCheck) return;
  try {
    await decrementQuota(quotaCheck, { requestId: requestId || null });
  } catch (err) {
    console.error('[claude-chat] quota refund failed:', err.message);
  }
}

async function refundAiCredits(event, action, requestId) {
  if (!requestId || !action) return;
  try {
    await releaseAiCreditConsumption(event, action, { requestId });
  } catch (err) {
    console.error('[claude-chat] ai credit refund failed:', err.message);
  }
}

function cleanModel(raw) {
  const m = String(raw || '').trim();
  if (!m) return DEFAULT_MODEL;
  if (!m.startsWith('claude-')) return DEFAULT_MODEL;
  return m;
}

/**
 * Models a request may ask for. The body is attacker-controlled: without this list
 * `examModel` / `model` let any caller (a guest included) run the most expensive
 * Claude model on our key. The app itself only ever asks for the two below.
 */
function allowedRequestModels() {
  return new Set(
    [
      DEFAULT_MODEL,
      EXAM_MODEL,
      process.env.CLAUDE_MODEL,
      process.env.CLAUDE_EXAM_MODEL,
    ]
      .map((m) => String(m || '').trim())
      .filter((m) => m.startsWith('claude-')),
  );
}

function pickRequestModel(requested, fallback) {
  const r = String(requested || '').trim();
  if (r && allowedRequestModels().has(r)) return r;
  if (r) console.warn('[claude-chat] ignored model not on the allowlist:', r.slice(0, 60));
  return cleanModel(fallback);
}

const SPELL_WORD_MAX = 64;
const SPELL_LIMIT = 120;
const SPELL_WINDOW_MS = 60 * 60 * 1000;

function parseBody(event) {
  let raw = event.body;
  if (event.isBase64Encoded && typeof raw === 'string') {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }
  return JSON.parse(raw || '{}');
}

exports.handler = async function handler(event) {
  const cors = corsHeaders(event, 'POST, OPTIONS');

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, cors, { error: 'method_not_allowed' });
  }

  let body;
  try {
    body = parseBody(event);
  } catch (_) {
    return jsonResponse(400, cors, { error: 'invalid_json' });
  }

  // ── spellCheckWord (lightweight Haiku hint — no credits) ─────────────────
  if (body.spellCheckWord === true) {
    const word = String(body.word || '').trim();
    const lang = String(body.lang || 'de').slice(0, 2);
    if (!word || word.length < 2) {
      return jsonResponse(400, cors, { error: 'word_required' });
    }
    // No login and no credits on this path: it must stay a spell check. An uncapped
    // "word" was a free, unmetered prompt to the model for anyone who found the endpoint.
    if (word.length > SPELL_WORD_MAX || /[\r\n]/.test(word)) {
      return jsonResponse(400, cors, { error: 'word_too_long' });
    }
    const spellStore = getStoreForEvent(event);
    const spellRl = await checkIpRateLimit(spellStore, event, 'ratelimit_spell', {
      limit: SPELL_LIMIT,
      windowMs: SPELL_WINDOW_MS,
    });
    if (!spellRl.ok) {
      return jsonResponse(200, cors, { correct: true, suggestion: null, skipped: true });
    }
    await recordIpRateLimitHit(spellStore, { ...spellRl, windowMs: SPELL_WINDOW_MS });
    const apiKey = readAnthropicKey();
    const badKey = rejectBadAnthropicKey(apiKey, jsonResponse, cors);
    if (badKey) return badKey;
    const langName = lang === 'de' ? 'German' : lang === 'es' ? 'Spanish' : 'English';
    const spellModel = cleanModel(process.env.CLAUDE_SPELL_MODEL || 'claude-haiku-4-5');
    try {
      const { text } = await callAnthropicJson(apiKey, {
        model: spellModel,
        maxTokens: 120,
        system: `You check ${langName} spelling for vocabulary learners. Reply ONLY JSON: {"correct":true} or {"correct":false,"suggestion":"..."}. suggestion must be the standard spelling in ${langName}, or null if correct.`,
        userContent: `Word: ${JSON.stringify(word)}`,
      });
      const parsed = extractJsonObject(text);
      return jsonResponse(200, cors, {
        correct: parsed?.correct === true,
        suggestion: parsed?.suggestion ? String(parsed.suggestion).trim() : null,
      });
    } catch (err) {
      console.warn('[claude-chat] spellCheckWord failed:', err.message);
      return jsonResponse(200, cors, { correct: true, suggestion: null, skipped: true });
    }
  }

  // ── validateExam branch (C-2: quota-gated) ──────────────────────────────
  if (body.validateExam === true && body.exam) {
    const personalVerifyPath =
      body.verifyAnswerKeys === true && body.discardFailedItems === true;
    if (personalVerifyPath && !isAllowLiveGenEnabled()) {
      return liveGenDisabledResponse(jsonResponse, cors);
    }
    try {
      const quotaGate = await checkQuota(event).catch(() => null);
      if (!quotaGate || !quotaGate.ok) {
        return jsonResponse(quotaGate?.status || 429, cors, {
          error: quotaGate?.error || 'quota_exceeded',
          used: quotaGate?.used,
          max: quotaGate?.max,
          plan: quotaGate?.plan,
        });
      }
      const apiKey = readAnthropicKey();
      const badKey = rejectBadAnthropicKey(apiKey, jsonResponse, cors);
      if (badKey) return badKey;
      const blueprint = body.blueprint === false ? null : resolveBlueprint(body.exam, body.blueprint);
      const gateOpts = { blueprint };
      if (body.partialExam === true || body.partialExam === false) {
        gateOpts.partialExam = body.partialExam;
      }
      const gate = validateGeneratedExam(body.exam, gateOpts);
      if (!gate.valid) {
        console.warn('[claude-chat] exam validation rejected:', gate.errors);
        return jsonResponse(422, cors, {
          error: 'exam_invalid',
          message: 'Generated exam failed answer-key validation',
          validationErrors: gate.errors,
        });
      }
      if (body.verifyAnswerKeys === true && body.discardFailedItems === true) {
        if (process.env.EXAM_ANSWER_KEY_VERIFY !== '1') {
          return verifyUnavailableResponse(jsonResponse, cors, 'verify_disabled');
        }
        try {
          const sanitizeOpts = { blueprint };
          if (body.partialExam === true || body.partialExam === false) {
            sanitizeOpts.partialExam = body.partialExam;
          }
          const sanitized = await verifyAndSanitizePersonalExam(body.exam, apiKey, sanitizeOpts);
          if (sanitized.verifySkipped) {
            return verifyUnavailableResponse(jsonResponse, cors, sanitized.verifySkipReason || 'verify_skipped');
          }
          if (!sanitized.valid || !sanitized.renderable) {
            console.warn('[claude-chat] personal exam empty after verify discard:', sanitized.errors);
            return jsonResponse(422, cors, {
              error: sanitized.emptyAfterVerify ? 'exam_empty_after_verify' : 'exam_invalid',
              message: sanitized.emptyAfterVerify
                ? 'No verifiable exam content remained after answer-key checks'
                : 'Generated exam failed validation after sanitization',
              validationErrors: sanitized.errors?.length
                ? sanitized.errors
                : ['exam_empty_after_verify'],
              discarded: sanitized.discarded,
            });
          }
          return jsonResponse(200, cors, {
            valid: true,
            exam: sanitized.exam,
            discarded: sanitized.discarded,
            placeholders: gate.placeholders,
          });
        } catch (err) {
          console.warn('[claude-chat] verify sanitize error:', err.message);
          return verifyUnavailableResponse(jsonResponse, cors, err.message || 'verify_error');
        }
      }
      if (body.verifyAnswerKeys === true) {
        try {
          const verify = await verifyAnswerKeysWithAI(body.exam, apiKey);
          if (!verify.ok && !verify.skipped) {
            console.warn('[claude-chat] answer-key verify mismatch:', verify.discrepancies);
            if (body.genTicket) {
              try {
                await releaseGenerationQuota(event, { genTicket: body.genTicket });
              } catch (relErr) {
                console.warn('[claude-chat] quota release failed:', relErr.message);
              }
            }
            return jsonResponse(422, cors, {
              error: 'exam_invalid',
              message: 'Answer-key verification mismatch',
              validationErrors: ['answer_key_verify_mismatch'],
              discrepancies: verify.discrepancies,
            });
          }
        } catch (err) {
          console.warn('[claude-chat] answer-key verify error:', err.message);
          return verifyUnavailableResponse(jsonResponse, cors, err.message || 'answer_key_verify_error');
        }
      }
      try {
        const topicGate = await verifyTopicCoherenceExam(body.exam, {
          topic: body.topic || body.exam?.topic,
          lang: body.lang || body.exam?.lang,
          level: body.level || body.exam?.level,
          apiKey,
        });
        if (!topicGate.ok) {
          console.warn('[claude-chat] topic coherence rejected:', topicGate.issues);
          if (body.genTicket) {
            try {
              await releaseGenerationQuota(event, { genTicket: body.genTicket });
            } catch (relErr) {
              console.warn('[claude-chat] quota release failed:', relErr.message);
            }
          }
          return jsonResponse(422, cors, {
            error: 'topic_coherence_failed',
            message: 'Exam content failed topic/CEFR coherence check',
            onTopic: topicGate.onTopic,
            cefrOk: topicGate.cefrOk,
            issues: topicGate.issues,
            validationErrors: ['topic_coherence_failed'],
          });
        }
      } catch (err) {
        console.warn('[claude-chat] topic coherence gate error:', err.message);
        if (personalVerifyPath) {
          return verifyUnavailableResponse(jsonResponse, cors, err.message || 'topic_coherence_error');
        }
      }
      return jsonResponse(200, cors, { valid: true, placeholders: gate.placeholders });
    } catch (err) {
      console.error('[claude-chat] validateExam error:', err.message, err.stack);
      if (personalVerifyPath) {
        return verifyUnavailableResponse(jsonResponse, cors, err.message || 'validate_failed');
      }
      try {
        const gate = validateGeneratedExam(body.exam, { blueprint: resolveBlueprint(body.exam, body.blueprint) });
        if (!gate.valid) {
          return jsonResponse(422, cors, {
            error: 'exam_invalid',
            validationErrors: gate.errors,
          });
        }
        return verifyUnavailableResponse(jsonResponse, cors, err.message || 'validate_failed');
      } catch (inner) {
        return jsonResponse(500, cors, { error: 'validate_failed', message: inner.message || err.message });
      }
    }
  }

  // ── scoreProductionModules (Schreiben rubric + Sprechen, AI credits) ─────
  if (body.scoreProductionModules === true) {
    try {
      const apiKey = readAnthropicKey();
      const badKey = rejectBadAnthropicKey(apiKey, jsonResponse, cors);
      if (badKey) return badKey;
      const lang = String(body.lang || 'de').slice(0, 2);
      const level = String(body.level || 'B1').toUpperCase();
      const passPercent = Math.max(
        1,
        Math.min(100, Number(body.passPercent) || Number(body.passPercentPerModule) || 60),
      );
      const schreiben = Array.isArray(body.schreiben) ? body.schreiben.slice(0, 6) : [];
      const sprechen = Array.isArray(body.sprechen) ? body.sprechen.slice(0, 6) : [];
      if (!schreiben.length && !sprechen.length) {
        return jsonResponse(400, cors, { error: 'no_tasks' });
      }
      const qState = await getQuotaState(event);
      const feedbackLevel = feedbackLevelForPlan(qState.plan);
      const requestId = body.requestId || null;
      if (schreiben.length) {
        const wCheck = await checkAiCredits(event, 'writing_correction');
        if (!wCheck.ok) {
          return jsonResponse(wCheck.error === 'ai_credits_exhausted' ? 402 : wCheck.status || 403, cors, {
            error: wCheck.error,
            remaining: wCheck.remaining,
            aiUsed: wCheck.used,
            aiMax: wCheck.max,
            plan: qState.plan,
            autoRechargeFailed: wCheck.autoRechargeFailed || false,
            reason: wCheck.reason || undefined,
          });
        }
      }
      if (sprechen.length) {
        const sCheck = await checkAiCredits(event, 'speaking');
        if (!sCheck.ok) {
          return jsonResponse(sCheck.error === 'ai_credits_exhausted' ? 402 : sCheck.status || 403, cors, {
            error: sCheck.error,
            remaining: sCheck.remaining,
            aiUsed: sCheck.used,
            aiMax: sCheck.max,
            plan: qState.plan,
            autoRechargeFailed: sCheck.autoRechargeFailed || false,
            reason: sCheck.reason || undefined,
          });
        }
      }
      let wMeta = null;
      let sMeta = null;
      if (schreiben.length) {
        wMeta = await confirmAiCreditConsumption(event, 'writing_correction', {
          requestId: requestId ? `${requestId}:writing` : null,
        });
        if (wMeta?.error) {
          return jsonResponse(402, cors, { error: wMeta.error, plan: qState.plan, ...wMeta });
        }
      }
      if (sprechen.length) {
        sMeta = await confirmAiCreditConsumption(event, 'speaking', {
          requestId: requestId ? `${requestId}:speaking` : null,
        });
        if (sMeta?.error) {
          if (schreiben.length && requestId) {
            await refundAiCredits(event, 'writing_correction', `${requestId}:writing`);
          }
          return jsonResponse(402, cors, { error: sMeta.error, plan: qState.plan, ...sMeta });
        }
      }
      const t0 = Date.now();
      let result;
      try {
        result = await runProductionEval(apiKey, {
          lang,
          level,
          passPercent,
          schreiben,
          sprechen,
          feedbackLevel,
        });
      } catch (err) {
        if (schreiben.length && requestId) await refundAiCredits(event, 'writing_correction', `${requestId}:writing`);
        if (sprechen.length && requestId) await refundAiCredits(event, 'speaking', `${requestId}:speaking`);
        throw err;
      }
      console.log('[claude-chat] scoreProductionModules', {
        ok: result.ok,
        schreiben: result.schreiben?.length || 0,
        sprechen: result.sprechen?.length || 0,
        feedbackLevel,
        ms: Date.now() - t0,
      });
      if (!result.ok) {
        if (schreiben.length && requestId) await refundAiCredits(event, 'writing_correction', `${requestId}:writing`);
        if (sprechen.length && requestId) await refundAiCredits(event, 'speaking', `${requestId}:speaking`);
        return jsonResponse(200, cors, { ok: false, error: result.error || 'eval_failed' });
      }
      const aiMeta = sMeta || wMeta;
      return jsonResponse(200, cors, {
        ok: true,
        passPercent,
        feedbackLevel,
        schreiben: result.schreiben,
        sprechen: result.sprechen,
        aiUsed: aiMeta?.aiUsed,
        aiMax: aiMeta?.aiMax,
        aiRemaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
        plan: qState.plan,
      });
    } catch (err) {
      console.error('[claude-chat] scoreProductionModules error:', err.message);
      return jsonResponse(503, cors, { ok: false, error: 'eval_unavailable', message: err.message });
    }
  }

  // ── startGeneration branch ───────────────────────────────────────────────
  // Issues a signed ticket after charging once:
  //   personal_exam → 4 AI credits (Pro) — Schreiben+Sprechen package (Lesen/Hören pool = free)
  //   personal_schreiben / personal_sprechen_gen → 2 AI credits each (single-module Via B)
  //   exam_generation / quick_exam → monthly exam quota
  if (body.startGeneration === true) {
    const scope = typeof body.scope === 'string' ? body.scope.trim() : '';
    if (!TICKETED_SCOPES.has(scope)) {
      return jsonResponse(400, cors, { error: 'invalid_scope' });
    }
    const maxChunks = Math.max(1, Math.min(Number(body.maxChunks) || 1, MAX_CHUNKS_ALLOWED));

    const apiKey = readAnthropicKey();
    const badKey = rejectBadAnthropicKey(apiKey, jsonResponse, cors);
    if (badKey) return badKey;

    const secret = getJwtSecret();
    if (!secret) return jsonResponse(503, cors, { error: 'misconfigured' });

    let quotaCheck;
    try {
      quotaCheck = await checkQuota(event);
    } catch (err) {
      console.error('[claude-chat] startGeneration quota check failed:', err);
      return jsonResponse(503, cors, { error: 'quota_service_unavailable' });
    }

    const qState = quotaCheck.state;
    const sub = qState.authenticated ? qState.email : `guest:${qState.ipHash || 'unknown'}`;

    const PERSONAL_CREDIT_SCOPES = new Set(['personal_exam', 'personal_schreiben', 'personal_sprechen_gen']);
    if (PERSONAL_CREDIT_SCOPES.has(scope)) {
      if (!isAllowLiveGenEnabled()) {
        return liveGenDisabledResponse(jsonResponse, cors);
      }
      const access = await requireActionAccess(event, scope);
      if (!access.ok) {
        return jsonResponse(access.status || 403, cors, { error: access.error, plan: access.plan });
      }

      const creditCheck = await checkAiCredits(event, scope);
      if (!creditCheck.ok) {
        return jsonResponse(creditCheck.error === 'ai_credits_exhausted' ? 402 : 403, cors, {
          error: creditCheck.error,
          remaining: creditCheck.remaining,
          aiUsed: creditCheck.used,
          aiMax: creditCheck.max,
          plan: access.plan,
          autoRechargeFailed: creditCheck.autoRechargeFailed || false,
          reason: creditCheck.reason || undefined,
        });
      }

      const { token: ticket, payload: ticketPayload } = createGenTicket(sub, scope, maxChunks, secret);
      let aiMeta;
      try {
        aiMeta = await confirmAiCreditConsumption(event, scope, {
          requestId: ticketPayload.nonce,
        });
      } catch (err) {
        console.error('[claude-chat] startGeneration AI credit reserve failed:', err);
        return jsonResponse(503, cors, { error: 'quota_service_unavailable' });
      }
      if (aiMeta?.error) {
        return jsonResponse(402, cors, {
          error: aiMeta.error,
          aiUsed: aiMeta.aiUsed,
          aiMax: aiMeta.aiMax,
          remaining: aiMeta.remaining,
          plan: access.plan,
        });
      }

      console.log('[claude-chat] startGeneration personal (AI credits)', {
        scope,
        maxChunks,
        sub: sub.slice(0, 30),
      });
      return jsonResponse(200, cors, {
        ticket,
        plan: access.plan,
        aiUsed: aiMeta?.aiUsed,
        aiRemaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
        aiMax: aiMeta?.aiMax,
        remaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
      });
    }

    if (!quotaCheck.ok) {
      return jsonResponse(quotaCheck.status || 429, cors, {
        error: quotaCheck.error || 'quota_exceeded',
        used: quotaCheck.used,
        max: quotaCheck.max,
        plan: quotaCheck.plan,
      });
    }

    let quotaMeta;
    const EXAM_QUOTA_SCOPES = new Set(['exam_generation', 'quick_exam']);
    const startRequestId = EXAM_QUOTA_SCOPES.has(scope) ? parseRequestId(body.requestId) : null;
    if (EXAM_QUOTA_SCOPES.has(scope) && !startRequestId) {
      return jsonResponse(400, cors, { error: 'request_id_required' });
    }
    try {
      quotaMeta = await incrementQuota(quotaCheck, { requestId: startRequestId });
    } catch (err) {
      console.error('[claude-chat] startGeneration quota reserve failed:', err);
      return jsonResponse(503, cors, { error: 'quota_service_unavailable' });
    }
    if (quotaMeta?.error === 'quota_exceeded') {
      return jsonResponse(429, cors, {
        error: 'quota_exceeded',
        used: quotaMeta.used,
        max: quotaMeta.max,
        plan: quotaMeta.plan,
      });
    }

    const { token: ticket, payload: ticketPayload } = createGenTicket(sub, scope, maxChunks, secret);
    await linkTicketQuotaCharge(event, qState, ticketPayload.nonce, quotaMeta);

    console.log('[claude-chat] startGeneration', { scope, maxChunks, sub: sub.slice(0, 30) });
    return jsonResponse(200, cors, {
      ticket,
      used: quotaMeta?.used,
      max: quotaMeta?.max,
      plan: quotaMeta?.plan,
    });
  }

  // ── releaseGeneration branch ─────────────────────────────────────────────
  if (body.releaseGeneration === true && body.genTicket) {
    const release = await releaseGenerationQuota(event, {
      genTicket: body.genTicket,
    });
    return jsonResponse(200, cors, release);
  }

  // ── deliverGeneration branch (exam shown to user — quota stays charged) ──
  if (body.deliverGeneration === true && body.genTicket) {
    const delivered = await deliverGenerationQuota(event, { genTicket: body.genTicket });
    return jsonResponse(200, cors, delivered);
  }

  // ── renewGeneration branch (extend ticket TTL, no extra quota charge) ────
  if (body.renewGeneration === true && body.genTicket) {
    const renewed = await renewGenerationTicket(event, { genTicket: body.genTicket });
    if (!renewed.renewed) {
      return jsonResponse(403, cors, { error: renewed.reason || 'renew_failed' });
    }
    return jsonResponse(200, cors, renewed);
  }

  // ── Common API key check (Gemini product games skip Anthropic) ───────────
  const isGeminiProductRoute =
    body.generateVocabQuiz === true ||
    body.generateListeningGame === true ||
    body.generateVocabPhrases === true;
  let apiKey = null;
  if (isGeminiProductRoute) {
    const geminiBad = rejectMissingGeminiKey(jsonResponse, cors);
    if (geminiBad) return geminiBad;
  } else {
    apiKey = readAnthropicKey();
    const badKey = rejectBadAnthropicKey(apiKey, jsonResponse, cors);
    if (badKey) return badKey;
  }

  // ── Pro AI modes (correctWriting, grammarCoaching) ───────────────────────
  if (body.correctWriting === true || body.grammarCoaching === true) {
    try {
      const aiAction = body.correctWriting === true ? 'writing_correction' : 'grammar_coaching';
      const access = await requireActionAccess(event, aiAction);
      if (!access.ok) {
        return jsonResponse(access.status || 403, cors, { error: access.error, plan: access.plan });
      }

      const creditCheck = await checkAiCredits(event, aiAction);
      if (!creditCheck.ok) {
        return jsonResponse(creditCheck.error === 'ai_credits_exhausted' ? 402 : creditCheck.status || 403, cors, {
          error: creditCheck.error,
          remaining: creditCheck.remaining,
          aiUsed: creditCheck.used,
          aiMax: creditCheck.max,
          plan: access.plan,
          autoRechargeFailed: creditCheck.autoRechargeFailed || false,
          reason: creditCheck.reason || undefined,
        });
      }

      const correctionModel = cleanModel(
        process.env.CLAUDE_CORRECTION_MODEL || 'claude-haiku-4-5',
      );
      const feedbackLevel = access.feedbackLevel || 'full';

      if (body.correctWriting === true) {
        const lang = String(body.lang || 'de').slice(0, 2);
        const level = String(body.level || 'B1').toUpperCase();
        const task = String(body.task || '').trim();
        const userText = String(body.userText || '').trim();
        if (!userText) {
          return jsonResponse(400, cors, { error: 'userText is required' });
        }
        const requestId = body.requestId || null;
        const aiMeta = await confirmAiCreditConsumption(event, 'writing_correction', { requestId });
        if (aiMeta?.error) {
          return jsonResponse(402, cors, {
            error: aiMeta.error,
            aiUsed: aiMeta.aiUsed,
            aiMax: aiMeta.aiMax,
            remaining: aiMeta.remaining,
            plan: access.plan,
          });
        }

        const minWords = Number(body.minWords) || 0;
        const maxWords = Number(body.maxWords) || 0;
        const passPercent = Math.max(
          1,
          Math.min(100, Number(body.passPercent) || Number(body.passPercentPerModule) || 60),
        );
        const system = writingCorrectionPrompt(lang, level, passPercent, feedbackLevel);
        const userContent = `Task:\n${task || '(writing task)'}\n\nMinimum words: ${minWords || 'n/a'}${maxWords ? `, maximum: ${maxWords}` : ''}\n\nCandidate text:\n${userText}`;

        const t0 = Date.now();
        let text;
        try {
          ({ text } = await callAnthropicJson(apiKey, {
            model: correctionModel,
            maxTokens: Math.min(Number(body.maxTokens) || 1500, feedbackLevel === 'basic' ? 800 : 1500),
            system,
            userContent,
          }));
        } catch (err) {
          await refundAiCredits(event, 'writing_correction', requestId);
          throw err;
        }
        const parsed = extractJsonObject(text);
        console.log('[claude-chat] correctWriting', { ok: !!parsed, feedbackLevel, ms: Date.now() - t0 });
        if (!parsed || typeof parsed !== 'object') {
          await refundAiCredits(event, 'writing_correction', requestId);
          return jsonResponse(200, cors, { ok: false, error: 'parse_failed' });
        }
        const scored = normalizeSchreibenItem({ ...parsed, id: 'writing' }, passPercent, feedbackLevel);
        const correction =
          feedbackLevel === 'basic'
            ? {
                summary: scored?.summary || parsed.summary,
                totalScore: scored?.totalScore ?? parsed.totalScore,
                passed: scored?.passed ?? parsed.passed,
                rubric: scored?.rubric ?? parsed.rubric,
                errorCounts: scored?.errorCounts || parsed.errorCounts,
                feedbackLevel: 'basic',
              }
            : parsed;
        return jsonResponse(200, cors, {
          ok: true,
          correction,
          feedbackLevel,
          score: scored?.score ?? parsed.totalScore ?? null,
          passed: scored?.passed ?? parsed.passed ?? null,
          rubric: scored?.rubric ?? parsed.rubric ?? null,
          errorCounts: scored?.errorCounts || parsed.errorCounts || null,
          plan: access.plan,
          aiUsed: aiMeta?.aiUsed,
          aiMax: aiMeta?.aiMax,
          aiRemaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
        });
      }

      const lang = String(body.lang || 'de').slice(0, 2);
      const level = String(body.level || 'B1').toUpperCase();
      const weakTags = Array.isArray(body.weakTags) ? body.weakTags.slice(0, 6) : [];
      const sampleMistakes = Array.isArray(body.sampleMistakes)
        ? body.sampleMistakes.slice(0, 8)
        : [];
      const requestId = body.requestId || null;
      const aiMeta = await confirmAiCreditConsumption(event, 'grammar_coaching', { requestId });
      if (aiMeta?.error) {
        return jsonResponse(402, cors, {
          error: aiMeta.error,
          aiUsed: aiMeta.aiUsed,
          aiMax: aiMeta.aiMax,
          remaining: aiMeta.remaining,
          plan: access.plan,
        });
      }
      const cert = certName(lang);
      const system = `You are a ${cert} ${level} grammar coach. Return ONLY valid JSON:
{"topics":[{"tag":"...","title":"...","explanation":"...","examples":["..."],"tip":"..."}]}
Max 4 topics, concise. Language: ${lang === 'de' ? 'German' : lang === 'es' ? 'Spanish' : 'English'}.`;
      const userContent = `Weak grammar areas (tags): ${weakTags.join(', ') || 'general'}\n\nSample mistakes:\n${sampleMistakes
        .map(
          (m, i) =>
            `${i + 1}. [${m.tag || 'grammar'}] Q: ${m.question || ''}\n   Yours: ${m.yours || ''}\n   Correct: ${m.correct || ''}\n   Note: ${m.explanation || ''}`,
        )
        .join('\n\n')}`;

      const t0 = Date.now();
      let text;
      try {
        ({ text } = await callAnthropicJson(apiKey, {
          model: correctionModel,
          maxTokens: Math.min(Number(body.maxTokens) || 1200, 1200),
          system,
          userContent,
        }));
      } catch (err) {
        await refundAiCredits(event, 'grammar_coaching', requestId);
        throw err;
      }
      const parsed = extractJsonObject(text);
      console.log('[claude-chat] grammarCoaching', { ok: !!parsed?.topics, ms: Date.now() - t0 });
      if (!parsed?.topics) {
        await refundAiCredits(event, 'grammar_coaching', requestId);
        return jsonResponse(200, cors, { ok: false, error: 'parse_failed' });
      }
      return jsonResponse(200, cors, {
        ok: true,
        coaching: parsed,
        plan: access.plan,
        aiUsed: aiMeta?.aiUsed,
        aiMax: aiMeta?.aiMax,
        aiRemaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
      });
    } catch (err) {
      console.error('[claude-chat] pro AI mode failed:', err.message);
      return jsonResponse(502, cors, { error: 'ai_unavailable' });
    }
  }

  // ── generateVocabQuiz (2 AI credits / batch of up to 10) ─────────────────
  if (body.generateVocabQuiz === true) {
    try {
      const access = await requireActionAccess(event, 'vocab_quiz');
      if (!access.ok) {
        return jsonResponse(access.status || 403, cors, { error: access.error, plan: access.plan });
      }

      const creditCheck = await checkAiCredits(event, 'vocab_quiz');
      if (!creditCheck.ok) {
        return jsonResponse(creditCheck.error === 'ai_credits_exhausted' ? 402 : 403, cors, {
          error: creditCheck.error,
          remaining: creditCheck.remaining,
          aiUsed: creditCheck.used,
          aiMax: creditCheck.max,
          plan: access.plan,
          autoRechargeFailed: creditCheck.autoRechargeFailed || false,
          reason: creditCheck.reason || undefined,
        });
      }

      const lang = String(body.lang || 'de').slice(0, 2);
      const level = String(body.level || 'B1').toUpperCase();
      const hintLang = String(body.hintLang || 'en').slice(0, 2);
      const rawWords = Array.isArray(body.words) ? body.words : [];
      const words = [...new Set(rawWords.map((w) => String(w || '').trim()).filter(Boolean))].slice(0, 40);
      if (words.length < 4) {
        return jsonResponse(400, cors, { error: 'need_at_least_4_words' });
      }
      const count = Math.min(Math.max(Number(body.count) || 10, 1), 10, words.length);
      const rawMeta = Array.isArray(body.wordMeta) ? body.wordMeta : [];
      const wordMeta = words.map((w) => {
        const hit = rawMeta.find((m) => String(m?.word || '').trim().toLowerCase() === w.toLowerCase());
        return {
          word: w,
          type: String(hit?.type || 'other').trim() || 'other',
          translation: String(hit?.translation || '').trim(),
          missCount: Number(hit?.missCount) || 0,
        };
      });
      const preferTargets = Array.isArray(body.preferTargets)
        ? body.preferTargets.map((w) => String(w || '').trim()).filter(Boolean)
        : [];
      const targetPool = weightedPickQuizTargets(wordMeta, count, preferTargets);
      const requestId = body.requestId || null;

      const sourceLangName = lang === 'de' ? 'German' : lang === 'es' ? 'Spanish' : 'English';
      const UI_LANG_NAMES = { en: 'English', es: 'Spanish', fr: 'French', it: 'Italian', de: 'German' };
      const hintLangName = UI_LANG_NAMES[hintLang] || UI_LANG_NAMES.en;
      const hintMode = body.hintLanguageMode === 'immersion' ? 'immersion' : 'interface';
      const allHintsLangName = hintMode === 'immersion' ? sourceLangName : hintLangName;
      const quizModel = productGeminiModel();
      const system = `You create vocabulary recall quizzes for ${level} ${sourceLangName} learners.
Return ONLY valid JSON (no markdown):
{"questions":[{"word":"TARGET","hintType":"synonym|antonym|explanation","hintLanguage":"${hintMode === 'immersion' ? lang : hintLang}","hint":"...","options":["w1","w2","w3","w4"]}]}

Rules:
- Generate exactly ${count} questions. Use these target words in order when possible: ${targetPool.join(', ')}.
- Each question must use a different "word" target from the list when possible.
- "word" must match one vocabulary item exactly (same spelling).
- "options" must be exactly 4 distinct words copied verbatim from the vocabulary list, including the correct "word".
- OPTION QUALITY (important): pick distractors that are plausible but clearly wrong — same part of speech as the target when possible (verbs with verbs, nouns with nouns). Do NOT pick four near-synonyms or words from the exact same semantic micro-cluster. Do NOT pick one obvious outlier (e.g. one verb among three nouns) that can be eliminated without reading the hint.
- Rotate hintType evenly across synonym, antonym, and explanation.
- ALL hints (synonym, antonym, explanation): write in ${allHintsLangName} only — same language for every hint in this quiz.
- Keep hints short (max 15 words). Do NOT include the target word.
- Set hintLanguage to "${hintMode === 'immersion' ? lang : hintLang}" on every question.
- Shuffle option order randomly.`;
      const metaLines = wordMeta
        .map((m, i) => {
          const pos = m.type && m.type !== 'other' ? ` [${m.type}]` : '';
          const tr = m.translation ? ` — ${m.translation}` : '';
          return `${i + 1}. ${m.word}${pos}${tr}`;
        })
        .join('\n');
      const userContent = `Vocabulary list (${sourceLangName}):\n${metaLines}`;

      const t0 = Date.now();
      let text;
      try {
        ({ text } = await callGeminiProductJson({
          model: quizModel,
          maxTokens: Math.min(Number(body.maxTokens) || 2500, 2500),
          system,
          userContent,
        }));
      } catch (err) {
        throw err;
      }

      const parsed = extractJsonObject(text);
      const rawQs = Array.isArray(parsed?.questions) ? parsed.questions : [];
      const wordSet = new Set(words.map((w) => w.toLowerCase()));
      const questions = [];
      const usedTargets = new Set();
      for (const q of rawQs) {
        const word = String(q?.word || '').trim();
        const hint = String(q?.hint || '').trim();
        let hintType = String(q?.hintType || '').trim().toLowerCase();
        if (!['synonym', 'antonym', 'explanation'].includes(hintType)) hintType = 'explanation';
        const opts = Array.isArray(q?.options)
          ? q.options.map((o) => String(o || '').trim()).filter(Boolean)
          : [];
        const uniqOpts = [...new Set(opts)];
        if (!word || !hint || uniqOpts.length < 4) continue;
        if (!wordSet.has(word.toLowerCase())) continue;
        if (usedTargets.has(word.toLowerCase())) continue;
        let finalOpts = repairQuizOptions(word, uniqOpts, wordMeta);
        if (finalOpts.length < 4) continue;
        if (!validateQuizOptionsQuality(word, finalOpts, wordMeta)) {
          finalOpts = repairQuizOptions(word, [], wordMeta);
        }
        if (finalOpts.length < 4 || !validateQuizOptionsQuality(word, finalOpts, wordMeta)) continue;
        usedTargets.add(word.toLowerCase());
        questions.push({
          word,
          hintType,
          hint,
          hintLanguage: String(q?.hintLanguage || (hintMode === 'immersion' ? lang : hintLang)).slice(0, 8),
          options: finalOpts.slice(0, 4),
        });
        if (questions.length >= count) break;
      }

      for (const forcedWord of targetPool) {
        if (questions.length >= count) break;
        if (usedTargets.has(forcedWord.toLowerCase())) continue;
        const finalOpts = repairQuizOptions(forcedWord, [], wordMeta);
        if (finalOpts.length < 4 || !validateQuizOptionsQuality(forcedWord, finalOpts, wordMeta)) continue;
        usedTargets.add(forcedWord.toLowerCase());
        questions.push({
          word: forcedWord,
          hintType: 'explanation',
          hint: `A ${sourceLangName} word from your vocabulary list.`,
          hintLanguage: hintMode === 'immersion' ? lang : hintLang,
          options: finalOpts.slice(0, 4),
        });
      }

      console.log('[claude-chat] generateVocabQuiz', {
        ok: questions.length > 0,
        requested: count,
        got: questions.length,
        ms: Date.now() - t0,
      });

      if (!questions.length) {
        return jsonResponse(200, cors, { ok: false, error: 'parse_failed', billed: false });
      }

      const aiMeta = await confirmAiCreditConsumption(event, 'vocab_quiz', { requestId });
      if (aiMeta?.error) {
        return jsonResponse(402, cors, {
          error: aiMeta.error,
          aiUsed: aiMeta.aiUsed,
          aiMax: aiMeta.aiMax,
          remaining: aiMeta.remaining,
          plan: access.plan,
          billed: false,
        });
      }

      return jsonResponse(200, cors, {
        ok: true,
        billed: true,
        questions,
        plan: access.plan,
        aiUsed: aiMeta?.aiUsed,
        aiMax: aiMeta?.aiMax,
        aiRemaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
      });
    } catch (err) {
      console.error('[claude-chat] generateVocabQuiz failed:', err.message);
      return jsonResponse(502, cors, { error: 'ai_unavailable' });
    }
  }

  // ── generateListeningGame (2 AI credits — 3 rounds, deferred billing) ───────
  if (body.generateListeningGame === true) {
    try {
      const access = await requireActionAccess(event, 'listening_game');
      if (!access.ok) {
        return jsonResponse(access.status || 403, cors, { error: access.error, plan: access.plan });
      }
      const creditCheck = await checkAiCredits(event, 'listening_game');
      if (!creditCheck.ok) {
        return jsonResponse(creditCheck.error === 'ai_credits_exhausted' ? 402 : 403, cors, {
          error: creditCheck.error,
          remaining: creditCheck.remaining,
          aiUsed: creditCheck.used,
          aiMax: creditCheck.max,
          plan: access.plan,
        });
      }
      const lang = String(body.lang || 'de').slice(0, 2);
      const level = String(body.level || 'B1').toUpperCase();
      const topic = String(body.topic || '').trim().slice(0, 120);
      const rawWords = Array.isArray(body.words) ? body.words : [];
      const words = [...new Set(rawWords.map((w) => String(w || '').trim()).filter(Boolean))].slice(0, 16);
      if (words.length < 3) {
        return jsonResponse(400, cors, { error: 'need_at_least_3_words' });
      }
      const requestId = body.requestId || null;
      const roundCount = LISTENING_AI_ROUND_COUNT;
      const useE2eFixture =
        process.env.ALLOW_LISTENING_E2E === '1' &&
        (process.env.LISTENING_E2E_FIXTURE === '1' || process.env.LISTENING_E2E_FIXTURE === 'true');
      const e2eFailAfter =
        process.env.ALLOW_LISTENING_E2E === '1' && process.env.LISTENING_E2E_FAIL_AFTER
          ? Number(process.env.LISTENING_E2E_FAIL_AFTER)
          : null;
      const sourceLangName = lang === 'de' ? 'German' : lang === 'es' ? 'Spanish' : 'English';
      const topicLine = topic ? `Topic: ${topic}.` : 'Topic: everyday life (work, home, errands, plans).';
      const listenModel = productGeminiModel();
      const voice = lang === 'es' ? 'es-ES' : lang === 'en' ? 'en-GB' : 'de-DE';
      const generatedRounds = [];
      const t0 = Date.now();

      for (let roundIndex = 0; roundIndex < roundCount; roundIndex++) {
        if (e2eFailAfter != null && !Number.isNaN(e2eFailAfter) && roundIndex >= e2eFailAfter) {
          break;
        }

        let passage = '';
        let validation = { ok: false };
        const maxPassageAttempts = useE2eFixture ? 1 : 3;
        for (let attempt = 1; attempt <= maxPassageAttempts; attempt++) {
          if (useE2eFixture) {
            passage = listeningE2ePassageForRound(words, roundIndex);
          } else {
            const weaveWords = pickWeaveForRound(words, roundIndex, roundCount);
            const extraHints = [];
            if (attempt > 1) extraHints.push('Keep under 120 words and under 480 characters.');
            if (attempt > 2 || level === 'A2') {
              extraHints.push('Use simple A2 sentence structures; avoid long compound sentences.');
            }
            const system = `You write short listening passages for ${level} ${sourceLangName} learners.
Return ONLY valid JSON: {"passage":"..."}

Rules:
- ${topicLine}
- ${level === 'A2' ? '60–100 words' : '80–130 words'} MAX (~30–50 seconds spoken). Natural, conversational monologue.
- MUST naturally include these vocabulary items (use inflected/separable forms when natural): ${weaveWords.join(', ')}.
- For separable verbs, you may split them in a clause (e.g. "schlägt … vor" for vorschlagen).
- Do NOT list words; write flowing prose. No bullet points.
${extraHints.length ? `- ${extraHints.join(' ')}` : ''}`;
            const userContent = `Round ${roundIndex + 1} of ${roundCount}. Vocabulary pool:\n${words.map((w, i) => `${i + 1}. ${w}`).join('\n')}`;
            let text;
            try {
              ({ text } = await callGeminiProductJson({
                model: listenModel,
                maxTokens: 900,
                system,
                userContent,
              }));
            } catch (err) {
              console.warn('[claude-chat] generateListeningGame round Gemini fail:', err.message);
              passage = '';
              break;
            }
            const parsed = extractJsonObject(text);
            passage = String(parsed?.passage || '').trim();
          }
          validation = validateListeningPassage(passage, words, lang, level);
          if (validation.ok) break;
          if (attempt < maxPassageAttempts) {
            console.warn('[claude-chat] generateListeningGame round retry:', validation.reason);
          }
        }

        if (!validation.ok) {
          console.warn('[claude-chat] generateListeningGame round invalid:', validation.reason);
          break;
        }
        const detected = validation.detected || detectAppearedWords(words, passage, lang);
        let audioBase64 = null;
        try {
          const audioBuf = await synthesize(passage, voice, lang);
          if (audioBuf && audioBuf.length) audioBase64 = audioBuf.toString('base64');
        } catch (ttsErr) {
          console.warn('[claude-chat] listening game TTS fail:', ttsErr.message);
        }
        const roundValid = validation.ok && !!audioBase64;
        generatedRounds.push({
          passage,
          topic: topic || null,
          displayWords: detected.all,
          appeared: detected.appeared,
          absent: detected.absent,
          audioBase64,
          audioMime: 'audio/mpeg',
          valid: roundValid,
        });
        if (!roundValid) break;
      }

      const roundsGenerated = generatedRounds.length;
      const validRounds = generatedRounds.filter((r) => r.valid);
      const rounds = validRounds.map(({ valid, ...r }) => r);
      const billed = shouldBillListeningAiSession(generatedRounds, roundCount);
      const partial = validRounds.length > 0 && validRounds.length < roundCount;

      if (!validRounds.length) {
        return jsonResponse(200, cors, {
          ok: false,
          error: 'listening_unavailable',
          billed: false,
          userMessage: 'We could not prepare the listening game. No credits were used.',
        });
      }

      let aiMeta = null;
      if (billed) {
        aiMeta = await confirmAiCreditConsumption(event, 'listening_game', { requestId });
        if (aiMeta?.error) {
          return jsonResponse(402, cors, {
            error: aiMeta.error,
            aiUsed: aiMeta.aiUsed,
            aiMax: aiMeta.aiMax,
            remaining: aiMeta.remaining,
            plan: access.plan,
            billed: false,
            partial,
            roundsGenerated,
            rounds,
          });
        }
      }

      console.log('[claude-chat] generateListeningGame', {
        ok: true,
        roundsGenerated,
        billed,
        partial,
        ms: Date.now() - t0,
      });

      return jsonResponse(200, cors, {
        ok: true,
        billed,
        partial,
        roundsGenerated: validRounds.length,
        rounds,
        plan: access.plan,
        aiUsed: billed ? aiMeta?.aiUsed : creditCheck.used,
        aiMax: billed ? aiMeta?.aiMax : creditCheck.max,
        aiRemaining: billed ? (aiMeta?.aiRemaining ?? aiMeta?.remaining) : creditCheck.remaining,
        userMessage: partial
          ? 'Only part of the listening session could be generated. No credits were used.'
          : undefined,
      });
    } catch (err) {
      console.error('[claude-chat] generateListeningGame failed:', err.message);
      return jsonResponse(502, cors, { error: 'ai_unavailable', billed: false });
    }
  }

  // ── generateVocabPhrases (1 AI credit) ───────────────────────────────────
  if (body.generateVocabPhrases === true) {
    try {
      const access = await requireActionAccess(event, 'vocab_phrases');
      if (!access.ok) {
        return jsonResponse(access.status || 403, cors, { error: access.error, plan: access.plan });
      }
      const creditCheck = await checkAiCredits(event, 'vocab_phrases');
      if (!creditCheck.ok) {
        return jsonResponse(creditCheck.error === 'ai_credits_exhausted' ? 402 : 403, cors, {
          error: creditCheck.error,
          remaining: creditCheck.remaining,
          plan: access.plan,
        });
      }
      const lang = String(body.lang || 'de').slice(0, 2);
      const level = String(body.level || 'B1').toUpperCase();
      const rawWords = Array.isArray(body.words) ? body.words : [];
      const words = [...new Set(rawWords.map((w) => String(w || '').trim()).filter(Boolean))].slice(0, 20);
      if (words.length < 2) {
        return jsonResponse(400, cors, { error: 'need_at_least_2_words' });
      }
      const count = Math.min(Math.max(Number(body.count) || 4, 3), 5, words.length);
      const requestId = body.requestId || null;
      const sourceLangName = lang === 'de' ? 'German' : lang === 'es' ? 'Spanish' : 'English';
      const phrasesModel = productGeminiModel();
      const separableRules = buildSeparablePromptRules(words);
      const baseSystem = `You create short everyday ${sourceLangName} phrases for ${level} learners using their vocabulary.
Return ONLY valid JSON:
{"phrases":[{"targetWord":"lemma","full":"complete sentence","blankToken":"word hidden in gap phase","blankPos":"noun|verb|adjective|adverb|other","tokens":["word","word",...]}]}

Rules:
- Exactly ${count} phrases. Each phrase uses ONE target word from the list (different targets when possible).
- "full" = natural short sentence (6–14 words) with the target in context.
- "blankToken" = the exact surface form as it appears in "full" (may be inflected).
- "blankPos" = part of speech of blankToken: noun|verb|adjective|adverb|other.
- Gap-fill distractors will be same POS as blankPos — write sentences where the blank clearly needs that word class.
- "tokens" = split "full" into click-order words (keep punctuation attached to words, e.g. "vor,").
- Everyday register only. One target per phrase — do not cram multiple deck words into one sentence.${separableRules}`;

      function parsePhrasesFromAi(text) {
        const parsed = extractJsonObject(text);
        const rawPhrases = Array.isArray(parsed?.phrases) ? parsed.phrases : [];
        const wordSet = new Set(words.map((w) => w.toLowerCase()));
        const out = [];
        const used = new Set();
        const rejected = [];
        for (const p of rawPhrases) {
          const targetWord = String(p?.targetWord || '').trim();
          const full = String(p?.full || '').trim();
          const blankToken = String(p?.blankToken || '').trim();
          let blankPos = String(p?.blankPos || '').trim().toLowerCase();
          if (!['noun', 'verb', 'adjective', 'adverb'].includes(blankPos)) blankPos = 'other';
          const tokens = Array.isArray(p?.tokens)
            ? p.tokens.map((t) => String(t || '').trim()).filter(Boolean)
            : full.split(/\s+/).filter(Boolean);
          if (!targetWord || !full || !blankToken || tokens.length < 3) continue;
          if (!wordSet.has(targetWord.toLowerCase())) continue;
          if (used.has(targetWord.toLowerCase())) continue;
          if (!full.toLowerCase().includes(blankToken.toLowerCase())) continue;

          const norm = normalizeSeparablePhraseItem({
            targetWord,
            full,
            blankToken,
            blankPos,
            tokens,
          });
          if (!norm.ok) {
            rejected.push({ targetWord, reason: norm.reason, full, blankToken });
            continue;
          }
          used.add(targetWord.toLowerCase());
          out.push(norm.phrase);
          if (out.length >= count) break;
        }
        return { phrases: out, rejected };
      }

      let phrases = [];
      let rejected = [];
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts && phrases.length < count; attempt++) {
        const retryHint =
          attempt > 1 && rejected.length
            ? `\n\nREJECTED (fix these — separable verbs MUST be split, blankToken = root only): ${rejected
                .map((r) => `${r.targetWord}: ${r.reason} in "${r.full}" (blank="${r.blankToken}")`)
                .join('; ')}`
            : '';
        const system = baseSystem + retryHint;
        const userContent = `Vocabulary (${sourceLangName}):\n${words.map((w, i) => `${i + 1}. ${w}`).join('\n')}`;
        let text;
        try {
          ({ text } = await callGeminiProductJson({
            model: phrasesModel,
            maxTokens: 1800,
            system,
            userContent,
          }));
        } catch (err) {
          if (attempt === maxAttempts) {
            throw err;
          }
          continue;
        }
        const parsed = parsePhrasesFromAi(text);
        rejected = parsed.rejected;
        for (const p of parsed.phrases) {
          if (!phrases.some((x) => x.targetWord.toLowerCase() === p.targetWord.toLowerCase())) {
            phrases.push(p);
          }
        }
        if (phrases.length >= count) break;
        if (attempt < maxAttempts && rejected.some((r) => isSeparableTarget(r.targetWord))) {
          console.log('[claude-chat] generateVocabPhrases separable gate retry', {
            attempt,
            rejected: rejected.map((r) => r.targetWord + ':' + r.reason),
          });
        }
      }
      if (phrases.length < 3) {
        return jsonResponse(200, cors, { ok: false, error: 'parse_failed', rejected, billed: false });
      }

      const aiMeta = await confirmAiCreditConsumption(event, 'vocab_phrases', { requestId });
      if (aiMeta?.error) {
        return jsonResponse(402, cors, {
          error: aiMeta.error,
          remaining: aiMeta.remaining,
          plan: access.plan,
          billed: false,
        });
      }

      return jsonResponse(200, cors, {
        ok: true,
        billed: true,
        phrases: phrases.slice(0, count),
        plan: access.plan,
        aiUsed: aiMeta?.aiUsed,
        aiMax: aiMeta?.aiMax,
        aiRemaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
      });
    } catch (err) {
      console.error('[claude-chat] generateVocabPhrases failed:', err.message);
      return jsonResponse(502, cors, { error: 'ai_unavailable' });
    }
  }

  // ── consumeAiAction (listening game, etc.) ───────────────────────────────
  if (body.consumeAiAction === true && body.action) {
    try {
      const action = String(body.action).trim();
      const creditCheck = await checkAiCredits(event, action);
      if (!creditCheck.ok) {
        return jsonResponse(creditCheck.error === 'ai_credits_exhausted' ? 402 : creditCheck.status || 403, cors, {
          error: creditCheck.error,
          remaining: creditCheck.remaining,
          aiUsed: creditCheck.used,
          aiMax: creditCheck.max,
          plan: creditCheck.plan,
          autoRechargeFailed: creditCheck.autoRechargeFailed || false,
          reason: creditCheck.reason || undefined,
        });
      }
      const requestId = body.requestId || null;
      const aiMeta = await confirmAiCreditConsumption(event, action, { requestId });
      if (aiMeta?.error) {
        return jsonResponse(402, cors, { error: aiMeta.error, ...aiMeta });
      }
      return jsonResponse(200, cors, {
        ok: true,
        action,
        aiUsed: aiMeta?.aiUsed,
        aiMax: aiMeta?.aiMax,
        aiRemaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
      });
    } catch (err) {
      console.error('[claude-chat] consumeAiAction failed:', err.message);
      return jsonResponse(503, cors, { error: 'quota_service_unavailable' });
    }
  }

  // ── personalPoolCommit (Lesen/Hören pool assembly quota — no AI credits) ──
  if (body.personalPoolCommit === 'lesen' || body.personalPoolCommit === 'horen') {
    try {
      const check = await checkPersonalPoolQuota(event, body.personalPoolCommit);
      if (!check.ok) {
        return jsonResponse(check.status || 429, cors, {
          error: check.error || 'personal_pool_quota_exceeded',
          module: check.module,
          used: check.used,
          max: check.max,
          plan: check.plan,
        });
      }
      const meta = await incrementPersonalPoolQuota(check, { requestId: body.requestId || null });
      if (meta?.error === 'personal_pool_quota_exceeded') {
        return jsonResponse(429, cors, {
          error: 'personal_pool_quota_exceeded',
          module: meta.module,
          used: meta.used,
          max: meta.max,
          plan: meta.plan,
        });
      }
      const aiSnap = await getAiCredits(event);
      return jsonResponse(200, cors, {
        ok: true,
        plan: aiSnap.plan,
        personalLesenUsed: meta?.personalLesenUsed ?? aiSnap.personalLesenUsed,
        personalHorenUsed: meta?.personalHorenUsed ?? aiSnap.personalHorenUsed,
        personalLesenMax: aiSnap.personalLesenMax,
        personalHorenMax: aiSnap.personalHorenMax,
        aiUsed: aiSnap.used,
        aiMax: aiSnap.max,
        aiRemaining: aiSnap.remaining,
        remaining: aiSnap.remaining,
        month: aiSnap.month,
      });
    } catch (err) {
      console.error('[claude-chat] personalPoolCommit failed:', err);
      return jsonResponse(503, cors, { error: 'quota_service_unavailable' });
    }
  }

  // ── quotaOnly / aiCreditsOnly (legacy compatibility) ─────────────────────
  if (body.quotaOnly === true || body.aiCreditsOnly === true) {
    try {
      const aiSnap = await getAiCredits(event);
      if (body.aiCreditsOnly === true) {
        return jsonResponse(200, cors, {
          ok: true,
          aiUsed: aiSnap.used,
          aiMax: aiSnap.max,
          aiRemaining: aiSnap.remaining,
          aiTotalPool: aiSnap.totalPool,
          rollover: aiSnap.rollover,
          creditTopups: aiSnap.creditTopups,
          remaining: aiSnap.remaining,
          month: aiSnap.month,
          plan: aiSnap.plan,
          autoRecharge: aiSnap.autoRecharge,
        });
      }
      const quotaCheck = await checkQuota(event);
      if (!quotaCheck.ok) {
        return jsonResponse(quotaCheck.status || 429, cors, {
          error: quotaCheck.error || 'quota_exceeded',
          used: quotaCheck.used,
          max: quotaCheck.max,
          plan: quotaCheck.plan,
          aiUsed: aiSnap.used,
          aiMax: aiSnap.max,
          aiRemaining: aiSnap.remaining,
          remaining: aiSnap.remaining,
          month: aiSnap.month,
        });
      }
      const quotaMeta = await incrementQuota(quotaCheck, {
        requestId: body.requestId || null,
      });
      if (!quotaMeta || typeof quotaMeta.used !== 'number') {
        return jsonResponse(503, cors, { error: 'quota_increment_failed' });
      }
      const aiAfter = await getAiCredits(event);
      return jsonResponse(200, cors, {
        ok: true,
        used: quotaMeta?.used,
        max: quotaMeta?.max,
        plan: quotaMeta?.plan,
        aiUsed: aiAfter.used,
        aiMax: aiAfter.max,
        aiRemaining: aiAfter.remaining,
        remaining: aiAfter.remaining,
        month: aiAfter.month,
      });
    } catch (err) {
      console.error('[claude-chat] quota-only failed:', err);
      return jsonResponse(503, cors, { error: 'quota_service_unavailable' });
    }
  }

  // ── Prompt validation ────────────────────────────────────────────────────
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return jsonResponse(400, cors, { error: 'prompt is required' });
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    return jsonResponse(400, cors, { error: `prompt exceeds ${MAX_PROMPT_LEN} characters` });
  }

  // B-1: whitelist of allowed actions
  const QUOTA_AI_ACTIONS = new Set([
    'exam_generation', 'personal_exam', 'quick_exam',
    'exam_generation_de', 'exam_generation_en', 'exam_generation_es',
    'vocab_explanation', 'translation',
  ]);
  const CREDIT_AI_ACTIONS = new Set([
    'writing_correction',
    'grammar_coaching',
    'speaking',
    'listening_game',
    'vocab_quiz',
    'vocab_phrases',
    'tts',
  ]);
  const aiAction = typeof body.aiAction === 'string' ? body.aiAction.trim() : null;

  if (!aiAction && !body.examGeneration) {
    console.warn('[claude-chat] B-1: blocked prompt call with no aiAction');
    return jsonResponse(403, cors, { error: 'action_required' });
  }
  if (aiAction && !QUOTA_AI_ACTIONS.has(aiAction) && !CREDIT_AI_ACTIONS.has(aiAction)) {
    console.warn('[claude-chat] B-1: blocked unknown aiAction:', aiAction);
    return jsonResponse(403, cors, { error: 'unknown_action' });
  }
  let creditAccess = null;
  if (aiAction && CREDIT_AI_ACTIONS.has(aiAction)) {
    creditAccess = await requireActionAccess(event, aiAction);
    if (!creditAccess.ok) {
      return jsonResponse(creditAccess.status || 403, cors, {
        error: creditAccess.error,
        plan: creditAccess.plan,
      });
    }
    const creditCheck = await checkAiCredits(event, aiAction);
    if (!creditCheck.ok) {
      return jsonResponse(creditCheck.error === 'ai_credits_exhausted' ? 402 : creditCheck.status || 403, cors, {
        error: creditCheck.error,
        remaining: creditCheck.remaining,
        aiUsed: creditCheck.used,
        aiMax: creditCheck.max,
        plan: creditAccess.plan,
        autoRechargeFailed: creditCheck.autoRechargeFailed || false,
        reason: creditCheck.reason || undefined,
      });
    }
  }

  // ── Ticket verification (exam generation) ────────────────────────────────
  // All examGeneration calls MUST present a server-issued ticket obtained via
  // startGeneration. body.consumeQuota is NOT trusted from the client.
  let quotaMeta = null;
  let reservedQuotaCheck = null;
  const requestId = body.requestId || null;
  let genTicketPayload = null;

  if (body.examGeneration) {
    if (!body.genTicket) {
      console.warn('[claude-chat] examGeneration without ticket — rejected');
      return jsonResponse(403, cors, { error: 'ticket_required' });
    }

    const secret = getJwtSecret();
    if (!secret) return jsonResponse(503, cors, { error: 'misconfigured' });

    const ticketPayload = verifyGenTicket(body.genTicket, secret);
    if (!ticketPayload) {
      return jsonResponse(403, cors, { error: 'ticket_invalid' });
    }
    genTicketPayload = ticketPayload;
    const owner = await assertGenerationTicketOwner(event, ticketPayload);
    if (!owner.ok) {
      return jsonResponse(403, cors, { error: owner.error || 'ticket_owner_mismatch' });
    }
    if (!TICKETED_SCOPES.has(ticketPayload.scope)) {
      return jsonResponse(403, cors, { error: 'ticket_scope_invalid' });
    }
    const PERSONAL_LIVE_SCOPES = new Set(['personal_exam', 'personal_schreiben', 'personal_sprechen_gen']);
    if (PERSONAL_LIVE_SCOPES.has(ticketPayload.scope) && !isAllowLiveGenEnabled()) {
      return liveGenDisabledResponse(jsonResponse, cors);
    }

    // Atomically increment the per-ticket chunk counter (server-controlled)
    const store = getStoreForEvent(event);
    const ticketKey = `gentk:${ticketPayload.nonce}`;
    const counterResult = await casWriteJson(
      store,
      ticketKey,
      (current) => {
        const used = (current?.chunksUsed || 0) + 1;
        if (used > ticketPayload.maxChunks) {
          return {
            skip: true,
            result: { error: 'chunks_exceeded', used, max: ticketPayload.maxChunks },
          };
        }
        return {
          payload: { chunksUsed: used, maxChunks: ticketPayload.maxChunks },
          result: { ok: true, chunksUsed: used },
        };
      },
      { logTag: '[gentk]' },
    ).catch((err) => {
      console.error('[claude-chat] chunk counter CAS error:', err.message);
      return { error: 'counter_error' };
    });

    if (counterResult?.error) {
      return jsonResponse(403, cors, { error: counterResult.error });
    }
    // Quota was already charged via startGeneration — skip quota reserve below
  } else {
    // Non-exam calls: server always charges quota regardless of body.consumeQuota
    // (B-4: reserve BEFORE the Anthropic call)
    let quotaCheck = null;
    try {
      quotaCheck = await checkQuota(event);
    } catch (err) {
      console.error('[claude-chat] quota check failed:', err);
      return jsonResponse(503, cors, { error: 'quota_service_unavailable' });
    }
    if (!quotaCheck.ok) {
      return jsonResponse(quotaCheck.status || 429, cors, {
        error: quotaCheck.error || 'quota_exceeded',
        used: quotaCheck.used,
        max: quotaCheck.max,
        plan: quotaCheck.plan,
      });
    }
    try {
      quotaMeta = await incrementQuota(quotaCheck, { requestId });
      reservedQuotaCheck = quotaCheck;
    } catch (err) {
      console.error('[claude-chat] quota reserve failed:', err);
      return jsonResponse(503, cors, { error: 'quota_service_unavailable' });
    }
    if (quotaMeta?.error === 'quota_exceeded') {
      return jsonResponse(429, cors, {
        error: 'quota_exceeded',
        used: quotaMeta.used,
        max: quotaMeta.max,
        plan: quotaMeta.plan,
      });
    }
  }

  // ── Anthropic call ───────────────────────────────────────────────────────
  const chunkSlot = String(body.chunkSlotType || body.slotType || '').toLowerCase();
  const chunkTeil = Number(body.chunkTeil ?? body.teil);
  let maxTokens = Math.min(Math.max(Number(body.maxTokens) || 6000, 1), MAX_TOKENS);
  if (body.examGeneration && chunkSlot.includes('ads_matching')) {
    maxTokens = Math.min(Math.max(maxTokens, 8000), 10000);
  }
  const examModelDefault = process.env.CLAUDE_EXAM_MODEL || EXAM_MODEL;
  const examModelPick =
    body.examGeneration && chunkSlot.includes('ads_matching')
      ? examModelDefault
      : pickRequestModel(body.examModel, examModelDefault);
  // Outside exam generation the client never picks the model.
  const model = body.examGeneration
    ? cleanModel(examModelPick)
    : cleanModel(process.env.CLAUDE_MODEL);

  if (body.examGeneration) {
    console.log('[claude-chat] exam chunk', {
      model,
      maxTokens,
      examModel: body.examModel || null,
      chunkTeil: Number.isFinite(chunkTeil) ? chunkTeil : null,
      chunkSlot: chunkSlot || null,
    });
  }

  const t0 = Date.now();
  let anthropicOk = false;
  let anthropicUsage = null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json().catch(() => ({}));
    anthropicUsage = data.usage || null;
    anthropicOk = res.ok;
    if (!res.ok) {
      const msg =
        data?.error?.message ||
        (typeof data?.error === 'string' ? data.error : '') ||
        `Anthropic API error (${res.status})`;
      console.error('[claude-chat] Anthropic error:', res.status, msg, {
        key: anthropicKeyFingerprint(apiKey),
      });
      await refundExamQuota(reservedQuotaCheck, requestId);
      if (body.examGeneration) {
        await logExamGenChunk(event, genTicketPayload, body, { ok: false, model, usage: anthropicUsage });
      }
      return jsonResponse(res.status >= 500 ? 502 : 400, cors, { error: msg });
    }

    const text = (data.content || []).map((part) => part.text || '').join('');
    const stopReason = data.stop_reason || data.stopReason || null;
    if (!text) {
      await refundExamQuota(reservedQuotaCheck, requestId);
      if (body.examGeneration) {
        await logExamGenChunk(event, genTicketPayload, body, { ok: false, model, usage: anthropicUsage });
      }
      return jsonResponse(502, cors, { error: 'Empty response from AI' });
    }

    let examChunkParsed = null;
    let examResponseText = text;

    if (body.examGeneration) {
      examChunkParsed = extractJsonObject(text);
      if (!examChunkParsed) {
        console.warn('[claude-chat] exam chunk JSON unparseable', {
          teil: Number.isFinite(chunkTeil) ? chunkTeil : null,
          slot: chunkSlot || null,
          stop_reason: stopReason,
          outChars: text.length,
        });
        await refundExamQuota(reservedQuotaCheck, requestId);
        await logExamGenChunk(event, genTicketPayload, body, { ok: false, model, usage: anthropicUsage });
        return jsonResponse(422, cors, {
          error: 'exam_chunk_unparseable',
          teil: Number.isFinite(chunkTeil) ? chunkTeil : null,
          slotType: chunkSlot || null,
          stop_reason: stopReason,
          message: stopReason === 'max_tokens' ? 'AI response truncated (max_tokens)' : 'Could not parse exam chunk JSON',
        });
      }
    }

    if (body.examGeneration) {
      const placeholderCount = (
        examResponseText.match(/\.\.\.|Option [A-D]"|"Text here"|"Question here"|Ein Text ueber|Ein Text .ber|An article about/gi) || []
      ).length;
      if (placeholderCount > 5) {
        console.warn('[claude-chat] exam has too many placeholders:', placeholderCount);
        return jsonResponse(422, cors, {
          error: 'exam_low_quality',
          message: 'Generated exam contains placeholder content. Retry recommended.',
        });
      }
    }

    // POOL-2 part gate (personal_exam only) — fail-closed; response text = normalized chunk JSON
    if (body.examGeneration && genTicketPayload?.scope === 'personal_exam') {
      try {
        const gateResult = await gatePersonalExamChunk(getStoreForEvent(event), {
          parsed: examChunkParsed,
          lang: body.lang || examChunkParsed?.lang,
          level: body.level || examChunkParsed?.level,
          chunkTeil: Number.isFinite(chunkTeil) ? chunkTeil : null,
          semantic: true,
        });
        if (!gateResult.ok) {
          const blocking = (gateResult.blocking || []).slice(0, 5).map((f) => ({
            id: f.id,
            severity: f.severity,
            message: f.message,
          }));
          console.warn('[claude-chat] part gate rejected:', gateResult.gateId, blocking[0]?.message);
          await refundExamQuota(reservedQuotaCheck, requestId);
          await logExamGenChunk(event, genTicketPayload, body, { ok: false, model, usage: anthropicUsage });
          return jsonResponse(422, cors, {
            error: 'part_gate_rejected',
            gate: gateResult.gateId,
            blocking,
            message: gateResult.message || 'Part failed quality gate',
            teil: Number.isFinite(chunkTeil) ? chunkTeil : null,
          });
        }
        examChunkParsed = gateResult.chunk;
        examResponseText = JSON.stringify(gateResult.chunk);
      } catch (gateErr) {
        console.error('[claude-chat] part gate unavailable:', gateErr.message, gateErr.stack);
        await refundExamQuota(reservedQuotaCheck, requestId);
        await logExamGenChunk(event, genTicketPayload, body, { ok: false, model, usage: anthropicUsage });
        return jsonResponse(503, cors, {
          error: 'part_gate_unavailable',
          message: gateErr.message || 'Part gate could not run',
        });
      }
    }

    let aiMeta = null;
    if (aiAction && CREDIT_AI_ACTIONS.has(aiAction)) {
      try {
        aiMeta = await confirmAiCreditConsumption(event, aiAction, { requestId });
      } catch (err) {
        console.error('[claude-chat] ai credit confirm failed:', err);
      }
    }

    console.log('[claude-chat] ok', {
      model,
      exam: !!body.examGeneration,
      partGate: !!(body.examGeneration && genTicketPayload?.scope === 'personal_exam'),
      ms: Date.now() - t0,
      maxTokens,
      outChars: examResponseText.length,
    });

    if (body.examGeneration) {
      await logExamGenChunk(event, genTicketPayload, body, { ok: anthropicOk, model, usage: anthropicUsage });
    }

    return jsonResponse(200, cors, {
      text: examResponseText,
      model,
      usage: data.usage || null,
      used: quotaMeta?.used,
      max: quotaMeta?.max,
      plan: quotaMeta?.plan,
      aiUsed: aiMeta?.aiUsed,
      aiMax: aiMeta?.aiMax,
      aiRemaining: aiMeta?.aiRemaining ?? aiMeta?.remaining,
    });
  } catch (err) {
    console.error('[claude-chat] request failed:', err, { ms: Date.now() - t0 });
    await refundExamQuota(reservedQuotaCheck, requestId);
    if (body.examGeneration) {
      await logExamGenChunk(event, genTicketPayload, body, { ok: false, model, usage: anthropicUsage });
    }
    return jsonResponse(502, cors, { error: err.message || 'Internal server error' });
  }
};
