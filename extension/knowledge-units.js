(function initAskmeKnowledgeUnits(root, factory) {
  const api = factory(root?.AskmeLearningCore);
  if (typeof module === 'object' && module?.exports) module.exports = api;
  if (root) root.AskmeKnowledgeUnits = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, learningCore => {
  'use strict';

  const KNOWLEDGE_UNIT_SCHEMA_VERSION = 2;
  const COVERAGE_SCHEMA_VERSION = 1;
  const GENERIC_HEADING = /^(?:week|module|lecture|topic|chapter|section|unit|overview|introduction|summary|learning objectives?|第[一二三四五六七八九十百\d]+[章节讲周]|概述|简介|总结|学习目标)(?:\s*\d+[.:：-]?)?$/iu;
  const EN_STOP = new Set(['using', 'based', 'introduction', 'overview', 'summary', 'example', 'examples', 'exercise', 'exercises', 'learning', 'objective', 'objectives']);

  function hashText(value) {
    if (learningCore?.hashText) return learningCore.hashText(value);
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    return `${(hash >>> 0).toString(16)}:${text.length}`;
  }

  function cleanLabel(value) {
    return String(value || '')
      .replace(/^#{1,6}\s*/u, '')
      .replace(/^(?:\d+(?:\.\d+){0,4}|[A-Z]|[IVX]+)[.)]?\s+/u, '')
      .replace(/[：:。.!?？；;]+$/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function canonicalLabel(value) {
    return cleanLabel(value)
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[“”'"`()\[\]{}]/gu, '')
      .replace(/\s*[-–—/]\s*/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function validLabel(value) {
    const label = cleanLabel(value);
    if (label.length < 3 || label.length > 90 || GENERIC_HEADING.test(label)) return false;
    const compact = label.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu, '');
    if (compact.length >= 6 && new Set(compact).size < 3) return false;
    if (/^(?:this|that|it|they|we|you|其|它|这|该|本节|上述)\b/iu.test(label)) return false;
    const words = label.split(/\s+/u);
    if (words.length > 9) return false;
    if (!/[\p{L}\p{N}]/u.test(label)) return false;
    return true;
  }

  function sentenceSpans(text) {
    const source = String(text || '');
    const output = [];
    let start = 0;
    const push = end => {
      let left = start, right = end;
      while (left < right && /\s/u.test(source[left])) left++;
      while (right > left && /\s/u.test(source[right - 1])) right--;
      if (right > left) output.push({ text: source.slice(left, right), start: left, end: right });
      start = end;
    };
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === '.' && /\d/u.test(source[index - 1] || '') && /\d/u.test(source[index + 1] || '')) continue;
      if (!/[.!?。！？；;\n]/u.test(char)) continue;
      let end = index + 1;
      while (end < source.length && /[.!?。！？；;\]\)}”’]/u.test(source[end])) end++;
      push(end);
      index = end - 1;
    }
    if (start < source.length) push(source.length);
    return output;
  }

  function explicitCandidates(sentence) {
    const candidates = [];
    const patterns = [
      /(?:^|[。；;]\s*)([\p{L}\p{N}][\p{L}\p{N}\s/_-]{1,70}?)\s*(?:是指|指的是|定义为|被定义为|是)\s*([^。！？；;]{6,})/gu,
      /(?:^|[.;]\s*)([A-Z][A-Za-z0-9 /_-]{1,70}?)\s+(?:is defined as|refers to|means|is the)\s+([^.!?;]{6,})/gu
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(sentence))) {
        const label = cleanLabel(match[1]);
        if (validLabel(label)) candidates.push({ label, description: match[0].trim(), kind: 'definition', confidence: 0.96 });
      }
    }
    return candidates;
  }

  function formulaCandidates(sentence) {
    const output = [];
    const pattern = /\b([A-Za-z][A-Za-z0-9_]{1,24})\s*=\s*([^,，。;；\n]{2,100})/gu;
    let match;
    while ((match = pattern.exec(sentence))) {
      const label = cleanLabel(match[1]);
      if (!validLabel(label) || /^[xyzijkn]$/iu.test(label)) continue;
      output.push({ label, description: sentence.trim(), kind: 'formula', confidence: 0.82 });
    }
    return output;
  }

  function specificHeadingCandidates(segment) {
    const path = Array.isArray(segment?.headingPath) ? segment.headingPath : [];
    const heading = cleanLabel(path.at(-1));
    if (!validLabel(heading) || GENERIC_HEADING.test(heading)) return [];
    const words = heading.toLowerCase().split(/\s+/u);
    if (words.every(word => EN_STOP.has(word))) return [];
    const firstSentence = sentenceSpans(segment.text)[0]?.text || String(segment.text || '').slice(0, 280);
    return [{ label: heading, description: firstSentence, kind: 'heading', confidence: 0.72 }];
  }

  function evidenceFor(segment, sentence, candidate) {
    const localStart = Math.max(0, sentence.start);
    const sourceVersion = String(segment.sourceVersion || hashText(String(segment.text || '')));
    return {
      segmentId: String(segment.id || segment.key || ''), artifactId: String(segment.artifactId || ''), pageId: String(segment.pageId || ''),
      sourceVersion,
      url: String(segment.url || ''), title: String(segment.title || ''), headingPath: Array.isArray(segment.headingPath) ? segment.headingPath.map(String) : [],
      charStart: Number.isInteger(segment.charStart) ? segment.charStart + localStart : localStart,
      charEnd: Number.isInteger(segment.charStart) ? segment.charStart + sentence.end : sentence.end,
      quote: sentence.text.slice(0, 600), kind: candidate.kind
    };
  }

  function buildKnowledgeUnits(segments, options = {}) {
    const courseId = String(options.courseId || segments?.[0]?.courseId || '');
    if (!courseId) return [];
    const groups = new Map();
    for (const segment of Array.isArray(segments) ? segments : []) {
      if (String(segment?.courseId || '') !== courseId || !segment?.text || !(segment.id || segment.key)) continue;
      const sentences = sentenceSpans(segment.text);
      const candidates = [];
      for (const sentence of sentences) {
        for (const candidate of [...explicitCandidates(sentence.text), ...formulaCandidates(sentence.text)]) candidates.push({ candidate, sentence });
      }
      for (const candidate of specificHeadingCandidates(segment)) candidates.push({ candidate, sentence: sentences[0] || { text: candidate.description, start: 0, end: candidate.description.length } });
      for (const { candidate, sentence } of candidates) {
        const canonical = canonicalLabel(candidate.label);
        if (!canonical) continue;
        const key = `${courseId}\u001f${canonical}`;
        const group = groups.get(key) || { courseId, canonical, labels: new Map(), descriptions: [], evidence: [], kinds: new Set(), confidence: 0 };
        group.labels.set(candidate.label, (group.labels.get(candidate.label) || 0) + candidate.confidence);
        if (candidate.description) group.descriptions.push(candidate.description);
        group.evidence.push(evidenceFor(segment, sentence, candidate));
        group.kinds.add(candidate.kind);
        group.confidence = Math.max(group.confidence, candidate.confidence);
        groups.set(key, group);
      }
    }
    return [...groups.values()].map(group => {
      const evidenceByRange = new Map();
      for (const item of group.evidence) {
        const rangeKey = `${item.segmentId}|${item.sourceVersion}|${item.charStart}|${item.charEnd}`;
        if (!evidenceByRange.has(rangeKey)) evidenceByRange.set(rangeKey, item);
      }
      const evidence = [...evidenceByRange.values()]
        .sort((left, right) => left.pageId.localeCompare(right.pageId) || left.segmentId.localeCompare(right.segmentId) || left.charStart - right.charStart || left.charEnd - right.charEnd)
        .slice(0, options.maxEvidence ?? 6);
      const label = [...group.labels.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
      const confidence = Math.min(0.99, group.confidence + Math.max(0, evidence.length - 1) * 0.03);
      const coveredRanges = evidence.map(item => ({ pageId: item.pageId, segmentId: item.segmentId, start: item.charStart, end: item.charEnd }));
      return {
        id: `ku:${hashText(`${courseId}|${group.canonical}`)}`, key: `ku:${hashText(`${courseId}|${group.canonical}`)}`,
        schemaVersion: KNOWLEDGE_UNIT_SCHEMA_VERSION, coverageSchemaVersion: COVERAGE_SCHEMA_VERSION, courseId, label, canonicalLabel: group.canonical,
        description: group.descriptions.sort((left, right) => left.length - right.length)[0]?.slice(0, 600) || '',
        kinds: [...group.kinds].sort(), confidence: Number(confidence.toFixed(2)), evidence,
        coveredRanges,
        sourceSegmentIds: [...new Set(evidence.map(item => item.segmentId))],
        contentHash: hashText(evidence.map(item => `${item.segmentId}:${item.sourceVersion}:${item.charStart}:${item.charEnd}:${item.quote}`).join('|'))
      };
    }).filter(unit => unit.evidence.length && (unit.confidence >= (options.minConfidence ?? 0.7)))
      .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
  }

  function knowledgeUnitState(unit) {
    if (!unit || unit.schemaVersion !== KNOWLEDGE_UNIT_SCHEMA_VERSION || unit.coverageSchemaVersion !== COVERAGE_SCHEMA_VERSION ||
        !Array.isArray(unit.evidence) || !unit.evidence.length || !Array.isArray(unit.coveredRanges) || !unit.coveredRanges.length) return 'stale';
    if (unit.evidence.length !== unit.coveredRanges.length) return 'needsReview';
    const rangeCounts = new Map();
    for (const range of unit.coveredRanges) {
      if (!range || typeof range.pageId !== 'string' || typeof range.segmentId !== 'string' || !range.segmentId ||
          !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start) return 'needsReview';
      const key = `${range.pageId}\u001f${range.segmentId}\u001f${range.start}\u001f${range.end}`;
      rangeCounts.set(key, (rangeCounts.get(key) || 0) + 1);
    }
    const valid = unit.evidence.every(item => {
      if (!item || typeof item.pageId !== 'string' || typeof item.segmentId !== 'string' || !item.segmentId ||
          typeof item.sourceVersion !== 'string' || !item.sourceVersion || typeof item.quote !== 'string' || !item.quote ||
          !Number.isSafeInteger(item.charStart) || !Number.isSafeInteger(item.charEnd) || item.charStart < 0 || item.charEnd <= item.charStart ||
          item.quote.length > item.charEnd - item.charStart) return false;
      const key = `${item.pageId}\u001f${item.segmentId}\u001f${item.charStart}\u001f${item.charEnd}`;
      const count = rangeCounts.get(key) || 0;
      if (!count) return false;
      rangeCounts.set(key, count - 1);
      return true;
    }) && [...rangeCounts.values()].every(count => count === 0);
    return valid ? 'current' : 'needsReview';
  }

  function residualLearningSpans(segments, units, options = {}) {
    const minimum = Number.isFinite(options.minLength) ? Math.max(1, Math.floor(options.minLength)) : 24;
    const currentUnits = (Array.isArray(units) ? units : []).filter(unit => knowledgeUnitState(unit) === 'current');
    const output = [];
    for (const segment of Array.isArray(segments) ? segments : []) {
      const text = String(segment?.text || '');
      const segmentId = String(segment?.id || segment?.key || '');
      if (!text || !segmentId) continue;
      const base = Number.isSafeInteger(segment.charStart) ? segment.charStart : 0;
      const sourceVersion = String(segment.sourceVersion || hashText(text));
      const ranges = [];
      for (const unit of currentUnits) for (const item of unit.evidence) {
        if (item.segmentId !== segmentId || item.sourceVersion !== sourceVersion) continue;
        const start = item.charStart - base, end = item.charEnd - base;
        if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= text.length) ranges.push({ start, end });
      }
      ranges.sort((left, right) => left.start - right.start || left.end - right.end);
      const merged = [];
      for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
        else merged.push({ ...range });
      }
      const gaps = [];
      let cursor = 0;
      for (const range of merged) {
        if (range.start > cursor) gaps.push({ start: cursor, end: range.start });
        cursor = Math.max(cursor, range.end);
      }
      if (cursor < text.length) gaps.push({ start: cursor, end: text.length });
      if (!merged.length) gaps.push({ start: 0, end: text.length });
      const uniqueGaps = new Map(gaps.map(item => [`${item.start}:${item.end}`, item]));
      for (const gap of uniqueGaps.values()) {
        const chunk = text.slice(gap.start, gap.end);
        for (const sentence of sentenceSpans(chunk)) {
          if (sentence.text.length < minimum) continue;
          output.push({
            schemaVersion: COVERAGE_SCHEMA_VERSION,
            id: `residual:${hashText(`${segment.courseId || ''}|${segmentId}|${sourceVersion}|${base + gap.start + sentence.start}|${base + gap.start + sentence.end}`)}`,
            courseId: String(segment.courseId || ''), segmentId, pageId: String(segment.pageId || ''), artifactId: String(segment.artifactId || ''), sourceVersion,
            start: base + gap.start + sentence.start, end: base + gap.start + sentence.end,
            text: sentence.text, url: String(segment.url || ''), title: String(segment.title || ''),
            headingPath: Array.isArray(segment.headingPath) ? segment.headingPath.map(String) : []
          });
        }
      }
    }
    return output.sort((left, right) => left.pageId.localeCompare(right.pageId) || left.segmentId.localeCompare(right.segmentId) || left.start - right.start);
  }

  function masteryRecord(unit, previous = {}) {
    if (!unit?.id || !unit?.contentHash) return null;
    const attempts = Array.isArray(previous.attempts) ? previous.attempts.filter(item => item && typeof item.questionId === 'string').slice(-49) : [];
    return {
      schemaVersion: 1, unitId: unit.id, contentHash: unit.contentHash,
      state: ['new', 'learning', 'review', 'relearning'].includes(previous.state) ? previous.state : 'new',
      stability: Number.isFinite(previous.stability) && previous.stability >= 0 ? previous.stability : 0,
      difficulty: Number.isFinite(previous.difficulty) && previous.difficulty >= 0 && previous.difficulty <= 10 ? previous.difficulty : 5,
      dueAt: typeof previous.dueAt === 'string' ? previous.dueAt : '', attempts
    };
  }

  function recordAttempt(record, attempt) {
    if (!record?.unitId || !attempt || typeof attempt.questionId !== 'string' || !/^(?:again|hard|good|easy)$/u.test(attempt.rating)) return null;
    const next = { ...record, attempts: [...record.attempts, {
      questionId: attempt.questionId.slice(0, 160), rating: attempt.rating,
      evidenceSegmentIds: [...new Set((attempt.evidenceSegmentIds || []).map(String))].slice(0, 8),
      answeredAt: String(attempt.answeredAt || new Date().toISOString())
    }].slice(-50) };
    next.state = attempt.rating === 'again' ? 'relearning' : 'review';
    return next;
  }

  return {
    KNOWLEDGE_UNIT_SCHEMA_VERSION, COVERAGE_SCHEMA_VERSION,
    cleanLabel, canonicalLabel, sentenceSpans, buildKnowledgeUnits, knowledgeUnitState, residualLearningSpans, masteryRecord, recordAttempt
  };
});
