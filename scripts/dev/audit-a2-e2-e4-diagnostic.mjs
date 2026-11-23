#!/usr/bin/env node
/** Diagnostic audit — A2 published e2/e3/e4 (2026-08-09). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { auditExam, isExamPublishable, partRecordToExamPart } from '../audit-pass-2.mjs';
import { checkPassageContentTopic } from '../lib/qualityGates/contentTopicCheck.mjs';
import { detectTopic } from '../lib/topicRotation.mjs';
import { extractAuditableSegments } from '../audit-languagetool-de.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HPM = require(path.join(ROOT, 'js/engine/horenPictureMatching.js'));
const { findExplanationOptionTextAlignFindings } = require('../lib/explanationOptionTextAlign.mjs');

const LT_BASE = (process.env.LT_BASE || 'http://127.0.0.1:8010').replace(/\/$/, '');
const LT_NOISE = new Set([
  'DE_CO2', 'CO2', 'TYPOGRAPHY', 'WHITESPACE_RULE', 'COMMA_PARENTHESIS_WHITESPACE',
  'UPPERCASE_SENTENCE_START', 'SENT_START_CONJUNCTIVE',
]);

const EXAMS = [2, 3, 4];

function publishedDocToExam(doc) {
  const buckets = { lesen: [], horen: [], schreiben: [], sprechen: [] };
  for (const p of doc.parts || []) {
    const part = partRecordToExamPart(p.snapshot);
    if (!part || !buckets[p.module]) continue;
    buckets[p.module].push(part);
  }
  const sort = (arr) => arr.sort((a, b) => a.teil - b.teil);
  return {
    level: doc.level,
    lesenParts: sort(buckets.lesen),
    horenParts: sort(buckets.horen),
    schreibenParts: sort(buckets.schreiben),
    sprechenParts: sort(buckets.sprechen),
  };
}

function flattenSnapshots(doc) {
  const passages = [];
  const questions = [];
  for (const p of doc.parts || []) {
    const snap = p.snapshot || {};
    for (const pg of snap.passages || []) passages.push({ ...pg, _partId: p.partId });
    if (snap.passage?.text) passages.push({ ...snap.passage, _partId: p.partId });
    for (const q of snap.questions || []) questions.push({ ...q, _partId: p.partId, module: p.module, teil: p.teil });
    for (const seg of snap.segments || []) {
      if (seg.text) passages.push({ id: seg.passageId, text: seg.text, _partId: p.partId });
      for (const q of seg.questions || []) questions.push({ ...q, _partId: p.partId, module: p.module, teil: p.teil });
    }
  }
  return { passages, questions };
}

function classifyLtMatch(m) {
  const rule = m.ruleId || '';
  if (LT_NOISE.has(rule) || /CO2|WHITESPACE|UPPERCASE_SENTENCE/i.test(rule)) return 'D';
  if (/FEHLERHAFTES_KOMMA|COMMA/i.test(rule)) return 'D';
  if (/EIN_BISSCHEN|STYLE|TYPO/i.test(rule)) return 'D';
  if (/AGREEMENT|SPELLER|CASE|GRAMMAR|KOMMA_ALLG/i.test(rule)) return 'A';
  return 'B';
}

async function ltCheck(text) {
  const body = new URLSearchParams({ language: 'de-DE', text });
  const res = await fetch(`${LT_BASE}/v2/check`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw new Error(`LT HTTP ${res.status}`);
  return res.json();
}

async function auditExamLt(doc, examId) {
  const flat = flattenSnapshots(doc);
  const batch = { passages: flat.passages, questions: flat.questions, level: 'A2' };
  const segments = extractAuditableSegments(batch, 'full');
  const hits = [];
  for (const seg of segments) {
    try {
      const data = await ltCheck(seg.text);
      for (const m of data.matches || []) {
        const slim = {
          ruleId: m?.rule?.id,
          message: m?.message,
          replacements: (m?.replacements || []).slice(0, 3).map((r) => r.value),
          context: m?.context?.text,
        };
        if (LT_NOISE.has(slim.ruleId)) continue;
        hits.push({
          examId,
          partContext: `${seg.field} p${seg.passageIndex ?? '-'} q${seg.questionIndex ?? '-'}`,
          ...slim,
          cat: classifyLtMatch(slim),
        });
      }
      await new Promise((r) => setTimeout(r, 25));
    } catch (err) {
      hits.push({ examId, error: err.message, partContext: seg.field });
    }
  }
  return { segments: segments.length, hits };
}

function auditH2(doc, examId) {
  const issues = [];
  for (const p of doc.parts || []) {
    if (p.module !== 'horen' || p.teil !== 2) continue;
    const snap = { ...p.snapshot, level: 'A2', module: 'horen', teil: 2 };
    const hits = HPM.validatePictureMatchingAlign(snap, { module: 'horen', teil: 2, level: 'A2' });
    for (const h of hits) issues.push({ examId, partId: p.partId, check: 'CHK-H2-ALIGN', severity: 'CRITICAL', message: h });
  }
  return issues;
}

function auditChk34(doc, examId) {
  const issues = [];
  for (const p of doc.parts || []) {
    for (const q of p.snapshot?.questions || []) {
      if (!q.options?.length) continue;
      const hits = findExplanationOptionTextAlignFindings({ questions: [q] });
      for (const h of hits) {
        issues.push({
          examId,
          partId: p.partId,
          qid: q.id,
          check: 'CHK-34',
          severity: h.severity,
          message: h.message,
        });
      }
    }
    for (const seg of p.snapshot?.segments || []) {
      for (const q of seg.questions || []) {
        if (!q.options?.length) continue;
        const hits = findExplanationOptionTextAlignFindings({ questions: [q] });
        for (const h of hits) {
          issues.push({ examId, partId: p.partId, qid: q.id, check: 'CHK-34', severity: h.severity, message: h.message });
        }
      }
    }
  }
  return issues;
}

async function auditTopic(doc, examId) {
  const issues = [];
  const A2_OFFICIAL = ['Reisen', 'Gesundheit', 'Stadtleben', 'Medien', 'Umwelt'];
  for (const p of doc.parts || []) {
    const snap = p.snapshot || {};
    const p0 = snap.passages?.[0] || snap.passage;
    if (!p0) continue;
    const tag = snap.topicTag || p0.topicTag || snap.questions?.[0]?.topicTags?.[0] || p.partId.match(/-cur-(\w+)/)?.[1];
    const declared = tag ? String(tag).charAt(0).toUpperCase() + String(tag).slice(1) : null;
    const text = [p0.title, p0.text, p0.transcript, ...(snap.questions || []).flatMap((q) => [q.question, q.explanation])].filter(Boolean).join('\n');
    const detected = detectTopic(text, { level: 'A2' });
    let mismatch = null;
    if (declared) {
      const ct = checkPassageContentTopic({ ...p0, topicTag: declared }, { level: 'A2', teil: p.teil, module: p.module });
      if (ct.mismatch) mismatch = ct.detail || ct.reason;
    }
    const slug = (p.partId.match(/-cur-(\w+)/) || [])[1];
    const slugOfficial = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : null;
    const catD = mismatch && slugOfficial && !A2_OFFICIAL.includes(detected) && detected !== slugOfficial;
    issues.push({
      examId,
      partId: p.partId,
      module: p.module,
      teil: p.teil,
      declared,
      detected,
      slugOfficial,
      mismatch: mismatch || null,
      /** A2 policy: passage-level mismatch is audit-only, not publish block */
      blocks: false,
      cat: mismatch ? (catD ? 'D' : 'B') : null,
    });
  }
  return issues.filter((i) => i.mismatch);
}

async function main() {
  let ltOk = false;
  try {
    const res = await fetch(`${LT_BASE}/v2/languages`);
    ltOk = res.ok;
  } catch { /* */ }

  const report = { at: new Date().toISOString(), ltAvailable: ltOk, exams: {} };

  for (const slot of EXAMS) {
    const examId = `official-de-A2-e${slot}`;
    console.error(`[audit] ${examId}…`);
    const fp = path.join(ROOT, 'library/published-exams/de/A2', `${examId}.json`);
    const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const exam = publishedDocToExam(doc);
    const pub = isExamPublishable({ exam, level: 'A2' }, { expectedLevel: 'A2' });
    const audit = auditExam({ exam }, examId);

    const h2 = auditH2(doc, examId);
    const chk34 = auditChk34(doc, examId);
    const topic = await auditTopic(doc, examId);
    let lt = { segments: 0, hits: [], skipped: !ltOk };
    if (ltOk) lt = await auditExamLt(doc, examId);

    const critical = [
      ...pub.blocking.filter((f) => f.severity === 'CRITICAL'),
      ...h2,
      ...chk34.filter((x) => x.severity === 'CRITICAL'),
    ];
    const important = audit.findings.filter((f) => f.severity === 'IMPORTANT');
    const minor = audit.findings.filter((f) => f.severity === 'MINOR');

    const ltByCat = { A: [], B: [], C: [], D: [] };
    for (const h of lt.hits) {
      if (h.cat && ltByCat[h.cat]) ltByCat[h.cat].push(h);
      else if (h.error) ltByCat.C.push(h);
    }

    report.exams[examId] = {
      slot,
      partIds: (doc.parts || []).map((p) => p.partId),
      h2Part: (doc.parts || []).find((p) => p.module === 'horen' && p.teil === 2)?.partId,
      publishable: pub.ok,
      blockingCount: pub.blocking.length,
      blocking: pub.blocking.map((f) => ({ id: f.id, severity: f.severity, message: f.message?.slice(0, 120) })),
      auditSummary: {
        critical: audit.critical,
        important: audit.important,
        minor: audit.minor,
        criticalChecks: [...new Set(critical.map((f) => f.id || f.check))],
      },
      chkH2Align: h2,
      chk34: {
        critical: chk34.filter((x) => x.severity === 'CRITICAL').length,
        minor: chk34.filter((x) => x.severity === 'MINOR').length,
        items: chk34,
      },
      contentTopic: {
        auditOnly: topic.filter((t) => !t.blocks),
        blocking: topic.filter((t) => t.blocks),
        items: topic,
      },
      languagetool: {
        scope: 'full',
        segments: lt.segments,
        totalHits: lt.hits.length,
        byCategory: {
          A: ltByCat.A.length,
          B: ltByCat.B.length,
          C: ltByCat.C.length,
          D: ltByCat.D.length,
        },
        samplesA: ltByCat.A.slice(0, 8),
        samplesD: ltByCat.D.slice(0, 5),
        allHits: lt.hits,
      },
      verdict: critical.length === 0 && topic.filter((t) => t.blocks).length === 0 ? 'CLEAN_OR_ADVISORY' : 'NEEDS_REVIEW',
    };
  }

  const outPath = path.join(ROOT, 'batches/ready/gate-logs/a2-e2-e4-diagnostic-2026-08-09.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify({
    outPath: path.relative(ROOT, outPath).replace(/\\/g, '/'),
    ltOk,
    summary: Object.fromEntries(Object.entries(report.exams).map(([k, v]) => [k, {
      verdict: v.verdict,
      publishable: v.publishable,
      h2: v.chkH2Align.length,
      chk34crit: v.chk34.critical,
      chk34min: v.chk34.minor,
      topicBlock: v.contentTopic.blocking.length,
      topicAudit: v.contentTopic.auditOnly.length,
      ltA: v.languagetool.byCategory.A,
      ltD: v.languagetool.byCategory.D,
      blocking: v.blockingCount,
    }])),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
