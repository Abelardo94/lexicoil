#!/usr/bin/env node
/** Sprechen T1 A2 personal_questions — _requestedTopic pool-fill only; question tags = Freizeit. */
import assert from 'node:assert/strict';
import {
  alignQuestionTopicTagsToRequestedTopic,
  tagBatchWithTopic,
  isSprechenT1PersonalFixedFormat,
} from '../topicRotation.mjs';
import { enrichBatchMetadata } from '../enrichBatchMetadata.mjs';
import { poolReadyCheck } from '../poolReadyCheck.mjs';
import { runMetadataSchemaGate } from '../qualityGates/metadataSchemaGate.mjs';

const spT1 = {
  module: 'sprechen',
  teil: 1,
  level: 'A2',
  lang: 'de',
  topicTag: 'Medien',
  _requestedTopic: 'Medien',
  passages: [],
  questions: [
    {
      id: 'q1',
      module: 'sprechen',
      teil: 1,
      level: 'A2',
      lang: 'de',
      type: 'personal_questions',
      question:
        'Geburtstag — Wann ist Ihr Geburtstag? Wohnort — Wo wohnen Sie? Beruf — Was ist Ihr Beruf? Hobby — Was machen Sie gern?',
      correct: 'rubric',
      correctAnswer: 'rubric',
      topicTags: ['Medien'],
    },
  ],
};

assert.ok(isSprechenT1PersonalFixedFormat(spT1), 'detect personal_questions T1');

const aligned = alignQuestionTopicTagsToRequestedTopic(structuredClone(spT1));
assert.equal(aligned.topicTag, 'Medien', 'batch.topicTag stays pool-fill axis');
assert.deepEqual(aligned.questions[0].topicTags, ['Freizeit'], 'question topicTags = content axis');

const tagged = tagBatchWithTopic(structuredClone(spT1), 'Medien');
assert.equal(tagged.topicTag, 'Medien');
assert.deepEqual(tagged.questions[0].topicTags, ['Freizeit']);

const { batch: enriched } = enrichBatchMetadata(structuredClone(spT1), {
  topic: false,
  grammar: false,
  vocab: false,
});
assert.equal(enriched.topicTag, 'Medien');
assert.deepEqual(enriched.questions[0].topicTags, ['Freizeit']);

const gate = runMetadataSchemaGate(enriched, {
  file: 'sprechen-t1-gemini-test.json',
  profile: 'generated',
  module: 'sprechen',
});
const mismatches = (gate.findings || []).filter((f) => f.rule === 'topic_mismatch');
assert.ok(mismatches.length >= 1, 'Q4 logs topic_mismatch for Freizeit vs Medien');

const ready = await poolReadyCheck(enriched, {
  file: 'sprechen-t1-gemini-test.json',
  level: 'A2',
  skipQ1: true,
  skipQ2: true,
});
const topicReject = (ready.reasons || []).filter((r) => r === 'topic_mismatch');
assert.equal(topicReject.length, 0, 'topic_mismatch must not block Sprechen T1 personal');
const audits = (ready.details || []).filter(
  (d) => d.rule === 'topic_mismatch' && d.severity === 'audit',
);
assert.ok(audits.length >= 1, 'topic_mismatch logged audit-only in poolReadyCheck');

console.log('PASS: sprechen-t1-topic-policy');
