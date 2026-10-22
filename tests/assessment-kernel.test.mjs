import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const kernel = require('../extension/assessment-kernel.js');

function assessment(overrides = {}) {
  const item = {
    schemaVersion: 1,
    id: 'assessment:1:report', courseId: '1', title: 'Design report',
    evidence: 'Assessment: Design report | Weighting: 35% | Outcomes: CLO 2',
    sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#section-2',
    extractorVersion: 1, rowOrdinal: 2,
    ...overrides
  };
  if (!Object.hasOwn(overrides, 'sourceVersion')) item.sourceVersion = kernel.hashText(`${item.sourceUrl}\n${item.evidence}\nassessment-row-v1`);
  if (!Object.hasOwn(overrides, 'evidenceRef')) item.evidenceRef = {
    schemaVersion: 1, courseId: item.courseId, sourceKind: 'assessment-row', sourceId: item.id, sourceVersion: item.sourceVersion,
    span: { start: 0, end: item.evidence.length }, quote: item.evidence, url: item.sourceUrl
  };
  return item;
}

function brief(overrides = {}) {
  const text = 'Submit one CAD assembly aligned to CLO 2.';
  const item = {
    schemaVersion: 1, id: 'assign-brief:1:91', courseId: '1', activityId: '91',
    sourceUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=91',
    extractorVersion: 1, parseStatus: 'complete',
    blocks: [{ blockId: 'brief-block:1', kind: 'paragraph', ordinal: 1, charStart: 0, charEnd: text.length, text }],
    ...overrides
  };
  const fullText = item.blocks.map(block => block.text).join(' ');
  if (!Object.hasOwn(overrides, 'textHash')) item.textHash = kernel.hashText(fullText);
  if (!Object.hasOwn(overrides, 'sourceVersion')) item.sourceVersion = kernel.hashText(`${item.sourceUrl}\n${item.textHash}\n${item.extractorVersion}`);
  return item;
}

function courseClaim(requirement, relation = 'explicit', overrides = {}) {
  const text = 'This lecture is explicitly aligned to CLO 2. Parametric design intent.';
  const quote = 'This lecture is explicitly aligned to CLO 2.';
  const url = 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=12';
  const sourceVersion = kernel.hashText(`${url}\n${text}`);
  return {
    requirementId: requirement.id, relation, relationBasis: { kind: 'shared-clo', value: 'clo:2' },
    source: { schemaVersion: 1, courseId: '1', sourceKind: 'course-material', sourceId: 'page:12', sourceVersion, url, text },
    evidence: { schemaVersion: 1, courseId: '1', sourceKind: 'course-material', sourceId: 'page:12', sourceVersion,
      span: { start: 0, end: quote.length }, quote, url },
    ...overrides
  };
}

test('EvidenceRef 规范化后拒绝跨课程、跨版本和越界证据', () => {
  const valid = kernel.normalizeEvidenceRef({
    courseId: '1', sourceKind: 'assessment-row', sourceId: 'assessment:1:report', sourceVersion: kernel.hashText('row'),
    span: { start: 0, end: 12 }, quote: 'Design report'
  });
  assert.equal(kernel.validateEvidenceRef(valid, { courseId: '1', sourceVersion: valid.sourceVersion }).ok, true);
  assert.equal(kernel.validateEvidenceRef(valid, { courseId: '2', sourceVersion: valid.sourceVersion }).status, 'conflict');
  assert.equal(kernel.validateEvidenceRef(valid, { courseId: '1', sourceVersion: kernel.hashText('other') }).status, 'stale');
  assert.equal(kernel.validateEvidenceRef({ ...valid, url: 'https://evil.example/course/view.php?id=1' }).status, 'conflict');
  assert.equal(kernel.normalizeEvidenceRef({ ...valid, span: { start: 9, end: 2 } }), null);
});

test('Requirement 只接受同课程安全 brief block，稳定 ID 绑定来源版本与范围', () => {
  const first = kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: brief() });
  const reordered = kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: { ...brief(), blocks: [...brief().blocks].reverse() } });
  assert.deepEqual(first.map(item => item.id), reordered.map(item => item.id));
  assert.equal(first.every(item => item.status === 'current'), true);
  assert.equal(first.some(item => item.sourceKind === 'assignment-brief'), true);
  const otherCourse = kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: brief({ courseId: '2' }) });
  assert.equal(otherCourse.some(item => item.sourceKind === 'assignment-brief'), false);
  const unsafe = kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: brief({ sourceUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=91&action=editsubmission' }) });
  assert.equal(unsafe.some(item => item.sourceKind === 'assignment-brief'), false);
  const changed = kernel.buildRequirements({ courseId: '1', assessment: assessment({ evidence: `${assessment().evidence} | Due: Week 8` }), brief: null });
  assert.notEqual(first.find(item => item.sourceKind === 'assessment-row').id, changed[0].id);
});

test('CoverageLink 区分显式、候选和缺口且候选不计入 confirmed', () => {
  const requirements = kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: brief() });
  const links = kernel.buildCoverageLinks(requirements, [
    courseClaim(requirements[0]),
    courseClaim(requirements[1], 'candidate')
  ]);
  const summary = kernel.summarizeCoverage(requirements, links);
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.candidate, 1);
  assert.equal(summary.gap, requirements.length - 1);
  assert.equal(summary.scopeStatus, 'partial');
  assert.deepEqual(links.find(item => item.relation === 'explicit').requirementSource, {
    sourceKind: requirements[0].evidence.sourceKind, sourceId: requirements[0].evidence.sourceId,
    sourceVersion: requirements[0].evidence.sourceVersion, span: requirements[0].evidence.span
  });
  const tampered = links.map(item => item.relation === 'explicit' ? { ...item, requirementSource: { ...item.requirementSource, sourceVersion: 'old' } } : item);
  assert.equal(kernel.summarizeCoverage(requirements, tampered).confirmed, 0);
});

test('PreparationSnapshot 对旧 schema、失效和冲突状态关闭执行门', () => {
  const requirements = kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: brief() });
  const links = kernel.buildCoverageLinks(requirements, requirements.map(item => courseClaim(item)));
  const ready = kernel.createPreparationSnapshot({ courseId: '1', assessmentId: assessment().id, requirements, coverageLinks: links });
  assert.deepEqual(kernel.evaluatePreparationGate(ready), { allowed: true, status: 'ready', dataStatus: 'current', scopeStatus: 'confirmed', reasons: [] });
  assert.equal(kernel.evaluatePreparationGate({ ...ready, schemaVersion: 0 }).status, 'needsReview');
  const flaggedStale = kernel.createPreparationSnapshot({ courseId: '1', assessmentId: assessment().id, requirements, coverageLinks: links, assessmentStale: true });
  assert.equal(kernel.evaluatePreparationGate(flaggedStale).status, 'blocked');
  const flaggedConflict = kernel.createPreparationSnapshot({ courseId: '1', assessmentId: assessment().id, requirements, coverageLinks: links, conflict: true });
  assert.equal(kernel.evaluatePreparationGate(flaggedConflict).dataStatus, 'conflict');
  const staleRequirement = { ...requirements[0], status: 'stale' };
  const stale = kernel.createPreparationSnapshot({ courseId: '1', assessmentId: assessment().id, requirements: [staleRequirement], coverageLinks: [] });
  assert.equal(kernel.evaluatePreparationGate(stale).allowed, false);
  const forged = { ...requirements[0], evidence: { ...requirements[0].evidence, sourceVersion: kernel.hashText('forged') } };
  const needsReview = kernel.createPreparationSnapshot({ courseId: '1', assessmentId: assessment().id, requirements: [forged], coverageLinks: [] });
  assert.equal(kernel.evaluatePreparationGate(needsReview).status, 'needsReview');
});

test('assessment evidenceRef 必须与顶层版本和原文范围一致', () => {
  assert.equal(kernel.buildRequirements({ courseId: '1', assessment: assessment({
    evidenceRef: { ...assessment().evidenceRef, sourceVersion: 'row-v0' }
  }) }).length, 0);
  assert.equal(kernel.buildRequirements({ courseId: '1', assessment: assessment({
    evidenceRef: { ...assessment().evidenceRef, span: { start: 1, end: 8 }, quote: 'Assessm' }
  }) }).length, 0);
});

test('brief block 拒绝修补越界范围和 activity 身份冲突', () => {
  const badRange = brief({ blocks: [{ ...brief().blocks[0], charStart: 999, charEnd: 1023 }] });
  assert.equal(kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: badRange }).some(item => item.sourceKind === 'assignment-brief'), false);
  const badActivity = brief({ activityId: '92' });
  assert.equal(kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: badActivity }).some(item => item.sourceKind === 'assignment-brief'), false);
  const forgedVersion = brief({ sourceVersion: kernel.hashText('forged') });
  assert.equal(kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: forgedVersion }).some(item => item.sourceKind === 'assignment-brief'), false);
  const forgedHash = brief({ textHash: kernel.hashText('other') });
  assert.equal(kernel.buildRequirements({ courseId: '1', assessment: assessment(), brief: forgedHash }).some(item => item.sourceKind === 'assignment-brief'), false);
});

test('CoverageLink 拒绝同课程任意证据和伪造语义关系', () => {
  const requirement = kernel.buildRequirements({ courseId: '1', assessment: assessment() })[0];
  const arbitrary = courseClaim(requirement, 'explicit');
  arbitrary.source.text = 'This page discusses unrelated study tips.';
  arbitrary.source.sourceVersion = kernel.hashText(`${arbitrary.source.url}\n${arbitrary.source.text}`);
  arbitrary.evidence = { ...arbitrary.evidence, sourceVersion: arbitrary.source.sourceVersion,
    span: { start: 0, end: arbitrary.source.text.length }, quote: arbitrary.source.text };
  const links = kernel.buildCoverageLinks([requirement], [arbitrary, courseClaim(requirement, 'explicit', { relationBasis: { kind: 'shared-clo', value: 'clo:9' } })]);
  assert.equal(links.some(item => item.relation === 'explicit'), false);
  assert.equal(links[0].relation, 'gap');
});

test('PreparationSnapshot 最小伪造对象、ID、来源版本和覆盖统计均不能通过执行门', () => {
  const requirement = kernel.buildRequirements({ courseId: '1', assessment: assessment() })[0];
  const links = kernel.buildCoverageLinks([requirement], [courseClaim(requirement)]);
  const ready = kernel.createPreparationSnapshot({ courseId: '1', assessmentId: assessment().id, requirements: [requirement], coverageLinks: links });
  assert.equal(kernel.evaluatePreparationGate({ schemaVersion: kernel.PREPARATION_SNAPSHOT_SCHEMA_VERSION, dataStatus: 'current', scopeStatus: 'confirmed' }).allowed, false);
  assert.equal(kernel.evaluatePreparationGate({ ...ready, id: 'preparation:forged' }).allowed, false);
  assert.equal(kernel.evaluatePreparationGate({ ...ready, sourceVersions: [{ ...ready.sourceVersions[0], sourceVersion: kernel.hashText('old') }] }).allowed, false);
  assert.equal(kernel.evaluatePreparationGate({ ...ready, coverage: { ...ready.coverage, confirmed: 0 } }).allowed, false);
  assert.equal(kernel.evaluatePreparationGate(ready, { snapshotId: 'preparation:changed' }).status, 'blocked');
});
