import { verifyAtomicClaim, normaliseForEvidence } from '../server/claim-verifier.mjs';

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function round(value) { return Number(value.toFixed(4)); }

export function validateGoldDataset(dataset) {
  if (!dataset || dataset.schemaVersion !== 1 || !Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error('金标数据集必须包含非空 cases');
  const ids = new Set();
  for (const item of dataset.cases) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) throw new Error('金标 case id 无效或重复');
    ids.add(item.id);
    if (typeof item.query !== 'string' || !item.query.trim()) throw new Error(`${item.id} 缺少 query`);
    if (!Array.isArray(item.relevantSegmentIds) || !item.relevantSegmentIds.length || item.relevantSegmentIds.some(id => typeof id !== 'string' || !id)) throw new Error(`${item.id} 缺少相关片段标注`);
    if (item.goldClaims !== undefined && (!Array.isArray(item.goldClaims) || item.goldClaims.some(claim => typeof claim?.text !== 'string' || !Array.isArray(claim.evidence) || !claim.evidence.length))) throw new Error(`${item.id} 的 goldClaims 无效`);
  }
  return true;
}

function rankedIds(run) {
  return (Array.isArray(run?.retrieved) ? run.retrieved : []).map(item => typeof item === 'string' ? item : item?.segmentId).filter(Boolean);
}

export function retrievalMetrics(dataset, run, k = 5) {
  validateGoldDataset(dataset);
  const byId = new Map((run?.cases || []).map(item => [item.id, item]));
  const perCase = dataset.cases.map(item => {
    const retrieved = rankedIds(byId.get(item.id)).slice(0, k);
    const relevant = new Set(item.relevantSegmentIds);
    const hits = retrieved.filter(id => relevant.has(id));
    const firstRank = retrieved.findIndex(id => relevant.has(id));
    return {
      id: item.id, retrieved: retrieved.length, relevant: relevant.size, hits: hits.length,
      hitAtK: hits.length ? 1 : 0, recallAtK: hits.length / relevant.size,
      reciprocalRank: firstRank < 0 ? 0 : 1 / (firstRank + 1)
    };
  });
  return {
    k, cases: perCase.length, hitAtK: round(mean(perCase.map(item => item.hitAtK))),
    recallAtK: round(mean(perCase.map(item => item.recallAtK))), mrrAtK: round(mean(perCase.map(item => item.reciprocalRank))), perCase
  };
}

function evidenceSupported(evidence, sourceExcerpt) {
  const quote = normaliseForEvidence(evidence);
  return quote.length >= 6 && normaliseForEvidence(sourceExcerpt).includes(quote);
}

export function answerMetrics(dataset, run) {
  validateGoldDataset(dataset);
  const byId = new Map((run?.cases || []).map(item => [item.id, item]));
  let totalItems = 0, citedItems = 0, supportedItems = 0, atomicItems = 0;
  const perCase = dataset.cases.map(item => {
    const result = byId.get(item.id) || {};
    const sources = new Map((result.sources || []).map(source => [Number(source.number), source]));
    const answerItems = Array.isArray(result.answerItems) ? result.answerItems : [];
    let caseSupported = 0, caseAtomic = 0;
    for (const answer of answerItems) {
      totalItems++;
      const source = sources.get(Number(answer.source));
      if (source && answer.evidence) citedItems++;
      const supported = source && evidenceSupported(answer.evidence, source.excerpt);
      if (supported) { supportedItems++; caseSupported++; }
      if (supported && verifyAtomicClaim(answer.text, answer.evidence).ok) { atomicItems++; caseAtomic++; }
    }
    const goldClaims = item.goldClaims || [];
    const coveredGoldClaims = goldClaims.filter(claim => answerItems.some(answer =>
      claim.evidence.some(quote => normaliseForEvidence(answer.evidence).includes(normaliseForEvidence(quote)) || normaliseForEvidence(quote).includes(normaliseForEvidence(answer.evidence)))
    )).length;
    return {
      id: item.id, answerItems: answerItems.length,
      citationSupport: answerItems.length ? caseSupported / answerItems.length : 0,
      atomicSupport: answerItems.length ? caseAtomic / answerItems.length : 0,
      goldClaimCoverage: goldClaims.length ? coveredGoldClaims / goldClaims.length : null
    };
  });
  const coverage = perCase.map(item => item.goldClaimCoverage).filter(value => value !== null);
  return {
    answerItems: totalItems,
    citationPresence: round(totalItems ? citedItems / totalItems : 0),
    citationSupport: round(totalItems ? supportedItems / totalItems : 0),
    atomicSupport: round(totalItems ? atomicItems / totalItems : 0),
    goldClaimCoverage: coverage.length ? round(mean(coverage)) : null,
    perCase
  };
}

export function evaluateLearningQuality(dataset, run, options = {}) {
  const retrieval = retrievalMetrics(dataset, run, options.k ?? 5);
  const answers = answerMetrics(dataset, run);
  const thresholds = { recallAtK: 0.8, mrrAtK: 0.65, citationSupport: 1, atomicSupport: 1, ...(dataset.thresholds || {}), ...(options.thresholds || {}) };
  const checks = {
    recallAtK: retrieval.recallAtK >= thresholds.recallAtK,
    mrrAtK: retrieval.mrrAtK >= thresholds.mrrAtK,
    citationSupport: answers.citationSupport >= thresholds.citationSupport,
    atomicSupport: answers.atomicSupport >= thresholds.atomicSupport
  };
  return { schemaVersion: 1, retrieval, answers, thresholds, checks, passed: Object.values(checks).every(Boolean) };
}
