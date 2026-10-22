import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRACTICE_ERROR_TAGS, normalizeGeneratedPracticeItem, normalizePracticeContext, practiceQuestionFingerprint,
  practiceContentDigest, ungradablePracticeResult, verifiedPracticeResult
} from './practice-core.mjs';

test('课程摘录内容摘要使用固定 UTF-8 SHA-256', () => {
  assert.equal(practiceContentDigest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(practiceContentDigest('课程原文'), practiceContentDigest('课程原文'));
});

test('错误类型闭集覆盖学习诊断所需类别', () => {
  assert.deepEqual(PRACTICE_ERROR_TAGS, [
    'definition-confusion', 'condition-omission', 'causal-error', 'sequence-error', 'formula-selection',
    'calculation-error', 'unit-error', 'transfer-failure', 'hint-dependent', 'unknown'
  ]);
});

test('practice-v2 context 只接受最小版本和历史标识', () => {
  const value = normalizePracticeContext({
    schemaVersion: 2, courseId: '1', knowledgeUnitId: 'ku:1', sourceId: 'page:1', sourceVersionHashes: ['v1'],
    dayKey: '2026-10-02', questionCount: 1, preparationSnapshotId: 'prep:1', previousItemIds: ['practice:old-item'],
    previousVariantKeys: ['scenario:apply:transfer'], variantSeed: '2026-10-02:2'
  });
  assert.equal(value.questionCount, 1);
  assert.deepEqual(value.previousItemIds, ['practice:old-item']);
  assert.equal(normalizePracticeContext({ ...value, sourceVersionHashes: [] }), null);
});

test('题目身份和 variant 可用于次日去重且不保存题干', () => {
  const item = normalizeGeneratedPracticeItem({
    question: 'What does mechanics study?', answer: 'Motion.', explanation: 'Mechanics studies motion.',
    evidence: 'Mechanics studies motion.', type: 'explanation', bloomLevel: 'understand', aspect: 'definition'
  }, 0, 'source-v1');
  assert.match(item.itemId, /^practice:/u);
  assert.equal(item.variantKey, 'explanation:understand:definition');
  assert.equal(practiceQuestionFingerprint('What does mechanics study?'), practiceQuestionFingerprint(' what does mechanics study '));
});

test('unknown 错误类型降级 ungradable', () => {
  const binding = { attemptId: 'attempt:one' };
  const evidenceRef = { id: 'evidence:one', sourceVersionHash: 'v1' };
  const value = verifiedPracticeResult({ verdict: 'incorrect', feedback: '无法确认错误类型', modelAnswer: 'A', explanation: 'A', errorTag: 'unknown', binding, evidenceRef });
  assert.equal(value.verdict, 'ungradable');
  assert.equal(value.verification.status, 'needsReview');
  assert.equal(JSON.stringify(ungradablePracticeResult(binding, ['AUDIT_FAILED'])).includes('studentAnswer'), false);
});
