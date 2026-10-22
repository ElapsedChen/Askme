import { createHash } from 'node:crypto';

export const PRACTICE_VERDICTS = Object.freeze(['correct', 'partial', 'incorrect', 'ungradable']);
export const PRACTICE_ERROR_TAGS = Object.freeze([
  'definition-confusion', 'condition-omission', 'causal-error', 'sequence-error', 'formula-selection',
  'calculation-error', 'unit-error', 'transfer-failure', 'hint-dependent', 'unknown'
]);
export const PRACTICE_ITEM_TYPES = Object.freeze(['short-answer', 'calculation', 'explanation', 'comparison', 'scenario']);
export const PRACTICE_BLOOM_LEVELS = Object.freeze(['remember', 'understand', 'apply', 'analyze']);

const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

export function practiceQuestionFingerprint(value) {
  const normalized = String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
  return normalized ? createHash('sha256').update(normalized).digest('hex').slice(0, 24) : '';
}

export function practiceContentDigest(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function practiceItemIdentity(question, sourceVersionHash) {
  const stem = practiceQuestionFingerprint(question);
  return stem && sourceVersionHash ? `practice:${createHash('sha256').update(`${sourceVersionHash}|${stem}`).digest('hex').slice(0, 24)}` : '';
}

export function normalizePracticeContext(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 2) return null;
  const courseId = clean(value.courseId, 12);
  const knowledgeUnitId = clean(value.knowledgeUnitId, 180);
  const sourceId = clean(value.sourceId, 4096);
  const sourceVersionHashes = Array.isArray(value.sourceVersionHashes)
    ? [...new Set(value.sourceVersionHashes.map(item => clean(item, 160)).filter(Boolean))].slice(0, 8) : [];
  const dayKey = clean(value.dayKey, 10);
  const questionCount = Number.isInteger(value.questionCount) && value.questionCount >= 1 && value.questionCount <= 3 ? value.questionCount : 3;
  if (!/^\d{1,12}$/u.test(courseId) || !knowledgeUnitId || !sourceId || !sourceVersionHashes.length || !/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) return null;
  const bounded = (items, prefix = '') => Array.isArray(items)
    ? [...new Set(items.map(item => clean(item, 180)).filter(item => item && (!prefix || item.startsWith(prefix))))].slice(-12) : [];
  return {
    schemaVersion: 2, courseId, knowledgeUnitId, sourceId, sourceVersionHashes, dayKey, questionCount,
    preparationSnapshotId: clean(value.preparationSnapshotId, 180),
    previousItemIds: bounded(value.previousItemIds, 'practice:'),
    previousVariantKeys: bounded(value.previousVariantKeys),
    variantSeed: clean(value.variantSeed, 120)
  };
}

export function normalizeGeneratedPracticeItem(item, index, sourceVersionHash) {
  const question = clean(item?.question, 500);
  const answer = clean(item?.answer, 800);
  const explanation = clean(item?.explanation, 1000);
  const evidence = clean(item?.evidence, 220);
  if (!question || !answer || !explanation || !evidence) return null;
  const type = PRACTICE_ITEM_TYPES.includes(item?.type) ? item.type : 'short-answer';
  const bloomLevel = PRACTICE_BLOOM_LEVELS.includes(item?.bloomLevel) ? item.bloomLevel : 'understand';
  const aspect = clean(item?.aspect, 80) || practiceQuestionFingerprint(question).slice(0, 12);
  const normalizedStemHash = practiceQuestionFingerprint(question);
  const variantKey = `${type}:${bloomLevel}:${aspect}`;
  const itemId = practiceItemIdentity(question, sourceVersionHash);
  return { id: `q${index + 1}`, itemId, normalizedStemHash, variantKey, type, bloomLevel, question, answer, explanation, evidence };
}

export function ungradablePracticeResult(binding, reasonCodes, status = 'unverified', method = 'deterministic-rubric') {
  return {
    schemaVersion: 2,
    verdict: 'ungradable',
    criterionResults: [],
    errorTags: [],
    evidenceRefs: [],
    verification: { status, method, reasonCodes: [...new Set(reasonCodes)].slice(0, 8) },
    binding
  };
}

export function verifiedPracticeResult({ verdict, feedback, modelAnswer, explanation, errorTag, binding, evidenceRef, verificationMethod = 'deterministic-rubric' }) {
  if (!['correct', 'partial', 'incorrect'].includes(verdict)) return null;
  const type = PRACTICE_ERROR_TAGS.includes(errorTag) ? errorTag : verdict === 'correct' ? null : 'unknown';
  const verificationStatus = type === 'unknown' ? 'needsReview' : 'verified';
  const criterionStatus = verdict === 'correct' ? 'met' : verdict === 'partial' ? 'partial' : 'not-met';
  const criterionId = 'course-evidence-answer';
  const errorTags = type ? [{
    type, rubricCriterionId: criterionId, evidenceSpanId: evidenceRef.id,
    observedMismatch: clean(feedback, 300),
    verification: { status: verificationStatus, method: verificationMethod, reasonCodes: type === 'unknown' ? ['ERROR_TAG_UNKNOWN'] : [] }
  }] : [];
  if (verificationStatus !== 'verified') return ungradablePracticeResult(binding, ['ERROR_TAG_UNKNOWN'], 'needsReview');
  return {
    schemaVersion: 2, verdict,
    feedback: clean(feedback, 1000), modelAnswer: clean(modelAnswer, 800), explanation: clean(explanation, 1000),
    criterionResults: [{ criterionId, status: criterionStatus, evidenceRef, verification: { status: 'verified', method: verificationMethod, reasonCodes: [] } }],
    errorTags, evidenceRefs: [evidenceRef],
    verification: { status: 'verified', method: verificationMethod, reasonCodes: [] }, binding
  };
}
