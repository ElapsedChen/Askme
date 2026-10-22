import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const progress = require('../extension/unit-progress.js');

const binding = (overrides = {}) => ({
  courseId: '1', knowledgeUnitId: 'ku:motion', sourceId: 'page:1', sourceVersionHashes: ['source-v1'],
  preparationSnapshotId: 'preparation:1', practiceItemId: 'practice:item-1', normalizedStemHash: 'stem-1',
  variantKey: 'explanation:understand:definition', attemptId: 'attempt:one', ...overrides
});

const result = (overrides = {}) => ({
  schemaVersion: 2, verdict: 'correct', binding: binding(), errorTags: [],
  criterionResults: [{ verification: { status: 'verified' } }],
  verification: { status: 'verified', method: 'deterministic-rubric', reasonCodes: [] }, ...overrides
});

test('ungradable 或未核验 correct 不产生掌握尝试', () => {
  assert.equal(progress.minimalAttempt(result({ verdict: 'ungradable', verification: { status: 'unverified' } }), { expectedBinding: binding() }), null);
  assert.equal(progress.minimalAttempt(result({ verification: { status: 'unverified' } }), { expectedBinding: binding() }), null);
});

test('来源版本或 preparation snapshot 改变后必须重新核验', () => {
  assert.equal(progress.validVerifiedResult(result(), binding({ sourceVersionHashes: ['source-v2'] })), false);
  const stored = { knowledgeUnitId: 'ku:motion', sourceVersionHashes: ['source-v1'], status: 'pendingDelayed', attempts: [] };
  assert.equal(progress.revalidateProgress(stored, ['source-v2']).status, 'needsRevalidation');
});

test('次日不同 item 与 variant 的无辅助正确才确认延迟掌握', () => {
  const firstAt = Date.parse('2026-10-01T00:00:00Z');
  const firstAttempt = progress.minimalAttempt(result(), { expectedBinding: binding(), now: firstAt, hintLevel: 0, answerViewed: false });
  const pending = progress.applyAttempt(null, firstAttempt, firstAt);
  assert.equal(pending.status, 'pendingDelayed');
  const secondBinding = binding({ practiceItemId: 'practice:item-2', normalizedStemHash: 'stem-2', variantKey: 'scenario:apply:transfer', attemptId: 'attempt:two' });
  const secondAt = firstAt + progress.DAY_MS;
  const secondAttempt = progress.minimalAttempt(result({ binding: secondBinding }), { expectedBinding: secondBinding, now: secondAt, hintLevel: 0, answerViewed: false });
  assert.equal(progress.applyAttempt(pending, secondAttempt, secondAt).status, 'delayedConfirmed');
  const duplicateVariant = { ...secondAttempt, attemptId: 'attempt:three', itemId: 'practice:item-3', variantKey: firstAttempt.variantKey };
  assert.equal(progress.applyAttempt(pending, duplicateVariant, secondAt).status, 'pendingDelayed');
});

test('错误标签使用闭集且持久记录不含题干答案反馈', () => {
  const incorrect = result({
    verdict: 'incorrect',
    errorTags: [{ type: 'unit-error', verification: { status: 'verified' } }]
  });
  const attempt = progress.minimalAttempt(incorrect, { expectedBinding: binding(), now: 1 });
  assert.deepEqual(attempt.errorTags, ['unit-error']);
  const serialized = JSON.stringify(attempt);
  for (const forbidden of ['studentAnswer', 'question', 'modelAnswer', 'feedback', 'evidence']) assert.equal(serialized.includes(forbidden), false);
});
