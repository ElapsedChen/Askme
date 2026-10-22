import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLearningQuality, retrievalMetrics, validateGoldDataset } from '../quality/learning-quality.mjs';

const dataset = {
  schemaVersion: 1,
  thresholds: { recallAtK: 0.5, mrrAtK: 0.5, citationSupport: 1, atomicSupport: 1 },
  cases: [{
    id: 'c1', query: 'What spindle speed is specified?', relevantSegmentIds: ['s2'],
    goldClaims: [{ text: 'The speed is 1200 rpm.', evidence: ['speed is 1200 rpm'] }]
  }]
};

const goodRun = { cases: [{
  id: 'c1', retrieved: [{ segmentId: 's1' }, { segmentId: 's2' }],
  sources: [{ number: 1, segmentId: 's2', excerpt: 'The specified spindle speed is 1200 rpm for this operation.' }],
  answerItems: [{ text: 'The specified spindle speed is 1200 rpm.', source: 1, evidence: 'spindle speed is 1200 rpm' }]
}] };

test('金标格式拒绝重复编号和缺少相关片段', () => {
  assert.equal(validateGoldDataset(dataset), true);
  assert.throws(() => validateGoldDataset({ schemaVersion: 1, cases: [{ id: 'x', query: 'q', relevantSegmentIds: [] }] }), /相关片段/u);
});

test('检索指标计算 recall at k 和 MRR', () => {
  const result = retrievalMetrics(dataset, goodRun, 5);
  assert.equal(result.recallAtK, 1);
  assert.equal(result.mrrAtK, 0.5);
});

test('完整评测要求检索与逐条证据同时过门槛', () => {
  const report = evaluateLearningQuality(dataset, goodRun);
  assert.equal(report.passed, true);
  assert.equal(report.answers.citationSupport, 1);
  assert.equal(report.answers.atomicSupport, 1);
  const bad = structuredClone(goodRun);
  bad.cases[0].answerItems[0].text = 'The specified spindle speed is 2000 rpm.';
  assert.equal(evaluateLearningQuality(dataset, bad).passed, false);
});
