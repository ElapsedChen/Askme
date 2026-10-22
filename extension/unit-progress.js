(function initAskmeUnitProgress(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module?.exports) module.exports = api;
  root.AskmeUnitProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const ERROR_TAGS = Object.freeze([
    'definition-confusion', 'condition-omission', 'causal-error', 'sequence-error', 'formula-selection',
    'calculation-error', 'unit-error', 'transfer-failure', 'hint-dependent', 'unknown'
  ]);
  const DAY_MS = 86_400_000;

  function currentBinding(binding, expected) {
    if (!binding || !expected || binding.courseId !== expected.courseId || binding.knowledgeUnitId !== expected.knowledgeUnitId ||
        binding.sourceId !== expected.sourceId || binding.preparationSnapshotId !== (expected.preparationSnapshotId || '')) return false;
    const left = Array.isArray(binding.sourceVersionHashes) ? binding.sourceVersionHashes : [];
    const right = Array.isArray(expected.sourceVersionHashes) ? expected.sourceVersionHashes : [];
    return left.length > 0 && left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function validVerifiedResult(result, expected) {
    return !!result && result.schemaVersion === 2 && ['correct', 'partial', 'incorrect'].includes(result.verdict) &&
      result.verification?.status === 'verified' && currentBinding(result.binding, expected) &&
      Array.isArray(result.criterionResults) && result.criterionResults.length > 0 &&
      result.criterionResults.every(item => item?.verification?.status === 'verified') &&
      Array.isArray(result.errorTags) && result.errorTags.every(item => ERROR_TAGS.includes(item?.type) && item.type !== 'unknown' && item?.verification?.status === 'verified');
  }

  function minimalAttempt(result, options = {}) {
    if (!validVerifiedResult(result, options.expectedBinding)) return null;
    const answeredAtMs = Number.isFinite(options.now) ? options.now : Date.now();
    const answeredAt = new Date(answeredAtMs).toISOString();
    const errorTags = [...new Set(result.errorTags.map(item => item.type))];
    return {
      attemptId: result.binding.attemptId, itemId: result.binding.practiceItemId,
      knowledgeUnitId: result.binding.knowledgeUnitId, sourceVersionHashes: [...result.binding.sourceVersionHashes],
      preparationSnapshotId: result.binding.preparationSnapshotId || '', normalizedStemHash: result.binding.normalizedStemHash,
      variantKey: result.binding.variantKey, verdict: result.verdict, errorTags,
      hintLevel: Number.isInteger(options.hintLevel) && options.hintLevel >= 0 && options.hintLevel <= 3 ? options.hintLevel : 0,
      answerViewed: options.answerViewed === true, answeredAt,
      dueAt: new Date(answeredAtMs + DAY_MS).toISOString()
    };
  }

  function applyAttempt(previous, attempt, now = Date.now()) {
    if (!attempt?.attemptId || !attempt?.knowledgeUnitId || !attempt?.itemId || !attempt?.variantKey) return previous || null;
    const base = previous && previous.knowledgeUnitId === attempt.knowledgeUnitId ? previous : { schemaVersion: 1, knowledgeUnitId: attempt.knowledgeUnitId, status: 'unseen', attempts: [] };
    if (base.attempts.some(item => item.attemptId === attempt.attemptId)) return base;
    const attempts = [...base.attempts, attempt].slice(-24);
    const earlier = [...base.attempts].reverse().find(item => item.verdict === 'correct' && item.hintLevel === 0 && !item.answerViewed);
    const delayed = attempt.verdict === 'correct' && attempt.hintLevel === 0 && !attempt.answerViewed && earlier &&
      Date.parse(attempt.answeredAt) - Date.parse(earlier.answeredAt) >= DAY_MS && earlier.variantKey !== attempt.variantKey && earlier.itemId !== attempt.itemId;
    const status = attempt.verdict !== 'correct' ? 'weak' : delayed ? 'delayedConfirmed' : 'pendingDelayed';
    return { ...base, schemaVersion: 1, sourceVersionHashes: [...attempt.sourceVersionHashes], status, attempts,
      lastAttemptAt: attempt.answeredAt, dueAt: delayed ? new Date(now + 3 * DAY_MS).toISOString() : attempt.dueAt,
      errorTags: attempt.errorTags };
  }

  function revalidateProgress(progress, sourceVersionHashes) {
    if (!progress) return null;
    const current = Array.isArray(sourceVersionHashes) ? sourceVersionHashes : [];
    return progress.sourceVersionHashes?.length === current.length && progress.sourceVersionHashes.every((item, index) => item === current[index])
      ? progress : { ...progress, status: 'needsRevalidation' };
  }

  function nextVariantContext(progress) {
    const attempts = Array.isArray(progress?.attempts) ? progress.attempts : [];
    return {
      previousItemIds: [...new Set(attempts.map(item => item.itemId).filter(Boolean))].slice(-12),
      previousVariantKeys: [...new Set(attempts.map(item => item.variantKey).filter(Boolean))].slice(-12)
    };
  }

  return { ERROR_TAGS, DAY_MS, currentBinding, validVerifiedResult, minimalAttempt, applyAttempt, revalidateProgress, nextVariantContext };
});
