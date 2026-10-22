import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCatalog, evaluate, scoreAnswer, scoreRetrieval, scoreSummary, validateDataset } from '../evaluation/gold-eval.mjs';

const qa = {
  id: 'q1', type: 'qa', answerability: 'answerable', language: 'cross', risk: 'high',
  evidenceGroups: [
    { id: 'definition', ids: ['a', 'a-alt'], gain: 3, required: true, versionHash: 'v1' },
    { id: 'condition', ids: ['b'], gain: 2, required: true, versionHash: 'v1' }
  ],
  requiredFacts: [
    { id: 'f1', evidenceIds: ['a', 'a-alt'] },
    { id: 'f2', evidenceIds: ['b'] }
  ]
};

test('数据集校验拒绝重复项目和缺少证据的可回答问题', () => {
  const result = validateDataset({ schemaVersion: 1, items: [
    { id: 'same', type: 'qa', answerability: 'answerable', evidenceGroups: [], requiredFacts: [] },
    { id: 'same', type: 'wrong', answerability: 'answerable', evidenceGroups: [], requiredFacts: [] }
  ] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('重复')));
  assert.ok(result.errors.some(error => error.includes('evidenceGroups')));
});

test('检索按必要证据组计算 Recall@k、MRR 和 nDCG', () => {
  const score = scoreRetrieval(qa, { retrievedEvidenceIds: ['noise', 'a-alt', 'b'] });
  assert.equal(score.recallAt5, 1);
  assert.equal(score.recallAt20, 1);
  assert.equal(score.mrr, 0.5);
  assert.ok(score.ndcgAt10 > 0.6 && score.ndcgAt10 < 1);
});

test('同一证据组的等价 span 不会让 nDCG 重复得分', () => {
  const score = scoreRetrieval(qa, { retrievedEvidenceIds: ['a', 'a-alt', 'b'] });
  assert.equal(score.ndcgAt10, 1);
});

test('引用指标和事实支持率可由事实到证据的映射确定性计算', () => {
  const score = scoreAnswer(qa, {
    citationIds: ['a', 'noise'],
    claims: [
      { factId: 'f1', citationIds: ['a'] },
      { factId: 'f2', citationIds: ['noise'] },
      { factId: 'invented', citationIds: ['a'] }
    ]
  });
  assert.equal(score.citationPrecision, 0.5);
  assert.equal(score.necessaryCitationRecall, 0.5);
  assert.equal(score.claimFaithfulness, 0.333333);
  assert.equal(score.unsupportedClaims, 2);
});

test('独立裁决可标记看似有引用但语义矛盾的 claim', () => {
  const score = scoreAnswer(qa, {
    claims: [{ factId: 'f1', citationIds: ['a'], adjudication: 'contradicted' }]
  });
  assert.equal(score.claimFaithfulness, 0);
  assert.equal(score.contradictedClaims, 1);
});

test('摘要报告关键事实覆盖、事实一致性和幻觉数', () => {
  const item = { ...qa, type: 'summary' };
  const score = scoreSummary(item, { claims: [
    { factId: 'f1', citationIds: ['a'] },
    { factId: 'unknown', citationIds: ['a'] }
  ] });
  assert.equal(score.keyFactRecall, 0.5);
  assert.equal(score.factConsistency, 0.5);
  assert.equal(score.hallucinatedOrUnsupported, 1);
});

test('本地索引目录默认不复制正文，显式选择才包含正文', () => {
  const source = { segments: [{ id: 's1', title: 'Private title', text: 'private body', headingPath: ['Week 1'], versionHash: 'v1' }] };
  const safe = createLocalCatalog(source);
  assert.equal(safe.entries[0].characterCount, 12);
  assert.equal(Object.hasOwn(safe.entries[0], 'text'), false);
  assert.equal(createLocalCatalog(source, { includeText: true }).entries[0].text, 'private body');
});

test('整体评测聚合检索、引用、总结、拒答并检查证据版本', () => {
  const summary = { ...qa, id: 's1', type: 'summary', risk: 'standard' };
  const unanswerable = { id: 'u1', type: 'qa', answerability: 'unanswerable', evidenceGroups: [], requiredFacts: [] };
  const dataset = { schemaVersion: 1, datasetId: 'local', items: [qa, summary, unanswerable] };
  const perfect = item => ({
    id: item.id,
    retrievedEvidenceIds: ['a', 'b'], citationIds: ['a', 'b'],
    claims: [{ factId: 'f1', citationIds: ['a'] }, { factId: 'f2', citationIds: ['b'] }], refused: false
  });
  const report = evaluate(dataset, { items: [perfect(qa), perfect(summary), { id: 'u1', refused: true, claims: [], citationIds: [] }] }, {
    catalog: { entries: [{ id: 'a', versionHash: 'v1' }, { id: 'a-alt', versionHash: 'v1' }, { id: 'b', versionHash: 'v1' }] }
  });
  assert.equal(report.aggregate.retrieval.recallAt20, 1);
  assert.equal(report.aggregate.answer.claimFaithfulness, 1);
  assert.equal(report.aggregate.summary.keyFactRecall, 1);
  assert.equal(report.aggregate.answer.correctRefusalRate, 1);
  assert.equal(report.versionCheck.valid, true);
  assert.equal(report.items.some(item => Object.hasOwn(item, 'question')), false);
});

test('评测拒绝缺项运行，避免用部分样本冒充完整回归', () => {
  const dataset = { schemaVersion: 1, items: [qa, { ...qa, id: 'q2' }] };
  assert.throws(() => evaluate(dataset, { items: [{ id: 'q1' }] }), /run 缺少项目: q2/u);
});

