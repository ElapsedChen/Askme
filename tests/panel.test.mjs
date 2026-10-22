import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../extension/panel.js', import.meta.url), 'utf8');
const learningCoreScript = readFileSync(new URL('../extension/learning-core.js', import.meta.url), 'utf8');
const knowledgeUnitsScript = readFileSync(new URL('../extension/knowledge-units.js', import.meta.url), 'utf8');
const assessmentKernelScript = readFileSync(new URL('../extension/assessment-kernel.js', import.meta.url), 'utf8');
const unitProgressScript = readFileSync(new URL('../extension/unit-progress.js', import.meta.url), 'utf8');
const panelHtml = readFileSync(new URL('../extension/panel.html', import.meta.url), 'utf8');
const panelCss = readFileSync(new URL('../extension/panel.css', import.meta.url), 'utf8');

test('整课同步前从结构化原文生成可回查知识单元', async () => {
  const { context } = await setup();
  const data = {
    pages: [{ id: 'p1', courseId: '1', artifactId: 'lecture-1', title: 'CAD lecture', section: 'Parametric modelling',
      url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=11',
      text: 'Parametric modelling is defined as a modelling approach in which dimensions and constraints control geometry. It preserves design intent.' }]
  };
  const result = context.indexCourseKnowledge(data, '1');
  assert.equal(result.some(unit => unit.canonicalLabel === 'parametric modelling'), true);
  assert.equal(data.knowledgeUnitSchemaVersion, 2);
  assert.equal(data.knowledgeUnits[0].evidence[0].segmentId.startsWith('seg:'), true);
  assert.equal(JSON.stringify(data.knowledgeUnits).includes('https://moodle.telt.unsw.edu.au'), true);
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.listeners = {}; this.textContent = '';
    this.hidden = false; this.disabled = false; this._value = ''; this.dataset = {}; this.title = ''; this.style = {}; this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); if (this.tagName === 'select' && this.children.length === children.length) this._value = children[0]?.value || ''; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  querySelector(tag) { return this.children.find(child => child.tagName === tag) || null; }
  remove() {}
  get options() { return this.children; }
  get value() { return this._value; }
  set value(value) { this._value = value; }
}

test('刷新新鲜度按六小时和二十四小时边界分类且保留不完整维度', async () => {
  const { context } = await setup();
  const now = Date.parse('2026-09-23T10:00:00Z');
  assert.equal(context.syncFreshness({ syncedAt: new Date(now - 6 * 3_600_000).toISOString() }, now).state, 'fresh');
  assert.equal(context.syncFreshness({ syncedAt: new Date(now - 6 * 3_600_000 - 1).toISOString() }, now).state, 'aging');
  assert.equal(context.syncFreshness({ syncedAt: new Date(now - 24 * 3_600_000).toISOString() }, now).state, 'aging');
  assert.equal(context.syncFreshness({ syncedAt: new Date(now - 24 * 3_600_000 - 1).toISOString() }, now).state, 'stale');
  const partial = context.syncFreshness({ syncedAt: new Date(now).toISOString(), eventSyncError: 'offline' }, now);
  assert.equal(partial.state, 'fresh');
  assert.equal(partial.partial, true);
  assert.equal(context.syncFreshness({ syncedAt: new Date(now).toISOString(), semanticStatus: '语义检索已完成' }, now).partial, false);
});

test('刷新批次按账号字段落盘且只保存身份哈希与时间事实', async () => {
  const item = { ...page('1', 'PRIVATE REFRESH BODY '.repeat(12), 'Private title'), id: 'private-page' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'Private course' }] });
  context.message = async type => {
    assert.equal(type, 'SYNC_COURSE');
    return { data: { pages: [item], files: [], events: [], errors: [] } };
  };
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.equal(saved.refreshPlanState.status, 'succeeded');
  assert.equal(saved.refreshPlanState.courseResults[0].courseId, '1');
  const serialized = JSON.stringify(saved.refreshPlanState);
  for (const forbidden of ['PRIVATE REFRESH BODY', 'Private title', 'Private course', item.url]) assert.equal(serialized.includes(forbidden), false);
});

test('超过三十分钟的 running 刷新批次恢复为失败并写回账号状态', async () => {
  const now = Date.now();
  const stale = {
    schemaVersion: 1, refreshId: 'rp:stale:batch', status: 'running', selectedCourseIds: ['1'],
    baselineSetHash: 'before', publishedPlanHash: 'published',
    startedAt: new Date(now - 30 * 60_000 - 1).toISOString(), settledAt: null, courseResults: []
  };
  const sharedStorage = { courses: [], library: {}, reviewProgress: {}, semanticIndex: {}, refreshPlanState: stale };
  const { saved, context } = await setup({ sharedStorage });
  assert.equal(saved.refreshPlanState.status, 'failed');
  assert.ok(Number.isFinite(Date.parse(saved.refreshPlanState.settledAt)));
  assert.equal(context.normalizeRefreshPlanState({ ...stale, startedAt: new Date(now - 29 * 60_000).toISOString() }, now).status, 'running');
});

test('多课程部分刷新结算后一次发布并明确失败课程沿用旧快照', async () => {
  const oldOne = { ...page('1', 'Old one '.repeat(12), 'Old one'), id: 'old-one' };
  const oldTwo = { ...page('2', 'Old two '.repeat(12), 'Old two'), id: 'old-two' };
  const freshOne = { ...page('1', 'Fresh one '.repeat(12), 'Fresh one'), id: 'fresh-one' };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }], library: { 1: { pages: [oldOne], files: [] }, 2: { pages: [oldTwo], files: [] } } });
  context.message = async (_type, { course }) => {
    if (course.id === '1') return { data: { pages: [freshOne], files: [], events: [], errors: [] } };
    throw new Error('course two offline');
  };
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.equal(saved.refreshPlanState.status, 'partial');
  assert.deepEqual(saved.refreshPlanState.courseResults.map(item => item.status), ['succeeded', 'failed']);
  assert.equal(saved.library['1'].pages[0].id, 'fresh-one');
  assert.equal(saved.library['2'].pages[0].id, 'old-two');
  assert.match(get('#status').textContent, /1\/2.*失败课程仍使用上次成功快照/u);
});

test('assessment 解析不完整时保留上次资料并标记待复核', async () => {
  const oldAssessment = { id: 'assessment:1:quiz', courseId: '1', title: 'Quiz', evidence: 'Quiz | 20%', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment' };
  const oldPage = { ...page('1', 'Old course content '.repeat(12), 'Old'), id: 'old' };
  const newPage = { ...page('1', 'New course content '.repeat(12), 'New'), id: 'new' };
  const { context, saved, get } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [oldPage], files: [], assessments: [oldAssessment] } }
  });
  context.message = async () => ({ data: {
    pages: [newPage], files: [], events: [], errors: [], assessments: [],
    assessmentParseStatus: 'unsupported', assessmentParseIssues: 1
  } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.equal(saved.library['1'].assessments[0].id, oldAssessment.id);
  assert.equal(saved.library['1'].assessmentStale, true);
  assert.equal(saved.refreshPlanState.courseResults[0].status, 'partial');
  assert.match(get('#status').textContent, /保留上次考核资料并标记待复核/u);
});

test('首次 assessment 解析不完整时不保存部分结果为可信资料', async () => {
  const partialAssessment = { id: 'assessment:1:quiz', courseId: '1', title: 'Quiz', evidence: 'Quiz | 20%', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment' };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: {} });
  context.message = async () => ({ data: {
    pages: [page('1', 'Course content '.repeat(12))], files: [], events: [], errors: [], assessments: [partialAssessment],
    assessmentParseStatus: 'partial', assessmentParseIssues: 1
  } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.deepEqual(saved.library['1'].assessments, []);
  assert.equal(saved.library['1'].assessmentStale, true);
  assert.equal(saved.refreshPlanState.courseResults[0].status, 'partial');
  assert.match(get('#status').textContent, /未把部分结果作为可信考核资料/u);
});

test('Moodle 考核要求变化后保留目标并要求用户重新核对', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const sourceUrl = 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment';
  const oldAssessment = { id: 'assessment:1:quiz', courseId: '1', title: 'Quiz', evidence: 'Quiz | Weighting: 20%', sourceUrl };
  const oldVersion = contentHash(`${sourceUrl}\n${oldAssessment.evidence}`);
  const goal = studyGoal('1', today, { assessmentId: oldAssessment.id, assessmentVersion: oldVersion, title: 'Quiz' });
  const { context, saved, get } = await setup({
    courses: [{ id: '1', title: 'One' }], studyGoals: [goal],
    library: { 1: { pages: [page('1', 'Old content '.repeat(12))], files: [], assessments: [oldAssessment] } }
  });
  context.message = async () => ({ data: {
    pages: [page('1', 'New content '.repeat(12))], files: [], events: [], errors: [], assessmentParseStatus: 'complete',
    assessments: [assessmentEvidence({ ...oldAssessment, evidence: 'Quiz | Weighting: 35%' })]
  } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.equal(saved.studyGoals[0].assessmentId, oldAssessment.id);
  assert.equal(saved.studyGoals[0].assessmentVersion, oldVersion);
  assert.equal(saved.studyGoals[0].assessmentNeedsRevalidation, true);
  assert.match(get('#status').textContent, /考核目标需要重新核对 Moodle 要求/u);
});

test('assessment sourceVersion 重算时同步 evidenceRef，范围无法定位则失败关闭', async () => {
  const base = assessmentEvidence({
    id: 'assessment:1:quiz', courseId: '1', title: 'Quiz', evidence: 'Quiz | Weighting: 20%',
    sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment'
  });
  const first = await setup({ courses: [{ id: '1', title: 'One' }] });
  first.context.message = async () => ({ data: {
    pages: [page('1', 'Course content '.repeat(12))], files: [], events: [], errors: [], assessments: [base], assessmentParseStatus: 'complete'
  } });
  first.context.fetch = async () => { throw new Error('offline'); };
  await first.context.sync();
  const stored = first.saved.library['1'].assessments[0];
  assert.equal(stored.evidenceRef.sourceVersion, stored.sourceVersion);
  assert.equal(stored.evidence.slice(stored.evidenceRef.span.start, stored.evidenceRef.span.end), stored.evidenceRef.quote);

  const broken = { ...base, evidenceRef: { ...base.evidenceRef, span: { start: 999, end: 1000 } } };
  const second = await setup({ courses: [{ id: '1', title: 'One' }] });
  second.context.message = async () => ({ data: {
    pages: [page('1', 'Course content '.repeat(12))], files: [], events: [], errors: [], assessments: [broken], assessmentParseStatus: 'complete'
  } });
  second.context.fetch = async () => { throw new Error('offline'); };
  await second.context.sync();
  assert.deepEqual(second.saved.library['1'].assessments, []);
  assert.equal(second.saved.library['1'].assessmentStale, true);
});

test('整课同步在生产路径持久化最小 Assessment snapshot，来源变化立即关闭 gate', async () => {
  const assessment = assessmentEvidence({
    id: 'assessment:1:design-report', courseId: '1', title: 'Design report', outcomesText: 'CLO 2',
    evidence: 'Assessment: Design report | Outcomes: CLO 2',
    sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment'
  });
  const mapped = { ...page('1', 'This lecture is explicitly aligned to CLO 2. Parametric design intent is preserved by constraints. '.repeat(2), 'Design intent'), id: 'mapped' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }] });
  context.message = async () => ({ data: {
    pages: [mapped], files: [], events: [], errors: [], assessments: [assessment], assessmentParseStatus: 'complete',
    assignmentBriefs: [], assignmentBriefParseStatus: 'not-found',
    assignmentBriefScan: { discovered: 0, attempted: 0, succeeded: 0, failed: 0, overflow: 0, complete: true }
  } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  const stored = saved.library['1'].assessmentPreparations[0];
  assert.equal(stored.schemaVersion, vm.runInContext('assessmentCore.PREPARATION_SNAPSHOT_SCHEMA_VERSION', context));
  assert.equal(vm.runInContext("assessmentCore.evaluatePreparationGate(library['1'].assessmentPreparations[0]).allowed", context), true);
  assert.equal(stored.requirements.length, 1);
  assert.equal(stored.coverageLinks[0].relation, 'explicit');
  assert.equal(JSON.stringify(stored).includes(mapped.text), false);
  assert.equal(JSON.stringify(stored).includes('answer'), false);
  vm.runInContext("library['1'].pages[0].text = 'The Moodle source changed and no longer contains an explicit CLO mapping.'", context);
  assert.equal(context.assessmentPreparationState('1', assessment).gate.status, 'blocked');
});

test('首次作业说明部分读取时不保存成功子集为可信要求', async () => {
  const leaked = assignmentBrief('1', '91', 'PRIVATE_PARTIAL_REQUIREMENT');
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }] });
  context.message = async () => ({ data: {
    pages: [page('1', 'Course content '.repeat(12))], files: [], events: [], errors: [],
    assignmentBriefs: [leaked], assignmentBriefParseStatus: 'partial',
    assignmentBriefScan: { discovered: 2, attempted: 2, succeeded: 1, failed: 1, overflow: 0, complete: false }
  } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.deepEqual(saved.library['1'].assignmentBriefs, []);
  assert.equal(saved.library['1'].assignmentBriefStale, true);
  assert.equal(JSON.stringify(saved.library['1']).includes('PRIVATE_PARTIAL_REQUIREMENT'), false);
  assert.match(get('#status').textContent, /未把部分结果作为可信要求/u);
});

test('作业说明部分刷新只更新成功项并保留失败项的旧完整版本', async () => {
  const oldOne = assignmentBrief('1', '91', 'Old requirement A');
  const oldTwo = assignmentBrief('1', '92', 'Old requirement B');
  const newOne = assignmentBrief('1', '91', 'Updated requirement A');
  const { context, saved } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [page('1', 'Old course content '.repeat(12))], files: [], assignmentBriefs: [oldOne, oldTwo] } }
  });
  context.message = async () => ({ data: {
    pages: [page('1', 'New course content '.repeat(12))], files: [], events: [], errors: [],
    assignmentBriefs: [newOne], assignmentBriefParseStatus: 'partial',
    assignmentBriefScan: { discovered: 2, attempted: 2, succeeded: 1, failed: 1, overflow: 0, complete: false }
  } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  const stored = saved.library['1'].assignmentBriefs;
  assert.equal(stored.find(item => item.activityId === '91').blocks[0].text, 'Updated requirement A');
  assert.equal(stored.find(item => item.activityId === '92').blocks[0].text, 'Old requirement B');
  assert.equal(saved.library['1'].assignmentBriefStale, true);
});

test('完整扫描确认没有作业说明时才清除旧 brief', async () => {
  const old = assignmentBrief('1', '91', 'Old requirement');
  const { context, saved } = await setup({
    courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Old content '.repeat(12))], files: [], assignmentBriefs: [old] } }
  });
  context.message = async () => ({ data: {
    pages: [page('1', 'New content '.repeat(12))], files: [], events: [], errors: [], assignmentBriefs: [], assignmentBriefParseStatus: 'not-found',
    assignmentBriefScan: { discovered: 0, attempted: 0, succeeded: 0, failed: 0, overflow: 0, complete: true }
  } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.deepEqual(saved.library['1'].assignmentBriefs, []);
  assert.equal(saved.library['1'].assignmentBriefStale, false);
});

test('作业说明优先按 activity ID 关联且同名不唯一时拒绝猜测', async () => {
  const byIdAssessment = { id: 'assessment:1:project', courseId: '1', title: 'Design Project', assignmentActivityId: '91', evidence: 'Project', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const exactAssessment = { id: 'assessment:1:report', courseId: '1', title: 'Technical Report', evidence: 'Report', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const idBrief = assignmentBrief('1', '91', 'ID requirement', 'Different display title');
  const exactBrief = assignmentBrief('1', '92', 'Exact title requirement', 'Technical Report');
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: {
    pages: [page('1', 'Course content '.repeat(12))], files: [], assessments: [byIdAssessment, exactAssessment], assignmentBriefs: [idBrief, exactBrief]
  } } });
  assert.equal(context.assignmentBriefForAssessment('1', byIdAssessment).activityId, '91');
  assert.equal(context.assignmentBriefForAssessment('1', exactAssessment).activityId, '92');
  const duplicate = assignmentBrief('1', '93', 'Duplicate title requirement', 'Technical Report');
  const ambiguous = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: {
    pages: [page('1', 'Course content '.repeat(12))], files: [], assessments: [exactAssessment], assignmentBriefs: [exactBrief, duplicate]
  } } });
  assert.equal(ambiguous.context.assignmentBriefForAssessment('1', exactAssessment), null);
  const duplicateId = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: {
    pages: [page('1', 'Course content '.repeat(12))], files: [], assessments: [byIdAssessment],
    assignmentBriefs: [idBrief, assignmentBrief('1', '91', 'Conflicting', 'Different display title')]
  } } });
  assert.equal(duplicateId.context.assignmentBriefForAssessment('1', byIdAssessment), null);
});

test('作业说明拒绝 activityId 与 sourceUrl id 不一致及越界 block', async () => {
  const assessment = { id: 'assessment:1:project', courseId: '1', title: 'Design Project', assignmentActivityId: '91' };
  const mismatched = assignmentBrief('1', '91', 'Requirement');
  mismatched.sourceUrl = 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=92';
  const outOfBounds = assignmentBrief('1', '91', 'Requirement');
  outOfBounds.blocks[0].charEnd = 999;
  for (const candidate of [mismatched, outOfBounds]) {
    const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [], files: [], assessments: [assessment], assignmentBriefs: [candidate] } } });
    assert.equal(context.assignmentBriefForAssessment('1', assessment), null);
  }
});

test('考核表把 brief 链接标为歧义、冲突或不安全时拒绝唯一同名回退', async () => {
  for (const briefLinkStatus of ['ambiguous', 'conflict', 'unsafe']) {
    const assessment = { id: 'assessment:1:report', courseId: '1', title: 'Technical Report', briefLinkStatus };
    const exactBrief = assignmentBrief('1', '92', 'Exact title requirement', 'Technical Report');
    const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: {
      pages: [page('1', 'Course content '.repeat(12))], files: [], assessments: [assessment], assignmentBriefs: [exactBrief]
    } } });
    assert.equal(context.assignmentBriefForAssessment('1', assessment), null);
  }
});

test('关联作业说明版本变化会保留学习目标并要求重新核对', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const assessment = { id: 'assessment:1:project', courseId: '1', title: 'Design Project', assignmentActivityId: '91', evidence: 'Project | Weighting: 35%', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const oldBrief = assignmentBrief('1', '91', 'Old verified requirement', 'Design Project');
  const newBrief = assignmentBrief('1', '91', 'New verified requirement', 'Design Project');
  const oldVersion = contentHash(`${assessment.sourceUrl}\n${assessment.evidence}\nbrief:${oldBrief.sourceVersion}`);
  const goal = studyGoal('1', today, { assessmentId: assessment.id, assessmentVersion: oldVersion, title: assessment.title });
  const { context, saved } = await setup({
    courses: [{ id: '1', title: 'One' }], studyGoals: [goal],
    library: { 1: { pages: [page('1', 'Old content '.repeat(12))], files: [], assessments: [assessment], assignmentBriefs: [oldBrief] } }
  });
  context.message = async () => ({ data: {
    pages: [page('1', 'New content '.repeat(12))], files: [], events: [], errors: [], assessments: [assessmentEvidence(assessment)], assessmentParseStatus: 'complete',
    assignmentBriefs: [newBrief], assignmentBriefParseStatus: 'complete',
    assignmentBriefScan: { discovered: 1, attempted: 1, succeeded: 1, failed: 0, overflow: 0, complete: true }
  } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.equal(saved.studyGoals[0].assessmentVersion, oldVersion);
  assert.equal(saved.studyGoals[0].assessmentNeedsRevalidation, true);
});

test('作业说明不进入知识单元、语义检索、复习卡片或 AI 问答来源', async () => {
  const secret = 'PRIVATE_ASSIGNMENT_BRIEF_CANARY';
  const lecture = page('1', 'Momentum is the product of mass and velocity. '.repeat(4), 'Physics lecture');
  const brief = assignmentBrief('1', '91', secret, 'Private assignment');
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [lecture], files: [], assignmentBriefs: [brief] } }
  });
  const snapshot = vm.runInContext('library["1"]', context);
  context.indexCourseKnowledge(snapshot, '1');
  assert.equal(JSON.stringify(snapshot.knowledgeUnits || []).includes(secret), false);
  assert.equal(JSON.stringify(context.semanticSegments(snapshot, '1')).includes(secret), false);
  assert.equal(JSON.stringify(context.reviewPages('1')).includes(secret), false);
  get('#question').value = 'What is momentum?';
  let request = null;
  context.fetch = async (url, options) => {
    if (!String(url).endsWith('/answer')) throw new Error('semantic offline');
    request = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ answer: 'Momentum equals mass times velocity. [1]' }) };
  };
  await context.ask();
  assert.ok(request);
  assert.equal(JSON.stringify(request).includes(secret), false);
  assert.equal(request.sources.every(source => source.url.includes('/mod/page/view.php')), true);
});

test('截止事项今日已打开可跨侧栏恢复，改期后重新获得优先级', async () => {
  const now = Date.now();
  const first = { id: 'stable-event', courseId: '1', title: 'Deadline', component: 'mod_assign', eventType: 'due', timestampMs: now + 3_600_000, courseUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const sharedStorage = { courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [], files: [], events: [first] } }, reviewProgress: {}, semanticIndex: {} };
  const original = await setup({ sharedStorage });
  await original.context.markDeadlineOpened(first, now);
  const rebuilt = await setup({ sharedStorage });
  assert.equal(rebuilt.context.deadlineOpenedToday(first, now), true);
  assert.equal(rebuilt.context.selectNextAction(rebuilt.context.todayPlan(now), now), null);
  const changed = { ...first, timestampMs: first.timestampMs + 60_000 };
  assert.equal(rebuilt.context.deadlineOpenedToday(changed, now), false);
  assert.equal(rebuilt.context.selectNextAction({ ...rebuilt.context.todayPlan(now), deadlines: [{ ...changed, course: { id: '1', title: 'One' } }] }, now).event.timestampMs, changed.timestampMs);
});

test('截止事项已打开状态写入失败会回滚且 Sydney 换日自动失效', async () => {
  const event = { id: 'event-fail', courseId: '1', title: 'Deadline', component: 'mod_assign', eventType: 'due', timestampMs: Date.now() + 3_600_000, courseUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const { context } = await setup();
  const originalSet = context.chrome.storage.local.set;
  context.chrome.storage.local.set = async patch => { if (patch.openedDeadlinesToday) throw new Error('disk full'); return originalSet(patch); };
  await assert.rejects(() => context.markDeadlineOpened(event), /disk full/);
  assert.equal(context.deadlineOpenedToday(event), false);
  const now = Date.now();
  const stored = vm.runInContext('openedDeadlinesToday', context);
  assert.equal(context.normalizeOpenedDeadlinesToday(stored, now + 48 * 3_600_000).entries.length, 0);
});

async function setup(initial = {}) {
  const elements = new Map();
  const document = {
    createElement: tag => new Element(tag),
    querySelector: selector => { if (!elements.has(selector)) elements.set(selector, new Element(selector.includes('course') || selector.includes('section') ? 'select' : 'div')); return elements.get(selector); },
    querySelectorAll: () => []
  };
  const saved = initial.sharedStorage || (initial.rawStorage ? structuredClone(initial.rawStorage) : {
    courses: initial.courses || [], library: initial.library || {}, reviewProgress: initial.reviewProgress || {}, semanticIndex: initial.semanticIndex || {},
    ...(Object.hasOwn(initial, 'learningSession') ? { learningSession: initial.learningSession } : {}),
    ...(Object.hasOwn(initial, 'studyPlanPreferences') ? { studyPlanPreferences: initial.studyPlanPreferences } : {}),
    ...(Object.hasOwn(initial, 'studyGoals') ? { studyGoals: initial.studyGoals } : {}),
    ...(Object.hasOwn(initial, 'studyPlanRuntime') ? { studyPlanRuntime: initial.studyPlanRuntime } : {}),
    ...(Object.hasOwn(initial, 'todayFocusSession') ? { todayFocusSession: initial.todayFocusSession } : {}),
    ...(Object.hasOwn(initial, 'openedDeadlinesToday') ? { openedDeadlinesToday: initial.openedDeadlinesToday } : {}),
    ...(Object.hasOwn(initial, 'refreshPlanState') ? { refreshPlanState: initial.refreshPlanState } : {}),
    ...(Object.hasOwn(initial, 'chatHistory') ? { chatHistory: initial.chatHistory } : {}),
    ...(Object.hasOwn(initial, 'chatSessions') ? { chatSessions: initial.chatSessions } : {})
  });
  let storageReads = 0;
  let tabQueries = 0;
  const tabMessages = [];
  const runtimeMessages = [];
  const aiProxyMessages = [];
  const chrome = { storage: { local: {
    get: async () => { storageReads++; return structuredClone(saved); },
    set: async patch => Object.assign(saved, structuredClone(patch)),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete saved[key]; }
  } }, tabs: {
    query: async () => { tabQueries++; return initial.hasMoodleTab === false ? [] : [{ id: 1 }]; },
    getCurrent: async () => ({ id: initial.currentTabId ?? 1 }),
    create: async () => ({}),
    sendMessage: async (tabId, message) => { tabMessages.push({ tabId, message }); return { ok: true, contentVersion: '2026.10.03.1', ...(initial.accountId ? { accountId: initial.accountId } : {}) }; }
  } };
  const defaultRuntimeSend = async message => message.type === 'REDEEM_EMBEDDED_CAPABILITY'
    ? (initial.redeemResult || { ok: true, bindingId: 'b'.repeat(48), tabId: initial.boundTabId ?? 1, hostDocumentId: 'host-document', generation: 1 })
    : ['CONFIRM_EMBEDDED_READY', 'REPORT_EMBEDDED_RENDER_STATE'].includes(message.type) ? { ok: true } : { ok: false };
  let context;
  if (initial.embedded || initial.runtimeId || initial.runtimeSendMessage || initial.aiProxyHandler) {
    const runtimeHandler = initial.runtimeSendMessage || defaultRuntimeSend;
    chrome.runtime = { ...(initial.runtimeId ? { id: initial.runtimeId } : {}), async sendMessage(message) {
      if (message.type === 'AI_PROXY') {
        aiProxyMessages.push(structuredClone(message));
        if (initial.aiProxyHandler) return initial.aiProxyHandler(message);
        try {
          const response = await context.fetch(`http://127.0.0.1:4317${message.endpoint}`, {
            method: message.method,
            ...(message.body ? { body: JSON.stringify(message.body), headers: { 'content-type': 'application/json' } } : {})
          });
          return { ok: true, status: response.status ?? (response.ok ? 200 : 500), responseOk: response.ok === true, data: await response.json() };
        } catch { return { ok: false, error: 'AI_PROXY_UNREACHABLE' }; }
      }
      runtimeMessages.push(structuredClone(message));
      return runtimeHandler(message);
    } };
  }
  const parentMessages = [];
  const parentWindow = { postMessage(message, origin) { parentMessages.push({ message, origin }); } };
  const panelWindow = initial.embedded ? {
    parent: parentWindow,
    listeners: {},
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); },
    removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter(item => item !== callback); },
    async emit(name, event) { await Promise.all((this.listeners[name] || []).map(callback => callback(event))); },
    postMessage() {},
    scrollTo(options) { this.lastScroll = options; }
  } : undefined;
  context = vm.createContext({ document, chrome, URL, console, AbortSignal, atob, crypto: webcrypto, TextEncoder, confirm: () => true, __ASKME_TEST_DIRECT_AI__: true, fetch: initial.fetch || (async () => { throw new Error('offline'); }),
    ...(initial.embedded ? { window: panelWindow, location: { search: '?embedded=1&g=1' } } : {}) });
  vm.runInContext(learningCoreScript, context);
  vm.runInContext(knowledgeUnitsScript, context);
  vm.runInContext(assessmentKernelScript, context);
  vm.runInContext(unitProgressScript, context);
  vm.runInContext(script, context);
  if (initial.authorizeEmbedded) {
    await panelWindow.emit('message', { origin: 'https://moodle.telt.unsw.edu.au', source: parentWindow, data: { type: 'ASKME_EMBEDDED_INIT', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 1 } });
    await vm.runInContext('panelReady', context);
  }
  if (!initial.embedded) await vm.runInContext('panelReady', context);
  await new Promise(resolve => setImmediate(resolve));
  return { context, saved, elements, get: selector => document.querySelector(selector), parentMessages, parentWindow, panelWindow,
    storageReads: () => storageReads, tabQueries: () => tabQueries, tabMessages, runtimeMessages, aiProxyMessages };
}

test('内嵌面板只接受 Moodle 父页面的白名单视图消息并回报当前模块', async () => {
  const embedded = await setup({ embedded: true, authorizeEmbedded: true });
  assert.deepEqual(JSON.parse(JSON.stringify(embedded.parentMessages.find(item => item.message?.type === 'ASKME_EMBEDDED_BOOT'))), {
    message: { type: 'ASKME_EMBEDDED_BOOT', contentVersion: '2026.10.02.1', generation: 1 }, origin: 'https://moodle.telt.unsw.edu.au'
  });
  const bindingId = 'b'.repeat(48);
  assert.deepEqual(JSON.parse(JSON.stringify(embedded.runtimeMessages.find(message => message.type === 'CONFIRM_EMBEDDED_READY'))), {
    type: 'CONFIRM_EMBEDDED_READY', bindingId, generation: 1
  });
  const redeemCount = embedded.runtimeMessages.filter(message => message.type === 'REDEEM_EMBEDDED_CAPABILITY').length;
  const readyCount = embedded.parentMessages.filter(item => item.message?.type === 'ASKME_EMBEDDED_READY').length;
  await embedded.panelWindow.emit('message', { origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow, data: { type: 'ASKME_EMBEDDED_INIT', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 1 } });
  assert.equal(embedded.runtimeMessages.filter(message => message.type === 'REDEEM_EMBEDDED_CAPABILITY').length, redeemCount);
  assert.equal(embedded.parentMessages.filter(item => item.message?.type === 'ASKME_EMBEDDED_READY').length, readyCount + 1);
  assert.equal(embedded.context.receiveEmbeddedView({ origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow, data: { type: 'ASKME_OPEN_VIEW', view: 'ask', bindingId, generation: 1 } }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(embedded.parentMessages.findLast(item => item.message.type === 'ASKME_EMBEDDED_VIEW'))), {
    message: { type: 'ASKME_EMBEDDED_VIEW', view: 'ask', bindingId, generation: 1 }, origin: 'https://moodle.telt.unsw.edu.au'
  });
  const count = embedded.parentMessages.length;
  assert.equal(embedded.context.receiveEmbeddedView({ origin: 'https://evil.example', source: embedded.parentWindow, data: { type: 'ASKME_OPEN_VIEW', view: 'courses', bindingId } }), false);
  assert.equal(embedded.context.receiveEmbeddedView({ origin: 'https://moodle.telt.unsw.edu.au', source: {}, data: { type: 'ASKME_OPEN_VIEW', view: 'courses', bindingId } }), false);
  assert.equal(embedded.context.receiveEmbeddedView({ origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow, data: { type: 'ASKME_OPEN_VIEW', view: 'settings', bindingId } }), false);
  assert.equal(embedded.context.receiveEmbeddedView({ origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow, data: { type: 'ASKME_OPEN_VIEW', view: 'ask', bindingId: 'c'.repeat(48) } }), false);
  assert.equal(embedded.parentMessages.length, count);
});

test('后台拒绝 ready 确认时面板保持失败状态并向当前 generation 宿主报告', async () => {
  const bindingId = 'b'.repeat(48);
  const embedded = await setup({
    embedded: true,
    authorizeEmbedded: true,
    runtimeSendMessage: async message => message.type === 'REDEEM_EMBEDDED_CAPABILITY'
      ? { ok: true, bindingId, tabId: 1, hostDocumentId: 'host-document', generation: 1 }
      : message.type === 'CONFIRM_EMBEDDED_READY'
        ? { ok: false, error: 'EMBEDDED_HOST_UNAVAILABLE' }
        : { ok: false }
  });
  assert.match(embedded.get('#status').textContent, /EMBEDDED_HOST_UNAVAILABLE/u);
  const failure = embedded.parentMessages.findLast(item => item.message?.type === 'ASKME_EMBEDDED_AUTH_ERROR');
  assert.equal(failure?.message.generation, 1);
  assert.equal(failure?.message.error, 'EMBEDDED_HOST_UNAVAILABLE');
  assert.equal(embedded.parentMessages.some(item => item.message?.type === 'ASKME_EMBEDDED_READY' && item.message.stage === 'layout-ready'), false);
});

test('折叠面板首次尺寸为零，展开和调整尺寸后重新上报布局', async () => {
  const embedded = await setup({ embedded: true, authorizeEmbedded: true });
  const main = embedded.get('main');
  let size = { width: 0, height: 0 };
  main.getBoundingClientRect = () => size;
  const document = embedded.context.document;
  document.body = { innerText: '课程与问答' };
  document.styleSheets = [{}];
  document.querySelectorAll = selector => selector === '.view' ? [{ id: 'courses', hidden: false }] : [];
  embedded.context.getComputedStyle = () => ({ display: 'flex' });
  await embedded.context.reportEmbeddedRenderState();
  let report = embedded.runtimeMessages.filter(message => message.type === 'REPORT_EMBEDDED_RENDER_STATE').at(-1);
  assert.equal(report.mainWidth, 0);
  assert.equal(report.aiState, 'offline');
  assert.equal(typeof report.hasSelectedCourse, 'boolean');
  assert.equal(Number.isInteger(report.courseCount), true);
  assert.equal('selectedCourseId' in report, false);
  size = { width: 400, height: 700 };
  embedded.context.receiveEmbeddedView({ origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow,
    data: { type: 'ASKME_OPEN_VIEW', view: 'ask', bindingId: 'b'.repeat(48), generation: 1 } });
  await Promise.resolve();
  report = embedded.runtimeMessages.filter(message => message.type === 'REPORT_EMBEDDED_RENDER_STATE').at(-1);
  assert.equal(report.mainWidth, 400);
  size = { width: 480, height: 700 };
  await embedded.panelWindow.emit('resize', {});
  await Promise.resolve();
  report = embedded.runtimeMessages.filter(message => message.type === 'REPORT_EMBEDDED_RENDER_STATE').at(-1);
  assert.equal(report.mainWidth, 480);
  const sequences = embedded.runtimeMessages.filter(message => message.type === 'REPORT_EMBEDDED_RENDER_STATE').map(message => message.diagnosticSeq);
  assert.equal(sequences.every((value, index) => index === 0 || value > sequences[index - 1]), true);
});

test('Chrome 隐去跨扩展 MessageEvent.source 时仍以 Moodle 来源和一次性凭据授权', async () => {
  const embedded = await setup({ embedded: true });
  const capability = 'a'.repeat(48);
  await embedded.panelWindow.emit('message', {
    origin: 'https://moodle.telt.unsw.edu.au', source: null,
    data: { type: 'ASKME_EMBEDDED_INIT', capability, hostDocumentId: 'host-document', generation: 1 }
  });
  await vm.runInContext('panelReady', embedded.context);
  const ready = embedded.parentMessages.find(item => item.message?.type === 'ASKME_EMBEDDED_READY');
  assert.equal(ready?.message.bindingId, 'b'.repeat(48));
  assert.equal(embedded.runtimeMessages.filter(message => message.type === 'REDEEM_EMBEDDED_CAPABILITY').length, 1);
  assert.equal(embedded.context.receiveEmbeddedView({
    origin: 'https://moodle.telt.unsw.edu.au', source: null,
    data: { type: 'ASKME_OPEN_VIEW', view: 'ask', bindingId: 'b'.repeat(48), capability, generation: 1 }
  }), true);
  assert.equal(embedded.context.receiveEmbeddedView({
    origin: 'https://moodle.telt.unsw.edu.au', source: null,
    data: { type: 'ASKME_OPEN_VIEW', view: 'courses', bindingId: 'b'.repeat(48), capability: 'c'.repeat(48), generation: 1 }
  }), false);
  assert.equal(embedded.context.receiveEmbeddedView({
    origin: 'https://evil.example', source: null,
    data: { type: 'ASKME_OPEN_VIEW', view: 'courses', bindingId: 'b'.repeat(48), generation: 1 }
  }), false);
  assert.equal(embedded.context.receiveEmbeddedView({
    origin: 'https://moodle.telt.unsw.edu.au',
    data: { type: 'ASKME_OPEN_VIEW', view: 'courses', bindingId: 'b'.repeat(48), generation: 1 }
  }), false);
});

test('课程卡 Sync 消息只接受已绑定父页面的规范 Moodle 课程并立即选中同步', async () => {
  const embedded = await setup({ embedded: true, authorizeEmbedded: true });
  const bindingId = 'b'.repeat(48);
  assert.equal(embedded.context.receiveEmbeddedView({
    origin: 'https://evil.example', source: embedded.parentWindow,
    data: { type: 'ASKME_SYNC_DISCOVERED_COURSE', bindingId, generation: 1, course: { id: '7', title: 'Forged', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=7' } }
  }), false);
  assert.equal(embedded.context.receiveEmbeddedView({
    origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow,
    data: { type: 'ASKME_SYNC_DISCOVERED_COURSE', bindingId, generation: 1, course: { id: '7', title: 'Bad URL', url: 'https://evil.example/course/view.php?id=7' } }
  }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(embedded.saved.courses.length, 0);
  assert.equal(embedded.context.receiveEmbeddedView({
    origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow,
    data: { type: 'ASKME_SYNC_DISCOVERED_COURSE', bindingId, generation: 1, course: { id: '7', title: 'MANF9543', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=7' } }
  }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(embedded.saved.courses[0].id, '7');
  assert.equal(embedded.saved.courses[0].selected, true);
});

test('Ask 模块保留上下文提问入口、建议提示词与来源区域', async () => {
  const { context, get } = await setup();
  assert.match(panelHtml, /id="prompt-suggestions"/);
  assert.match(panelHtml, /核心概念/);
  assert.match(panelHtml, /可能考点/);
  assert.match(panelHtml, /迁移应用/);
  assert.match(panelHtml, /id="sources"/);
  assert.equal(context.applyPromptSuggestion('  请解释并迁移这个概念。  '), true);
  assert.equal(get('#question').value, '请解释并迁移这个概念。');
  assert.equal(context.applyPromptSuggestion('   '), false);
});

test('未获 capability 的同源自建 iframe 不加载存储、不附业务事件且不查询标签页', async () => {
  const embedded = await setup({ embedded: true });
  assert.equal(embedded.storageReads(), 0);
  assert.equal(embedded.tabQueries(), 0);
  assert.equal(embedded.get('#start-today').listeners.click, undefined);
  assert.equal(embedded.context.receiveEmbeddedView({ origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow, data: { type: 'ASKME_OPEN_VIEW', view: 'ask' } }), false);
  assert.equal(embedded.tabMessages.length, 0);
});

test('内嵌面板精确使用 capability 绑定标签且从不回退查询其他 Moodle 标签', async () => {
  const embedded = await setup({ embedded: true, authorizeEmbedded: true, currentTabId: 22, boundTabId: 22 });
  assert.equal(embedded.tabQueries(), 0);
  assert.ok(embedded.tabMessages.length > 0);
  assert.equal(embedded.tabMessages.every(item => item.tabId === 22), true);
  assert.equal(await embedded.context.moodleTab(), 22);
});

test('讲解当前页通过 binding 向后台取静态来源并在 Ask 模块显示本地 AI 解释与 Moodle 引用', async () => {
  const bindingId = 'b'.repeat(48);
  const embedded = await setup({
    embedded: true, authorizeEmbedded: true, accountId: '12345',
    runtimeSendMessage: async message => message.type === 'REDEEM_EMBEDDED_CAPABILITY'
      ? { ok: true, bindingId, tabId: 1, hostDocumentId: 'host-document' }
      : message.type === 'GET_BOUND_CURRENT_PAGE_SOURCE'
        ? { ok: true, contentVersion: '2026.10.02.1', accountId: '12345', source: { title: 'Week 3', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7', excerpt: 'Manufacturing concept '.repeat(30), truncated: false } }
        : { ok: false },
    fetch: async () => ({ ok: true, status: 200, async json() { return { answer: '准确解释 [1]' }; } })
  });
  const accepted = embedded.context.receiveEmbeddedView({
    origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow,
    data: { type: 'ASKME_EXPLAIN_CURRENT_PAGE', bindingId, generation: 1 }
  });
  assert.equal(accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(embedded.runtimeMessages.at(-1))), { type: 'GET_BOUND_CURRENT_PAGE_SOURCE', bindingId, userId: '12345' });
  assert.equal(embedded.get('#answer').textContent, '准确解释 [1]');
  assert.equal(embedded.get('#answer').hidden, false);
  assert.equal(embedded.parentMessages.some(item => item.message?.type === 'ASKME_HOST_ACTION_RESULT' && item.message.ok === true && item.message.bindingId === bindingId), true);
});

test('内嵌 panel 信任后台已验证的绑定且后台拒绝错误标签时保持未启动', async () => {
  const embedded = await setup({ embedded: true, authorizeEmbedded: true, currentTabId: 22, redeemResult: { ok: false, error: 'EMBEDDED_TAB_MISMATCH' } });
  assert.equal(embedded.storageReads(), 0);
  assert.equal(embedded.tabQueries(), 0);
  assert.equal(embedded.tabMessages.length, 0);
  assert.equal(embedded.get('#start-today').listeners.click, undefined);
  assert.equal(embedded.parentMessages.some(item => item.message?.type === 'ASKME_EMBEDDED_READY'), false);
  assert.equal(embedded.parentMessages.some(item => item.message?.type === 'ASKME_EMBEDDED_AUTH_ERROR'), true);
});

function page(courseId, text, title = 'Week 1') {
  return { courseId, title, section: 'Week 1', text, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=${courseId}` };
}

let lastPracticeDigest = '';

function practiceV2(verdict, feedback, modelAnswer, explanation = '', contentDigest = lastPracticeDigest) {
  return {
    schemaVersion: 2, verdict, feedback, modelAnswer, explanation, contentDigest,
    verification: { status: 'verified', method: 'deterministic-rubric', reasonCodes: [] },
    criterionResults: [{ criterionId: 'course-evidence-answer', verification: { status: 'verified' } }],
    errorTags: verdict === 'correct' ? [] : [{ type: 'definition-confusion', verification: { status: 'verified' } }], evidenceRefs: []
  };
}

function practiceDigest(excerpt) { return createHash('sha256').update(String(excerpt || ''), 'utf8').digest('hex'); }
function generatedPractice(options, sessionId, questions, overrides = {}) {
  const body = JSON.parse(options.body);
  lastPracticeDigest = practiceDigest(body.source.excerpt);
  return { ok: true, status: 200, json: async () => ({ schemaVersion: 2, sessionId, contentDigest: lastPracticeDigest, questions, ...overrides }) };
}

function calendarEvent(courseId, title, eventType, timestampMs, evidenceText, overrides = {}) {
  return {
    id: `event:${courseId}:${title}:${eventType}:${timestampMs}`, courseId: String(courseId), title,
    component: 'mod_assign', eventType, timestampMs, courseTitle: `Course ${courseId}`,
    courseUrl: `https://moodle.telt.unsw.edu.au/course/view.php?id=${courseId}`,
    activityUrl: `https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=${courseId}01`,
    sourceVersion: contentHash(evidenceText),
    evidence: { schemaVersion: 1, rawText: evidenceText, normalizedText: evidenceText, verbatim: true,
      title: { value: title, source: 'event-container-text' }, dateTime: { value: evidenceText, source: 'event-container-text' },
      eventType: { value: eventType, source: 'data-event-type' } },
    ...overrides
  };
}

function contentHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

function assessmentEvidence(value) {
  const item = { schemaVersion: 1, extractorVersion: 1, ...value };
  item.sourceVersion = contentHash(`${item.sourceUrl || ''}\n${item.evidence || ''}\nassessment-row-v1`);
  item.evidenceRef = {
    schemaVersion: 1, courseId: String(item.courseId), sourceKind: 'assessment-row', sourceId: String(item.id), sourceVersion: item.sourceVersion,
    span: { start: 0, end: item.evidence.length }, quote: item.evidence, url: item.sourceUrl
  };
  return item;
}

function learningKey(item) {
  return `${String(item.id || `${item.url}|${item.title || item.section || ''}`)}\u001f${contentHash(item.text)}`;
}

function storedSession(courseId, item, overrides = {}) {
  return {
    schemaVersion: 1,
    view: 'review',
    courseId: String(courseId),
    sectionKey: '',
    cardKey: learningKey(item),
    mode: 'card',
    practiceQuestionIndex: 0,
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function studyGoal(courseId, examDate, overrides = {}) {
  return {
    id: `exam:${courseId}`, courseId: String(courseId), title: `Course ${courseId} exam`, examDate, examTime: '', timeZone: 'Australia/Sydney',
    priority: 'normal', scopeMode: 'all', sectionKeys: [], includeFutureSections: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null,
    ...overrides
  };
}

function assignmentBrief(courseId, activityId, text, title = `Assignment ${activityId}`) {
  const sourceUrl = `https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=${activityId}`;
  const textHash = contentHash(text);
  return {
    schemaVersion: 1, id: `assign-brief:${courseId}:${activityId}`, courseId: String(courseId), activityId: String(activityId), sourceUrl, title,
    section: 'Assessment', blocks: [{ blockId: 'brief-block:1', kind: 'paragraph', ordinal: 1, charStart: 0, charEnd: text.length, text }], textHash,
    sourceVersion: contentHash(`${sourceUrl}\n${textHash}\n1`), extractorVersion: 1, parseStatus: 'complete', syncedAt: new Date().toISOString()
  };
}

function focusQueueItem(course, item, estimateMinutes = 8, reason = '一般新知识点') {
  return { course, page: item, key: item.id || `${item.url}|${item.title}`, estimateMinutes, reason, isNew: true, weak: false, examNear: false };
}

test('Moodle 标签页运行旧内容脚本时要求刷新，不继续静默同步', async () => {
  const { context } = await setup();
  context.chrome.tabs.sendMessage = async () => ({ ok: true, contentVersion: 'old' });
  await assert.rejects(() => context.message('DISCOVER'), /刷新该 Moodle 页面/);
});

test('生产环境没有 Moodle 标签页时首次主按钮直接提供打开我的课程', async () => {
  const { context, get } = await setup({ runtimeId: 'production-extension-id', hasMoodleTab: false });
  assert.equal(get('#start-today').textContent, '打开 Moodle“我的课程” →');
  assert.equal(get('#start-today').disabled, false);
  let opened = '';
  context.chrome.tabs.create = async ({ url }) => { opened = url; return {}; };
  await context.startToday();
  assert.equal(opened, 'https://moodle.telt.unsw.edu.au/my/courses.php');
});

test('有 Moodle 标签页但从未发现课程时首次主按钮执行发现', async () => {
  const { context, get } = await setup();
  assert.equal(get('#start-today').textContent, '发现 Moodle 课程 →');
  let discovered = 0;
  context.message = async type => { assert.equal(type, 'DISCOVER'); discovered++; return { courses: [{ id: '1', title: 'One' }] }; };
  await context.startToday();
  assert.equal(discovered, 1);
  assert.match(get('#start-today').textContent, /同步所选课程/);
});

test('发现零门课程后主按钮转为打开 Moodle 我的课程', async () => {
  const { context, get } = await setup();
  context.message = async type => { assert.equal(type, 'DISCOVER'); return { courses: [] }; };
  await context.startToday();
  assert.equal(get('#start-today').textContent, '打开 Moodle“我的课程” →');
  assert.match(get('#status').textContent, /本页没有课程链接/);
});

test('已有课程全部未选择时主按钮和课程页 quiet 同步按钮均禁用', async () => {
  const { get } = await setup({ courses: [{ id: '1', title: 'One', selected: false }, { id: '2', title: 'Two', selected: false }] });
  assert.equal(get('#start-today').textContent, '请先选择至少一门课程');
  assert.equal(get('#start-today').disabled, true);
  assert.equal(get('#sync').disabled, true);
  assert.match(panelHtml, /id="sync"[^>]*class="quiet wide"/u);
});

test('未选择课程不会继续出现在问答和复习范围', async () => {
  const { get } = await setup({
    courses: [{ id: '1', title: 'Selected course' }, { id: '2', title: 'Unselected course', selected: false }],
    library: { 1: { pages: [page('1', 'Selected content '.repeat(10))], files: [] }, 2: { pages: [page('2', 'Unselected content '.repeat(10))], files: [] } }
  });
  assert.deepEqual(get('#ask-course').options.map(option => option.value), ['1']);
  assert.deepEqual(get('#review-course').options.map(option => option.value), ['1']);
  assert.equal(get('#course-list').children[0].children[2].textContent, '已选择');
  assert.equal(get('#course-list').children[1].children[2].textContent, '未选择');
});

test('已选课程没有可用正文或只有空快照时主按钮要求同步', async () => {
  const missing = await setup({ courses: [{ id: '1', title: 'Missing' }] });
  assert.equal(missing.get('#start-today').textContent, '同步所选课程（1 门未同步） →');
  const empty = await setup({ courses: [{ id: '1', title: 'Empty' }], library: { 1: { pages: [], files: [], syncedAt: new Date().toISOString() } } });
  assert.equal(empty.get('#start-today').textContent, '同步所选课程（1 门未同步） →');
});

test('部分选中课程已有正文但仍有未同步课程时继续提示同步', async () => {
  const { get } = await setup({
    courses: [{ id: '1', title: 'Ready' }, { id: '2', title: 'Missing' }],
    library: { 1: { pages: [page('1', 'Ready content '.repeat(8), 'Ready page')], files: [] } }
  });
  assert.equal(get('#start-today').textContent, '同步所选课程（1 门未同步） →');
});

test('全部选中课程有正文时首次主按钮精确打开第一个知识点', async () => {
  const first = { ...page('1', 'First body '.repeat(10), 'First knowledge'), id: 'first-knowledge' };
  const second = { ...page('2', 'Second body '.repeat(10), 'Second knowledge'), id: 'second-knowledge' };
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: { 1: { pages: [first], files: [] }, 2: { pages: [second], files: [] } }
  });
  assert.equal(get('#start-today').textContent, '开始第一个知识点 →');
  await context.startToday();
  assert.equal(get('#review-course').value, '1');
  assert.equal(vm.runInContext('activeCard.id', context), 'first-knowledge');
  assert.equal(get('#card').children[1].textContent, 'First knowledge');
});

test('本机 AI 健康检查离线时仍完成 HTML 同步并说明受限功能', async () => {
  const htmlPage = { ...page('1', 'HTML lesson '.repeat(10), 'HTML lesson'), id: 'html-lesson' };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }] });
  context.message = async type => {
    assert.equal(type, 'SYNC_COURSE');
    return { data: { pages: [htmlPage], files: [], errors: [] } };
  };
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.equal(saved.library['1'].pages[0].id, 'html-lesson');
  assert.match(get('#status').textContent, /同步完成：1\/1/);
  assert.match(get('#status').textContent, /HTML 内容仍会同步/);
  assert.match(get('#status').textContent, /文件正文、语义检索、摘要和自测暂时受限/);
});

test('AI 状态区分服务未运行、代理鉴权异常并可手动重试', async () => {
  const { context, get } = await setup({ fetch: async () => { throw new TypeError('connection refused'); } });
  await context.checkAiHealth(true);
  assert.equal(get('#ai-status').dataset.state, 'offline');
  assert.equal(get('#ai-status').textContent, 'AI 服务未运行');
  assert.match(get('#ai-detail').textContent, /无法访问|扩展 ID/u);
  context.fetch = async () => ({ ok: false, status: 403 });
  await context.checkAiHealth(true);
  assert.equal(get('#ai-status').dataset.state, 'proxy-auth-rejected');
  assert.equal(get('#ai-status').textContent, 'AI 鉴权异常');
  assert.match(panelCss, /\.ai-status\[data-state="proxy-auth-rejected"\]/u);
  assert.match(panelCss, /\.ai-detail\[data-state="proxy-auth-rejected"\]/u);
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, state: 'model-missing', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: [], missingModels: ['qwen3-embedding:0.6b'] }) });
  await context.checkAiHealth(true);
  assert.equal(get('#ai-status').dataset.state, 'model-missing');
  assert.equal(get('#ai-status').textContent, 'AI 模型未安装');
  assert.match(get('#ai-status').title, /qwen3-embedding/u);
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, state: 'degraded', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: [] }) });
  await context.checkAiHealth(true);
  assert.equal(get('#ai-status').dataset.state, 'degraded');
  assert.equal(get('#ai-status').textContent, 'AI 运行异常');
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) });
  await context.checkAiHealth(true);
  assert.equal(get('#ai-status').dataset.state, 'ready');
  assert.equal(get('#ai-status').textContent, 'AI 服务已连接');
  assert.match(get('#ai-status').title, /qwen3\.5:9b/u);
  assert.match(get('#ai-detail').textContent, /qwen3\.5:9b/u);
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2'] }) });
  await context.checkAiHealth(true);
  assert.equal(get('#ai-status').dataset.state, 'incompatible');
  assert.equal(get('#ai-status').textContent, 'AI 版本不符');
});

test('正式扩展上下文的全部本机 AI 请求经后台固定代理发送', async () => {
  const calls = [];
  const { context } = await setup({
    runtimeId: 'hmabehbhopolggfbmglhojehbjijcifi',
    aiProxyHandler: async message => {
      calls.push(structuredClone(message));
      if (message.type !== 'AI_PROXY') return { ok: false };
      const data = message.endpoint === '/health?deep=1'
        ? { ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }
        : { answer: 'grounded' };
      return { ok: true, status: 200, responseOk: true, data };
    }
  });
  const response = await context.aiFetch('http://127.0.0.1:4317/answer', {
    method: 'POST', body: JSON.stringify({ question: 'Q', sources: [{ title: 'T', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1', excerpt: 'Evidence' }] }), timeoutMs: 65_000
  });
  assert.equal((await response.json()).answer, 'grounded');
  const request = calls.find(item => item.endpoint === '/answer');
  assert.equal(request.type, 'AI_PROXY');
  assert.equal(request.method, 'POST');
  assert.equal(request.timeoutMs, 65_000);
  assert.equal(request.body.question, 'Q');
  assert.doesNotMatch(script, /fetch\(`\$\{localAi\}/u);
});

test('本机 AI 响应限制与读取错误显示具体原因而不误报服务离线', async () => {
  let proxyError = 'AI_PROXY_RESPONSE_TOO_LARGE';
  const { context } = await setup({
    runtimeId: 'hmabehbhopolggfbmglhojehbjijcifi',
    aiProxyHandler: async () => ({ ok: false, error: proxyError })
  });
  const expected = new Map([
    ['AI_PROXY_RESPONSE_TOO_LARGE', '本机 AI 响应超过 4 MB 上限。'],
    ['AI_PROXY_RESPONSE_READ_FAILED', '本机 AI 响应中途断开，请重试。'],
    ['AI_PROXY_INVALID_UTF8', '本机 AI 响应编码无效。'],
    ['AI_PROXY_INVALID_JSON', '本机 AI 返回的响应格式无效。']
  ]);
  for (const [code, message] of expected) {
    proxyError = code;
    await assert.rejects(
      () => context.aiFetch('http://127.0.0.1:4317/health?deep=1', { timeoutMs: 4_500 }),
      error => error.code === code && error.message === message
    );
  }
});

test('同步进行中拒绝重复启动并保持 quiet 同步按钮禁用', async () => {
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }] });
  let finish, syncCalls = 0;
  context.message = async type => {
    assert.equal(type, 'SYNC_COURSE');
    syncCalls++;
    return new Promise(resolve => { finish = resolve; });
  };
  context.fetch = async () => { throw new Error('offline'); };
  const first = context.sync();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(syncCalls, 1);
  assert.equal(get('#sync').disabled, true);
  await context.sync();
  assert.equal(syncCalls, 1);
  assert.match(get('#status').textContent, /请等待课程清除或单项活动重试结束后再同步课程/);
  finish({ data: { pages: [page('1', 'Synced HTML '.repeat(8))], files: [], errors: [] } });
  await first;
});

test('课程视图不包含第二个 primary 主按钮', () => {
  const coursesView = panelHtml.match(/<section id="courses"[\s\S]*?<\/section>/u)?.[0] || '';
  assert.ok(coursesView);
  assert.doesNotMatch(coursesView, /class="[^"]*\bprimary\b/u);
  assert.equal((panelHtml.match(/id="start-today"[^>]*class="primary"/gu) || []).length, 1);
});

test('学习计划分钟默认三十并接受十和一百八十边界，非法值不覆盖', async () => {
  const { context, saved, get } = await setup();
  assert.equal(get('#daily-minutes').value, '30');
  assert.equal(vm.runInContext('studyPlanPreferences.dailyMinutes', context), 30);
  get('#daily-minutes').value = '10';
  await context.savePlanSettings();
  assert.equal(saved.studyPlanPreferences.dailyMinutes, 10);
  get('#daily-minutes').value = '180';
  await context.savePlanSettings();
  assert.equal(saved.studyPlanPreferences.dailyMinutes, 180);
  get('#daily-minutes').value = '9';
  await context.savePlanSettings();
  assert.equal(saved.studyPlanPreferences.dailyMinutes, 180);
  assert.equal(vm.runInContext('studyPlanPreferences.dailyMinutes', context), 180);
  assert.match(get('#plan-settings-status').textContent, /10–180/);
});

test('学习计划设置和考试目标按 Moodle 账号物理隔离', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const rawStorage = {
    'askme:v1:user:111:courses': [{ id: '1', title: 'A' }], 'askme:v1:user:111:library': { 1: { pages: [page('1', 'A body')], files: [] } },
    'askme:v1:user:111:reviewProgress': {}, 'askme:v1:user:111:semanticIndex': {}, 'askme:v1:user:111:learningSession': null,
    'askme:v1:user:111:studyPlanPreferences': { dailyMinutes: 10, blockMinutes: 30 }, 'askme:v1:user:111:studyGoals': [studyGoal('1', today, { title: 'A exam' })],
    'askme:v1:user:222:courses': [{ id: '2', title: 'B' }], 'askme:v1:user:222:library': { 2: { pages: [page('2', 'B body')], files: [] } },
    'askme:v1:user:222:reviewProgress': {}, 'askme:v1:user:222:semanticIndex': {}, 'askme:v1:user:222:learningSession': null,
    'askme:v1:user:222:studyPlanPreferences': { dailyMinutes: 180, blockMinutes: 30 }, 'askme:v1:user:222:studyGoals': [studyGoal('2', today, { title: 'B exam' })]
  };
  const a = await setup({ rawStorage, runtimeId: 'production-extension-id', accountId: '111' });
  const b = await setup({ rawStorage, runtimeId: 'production-extension-id', accountId: '222' });
  assert.equal(vm.runInContext('studyPlanPreferences.dailyMinutes', a.context), 10);
  assert.equal(vm.runInContext('studyGoals[0].title', a.context), 'A exam');
  assert.equal(vm.runInContext('studyPlanPreferences.dailyMinutes', b.context), 180);
  assert.equal(vm.runInContext('studyGoals[0].title', b.context), 'B exam');
});

test('悉尼今天的考试仍有效，昨天的考试加载后自动归档', async () => {
  const probe = await setup();
  const today = probe.context.sydneyDayKey(Date.now());
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const item = page('1', 'Exam body '.repeat(10));
  const { context, saved } = await setup({
    courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } },
    studyGoals: [studyGoal('1', today, { id: 'exam:today' }), studyGoal('1', yesterday, { id: 'exam:yesterday' })]
  });
  assert.equal(vm.runInContext("studyGoals.find(goal => goal.id === 'exam:today').archivedAt", context), null);
  assert.equal(vm.runInContext("studyGoals.find(goal => goal.id === 'exam:yesterday').archivedAt", context) != null, true);
  assert.equal(saved.studyGoals.find(goal => goal.id === 'exam:yesterday').archivedAt != null, true);
  assert.equal(context.activeExamGoal('1')?.id, 'exam:today');
});

test('指定考试分节严格决定考试标记，正文变化仍进入到期队列', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const outside = { ...page('1', 'Outside body '.repeat(10), 'Outside'), id: 'outside', sectionGroup: 'Week 1' };
  const changed = { ...page('1', 'Changed body '.repeat(10), 'Changed'), id: 'changed', sectionGroup: 'Week 2', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const dueAt = new Date(Date.now() + 86_400_000).toISOString();
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [outside, changed], files: [] } }, studyPlanPreferences: { dailyMinutes: 30 },
    studyGoals: [studyGoal('1', today, { scopeMode: 'sections', sectionKeys: ['week:2'], includeFutureSections: false })],
    reviewProgress: { 1: {
      outside: { contentHash: contentHash(outside.text), dueAt: new Date(Date.now() - 1000).toISOString(), introducedAt: new Date().toISOString() },
      changed: { contentHash: 'old-body', dueAt, introducedAt: new Date().toISOString() }
    } }
  });
  const queue = context.buildStudyQueue();
  const outsideItem = queue.items.find(item => item.key === 'outside');
  const changedItem = queue.items.find(item => item.key === 'changed');
  assert.equal(outsideItem.examNear, false);
  assert.equal(changedItem.examNear, true);
  assert.equal(changedItem.isNew, false);
  assert.equal(changedItem.estimateMinutes, 4);
});

test('学习计划固定估时为薄弱六分钟、到期四分钟和新卡八分钟', async () => {
  const weak = { ...page('1', 'Weak '.repeat(20), 'Weak'), id: 'weak' };
  const due = { ...page('1', 'Due '.repeat(25), 'Due'), id: 'due', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const fresh = { ...page('1', 'Fresh '.repeat(20), 'Fresh'), id: 'fresh', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=3' };
  const past = new Date(Date.now() - 1000).toISOString();
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [weak, due, fresh], files: [] } }, studyPlanPreferences: { dailyMinutes: 180 }, reviewProgress: { 1: {
    weak: { contentHash: contentHash(weak.text), dueAt: past, introducedAt: new Date().toISOString(), practiceVerdict: 'incorrect' },
    due: { contentHash: contentHash(due.text), dueAt: past, introducedAt: new Date().toISOString() }
  } } });
  assert.deepEqual(Object.fromEntries(context.buildStudyQueue().items.map(item => [item.key, item.estimateMinutes])), { weak: 6, due: 4, fresh: 8 });
});

test('三十分钟计划最多排二十四分钟，十分钟有候选时至少排一项', async () => {
  const pages = Array.from({ length: 6 }, (_, i) => ({ ...page('1', 'New '.repeat(25), `New ${i}`), id: `new-${i}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=${i + 1}` }));
  const thirty = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } }, studyPlanPreferences: { dailyMinutes: 30 } });
  const queue30 = thirty.context.buildStudyQueue();
  assert.equal(queue30.usableMinutes, 24);
  assert.ok(queue30.estimatedMinutes <= 24);
  assert.equal(queue30.items.length, 3);
  const ten = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [pages[0]], files: [] } }, studyPlanPreferences: { dailyMinutes: 10 } });
  const queue10 = ten.context.buildStudyQueue();
  assert.equal(queue10.usableMinutes, 8);
  assert.equal(queue10.items.length, 1);
});

test('学习计划新卡仍受每日十个全局限制', async () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({ ...page('1', 'New '.repeat(25), `New ${i}`), id: `new-${i}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=${i + 1}` }));
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } }, studyPlanPreferences: { dailyMinutes: 180 } });
  const queue = context.buildStudyQueue();
  assert.equal(queue.items.length, 10);
  assert.equal(queue.dailyLimitExcluded, 2);
  assert.equal(queue.unplanned, 2);
});

test('首次揭示新卡会占用后台额度且同一卡片重复操作只占用一次', async () => {
  const item = { ...page('1', 'Claimed new concept '.repeat(8), 'Claimed'), id: 'claimed-new' };
  let claims = 0, claimedIdentity = '';
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } },
    runtimeSendMessage: async message => {
      assert.equal(message.type, 'CLAIM_NEW_CARD');
      claims++; claimedIdentity = message.identity;
      return { ok: true, runtime: { dayKey: message.dayKey, newCardClaims: [message.identity] } };
    }
  });
  context.nextCard();
  await context.reveal();
  assert.equal(claims, 1);
  assert.match(claimedIdentity, /^1\u001fclaimed-new\u001f/u);
  assert.equal(get('#rating-actions').hidden, false);
  await context.reveal();
  assert.equal(claims, 1);
  assert.equal(context.introducedTodayCount(), 1);
});

test('后台拒绝新卡额度时不揭示正文并显示每日上限说明', async () => {
  const item = { ...page('1', 'Rejected new concept '.repeat(8), 'Rejected'), id: 'rejected-new' };
  let claims = 0;
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } },
    runtimeSendMessage: async () => { claims++; return { ok: false, error: 'NEW_LIMIT_REACHED' }; }
  });
  context.nextCard();
  await context.reveal();
  assert.equal(claims, 1);
  assert.equal(get('#rating-actions').hidden, true);
  assert.equal(get('#card').children.some(child => child.textContent.includes('Rejected new concept')), false);
  assert.match(get('#status').textContent, /今天已开始 10 个新知识点/);
});

test('紧急截止优先续学，续学优先计划队列，队列优先未来事项', async () => {
  const item = { ...page('1', 'Resume '.repeat(20), 'Resume'), id: 'resume-plan' };
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } }, learningSession: storedSession('1', item) });
  const now = Date.now();
  const urgent = { id: 'urgent-plan', timestampMs: now + 1000 };
  const future = { id: 'future-plan', timestampMs: now + 2 * 86_400_000 };
  const queued = { course: { id: '1' }, page: item, key: 'resume-plan', weak: false, examNear: false };
  assert.equal(context.selectNextAction({ deadlines: [urgent, future], candidates: [], studyQueue: { items: [queued] } }, now).event.id, 'urgent-plan');
  assert.equal(context.selectNextAction({ deadlines: [future], candidates: [], studyQueue: { items: [queued] } }, now).type, 'resume');
  vm.runInContext('learningSession = null; learningSessionDesired = null', context);
  assert.equal(context.selectNextAction({ deadlines: [future], candidates: [], studyQueue: { items: [queued] } }, now).queueItem.key, 'resume-plan');
  assert.equal(context.selectNextAction({ deadlines: [future], candidates: [], studyQueue: { items: [] } }, now).event.id, 'future-plan');
});

test('同档普通课程在四十分钟计划中都会入选且同课程最多连续两项', async () => {
  const make = (courseId, count) => Array.from({ length: count }, (_, i) => ({ ...page(courseId, `${courseId} body `.repeat(15), `${courseId}-${i}`), id: `${courseId}-${i}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=${courseId}${i}` }));
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }], library: { 1: { pages: make('1', 3), files: [] }, 2: { pages: make('2', 2), files: [] } }, studyPlanPreferences: { dailyMinutes: 40 } });
  const ids = context.buildStudyQueue().items.map(item => String(item.course.id));
  assert.ok(ids.includes('1') && ids.includes('2'));
  assert.ok(ids.every((id, index) => index < 2 || !(id === ids[index - 1] && id === ids[index - 2])));
});

test('课程与页面数组重排不会改变学习计划结果', async () => {
  const one = Array.from({ length: 3 }, (_, i) => ({ ...page('1', 'One '.repeat(20), `One ${i}`), id: `one-${i}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1${i}` }));
  const two = Array.from({ length: 3 }, (_, i) => ({ ...page('2', 'Two '.repeat(20), `Two ${i}`), id: `two-${i}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2${i}` }));
  const a = await setup({ courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }], library: { 1: { pages: one, files: [] }, 2: { pages: two, files: [] } }, studyPlanPreferences: { dailyMinutes: 40 } });
  const b = await setup({ courses: [{ id: '2', title: 'Two' }, { id: '1', title: 'One' }], library: { 1: { pages: [...one].reverse(), files: [] }, 2: { pages: [...two].reverse(), files: [] } }, studyPlanPreferences: { dailyMinutes: 40 } });
  assert.deepEqual(Array.from(a.context.buildStudyQueue().items, item => `${item.course.id}:${item.key}`), Array.from(b.context.buildStudyQueue().items, item => `${item.course.id}:${item.key}`));
});

test('首页解释容量不足、预算排满和每日新卡限制造成的未排入', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const pages = Array.from({ length: 12 }, (_, i) => ({ ...page('1', 'Exam '.repeat(20), `Exam ${i}`), id: `exam-page-${i}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=${i + 1}` }));
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } }, studyPlanPreferences: { dailyMinutes: 10 }, studyGoals: [studyGoal('1', today)] });
  context.renderTodayStudy();
  const text = get('#today-plan-details').children.flatMap(child => [child.textContent, ...(child.children || []).map(grandchild => grandchild.textContent)]).join(' ');
  assert.match(text, /今日预算 10 分钟/);
  assert.match(text, /未排入/);
  assert.match(text, /今天的 10 分钟已排满/);
  assert.match(text, /每天最多 10 个新知识点限制/);
  assert.match(text, /考试前可能无法练习全部可见内容/);
});

test('学习计划设置保存失败保持旧内存和旧存储且持久化对象不含正文或答案', async () => {
  const oldPreferences = { dailyMinutes: 30, blockMinutes: 30 };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const oldGoals = [studyGoal('1', today, { title: 'Existing exam' })];
  const item = page('1', 'Existing course body '.repeat(8), 'Existing page');
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } }, studyPlanPreferences: oldPreferences, studyGoals: oldGoals });
  get('#daily-minutes').value = '60';
  context.chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
  await context.savePlanSettings();
  assert.deepEqual(saved.studyPlanPreferences, oldPreferences);
  assert.deepEqual(saved.studyGoals, oldGoals);
  assert.equal(vm.runInContext('studyPlanPreferences.dailyMinutes', context), 30);
  assert.equal(vm.runInContext('studyGoals[0].title', context), 'Existing exam');
  assert.match(get('#plan-settings-status').textContent, /保存失败/);

  const clean = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'SECRET PAGE TEXT', 'Page')], files: [] } } });
  clean.get('#daily-minutes').value = '10';
  vm.runInContext(`planEditors.get('1').exam.value = ${JSON.stringify(today)}`, clean.context);
  await clean.context.savePlanSettings();
  assert.equal(clean.saved.studyGoals.length, 1);
  const serialized = JSON.stringify({ preferences: clean.saved.studyPlanPreferences, goals: clean.saved.studyGoals });
  for (const forbidden of ['SECRET PAGE TEXT', 'studentAnswer', 'modelAnswer', 'feedback', 'sourceExcerpt', 'pageText']) assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
});

test('Moodle 明确考核项目可回查并成为学习计划目标', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const assessment = {
    id: 'assessment:1:weekly-evaluation', courseId: '1', title: 'Weekly evaluation', weightingText: '15%', explicitWeight: 15,
    lengthText: '15 mins per week', outcomesText: 'CLOs 1–3', dueText: 'Week 7, 8 and 9', feedbackText: '1 week after each evaluation',
    evidence: 'Assessment: Weekly evaluation | Weighting: 15%', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#section-2'
  };
  const { context, saved, get } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [page('1', 'Course body '.repeat(12))], files: [], assessments: [assessment] } }
  });
  const editor = vm.runInContext("planEditors.get('1')", context);
  editor.target.value = assessment.id; editor.exam.value = today;
  await context.savePlanSettings();
  assert.equal(saved.studyGoals[0].assessmentId, assessment.id);
  assert.equal(saved.studyGoals[0].title, 'Weekly evaluation');
  const collect = element => [element.textContent, ...(element.children || []).flatMap(collect)].filter(Boolean).join(' ');
  const detailsText = collect(get('#library-details'));
  assert.match(detailsText, /明确考核项目（1）/u);
  assert.match(detailsText, /权重 15%/u);
  assert.match(detailsText, /CLOs 1–3/u);
  assert.doesNotMatch(JSON.stringify(saved.studyGoals), /Assessment: Weekly evaluation/u);
  const beforeHash = vm.runInContext("courseSnapshotFingerprint('1', library['1'])", context);
  vm.runInContext("library['1'].assessments[0].evidence += ' | Due Date changed'", context);
  assert.notEqual(vm.runInContext("courseSnapshotFingerprint('1', library['1'])", context), beforeHash);
});

test('复习页将明确考核要求组织为可回查的 Assessment Workspace', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const assessment = assessmentEvidence({
    id: 'assessment:1:design-report', courseId: '1', title: 'Design report', weightingText: '35%', lengthText: '2000 words', dueText: 'Week 8', outcomesText: 'CLO 2',
    evidence: 'Assessment: Design report | Weighting: 35% | CLO 2', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment'
  });
  const mapped = { ...page('1', `This lecture is explicitly aligned to CLO 2. ${'Parametric modelling is defined as dimensions and constraints controlling geometry to preserve design intent. '.repeat(4)}`, 'Design intent'), id: 'mapped' };
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [mapped], files: [], assessments: [assessment] } },
    studyGoals: [studyGoal('1', today, { assessmentId: assessment.id, title: assessment.title })]
  });
  vm.runInContext("indexCourseKnowledge(library['1'], '1'); buildAssessmentPreparations(library['1'], '1'); renderAssessmentWorkspace()", context);
  const collect = element => [element.textContent, ...(element.children || []).flatMap(collect)].filter(Boolean).join(' ');
  assert.equal(get('#assessment-workspace').hidden, false);
  const text = collect(get('#assessment-workspace-content'));
  assert.match(text, /ASSESSMENT WORKSPACE.*Design report/u);
  assert.match(text, /权重.*35%.*时长.*2000 words.*截止.*Week 8.*CLO.*CLO 2/u);
  assert.match(text, /明确 CoverageLink.*只使用这些知识点.*未确认属于考核范围/u);
  assert.match(text, /查看 Moodle 要求.*开始 1 题短诊断/u);
});

test('Assessment Workspace 仅在 gate 通过后从最多三个 current KU 启动短诊断', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const assessment = assessmentEvidence({ id: 'assessment:1:diagnostic', courseId: '1', title: 'Diagnostic', outcomesText: 'CLO 2',
    evidence: 'Assessment: Diagnostic | CLO 2', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment' });
  const concepts = [
    ['Momentum', 2, 'Momentum is defined as mass multiplied by velocity.'],
    ['Kinetic energy', 2, 'Kinetic energy is defined as energy associated with motion.'],
    ['Thermodynamics', 1, 'Thermodynamics is defined as the study of heat and work.'],
    ['Manufacturing planning', 1, 'Manufacturing planning is defined as sequencing production operations.']
  ];
  const pages = concepts.map(([title, clo, definition], index) => ({ ...page('1', `This lecture is explicitly aligned to CLO ${clo}. ${`${definition} `.repeat(4)}`, title), id: `concept-${index + 1}` }));
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [], assessments: [assessment] } },
    studyGoals: [studyGoal('1', today, { assessmentId: assessment.id, title: assessment.title })] });
  vm.runInContext("indexCourseKnowledge(library['1'], '1'); buildAssessmentPreparations(library['1'], '1')", context);
  let generates = 0;
  context.fetch = async (url, options) => {
    assert.match(String(url), /practice\/generate$/u); generates++;
    return generatedPractice(options, 'diagnostic-session', [
      { id: 'q1', itemId: `practice:diagnostic-${generates}`, normalizedStemHash: `stem-${generates}`, variantKey: `explanation:understand:aspect-${generates}`, question: `诊断题 ${generates}` },
      { id: 'q2', question: '不应进入本 KU 诊断的第二题' }
    ]);
  };
  const scope = context.assessmentLearningScope('1', context.reviewPages('1'), context.activeExamGoal('1'));
  assert.equal(scope.gate.allowed, true);
  await context.startAssessmentDiagnostic(scope);
  assert.equal(vm.runInContext('practiceDiagnosticCards.length', context), 1);
  assert.deepEqual(Array.from(vm.runInContext('practiceDiagnosticCards', context), item => item.title), ['Momentum']);
  assert.equal(vm.runInContext('practiceQuestions.length', context), 1);
  assert.equal(generates, 1);
});

test('Assessment Workspace 在没有明确映射 KnowledgeUnit 时禁用短诊断并说明缺口', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const assessment = assessmentEvidence({ id: 'assessment:1:no-map', courseId: '1', title: 'No map', outcomesText: 'CLO 4',
    evidence: 'Assessment: No map | CLO 4', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment' });
  const unrelated = { ...page('1', 'This lecture is explicitly aligned to CLO 1. Unrelated topic. '.repeat(4), 'Unrelated'), id: 'unrelated' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [unrelated], files: [], assessments: [assessment] } },
    studyGoals: [studyGoal('1', today, { assessmentId: assessment.id, title: assessment.title })] });
  vm.runInContext("indexCourseKnowledge(library['1'], '1'); buildAssessmentPreparations(library['1'], '1'); renderAssessmentWorkspace()", context);
  const all = root => [root, ...(root.children || []).flatMap(all)];
  const content = get('#assessment-workspace-content');
  const button = all(content).find(item => item.tagName === 'button');
  const text = all(content).map(item => item.textContent).filter(Boolean).join(' ');
  assert.match(text, /没有同时满足 PreparationSnapshot gate 与明确 CoverageLink.*未确认属于考核范围/u);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '暂无可核验短诊断');
});

test('考核目标优先使用明确 CLO 映射但不把 CLO 误作完整考试边界', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const assessment = assessmentEvidence({
    id: 'assessment:1:design-report', courseId: '1', title: 'Design report', outcomesText: 'CLOs 2–3',
    evidence: 'Assessment: Design report | Aligned CLOs: CLOs 2–3', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment'
  });
  const home = { ...page('1', 'Assessment table says CLOs 2–3. '.repeat(4), 'Design report'), id: assessment.id, url: assessment.sourceUrl };
  const mapped = { ...page('1', 'This lecture is explicitly aligned to CLO 2. Parametric constraints preserve design intent. '.repeat(3), 'Parametric design'), id: 'mapped', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const outside = { ...page('1', 'This lecture is explicitly aligned to CLO 1. Manufacturing planning content. '.repeat(3), 'Manufacturing planning'), id: 'outside', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=3' };
  let generated;
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [home, mapped, outside], files: [], assessments: [assessment] } },
    studyPlanPreferences: { dailyMinutes: 180 }, studyGoals: [studyGoal('1', today, { assessmentId: assessment.id, title: assessment.title })],
    fetch: async (url, options) => {
      if (String(url).endsWith('/practice/generate')) {
        generated = JSON.parse(options.body);
        return generatedPractice(options, 'a'.repeat(32), [{ id: 'q1', question: 'What preserves design intent?' }]);
      }
      throw new Error('unexpected');
    }
  });
  vm.runInContext("buildAssessmentPreparations(library['1'], '1')", context);
  assert.deepEqual(Array.from(context.explicitCloRefs('This material maps to CLO 1, CLOs 2–3 and Course Learning Outcome 5')), [1, 2, 3, 5]);
  const scope = context.assessmentLearningScope('1', context.reviewPages('1'), context.activeExamGoal('1'));
  assert.equal(scope.strategy, 'clo-candidates');
  assert.deepEqual(Array.from(scope.pages, item => item.id), ['mapped', 'outside']);
  assert.deepEqual(Array.from(scope.mappedPages, item => item.id), ['mapped']);
  const queue = context.buildStudyQueue();
  assert.deepEqual(new Set(Array.from(queue.items, item => item.key)), new Set(['mapped', 'outside']));
  assert.equal(queue.items[0].key, 'mapped');
  assert.equal(queue.items[0].cloCandidate, true);
  assert.match(queue.items[0].reason, /CLO 2.*CLO 3.*不是完整考试边界/u);
  context.nextCard();
  await context.startPractice();
  assert.equal(generated.source.title, 'Parametric design');
  assert.equal(generated.objective, 'Design report · CLOs 2–3');
});

test('否定语境中的 CLO 不会被当作正向考核映射', async () => {
  const { context } = await setup();
  assert.deepEqual(Array.from(context.explicitCloRefs('This topic does not assess CLO 2. It aligns to CLO 3.')), [3]);
  assert.deepEqual(Array.from(context.explicitCloRefs('本节不涉及 CLO 4，但对应 CLO 5')), [5]);
  assert.deepEqual(Array.from(context.explicitCloRefs('CLO 2 is not assessed. CLO 3 is assessed.')), [3]);
  assert.deepEqual(Array.from(context.explicitCloRefs('No assessment of CLO 6. CLO 7 applies.')), [7]);
  assert.deepEqual(Array.from(context.explicitCloRefs('CLO 8 不考核。CLO 9 对应本节。')), [9]);
  assert.deepEqual(Array.from(context.explicitCloRefs('This assessment does not assess following CLO 2! Does the next task assess CLO 3?')), [3]);
  assert.deepEqual(Array.from(context.explicitCloRefs('The outline mentions CLO 1, while this assessment explicitly assesses CLO 2.')), [2]);
  assert.deepEqual(Array.from(context.explicitCloRefs('This assessment covers CLO 4, but the tutorial does not assess CLO 5.')), [4]);
});

test('CLO 仅在明确映射语境中成立，咨询、定义和罗列均不形成覆盖', async () => {
  const { context } = await setup();
  assert.deepEqual(Array.from(context.explicitCloRefs('For questions about CLO 2 please consult the course outline.')), []);
  assert.deepEqual(Array.from(context.explicitCloRefs('See the course outline for CLO 3.')), []);
  assert.deepEqual(Array.from(context.explicitCloRefs('CLO 4 means the fourth course learning outcome.')), []);
  assert.deepEqual(Array.from(context.explicitCloRefs('CLO 1, CLOs 2–3 and Course Learning Outcome 5')), []);
  assert.deepEqual(Array.from(context.explicitCloRefs('This lecture is explicitly mapped to CLO 2 and assesses CLO 3.')), [2, 3]);
  assert.deepEqual(Array.from(context.explicitCloRefs('本节明确对应 CLO 5，但不考核 CLO 6。')), [5]);
});

test('待复核或来源失效的考核目标关闭备考执行门且不返回 CLO 候选', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const assessment = { id: 'assessment:1:report', courseId: '1', title: 'Report', outcomesText: 'CLO 2', evidence: 'Report | CLO 2', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const mapped = { ...page('1', 'This lecture is explicitly mapped to CLO 2. '.repeat(4), 'Mapped'), id: 'mapped' };
  for (const state of [
    { goal: { assessmentNeedsRevalidation: true }, library: {} },
    { goal: {}, library: { assessmentStale: true } },
    { goal: {}, library: { assignmentBriefStale: true } }
  ]) {
    const goal = studyGoal('1', today, { assessmentId: assessment.id, title: assessment.title, ...state.goal });
    const { context } = await setup({ courses: [{ id: '1', title: 'One' }], studyGoals: [goal], library: { 1: {
      pages: [mapped], files: [], assessments: [assessment], ...state.library
    } } });
    const scope = context.assessmentLearningScope('1', context.reviewPages('1'), context.activeExamGoal('1'));
    assert.notEqual(scope.strategy, 'clo-candidates');
    assert.equal(scope.gate.allowed, false);
    assert.match(scope.gate.status, /blocked|needsReview/u);
    assert.equal(Array.isArray(scope.mappedPages), false);
  }
});

test('考核 CLO 无课程材料显式映射时执行门失败关闭且不按截止周猜测', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const assessment = assessmentEvidence({
    id: 'assessment:1:quiz', courseId: '1', title: 'Quiz', outcomesText: 'CLO 4', dueText: 'Week 7',
    evidence: 'Quiz | CLO 4 | Due Week 7', sourceUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1#assessment'
  });
  const weekSeven = { ...page('1', 'Week seven material without an outcome marker. '.repeat(4), 'Week 7 content'), id: 'w7', sectionGroup: 'Week 7' };
  const weekTwo = { ...page('1', 'Week two material without an outcome marker. '.repeat(4), 'Week 2 content'), id: 'w2', sectionGroup: 'Week 2', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [weekSeven, weekTwo], files: [], assessments: [assessment] } },
    studyPlanPreferences: { dailyMinutes: 180 }, studyGoals: [studyGoal('1', today, { assessmentId: assessment.id, title: assessment.title })]
  });
  vm.runInContext("buildAssessmentPreparations(library['1'], '1')", context);
  const scope = context.assessmentLearningScope('1', context.reviewPages('1'), context.activeExamGoal('1'));
  assert.equal(scope.strategy, 'needs-review');
  assert.equal(scope.gate.allowed, false);
  assert.deepEqual(Array.from(scope.pages, item => item.id), ['w7', 'w2']);
  const queue = context.buildStudyQueue();
  assert.deepEqual(new Set(Array.from(queue.items, item => item.key)), new Set(['w7', 'w2']));
  assert.equal(queue.items.some(item => item.cloCandidate), false);
  const strict = context.assessmentLearningScope('1', context.reviewPages('1', 'week:2'), {
    ...context.activeExamGoal('1'), scopeMode: 'sections', sectionKeys: ['week:7']
  });
  assert.equal(strict.strategy, 'needs-review');
  assert.equal(strict.pages.length, 0);
});

test('生产环境把四个旧根键迁移到当前账号物理空间并移除根键', async () => {
  const legacy = {
    courses: [{ id: '1', title: 'Legacy course' }],
    library: { 1: { pages: [page('1', 'Legacy content')], files: [] } },
    reviewProgress: { 1: { card: { rating: 'good' } } },
    semanticIndex: { 1: { model: 'qwen3-embedding:0.6b', records: {} } }
  };
  const { saved } = await setup({ rawStorage: legacy, runtimeId: 'production-extension-id', accountId: '12345' });
  for (const field of ['courses', 'library', 'reviewProgress', 'semanticIndex']) {
    assert.deepEqual(saved[`askme:v1:user:12345:${field}`], legacy[field]);
    assert.equal(Object.hasOwn(saved, field), false);
  }
  assert.deepEqual(saved['askme:v1:legacyMigration'], { userId: '12345', state: 'done' });
});

test('不同 Moodle 账号只读取各自的物理存储空间', async () => {
  const rawStorage = {
    'askme:v1:user:111:courses': [{ id: '1', title: 'Account A' }],
    'askme:v1:user:111:library': { 1: { pages: [page('1', 'A content')], files: [] } },
    'askme:v1:user:111:reviewProgress': { 1: { a: { rating: 'good' } } },
    'askme:v1:user:111:semanticIndex': { 1: { model: 'a-model', records: {} } },
    'askme:v1:user:222:courses': [{ id: '2', title: 'Account B' }],
    'askme:v1:user:222:library': { 2: { pages: [page('2', 'B content')], files: [] } },
    'askme:v1:user:222:reviewProgress': { 2: { b: { rating: 'easy' } } },
    'askme:v1:user:222:semanticIndex': { 2: { model: 'b-model', records: {} } }
  };
  const accountA = await setup({ rawStorage, runtimeId: 'production-extension-id', accountId: '111' });
  const accountB = await setup({ rawStorage, runtimeId: 'production-extension-id', accountId: '222' });
  assert.equal(vm.runInContext('courses[0].title', accountA.context), 'Account A');
  assert.equal(vm.runInContext("library['1'].pages[0].text", accountA.context), 'A content');
  assert.equal(vm.runInContext("library['2']", accountA.context), undefined);
  assert.equal(vm.runInContext('courses[0].title', accountB.context), 'Account B');
  assert.equal(vm.runInContext("library['2'].pages[0].text", accountB.context), 'B content');
  assert.equal(vm.runInContext("library['1']", accountB.context), undefined);
});

test('生产环境拒绝消息返回的 Moodle 账号与当前数据空间不一致', async () => {
  const { context } = await setup({
    rawStorage: {
      'askme:v1:user:111:courses': [],
      'askme:v1:user:111:library': {},
      'askme:v1:user:111:reviewProgress': {},
      'askme:v1:user:111:semanticIndex': {}
    },
    runtimeId: 'production-extension-id',
    accountId: '111'
  });
  context.chrome.tabs.sendMessage = async (_tab, message) => {
    assert.equal(message.expectedUserId, '111');
    return { ok: true, contentVersion: '2026.10.02.1', accountId: '222', courses: [] };
  };
  await assert.rejects(() => context.message('DISCOVER'), /Moodle 登录账号已变化/);
});

test('重建面板后首页可从同一账号存储精确恢复课程分节和正文卡片', async () => {
  const first = { ...page('1', 'First concept '.repeat(10), 'First'), id: 'first', sectionGroup: 'Week 1' };
  const target = { ...page('1', 'Target concept '.repeat(10), 'Target'), id: 'target', sectionGroup: 'Week 2', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const sharedStorage = {
    'askme:v1:user:123:courses': [{ id: '1', title: 'Physics' }],
    'askme:v1:user:123:library': { 1: { pages: [first, target], files: [] } },
    'askme:v1:user:123:reviewProgress': {},
    'askme:v1:user:123:semanticIndex': {},
    'askme:v1:user:123:learningSession': null
  };
  const firstVm = await setup({ sharedStorage, runtimeId: 'production-extension-id', accountId: '123' });
  firstVm.get('#review-course').value = '1';
  firstVm.context.renderSectionSelect('review-section', '1', false);
  firstVm.get('#review-section').value = 'week:2';
  firstVm.context.nextCard();
  await vm.runInContext('learningSessionWriteQueue', firstVm.context);
  assert.equal(sharedStorage['askme:v1:user:123:learningSession'].cardKey, learningKey(target));

  const rebuilt = await setup({ sharedStorage, runtimeId: 'production-extension-id', accountId: '123' });
  assert.equal(rebuilt.get('#start-today').textContent, '继续上次学习 →');
  await rebuilt.context.startToday();
  assert.equal(rebuilt.get('#review-course').value, '1');
  assert.equal(rebuilt.get('#review-section').value, 'week:2');
  assert.equal(rebuilt.get('#card').children[1].textContent, 'Target');
  assert.equal(vm.runInContext('activeCard.id', rebuilt.context), 'target');
});

test('首页行动按紧急截止、续学、薄弱点、普通复习和未来截止排序', async () => {
  const item = { ...page('1', 'Resume concept '.repeat(10), 'Resume'), id: 'resume' };
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [item], files: [] } },
    learningSession: storedSession('1', item)
  });
  const now = Date.now();
  const urgent = { id: 'urgent', courseId: '1', title: 'Urgent', timestampMs: now + 3_600_000 };
  const future = { id: 'future', courseId: '1', title: 'Future', timestampMs: now + 3 * 86_400_000 };
  const weak = { course: { id: '1' }, due: 1, weak: 1, targetCardKey: 'weak' };
  const regular = { course: { id: '1' }, due: 1, weak: 0, targetCardKey: 'regular' };
  assert.equal(context.selectNextAction({ deadlines: [urgent, future], candidates: [weak, regular] }, now).type, 'deadline');
  assert.equal(context.selectNextAction({ deadlines: [future], candidates: [weak, regular] }, now).type, 'resume');
  vm.runInContext('learningSession = null; learningSessionDesired = null', context);
  assert.equal(context.selectNextAction({ deadlines: [future], candidates: [weak, regular] }, now).targetCardKey, 'weak');
  assert.equal(context.selectNextAction({ deadlines: [future], candidates: [regular] }, now).targetCardKey, 'regular');
  assert.equal(context.selectNextAction({ deadlines: [future], candidates: [] }, now).event.id, 'future');
});

test('自测第二题重建后重新生成题目并只用最小断点恢复题号', async () => {
  const item = { ...page('1', 'Momentum concept '.repeat(10), 'Momentum'), id: 'momentum' };
  const sharedStorage = { courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [item], files: [] } }, reviewProgress: {}, semanticIndex: {}, learningSession: null };
  const firstVm = await setup({ sharedStorage });
  firstVm.context.nextCard();
  firstVm.context.fetch = async (_url, options) => generatedPractice(options, 'first-session', [
    { id: 'q1', question: 'First question?' }, { id: 'q2', question: 'Second question?' }, { id: 'q3', question: 'Third question?' }
  ]);
  await firstVm.context.startPractice();
  vm.runInContext('practiceSubmitted = true', firstVm.context);
  firstVm.context.nextPracticeQuestion();
  await vm.runInContext('learningSessionWriteQueue', firstVm.context);
  assert.deepEqual(Object.keys(sharedStorage.learningSession).sort(), ['cardKey', 'courseId', 'mode', 'practiceQuestionIndex', 'schemaVersion', 'sectionKey', 'updatedAt', 'view']);
  assert.equal(sharedStorage.learningSession.practiceQuestionIndex, 1);
  const serialized = JSON.stringify(sharedStorage.learningSession);
  for (const forbidden of ['studentAnswer', 'sessionId', 'questions', 'questionId', 'feedback', 'modelAnswer', 'sourceExcerpt', 'pageText']) assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));

  const rebuilt = await setup({ sharedStorage });
  let generated = 0;
  rebuilt.context.fetch = async (_url, options) => {
    generated++;
    return generatedPractice(options, 'new-session', [
      { id: 'n1', question: 'New first?' }, { id: 'n2', question: 'New second?' }, { id: 'n3', question: 'New third?' }
    ]);
  };
  await rebuilt.context.startToday();
  assert.equal(generated, 1);
  assert.equal(rebuilt.get('#practice-progress').textContent, '第 2 / 3 题');
  assert.equal(rebuilt.get('#practice-question').textContent, 'New second?');
});

test('正文变化、页面删除、课程取消和超过二十四小时都会清除续学断点', async () => {
  const original = { ...page('1', 'Original concept '.repeat(10), 'Original'), id: 'original' };
  const session = storedSession('1', original);
  const cases = [
    { name: '正文变化', courses: [{ id: '1', title: 'One' }], pages: [{ ...original, text: 'Changed concept '.repeat(10) }], session },
    { name: '页面删除', courses: [{ id: '1', title: 'One' }], pages: [], session },
    { name: '课程取消', courses: [{ id: '1', title: 'One', selected: false }], pages: [original], session },
    { name: '超过24h', courses: [{ id: '1', title: 'One' }], pages: [original], session: { ...session, updatedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() } }
  ];
  for (const scenario of cases) {
    const sharedStorage = { courses: scenario.courses, library: { 1: { pages: scenario.pages, files: [] } }, reviewProgress: {}, semanticIndex: {}, learningSession: scenario.session };
    const { context } = await setup({ sharedStorage });
    await vm.runInContext('learningSessionWriteQueue', context);
    assert.equal(sharedStorage.learningSession, null, scenario.name);
    assert.equal(context.learningResumeTarget(), null, scenario.name);
  }
});

test('清除课程索引时同时清除该课程续学断点', async () => {
  const item = { ...page('1', 'Course concept '.repeat(10), 'Course page'), id: 'course-page' };
  const sharedStorage = { courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } }, reviewProgress: {}, semanticIndex: {}, learningSession: storedSession('1', item) };
  const { context, get } = await setup({ sharedStorage });
  const findByClass = (root, className) => root?.className === className ? root : root?.children?.map(child => findByClass(child, className)).find(Boolean);
  const clear = findByClass(get('#library-details'), 'clear-library');
  assert.ok(clear);
  await clear.listeners.click();
  await vm.runInContext('learningSessionWriteQueue', context);
  assert.equal(sharedStorage.library['1'], undefined);
  assert.equal(sharedStorage.learningSession, null);
});

test('续学断点写入失败时保留旧内存与旧存储且不声称保存成功', async () => {
  const oldPage = { ...page('1', 'Old concept '.repeat(10), 'Old'), id: 'old' };
  const newPage = { ...page('1', 'New concept '.repeat(10), 'New'), id: 'new', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const oldSession = storedSession('1', oldPage);
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [oldPage, newPage], files: [] } }, learningSession: oldSession });
  context.chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
  context.nextCard(false, 'new');
  await vm.runInContext('learningSessionWriteQueue', context);
  assert.deepEqual(saved.learningSession, oldSession);
  assert.equal(vm.runInContext('learningSession.cardKey', context), oldSession.cardKey);
  assert.doesNotMatch(get('#status').textContent, /已保存|保存成功/);
});

test('检索摘录从正文匹配位置取材，且拒绝站外来源', async () => {
  const { context } = await setup({ courses: [{ id: '1', title: 'Course 1' }], library: { 1: { pages: [page('1', '前文'.repeat(300) + '核心概念在这里，便于复习。', '核心概念')] , files: [] } } });
  const found = context.rank('核心概念', '1');
  assert.equal(found.length, 1);
  assert.match(found[0].excerpt, /核心概念在这里/);
  assert.equal(context.safeLink('https://evil.example/course'), null);
  assert.equal(context.safeLink('https://user:pass@moodle.telt.unsw.edu.au/course/view.php?id=1'), null);
});

test('一门同步失败后继续下一门，且保留失败课程原索引', async () => {
  const courses = [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }];
  const old = { pages: [page('1', 'old content')], files: [] };
  const { context, saved, get } = await setup({ courses, library: { 1: old } });
  context.message = async (_type, { course }) => {
    if (course.id === '1') throw new Error('页面访问失败');
    return { data: { pages: [page('2', 'new content')], files: [], errors: [], skippedPages: 0, truncatedPages: 0 } };
  };
  await context.sync();
  assert.equal(saved.library['1'].pages[0].text, 'old content');
  assert.equal(saved.library['2'].pages[0].text, 'new content');
  assert.match(get('#status').textContent, /1\/2/);
  assert.match(get('#status').textContent, /页面访问失败/);
});

test('Moodle 跳回课程首页的活动显示为暂不可访问', async () => {
  const { context, get, saved } = await setup({ courses: [{ id: '1', title: 'MANF9543' }] });
  context.message = async () => ({ data: { pages: [page('1', 'Lecture text')], files: [], errors: [], unavailableActivities: [{ title: 'Future folder', url: 'https://moodle.telt.unsw.edu.au/mod/folder/view.php?id=7', section: 'Week 7' }] } });
  await context.sync();
  assert.equal(saved.library['1'].unavailableActivities.length, 1);
  assert.match(get('#status').textContent, /暂不可访问 1 项/);
});

test('本地存储满时保留旧索引并给出清理提示', async () => {
  const old = { pages: [page('1', 'old content')], files: [] };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: old } });
  context.message = async () => ({ data: { pages: [page('1', 'new content')], files: [], errors: [] } });
  context.chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
  await context.sync();
  assert.equal(saved.library['1'].pages[0].text, 'old content');
  assert.match(get('#status').textContent, /QUOTA_BYTES exceeded/);
  assert.match(get('#status').textContent, /无法保存刷新批次/);
});

test('复习卡片轮换，切换课程后重置为新课程第一页', async () => {
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: {
      1: { pages: [page('1', 'A'.repeat(90), 'A'), page('1', 'B'.repeat(90), 'B')], files: [] },
      2: { pages: [page('2', 'C'.repeat(90), 'C')], files: [] }
    }
  });
  context.nextCard();
  assert.equal(get('#card').children[1].textContent, 'A');
  context.nextCard();
  assert.equal(get('#card').children[1].textContent, 'B');
  get('#review-course').value = '2';
  get('#review-course').listeners.change();
  assert.equal(get('#card').children[1].textContent, 'C');
  assert.equal(get('#study-output').hidden, true);
});

test('有可回查知识单元时复习、自测与排程优先使用稳定知识点而非整页', async () => {
  const source = { ...page('1', 'Parametric modelling source text '.repeat(5), 'Lecture page'), id: 'p1' };
  const unit = {
    schemaVersion: 2, coverageSchemaVersion: 1, id: 'ku:parametric', courseId: '1', label: 'Parametric modelling', description: 'Dimensions and constraints control geometry.',
    contentHash: 'unit-version-1', kinds: ['definition'],
    evidence: [{ segmentId: 'seg:p1:0', sourceVersion: 'source-v1', charStart: 0, charEnd: 79, pageId: 'p1', url: source.url, quote: 'Parametric modelling uses dimensions and constraints to preserve design intent.', headingPath: ['Week 1'] }],
    coveredRanges: [{ pageId: 'p1', segmentId: 'seg:p1:0', start: 0, end: 79 }]
  };
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [source], files: [], knowledgeUnitSchemaVersion: 2, knowledgeUnits: [unit] } }
  });
  context.nextCard();
  assert.equal(get('#card').children[1].textContent, 'Parametric modelling');
  assert.equal(vm.runInContext('activeCard.knowledgeUnit', context), true);
  assert.equal(vm.runInContext('cardKey(activeCard)', context), 'ku:parametric');
  assert.equal(vm.runInContext('reviewContentHash(activeCard)', context), 'unit-version-1');
  assert.match(get('#card').children[2].textContent, /解释“Parametric modelling”/u);
  vm.runInContext("library['1'].knowledgeUnits[0].sourceSegmentIds = [semanticSegments(library['1'], '1').segments[0].id]", context);
  assert.equal(vm.runInContext("knowledgeUnitRank('Parametric modelling', '1', '', semanticSegments(library['1'], '1').segments).length", context), 1);
  get('#ask-course').value = '1';
  get('#ask-section').value = '';
  context.renderPromptSuggestions();
  assert.match(get('#prompt-suggestion-buttons').children.map(item => item.textContent).join(' '), /Parametric modelling/u);
});

test('部分页面已提炼知识单元时仍保留其他未提炼页面进入学习队列', async () => {
  const covered = { ...page('1', 'Covered source text '.repeat(8), 'Covered lecture'), id: 'p1' };
  const fallback = { ...page('1', 'Unparsed but still important source text '.repeat(8), 'Unparsed lecture'), id: 'p2', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=22' };
  const unit = {
    schemaVersion: 2, coverageSchemaVersion: 1, id: 'ku:covered', courseId: '1', label: 'Covered concept', description: 'A grounded concept description.',
    contentHash: 'unit-version-1', kinds: ['definition'],
    evidence: [{ segmentId: 'seg:p1:0', sourceVersion: 'source-v1', charStart: 0, charEnd: 59, pageId: 'p1', url: covered.url, quote: 'Covered source text provides the evidence for this concept.', headingPath: ['Week 1'] }],
    coveredRanges: [{ pageId: 'p1', segmentId: 'seg:p1:0', start: 0, end: 59 }]
  };
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [covered, fallback], files: [], knowledgeUnitSchemaVersion: 2, knowledgeUnits: [unit] } }
  });
  const cards = context.reviewPages('1');
  assert.deepEqual(JSON.parse(JSON.stringify(cards.map(item => item.title))), ['Covered concept', 'Covered lecture · 未覆盖片段', 'Unparsed lecture']);
});

test('同一页面有知识单元时仍生成未覆盖条件与步骤的残余卡片', async () => {
  const source = { ...page('1', 'Feed rate is defined as travel per revolution. Use 0.5 mm only for stable cutting. Step 1.2 requires coolant. '.repeat(2), 'Feed rate lecture'), id: 'p1' };
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [source], files: [] } } });
  const snapshot = vm.runInContext('library["1"]', context);
  context.indexCourseKnowledge(snapshot, '1');
  const cards = context.reviewPages('1');
  assert.equal(cards.some(item => item.knowledgeUnit), true);
  const residual = cards.filter(item => item.residualLearningSpan);
  assert.equal(residual.length > 0, true);
  assert.match(residual.map(item => item.text).join(' '), /0\.5 mm.*Step 1\.2/u);
  assert.equal(cards.some(item => item.title === 'Feed rate lecture' && !item.residualLearningSpan), false);
});

test('知识单元不可用时复习继续回退到原页面卡片', async () => {
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Fallback page '.repeat(10), 'Fallback')], files: [], knowledgeUnits: [] } } });
  context.nextCard();
  assert.equal(get('#card').children[1].textContent, 'Fallback');
  assert.equal(vm.runInContext('Boolean(activeCard.knowledgeUnit)', context), false);
});

test('重新同步同一课程会清除旧答案并换用新卡片', async () => {
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [page('1', 'O'.repeat(90), 'Old')], files: [] } }
  });
  context.nextCard();
  get('#answer').textContent = '旧答案'; get('#answer').hidden = false;
  get('#sources').append(new Element('a'));
  context.message = async () => ({ data: { pages: [page('1', 'N'.repeat(90), 'New')], files: [], errors: [] } });
  await context.sync();
  assert.equal(get('#answer').hidden, true);
  assert.equal(get('#sources').children.length, 0);
  assert.equal(get('#card').children[1].textContent, 'New');
});

test('检索拒绝损坏索引中的跨课程页面', async () => {
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('2', '惯性概念')], files: [] } } });
  assert.equal(context.rank('惯性', '1').length, 0);
});

test('同步课程时将本机提取的 PDF 页面并入索引', async () => {
  const file = { title: 'Lecture PDF', url: 'https://moodle.telt.unsw.edu.au/mod/resource/view.php?id=7', section: 'Week 1' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }] });
  context.chrome.tabs.sendMessage = async (_tab, message) => message.type === 'PING'
    ? { ok: true, contentVersion: '2026.10.02.1' }
    : message.type === 'SYNC_COURSE'
      ? { ok: true, contentVersion: '2026.10.02.1', data: { pages: [page('1', 'HTML text')], files: [file], errors: [], skippedPages: 0, truncatedPages: 0 } }
      : { ok: true, contentVersion: '2026.10.02.1', data: { base64: 'ZmFrZQ==', mime: 'application/pdf' } };
  context.fetch = async url => String(url).includes('/health')
    ? { ok: true, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) }
    : { ok: true, json: async () => ({ pages: [page('1', 'PDF concept', 'Lecture page 1')], kind: 'pdf', truncatedParts: 0, skippedParts: 0, emptyParts: 0 }) };
  await context.sync();
  assert.equal(saved.library['1'].pages.length, 2);
  assert.equal(saved.library['1'].files[0].indexStatus, 'indexed');
  assert.equal(saved.library['1'].indexedFiles, 1);
});

test('本机文件服务离线重同步时保留同一文件的全部上次成功正文页', async () => {
  const fileUrl = 'https://moodle.telt.unsw.edu.au/mod/resource/view.php?id=7';
  const oldFilePages = [1, 2].map(partNumber => ({
    ...page('1', `PDF retained part ${partNumber} `.repeat(12), `Lecture PDF · page ${partNumber}`),
    id: `${fileUrl}#part=${partNumber}`, url: fileUrl, sourceType: 'file', partNumber,
    syncedAt: '2026-09-24T00:00:00.000Z'
  }));
  const oldFile = { title: 'Lecture PDF', url: fileUrl, section: 'Week 1', indexStatus: 'indexed', indexedParts: 2 };
  const { context, saved, get } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [page('1', 'Old HTML'), ...oldFilePages], files: [oldFile], syncedAt: '2026-09-24T00:00:00.000Z' } }
  });
  context.message = async () => ({ data: { pages: [page('1', 'Fresh HTML')], files: [{ ...oldFile, indexStatus: 'linked' }], errors: [] } });
  context.fetch = async () => { throw new TypeError('connection refused'); };
  await context.sync();
  const retained = saved.library['1'].pages.filter(item => item.sourceType === 'file');
  assert.equal(retained.length, 2);
  assert.deepEqual(retained.map(item => item.partNumber), [1, 2]);
  assert.equal(retained.every(item => item.sourceStale && item.sourceStaleReason === 'local-service-offline'), true);
  assert.equal(saved.library['1'].preservedFilePages, 2);
  assert.equal(saved.library['1'].files[0].lastGoodIndexedParts, 2);
  assert.match(saved.library['1'].fileIndexStatus, /已保留上次成功解析的 2 页/u);
  assert.match(get('#status').textContent, /已保留上次成功解析的 2 页/u);
});

test('在线文件仅部分解析时保留缺失旧页但不让旧页参与知识与语义索引', async () => {
  const fileUrl = 'https://moodle.telt.unsw.edu.au/mod/resource/view.php?id=17';
  const oldPages = [1, 2].map(partNumber => ({
    ...page('1', partNumber === 2 ? 'STALE_SECRET_SHOULD_NOT_BE_INDEXED '.repeat(8) : 'Old first page '.repeat(8), `Old PDF page ${partNumber}`),
    id: `${fileUrl}#part=${partNumber}`, url: `${fileUrl}#page=${partNumber}`, sourceType: 'file', partNumber
  }));
  const file = { title: 'Lecture PDF', url: fileUrl, section: 'Week 1', indexStatus: 'indexed', indexedParts: 2 };
  const freshFilePage = {
    ...page('1', 'Fresh first PDF page explains parametric modelling and design intent. '.repeat(5), 'Fresh PDF page 1'),
    id: `${fileUrl}#part=1`, url: `${fileUrl}#page=1`, sourceType: 'file', partNumber: 1
  };
  const { context, saved } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [page('1', 'Old HTML'), ...oldPages], files: [file] } }
  });
  context.chrome.tabs.sendMessage = async (_tab, message) => message.type === 'PING'
    ? { ok: true, contentVersion: '2026.10.02.1' }
    : message.type === 'SYNC_COURSE'
      ? { ok: true, contentVersion: '2026.10.02.1', data: { pages: [page('1', 'Fresh HTML content '.repeat(8))], files: [{ ...file, indexStatus: 'linked' }], errors: [] } }
      : { ok: true, contentVersion: '2026.10.02.1', data: { base64: 'ZmFrZQ==', mime: 'application/pdf' } };
  context.fetch = async (url, options) => {
    if (String(url).includes('/health')) return { ok: true, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) };
    if (String(url).endsWith('/extract')) return { ok: true, json: async () => ({ pages: [freshFilePage], kind: 'pdf', totalParts: 2, skippedParts: 1, emptyParts: 0, truncatedParts: 0 }) };
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: 'qwen3-embedding:0.6b', dimensions: 1024, vectors: body.texts.map(() => Buffer.from([127, ...Array(1023).fill(0)]).toString('base64')) }) };
  };
  await context.sync();
  const snapshot = saved.library['1'];
  assert.equal(snapshot.files[0].indexStatus, 'partial');
  assert.equal(snapshot.pages.filter(item => item.sourceType === 'file').length, 2);
  const stale = snapshot.pages.find(item => item.partNumber === 2);
  assert.equal(stale.sourceStale, true);
  assert.equal(JSON.stringify(snapshot.knowledgeUnits || []).includes('STALE_SECRET_SHOULD_NOT_BE_INDEXED'), false);
  assert.equal(JSON.stringify(context.semanticSegments(snapshot, '1')).includes('STALE_SECRET_SHOULD_NOT_BE_INDEXED'), false);
  assert.equal(context.pagesForScope('1').some(item => item.sourceStale), false);
});

test('SolidWorks 文件保留 Moodle 链接且不发送到文档解析器', async () => {
  const cad = { title: 'Air Engine - Base Plate.SLDPRT', url: 'https://moodle.telt.unsw.edu.au/pluginfile.php/12/Air%20Engine%20-%20Base%20Plate.SLDPRT' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'MANF9543' }] });
  let fetched = false;
  context.chrome.tabs.sendMessage = async (_tab, message) => {
    if (message.type === 'PING') return { ok: true, contentVersion: '2026.10.02.1' };
    if (message.type === 'SYNC_COURSE') return { ok: true, contentVersion: '2026.10.02.1', data: { pages: [page('1', 'Lecture content')], files: [cad], errors: [] } };
    fetched = true;
    return { ok: true, contentVersion: '2026.10.02.1', data: { base64: 'ZmFrZQ==', mime: 'application/octet-stream' } };
  };
  context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) });
  await context.sync();
  assert.equal(fetched, false);
  assert.equal(saved.library['1'].files[0].indexStatus, 'unsupported');
  assert.equal(saved.library['1'].skippedFiles, 1);
});

test('中文问题在本地翻译后可检索英文讲义，答案仍使用原问题', async () => {
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'Physics' }],
    library: { 1: { pages: [page('1', 'Newton motion and force are related.', 'Lecture')], files: [] } }
  });
  get('#question').value = '牛顿运动定律是什么？';
  let sent;
  context.fetch = async (url, options) => {
    if (String(url).endsWith('/translate')) return { ok: true, json: async () => ({ terms: ['Newton motion'] }) };
    sent = JSON.parse(options.body);
    return { status: 200, ok: true, json: async () => ({ answer: '根据讲义，力与运动相关。[1]' }) };
  };
  await context.ask();
  assert.equal(sent.question, '牛顿运动定律是什么？');
  assert.equal(sent.sources.length, 1);
  assert.match(get('#answer').textContent, /力与运动相关/);
  assert.equal(get('#sources').children.length, 1);
});

test('截止问题把同课程精确 due 事件固定为来源一且不被 Examples 页面顶掉', async () => {
  const due = calendarEvent('1', '26T3 Assignment Task 1 - Submission is due', 'due', Date.parse('2026-10-02T17:00:00+10:00'),
    'Friday, 2 October 2026 17:00 26T3 Assignment Task 1 - Submission is due.');
  const taskTwo = calendarEvent('1', '26T3 Assignment Task 2 - Submission is due', 'due', Date.parse('2026-10-09T17:00:00+11:00'),
    'Friday, 9 October 2026 17:00 26T3 Assignment Task 2 - Submission is due.', { activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=102' });
  const examples = page('1', 'Assignment 1 Examples demonstrate project scheduling. '.repeat(8), 'Assignment 1 Examples');
  const { context, get } = await setup({ courses: [{ id: '1', title: 'GSOE9820' }], library: { 1: { pages: [examples], files: [], events: [due, taskTwo] } } });
  get('#question').value = '根据课程资料，26T3 Assignment Task 1 的截止日期和时间是什么？';
  let request;
  context.fetch = async (url, options) => {
    if (!String(url).endsWith('/answer')) throw new Error('unexpected');
    request = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ answer: '截止时间是 2026 年 10 月 2 日 17:00。[1]' }) };
  };
  await context.ask();
  assert.equal(request.sources[0].title, due.title);
  assert.equal(request.sources[0].excerpt, due.evidence.normalizedText);
  assert.equal(request.sources.some(source => source.title === taskTwo.title), false);
  assert.equal(request.sources.some(source => source.title === 'Assignment 1 Examples'), true);
  const sourceDisclosure = get('#sources').children[0];
  const sourceBox = sourceDisclosure.children.find(child => child.tagName === 'div');
  assert.equal(sourceBox.children.find(child => child.tagName === 'a').textContent, due.title);
});

test('旧快照缺少 events 时截止提问轻量刷新并把事件送入 answer 请求', async () => {
  const courseId = '101609';
  const evidence = 'Friday, 2 October 2026 17:00 26T3 Assignment Task 1 - Submission is due.';
  const due = calendarEvent(courseId, '26T3 Assignment Task 1 - Submission is due', 'due', 1790924400000, evidence,
    { activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=456' });
  const examples = page(courseId, 'Assignment 1 Examples demonstrate project scheduling. '.repeat(8), 'Assignment 1 Examples');
  const { context, get, saved } = await setup({
    courses: [{ id: courseId, title: 'GSOE9820 - Engineering Project Management - 2026 T3', url: `https://moodle.telt.unsw.edu.au/course/view.php?id=${courseId}` }],
    library: { [courseId]: { pages: [examples], files: [], events: [] } }
  });
  let refreshes = 0;
  context.message = async (type, { course }) => {
    assert.equal(type, 'SYNC_COURSE_EVENTS');
    assert.equal(course.id, courseId);
    refreshes++;
    return { data: { events: [due] } };
  };
  let request;
  context.fetch = async (url, options) => {
    if (!String(url).endsWith('/answer')) throw new Error('unexpected');
    request = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ answer: '26T3 Assignment Task 1 的截止时间是 2026 年 10 月 2 日（星期五）17:00。[1]' }) };
  };
  get('#question').value = '根据课程资料，26T3 Assignment Task 1 的截止日期和时间是什么？';
  await context.ask();
  assert.equal(refreshes, 1);
  assert.equal(saved.library[courseId].events[0].sourceVersion, due.sourceVersion);
  assert.equal(request.sources[0].title, due.title);
  assert.equal(request.sources[0].excerpt, evidence);
  assert.equal(request.sources.some(source => source.title === 'Assignment 1 Examples'), true);
});

test('截止事项轻量刷新失败时保留旧快照且不把不相关页面送入 answer', async () => {
  const courseId = '101609';
  const old = calendarEvent(courseId, '26T3 Assignment Task 2 - Submission is due', 'due', 1791529200000,
    'Friday, 9 October 2026 17:00 26T3 Assignment Task 2 - Submission is due.',
    { activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=457' });
  const examples = page(courseId, 'Assignment 1 Examples demonstrate project scheduling. '.repeat(8), 'Assignment 1 Examples');
  const { context, get, saved } = await setup({
    courses: [{ id: courseId, title: 'GSOE9820', url: `https://moodle.telt.unsw.edu.au/course/view.php?id=${courseId}` }],
    library: { [courseId]: { pages: [examples], files: [], events: [old] } }
  });
  context.message = async () => { throw new Error('Moodle 日历暂时无法读取'); };
  let answerCalls = 0;
  context.fetch = async () => { answerCalls++; throw new Error('不应请求 answer'); };
  get('#question').value = '根据课程资料，26T3 Assignment Task 1 的截止日期和时间是什么？';
  await context.ask();
  assert.equal(answerCalls, 0);
  assert.equal(saved.library[courseId].events[0].id, old.id);
  assert.equal(get('#sources').children.length, 0);
  assert.match(get('#answer').textContent, /未能核对 Moodle 日历：Moodle 日历暂时无法读取.*已保留上次成功/u);
});

test('截止事项轻量刷新返回空 events 时失败关闭并保留旧快照', async () => {
  const courseId = '101609';
  const old = calendarEvent(courseId, '26T3 Assignment Task 2 - Submission is due', 'due', 1791529200000,
    'Friday, 9 October 2026 17:00 26T3 Assignment Task 2 - Submission is due.',
    { activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=457' });
  const examples = page(courseId, 'Assignment 1 Examples demonstrate project scheduling. '.repeat(8), 'Assignment 1 Examples');
  const { context, get, saved } = await setup({
    courses: [{ id: courseId, title: 'GSOE9820', url: `https://moodle.telt.unsw.edu.au/course/view.php?id=${courseId}` }],
    library: { [courseId]: { pages: [examples], files: [], events: [old] } }
  });
  let refreshes = 0, answerCalls = 0;
  context.message = async type => { assert.equal(type, 'SYNC_COURSE_EVENTS'); refreshes++; return { data: { events: [] } }; };
  context.fetch = async () => { answerCalls++; throw new Error('不应请求 answer'); };
  get('#question').value = '26T3 Assignment Task 1 due date and time?';
  await context.ask();
  assert.equal(refreshes, 1);
  assert.equal(answerCalls, 0);
  assert.equal(saved.library[courseId].events[0].id, old.id);
  assert.equal(get('#sources').children.length, 0);
  assert.match(get('#answer').textContent, /Moodle 日历中未找到.*精确匹配/u);
});

test('截止事项轻量刷新只返回非匹配事项时失败关闭并保留旧快照', async () => {
  const courseId = '101609';
  const old = calendarEvent(courseId, '26T3 Assignment Task 2 - Submission is due', 'due', 1791529200000,
    'Friday, 9 October 2026 17:00 26T3 Assignment Task 2 - Submission is due.',
    { activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=457' });
  const refreshedButUnrelated = calendarEvent(courseId, '26T3 Assignment Task 3 - Submission is due', 'due', 1792134000000,
    'Friday, 16 October 2026 17:00 26T3 Assignment Task 3 - Submission is due.',
    { activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=458' });
  const examples = page(courseId, 'Assignment 1 Examples demonstrate project scheduling. '.repeat(8), 'Assignment 1 Examples');
  const { context, get, saved } = await setup({
    courses: [{ id: courseId, title: 'GSOE9820', url: `https://moodle.telt.unsw.edu.au/course/view.php?id=${courseId}` }],
    library: { [courseId]: { pages: [examples], files: [], events: [old] } }
  });
  let answerCalls = 0;
  context.message = async () => ({ data: { events: [refreshedButUnrelated] } });
  context.fetch = async () => { answerCalls++; throw new Error('不应请求 answer'); };
  get('#question').value = '26T3 Assignment Task 1 什么时候截止？';
  await context.ask();
  assert.equal(answerCalls, 0);
  assert.equal(saved.library[courseId].events[0].id, old.id);
  assert.equal(saved.library[courseId].events.some(event => event.id === refreshedButUnrelated.id), false);
  assert.equal(get('#sources').children.length, 0);
  assert.match(get('#answer').textContent, /Moodle 日历中未找到.*精确匹配/u);
});

test('事件检索精确区分 Task 1 与 Task 2，并按 due、open、close 意图隔离', async () => {
  const taskOneDue = calendarEvent('1', 'Assignment Task 1 - Submission is due', 'due', 1, 'Friday, 2 October 2026 17:00 Assignment Task 1 - Submission is due.');
  const taskOneOpen = calendarEvent('1', 'Assignment Task 1 opens', 'open', 2, 'Monday, 1 September 2026 09:00 Assignment Task 1 opens.');
  const taskOneClose = calendarEvent('1', 'Assignment Task 1 closes', 'close', 3, 'Friday, 2 October 2026 17:30 Assignment Task 1 closes.');
  const taskTwoDue = calendarEvent('1', 'Assignment Task 2 - Submission is due', 'due', 4, 'Friday, 9 October 2026 17:00 Assignment Task 2 - Submission is due.');
  const otherCourse = calendarEvent('2', 'Assignment Task 1 - Submission is due', 'due', 5, 'Friday, 30 October 2026 17:00 Assignment Task 1 - Submission is due.');
  const unsafe = calendarEvent('1', 'Assignment Task 1 - Submission is due', 'due', 6, 'Friday, 6 November 2026 17:00 Assignment Task 1 - Submission is due.', { activityUrl: 'https://evil.example/mod/assign/view.php?id=1' });
  const legacy = { ...taskOneDue, id: 'legacy', evidence: undefined, sourceVersion: undefined };
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }], library: { 1: { pages: [], files: [], events: [taskOneDue, taskOneOpen, taskOneClose, taskTwoDue, otherCourse, unsafe, legacy] } } });
  assert.deepEqual(Array.from(context.deadlineEventSources('Assignment Task 1 的截止日期和时间是什么？', '1'), item => item.eventType), ['due']);
  assert.deepEqual(Array.from(context.deadlineEventSources('Assignment Task 1 什么时候开放？', '1'), item => item.eventType), ['open']);
  assert.deepEqual(Array.from(context.deadlineEventSources('When does Assignment Task 1 close?', '1'), item => item.eventType), ['close']);
  assert.deepEqual(Array.from(context.deadlineEventSources('Assignment Task 2 due time?', '1'), item => item.title), [taskTwoDue.title]);
  assert.equal(context.deadlineEventSources('Assignment Task 1 的要求是什么？', '1').length, 0);
});

test('同一主体多个冲突 due 事件全部进入来源且保持排在普通页面前', async () => {
  const first = calendarEvent('1', 'Assignment Task 1 - Submission is due', 'due', 1, 'Friday, 2 October 2026 17:00 Assignment Task 1 - Submission is due.');
  const second = calendarEvent('1', 'Assignment Task 1 - Submission is due', 'due', 2, 'Monday, 5 October 2026 17:00 Assignment Task 1 - Submission is due.', { activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=102' });
  const lecture = page('1', 'Assignment Task 1 guidance and examples. '.repeat(8), 'Assignment guidance');
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [lecture], files: [], events: [second, first] } } });
  get('#question').value = 'Assignment Task 1 的截止日期和时间是什么？';
  let request;
  context.fetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ answer: '存在冲突。[1][2]' }) }; };
  await context.ask();
  assert.deepEqual(request.sources.slice(0, 2).map(source => source.excerpt), [first.evidence.normalizedText, second.evidence.normalizedText]);
  assert.equal(request.sources[2].title, lecture.title);
});

test('同一课程连续提问会带上历史并将新回答保存到该课程对话', async () => {
  const previous = [
    { role: 'user', text: '什么是惯性？', createdAt: '2026-09-23T00:00:00.000Z', sources: [] },
    { role: 'assistant', text: '惯性是物体保持运动状态的性质。[1]', createdAt: '2026-09-23T00:00:01.000Z', sources: [] }
  ];
  const { context, get, saved } = await setup({
    courses: [{ id: '1', title: 'Physics' }],
    library: { 1: { pages: [page('1', 'Inertia and mass describe resistance to changes in motion. '.repeat(4), 'Lecture')], files: [] } },
    chatHistory: { 1: previous }
  });
  get('#question').value = 'Inertia 和 mass 有什么关系？';
  let request;
  context.fetch = async (url, options) => {
    if (!String(url).endsWith('/answer')) throw new Error('semantic offline');
    request = JSON.parse(options.body);
    return { status: 200, ok: true, json: async () => ({ answer: '质量越大，改变运动状态越困难。[1]' }) };
  };
  await context.ask();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(request.history)), previous.map(item => ({ role: item.role, content: item.text })));
  assert.equal(saved.chatHistory['1'].at(-2).text, 'Inertia 和 mass 有什么关系？');
  assert.equal(saved.chatHistory['1'].at(-1).text, '质量越大，改变运动状态越困难。[1]');
  assert.match(get('#answer').textContent, /质量越大/);
});

test('每门课程可新建和切换持久会话，旧会话内容仍可继续追问', async () => {
  const first = [
    { role: 'user', text: '什么是惯性？', createdAt: '2026-09-23T00:00:00.000Z', sources: [] },
    { role: 'assistant', text: '惯性描述保持运动状态的性质。', createdAt: '2026-09-23T00:00:01.000Z', sources: [] }
  ];
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'Physics' }], chatHistory: { 1: first } });
  const firstId = vm.runInContext("chatSessions['1'].activeId", context);
  get('#ask-course').value = '1';
  await context.newChatConversation();
  const secondId = vm.runInContext("chatSessions['1'].activeId", context);
  assert.notEqual(secondId, firstId);
  await context.appendChatMessage('1', { role: 'user', text: '继续讲质量', createdAt: '2026-09-23T01:00:00.000Z', sources: [] });
  assert.equal(saved.chatSessions['1'].sessions.length, 2);
  await context.selectChatSession('1', firstId);
  assert.equal(get('#chat-session-title').textContent, '什么是惯性？');
  assert.equal(saved.chatHistory['1'][0].text, '什么是惯性？');
});

test('提问输入框仅用 Enter 提交，Shift+Enter 和 IME Enter 保留输入', async () => {
  const enter = await setup({
    courses: [{ id: '1', title: 'Physics' }],
    library: { 1: { pages: [page('1', 'Momentum changes with force.', 'Lecture')], files: [] } }
  });
  let answerCalls = 0;
  enter.context.fetch = async url => {
    if (String(url).endsWith('/answer')) {
      answerCalls++;
      return { ok: true, status: 200, json: async () => ({ answer: 'Momentum answer' }) };
    }
    throw new Error('unexpected fetch');
  };
  enter.get('#question').value = 'What is momentum?';
  let prevented = false;
  await enter.get('#question').listeners.keydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(answerCalls, 1);

  const shifted = await setup({ courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [page('1', 'Momentum changes with force.', 'Lecture')], files: [] } } });
  let shiftPrevented = false;
  shifted.get('#question').value = 'line one';
  await shifted.get('#question').listeners.keydown({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13, preventDefault() { shiftPrevented = true; } });
  assert.equal(shiftPrevented, false);
  assert.equal(shifted.get('#question').value, 'line one');

  for (const event of [
    { key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 },
    { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }
  ]) {
    const ime = await setup({ courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [page('1', 'Momentum changes with force.', 'Lecture')], files: [] } } });
    let imePrevented = false;
    ime.get('#question').value = '输入中的问题';
    await ime.get('#question').listeners.keydown({ ...event, preventDefault() { imePrevented = true; } });
    assert.equal(imePrevented, false);
    assert.equal(ime.get('#question').value, '输入中的问题');
  }
});

test('回答失败时恢复原问题但不覆盖等待期间的新草稿', async () => {
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'Physics' }],
    library: { 1: { pages: [page('1', 'Momentum changes with force.', 'Lecture')], files: [] } }
  });
  let answerStarted;
  const started = new Promise(resolve => { answerStarted = resolve; });
  context.fetch = async url => {
    if (String(url).endsWith('/answer')) {
      answerStarted();
      return { ok: false, status: 503, json: async () => ({}) };
    }
    throw new Error('unexpected fetch');
  };
  get('#question').value = 'What is momentum?';
  const pending = context.ask();
  await started;
  get('#question').value = '等待期间的新草稿';
  await pending;
  assert.equal(get('#question').value, '等待期间的新草稿');
});

test('删除当前会话期间完成的旧回答不会写回新会话', async () => {
  const { context, get, saved } = await setup({
    courses: [{ id: '1', title: 'Physics' }],
    library: { 1: { pages: [page('1', 'Momentum changes with force.', 'Lecture')], files: [] } }
  });
  let answerResolve;
  let answerStarted;
  const started = new Promise(resolve => { answerStarted = resolve; });
  const answer = new Promise(resolve => { answerResolve = resolve; });
  context.fetch = async url => {
    if (String(url).endsWith('/answer')) {
      answerStarted();
      return answer;
    }
    throw new Error('unexpected fetch');
  };
  get('#question').value = 'What is momentum?';
  const pending = context.ask();
  await started;
  const clearing = context.clearChatConversation();
  answerResolve({ ok: true, status: 200, json: async () => ({ answer: '不应写回的旧回答' }) });
  await Promise.all([pending, clearing]);
  assert.equal(get('#answer').hidden, true);
  assert.equal(saved.chatHistory['1']?.some(message => message.text === '不应写回的旧回答'), false);
});

test('Moodle 截图消息附加到当前问答会话并预填视觉提问', async () => {
  const embedded = await setup({ embedded: true, authorizeEmbedded: true, courses: [{ id: '1', title: 'Physics' }] });
  const accepted = embedded.context.receiveEmbeddedView({
    origin: 'https://moodle.telt.unsw.edu.au', source: embedded.parentWindow,
    data: { type: 'ASKME_ATTACH_SCREENSHOT', bindingId: 'b'.repeat(48), generation: 1, dataUrl: 'data:image/png;base64,ZmFrZQ==', capturedAt: '2026-09-24T00:00:00.000Z' }
  });
  assert.equal(accepted, true);
  assert.equal(embedded.get('#screenshot-attachment').hidden, false);
  assert.match(embedded.get('#question').value, /解释这张 Moodle 截图/u);
  assert.equal(vm.runInContext('pendingScreenshot.dataUrl', embedded.context), 'data:image/png;base64,ZmFrZQ==');
});

test('同一面板的连续对话写入严格串行且后写入不会被旧快照覆盖', async () => {
  const { context, saved } = await setup();
  const originalSet = context.chrome.storage.local.set;
  let firstWrite = true;
  context.chrome.storage.local.set = async patch => {
    if (patch.chatHistory && firstWrite) { firstWrite = false; await new Promise(resolve => setTimeout(resolve, 10)); }
    return originalSet(patch);
  };
  const first = context.appendChatMessage('1', { role: 'user', text: '第一问', createdAt: '2026-09-23T00:00:00.000Z', sources: [] });
  const second = context.appendChatMessage('1', { role: 'assistant', text: '第一答', createdAt: '2026-09-23T00:00:01.000Z', sources: [] });
  await Promise.all([first, second]);
  assert.deepEqual(saved.chatHistory['1'].map(item => item.text), ['第一问', '第一答']);
});

test('中文翻译回退不会检索所选分节之外的英文讲义', async () => {
  const first = { ...page('1', 'Kinematics studies rigid body motion. '.repeat(4), 'Kinematics'), sectionGroup: 'Week 1' };
  const second = { ...page('1', 'Fluid mechanics studies pressure and flow. '.repeat(4), 'Fluids'), sectionGroup: 'Week 2', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [first, second], files: [] } } });
  get('#ask-section').value = 'week:1'; get('#question').value = '什么是流体力学？';
  let answerCalls = 0;
  context.fetch = async url => {
    if (String(url).endsWith('/translate')) return { ok: true, json: async () => ({ terms: ['fluid mechanics pressure flow'] }) };
    answerCalls++;
    return { status: 200, ok: true, json: async () => ({ answer: '不应调用。[1]' }) };
  };
  await context.ask();
  assert.equal(answerCalls, 0);
  assert.match(get('#answer').textContent, /未找到相关内容/);
  assert.equal(get('#sources').children.length, 0);
});

test('英文虚词不会使无关讲义被误判为匹配', async () => {
  const { context } = await setup({
    courses: [{ id: '1', title: 'Physics' }],
    library: { 1: { pages: [page('1', 'The course is in English with many examples.', 'Overview')], files: [] } }
  });
  assert.equal(context.rank('what is the force of motion', '1').length, 0);
});

test('中文提问中的周次数字能优先匹配相应周讲义', async () => {
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'General project planning', 'Week 1'), page('1', 'General project planning', 'Week 3')], files: [] } } });
  assert.equal(context.rank('第3周的 project planning', '1')[0].title, 'Week 3');
});

test('揭示卡片后记录掌握程度，并优先展示仍到期的知识点', async () => {
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'A'.repeat(90), 'First'), page('1', 'B'.repeat(90), 'Second')], files: [] } } });
  context.nextCard();
  assert.equal(get('#card').children[1].textContent, 'First');
  await context.reveal();
  assert.equal(get('#rating-actions').hidden, false);
  await context.rateCard('good');
  assert.equal(saved.reviewProgress['1']['https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1|First'].rating, 'good');
  assert.equal(get('#card').children[1].textContent, 'Second');
  assert.match(get('#review-progress').textContent, /待复习 1/);
});

test('生产面板通过后台复习事务接收权威合并状态', async () => {
  const lecture = { ...page('1', 'Coordinator concept '.repeat(10), 'Coordinator card'), id: 'card-a' };
  let sent;
  const backendProgress = {};
  const { context, get } = await setup({
    accountId: '111', courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [lecture], files: [] } },
    runtimeSendMessage: async message => {
      sent = message;
      const entry = { rating: message.rating, contentHash: message.contentHash, dueAt: new Date(message.now + 86_400_000).toISOString(), introducedAt: new Date(message.now).toISOString(), reviews: 1, intervalDays: 1 };
      backendProgress['1'] = { 'card-a': entry };
      return { ok: true, entry, reviewProgress: structuredClone(backendProgress), todayFocusSession: null };
    }
  });
  get('#review-course').value = '1'; get('#rating-actions').hidden = false;
  vm.runInContext("activeCard = library['1'].pages[0]", context);
  await context.rateCard('good');
  assert.equal(sent.type, 'MUTATE_REVIEW');
  assert.equal(sent.userId, '111');
  assert.equal(sent.cardKey, 'card-a');
  assert.equal(sent.rating, 'good');
  assert.match(sent.operationId, /^review:111:/);
  assert.equal(vm.runInContext("reviewProgress['1']['card-a'].reviews", context), 1);
});

test('复习间隔按评价变化，忘记时十分钟后重试', async () => {
  const { context } = await setup();
  const now = Date.parse('2026-09-23T00:00:00Z');
  const first = context.scheduleReview(null, 'good', now);
  assert.equal(first.intervalDays, 1);
  const second = context.scheduleReview(first, 'good', now);
  assert.equal(second.intervalDays, 3);
  const again = context.scheduleReview(second, 'again', now);
  assert.equal(Date.parse(again.dueAt) - now, 600000);
});

test('每日新知识点限制为十个，到期旧卡片仍可复习', async () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({ ...page('1', 'Concept '.repeat(15), `Card ${i + 1}`), id: `card-${i + 1}` }));
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } } });
  context.nextCard();
  assert.match(get('#review-progress').textContent, /今日待复习 10/);
  assert.equal(context.dueReviewPages('1', context.reviewPages('1')).pages.length, 10);
});

test('每日十张新卡额度由所有已选课程共享', async () => {
  const now = Date.parse('2026-09-23T04:00:00Z');
  const introducedAt = new Date(now).toISOString();
  const courseOnePages = Array.from({ length: 6 }, (_, i) => ({ ...page('1', 'Prior concept '.repeat(10), `Prior ${i + 1}`), id: `prior-${i + 1}` }));
  const courseTwoPages = Array.from({ length: 8 }, (_, i) => ({ ...page('2', 'New concept '.repeat(10), `New ${i + 1}`), id: `new-${i + 1}` }));
  const records = Object.fromEntries(courseOnePages.map(item => [item.id, { introducedAt, dueAt: new Date(now + 86_400_000).toISOString(), contentHash: 'saved' }]));
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: { 1: { pages: courseOnePages, files: [] }, 2: { pages: courseTwoPages, files: [] } },
    reviewProgress: { 1: records }
  });
  assert.equal(context.introducedTodayCount(now), 6);
  assert.equal(context.dueReviewPages('2', context.reviewPages('2'), now).newAllowance, 4);
  assert.equal(context.dueReviewPages('2', context.reviewPages('2'), now).pages.length, 4);
  vm.runInContext("courses[0].selected = false", context);
  assert.equal(context.introducedTodayCount(now), 6);
  assert.equal(context.dueReviewPages('2', context.reviewPages('2'), now).newAllowance, 4);
});

test('评分与自测并发保存会串行合并而不覆盖另一课程记录', async () => {
  const firstPage = { ...page('1', 'Rated concept '.repeat(12), 'Rated card'), id: 'rated-card' };
  const secondPage = { ...page('2', 'Practice concept '.repeat(12), 'Practice card'), id: 'practice-card' };
  const { context, saved, get } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: { 1: { pages: [firstPage], files: [] }, 2: { pages: [secondPage], files: [] } }
  });
  let releaseFirst;
  let writes = 0;
  context.chrome.storage.local.set = async patch => {
    writes += 1;
    if (writes === 1) await new Promise(resolve => { releaseFirst = resolve; });
    Object.assign(saved, structuredClone(patch));
  };
  get('#review-course').value = '1';
  get('#rating-actions').hidden = false;
  vm.runInContext("activeCard = library['1'].pages[0]; practiceCard = { courseId: '2', key: 'practice-card', contentHash: hashText(library['2'].pages[0].text) }", context);
  const rated = context.rateCard('good');
  const binding = { courseId: '2', knowledgeUnitId: 'practice-card', sourceId: 'practice-card', sourceVersionHashes: [context.hashText(secondPage.text)], preparationSnapshotId: '',
    practiceItemId: 'practice:item-concurrent', normalizedStemHash: 'stem-concurrent', variantKey: 'explanation:understand:definition', attemptId: 'attempt:concurrent1' };
  const practiced = context.recordPracticeOutcome({ ...practiceV2('incorrect', '概念定义不完整', '课程定义'), binding });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  releaseFirst();
  await Promise.all([rated, practiced]);
  assert.equal(writes, 2);
  assert.ok(saved.reviewProgress['1']['rated-card']);
  assert.equal(saved.reviewProgress['2']['practice-card'].practiceVerdict, 'incorrect');
});

test('今日计划的跨课程新卡汇总不会把全局额度重复计算', async () => {
  const now = Date.parse('2026-09-23T04:00:00Z');
  const makePages = (courseId, prefix) => Array.from({ length: 8 }, (_, i) => ({ ...page(courseId, 'New concept '.repeat(10), `${prefix} ${i + 1}`), id: `${prefix}-${i + 1}` }));
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: { 1: { pages: makePages('1', 'one'), files: [] }, 2: { pages: makePages('2', 'two'), files: [] } }
  });
  const plan = context.todayPlan(now);
  assert.equal(plan.totalDue, 10);
  assert.deepEqual(Array.from(plan.candidates, item => item.due), [8, 2]);
});

test('新卡额度按 Australia Sydney 日界计算', async () => {
  const now = Date.parse('2026-10-03T14:30:00Z'); // 悉尼 2026-10-04 00:30
  const priorSydneyDay = '2026-10-03T13:30:00Z'; // 悉尼 2026-10-03 23:30
  const currentSydneyDay = '2026-10-03T14:10:00Z'; // 悉尼 2026-10-04 00:10
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }],
    reviewProgress: { 1: {
      previous: { introducedAt: priorSydneyDay },
      current: { introducedAt: currentSydneyDay }
    } }
  });
  assert.equal(context.sydneyDayKey(now), '2026-10-04');
  assert.equal(context.introducedTodayCount(now), 1);
});

test('全局新卡额度用尽后到期旧卡和薄弱点仍不受限', async () => {
  const now = Date.parse('2026-09-23T04:00:00Z');
  const fresh = Array.from({ length: 10 }, (_, i) => ({ ...page('1', 'Fresh '.repeat(20), `Fresh ${i + 1}`), id: `fresh-${i + 1}` }));
  const old = { ...page('2', 'Old due '.repeat(20), 'Old due'), id: 'old-due' };
  const weak = { ...page('2', 'Weak due '.repeat(20), 'Weak due'), id: 'weak-due' };
  const unseen = { ...page('2', 'Unseen '.repeat(20), 'Unseen'), id: 'unseen' };
  const introducedAt = new Date(now).toISOString();
  const { context } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: { 1: { pages: fresh, files: [] }, 2: { pages: [old, weak, unseen], files: [] } },
    reviewProgress: {
      1: Object.fromEntries(fresh.map(item => [item.id, { introducedAt, dueAt: new Date(now + 86_400_000).toISOString() }])),
      2: {
        [old.id]: { introducedAt: '2026-09-20T00:00:00Z', dueAt: new Date(now - 1000).toISOString(), contentHash: 'pending' },
        [weak.id]: { introducedAt: '2026-09-20T00:00:00Z', dueAt: new Date(now - 1000).toISOString(), contentHash: 'pending', practiceVerdict: 'incorrect' }
      }
    }
  });
  vm.runInContext("reviewProgress['2']['old-due'].contentHash = hashText(library['2'].pages[0].text); reviewProgress['2']['weak-due'].contentHash = hashText(library['2'].pages[1].text)", context);
  const due = context.dueReviewPages('2', context.reviewPages('2'), now);
  assert.equal(due.newAllowance, 0);
  assert.deepEqual(Array.from(due.pages, item => item.id), ['weak-due', 'old-due']);
});

test('今日学习入口优先进入有待练习内容的课程', async () => {
  const first = page('1', 'A'.repeat(90), '已完成课程');
  const second = page('2', 'B'.repeat(90), '今日课程');
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: { 1: { pages: [first], files: [] }, 2: { pages: [second], files: [] } }
  });
  context.nextCard();
  await context.reveal();
  await context.rateCard('good');
  await vm.runInContext('learningSessionWriteQueue', context);
  assert.match(get('#today-summary').textContent, /1 个待练习/);
  await context.startToday();
  assert.equal(get('#review-course').value, '2');
  assert.equal(get('#card').children[1].textContent, '今日课程');
});

test('今日学习评分后先显示保存回执，点击继续才严格进入计划下一项', async () => {
  const first = page('1', 'A'.repeat(90), 'Course one card');
  const second = page('2', 'B'.repeat(90), 'Course two card');
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: { 1: { pages: [first], files: [] }, 2: { pages: [second], files: [] } }
  });
  await context.startToday();
  assert.equal(get('#review-course').value, '1');
  assert.equal(get('#card').children[1].textContent, 'Course one card');
  await context.reveal();
  await context.rateCard('good');
  assert.equal(get('#review-course').value, '1');
  assert.equal(get('#card').children[1].textContent, 'Course one card');
  assert.equal(get('#focus-receipt').hidden, false);
  assert.match(get('#focus-receipt-title').textContent, /学习记录已保存/);
  await context.continueFocus();
  assert.equal(get('#review-course').value, '2');
  assert.equal(get('#card').children[1].textContent, 'Course two card');
  await context.reveal();
  await context.rateCard('good');
  assert.equal(get('#review-course').value, '2');
  assert.equal(get('#focus-receipt').hidden, false);
  assert.match(get('#focus-continue').textContent, /查看本块总结/);
  await context.continueFocus();
  assert.equal(get('#focus-complete').hidden, false);
  assert.match(get('#focus-complete-summary').textContent, /已处理 2 项/);
});

test('首个今日学习块在三十、六十和一百八十分钟日预算下都不超过二十四分钟', async () => {
  const pages = Array.from({ length: 12 }, (_, index) => ({ ...page('1', `Body ${index} `.repeat(20), `Card ${index}`), id: `card-${index}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=${index + 1}` }));
  for (const dailyMinutes of [30, 60, 180]) {
    const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } }, studyPlanPreferences: { dailyMinutes } });
    const session = context.newFocusSession(context.buildStudyQueue());
    assert.ok(session);
    assert.equal(session.plannedMinutes, 30);
    assert.ok(Array.from(session.itemMinutes).reduce((sum, value) => sum + value, 0) <= 24);
  }
});

test('今日学习块严格执行 A1、B1、A2 快照顺序且不展示预算外第四项', async () => {
  const one = { id: '1', title: 'One' }, two = { id: '2', title: 'Two' };
  const a1 = { ...page('1', 'A1 body '.repeat(20), 'A1'), id: 'a1', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=11' };
  const b1 = { ...page('2', 'B1 body '.repeat(20), 'B1'), id: 'b1', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=21' };
  const a2 = { ...page('1', 'A2 body '.repeat(20), 'A2'), id: 'a2', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=12' };
  const outside = { ...page('2', 'OUTSIDE body '.repeat(20), 'OUTSIDE'), id: 'outside', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=22' };
  const { context, saved, get } = await setup({ courses: [one, two], library: { 1: { pages: [a1, a2], files: [] }, 2: { pages: [b1, outside], files: [] } }, studyPlanPreferences: { dailyMinutes: 180 } });
  const queue = { items: [focusQueueItem(one, a1), focusQueueItem(two, b1), focusQueueItem(one, a2), focusQueueItem(two, outside)] };
  const session = context.newFocusSession(queue);
  assert.equal(session.itemIds.length, 3);
  assert.deepEqual(Array.from(session.itemIds), [context.focusItemId(a1), context.focusItemId(b1), context.focusItemId(a2)]);
  await context.persistFocusSession(session);
  await context.openFocusCurrent();
  for (const [index, expected] of ['A1', 'B1', 'A2'].entries()) {
    assert.equal(get('#card').children[1].textContent, expected);
    await context.reveal();
    await context.rateCard('good');
    assert.equal(get('#focus-receipt').hidden, false);
    if (index < 2) await context.continueFocus();
  }
  assert.equal(JSON.stringify(saved.todayFocusSession).includes('outside'), false);
  assert.equal(get('#card').children.some(child => child.textContent === 'OUTSIDE'), false);
});

test('跳过知识点只更新学习块，不写入 reviewProgress', async () => {
  const first = { ...page('1', 'First body '.repeat(20), 'First'), id: 'first' };
  const second = { ...page('1', 'Second body '.repeat(20), 'Second'), id: 'second', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } } });
  await context.startToday();
  await context.skipFocusItem();
  assert.deepEqual(saved.reviewProgress, {});
  assert.equal(saved.todayFocusSession.skipped.length, 1);
  assert.equal(get('#focus-receipt').hidden, false);
  await context.continueFocus();
  assert.equal(get('#card').children[1].textContent, 'Second');
});

test('今天到这里保留已存记录并阻止通用断点自动恢复', async () => {
  const first = { ...page('1', 'First body '.repeat(20), 'First'), id: 'first' };
  const second = { ...page('1', 'Second body '.repeat(20), 'Second'), id: 'second', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } } });
  await context.startToday();
  await context.reveal();
  await context.rateCard('good');
  await context.stopFocus();
  await vm.runInContext('learningSessionWriteQueue', context);
  assert.equal(saved.reviewProgress['1'].first.rating, 'good');
  assert.equal(saved.todayFocusSession.status, 'ended');
  assert.equal(saved.learningSession, null);
  assert.equal(context.validatedLearningResume(), null);
  assert.notEqual(context.selectNextAction(context.todayPlan())?.type, 'resume');
});

test('重建侧栏后从当前账号存储恢复同一学习块条目', async () => {
  const first = { ...page('1', 'First body '.repeat(20), 'First'), id: 'first' };
  const second = { ...page('1', 'Second body '.repeat(20), 'Second'), id: 'second', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const sharedStorage = { courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } }, reviewProgress: {}, semanticIndex: {}, studyPlanPreferences: { dailyMinutes: 30 }, studyGoals: [], studyPlanRuntime: {} };
  const firstPanel = await setup({ sharedStorage });
  await firstPanel.context.startToday();
  const expectedId = sharedStorage.todayFocusSession.itemIds[0];
  const rebuilt = await setup({ sharedStorage });
  assert.equal(rebuilt.context.selectNextAction(rebuilt.context.todayPlan()).type, 'focus');
  await rebuilt.context.startToday();
  assert.equal(rebuilt.get('#card').children[1].textContent, 'First');
  assert.equal(vm.runInContext('todayFocusSession.itemIds[todayFocusSession.currentIndex]', rebuilt.context), expectedId);
});

test('学习块恢复时正文变化或页面删除会安全跳过，不展示旧正文', async () => {
  for (const mutation of ['changed', 'deleted']) {
    const first = { ...page('1', 'SECRET OLD BODY '.repeat(10), 'First'), id: 'first' };
    const second = { ...page('1', 'Second current body '.repeat(10), 'Second'), id: 'second', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
    const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } } });
    await context.startToday();
    if (mutation === 'changed') vm.runInContext("library['1'].pages[0].text = 'NEW BODY WITH A DIFFERENT HASH'", context);
    else vm.runInContext("library['1'].pages.shift()", context);
    await context.openFocusCurrent();
    assert.equal(get('#card').children[1].textContent, 'Second');
    assert.equal(get('#card').children.some(child => child.textContent.includes('SECRET OLD BODY')), false);
    assert.equal(saved.todayFocusSession.currentIndex, 1);
    assert.equal(saved.todayFocusSession.skipped.length, 0, '内容失效不得计为用户主动跳过');
  }
});

test('自评存储失败时保留当前项、游标和可重试评分按钮', async () => {
  const first = { ...page('1', 'First body '.repeat(20), 'First'), id: 'first' };
  const second = { ...page('1', 'Second body '.repeat(20), 'Second'), id: 'second', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } } });
  await context.startToday();
  await context.reveal();
  const persistedBefore = structuredClone(saved.todayFocusSession);
  context.chrome.storage.local.set = async patch => { if (patch.reviewProgress) throw new Error('QUOTA_BYTES exceeded'); Object.assign(saved, structuredClone(patch)); };
  await context.rateCard('good');
  assert.deepEqual(saved.todayFocusSession, persistedBefore);
  assert.deepEqual(saved.reviewProgress, {});
  assert.equal(get('#card').children[1].textContent, 'First');
  assert.equal(get('#focus-receipt').hidden, true);
  assert.equal(get('#rating-actions').hidden, false);
  assert.match(get('#status').textContent, /无法保存复习记录/);
});

test('学习块持久化对象不包含正文、URL、学生答案或 AI 输出', async () => {
  const secretBody = 'PRIVATE COURSE BODY 7f3f '.repeat(10);
  const secretUrl = 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=98765';
  const item = { ...page('1', secretBody, 'Sensitive title'), url: secretUrl };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'Private course name' }], library: { 1: { pages: [item], files: [] } } });
  await context.startToday();
  const serialized = JSON.stringify(saved.todayFocusSession);
  for (const forbidden of [secretBody, secretUrl, 'Sensitive title', 'Private course name', 'STUDENT ANSWER', 'MODEL ANSWER']) assert.equal(serialized.includes(forbidden), false, `会话泄露了：${forbidden}`);
});

test('学习块结束总结准确显示已处理和跳过数量', async () => {
  const first = { ...page('1', 'First body '.repeat(20), 'First'), id: 'first' };
  const second = { ...page('1', 'Second body '.repeat(20), 'Second'), id: 'second', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } } });
  await context.startToday();
  await context.reveal();
  await context.rateCard('good');
  await context.continueFocus();
  await context.skipFocusItem();
  await context.continueFocus();
  assert.equal(get('#focus-complete').hidden, false);
  assert.match(get('#focus-complete-summary').textContent, /已处理 1 项.*跳过 1 项/);
});

test('完成首块后只在用户显式选择时再安排一块', async () => {
  const pages = Array.from({ length: 4 }, (_, index) => ({ ...page('1', `Body ${index} `.repeat(20), `Card ${index + 1}`), id: `card-${index + 1}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=${index + 1}` }));
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } }, studyPlanPreferences: { dailyMinutes: 60 } });
  await context.startToday();
  for (let index = 0; index < 3; index++) {
    await context.reveal();
    await context.rateCard('good');
    await context.continueFocus();
  }
  assert.equal(saved.todayFocusSession.status, 'complete');
  assert.equal(get('#focus-complete').hidden, false);
  assert.match(get('#focus-more').textContent, /再安排 30 分钟/);
  await context.startAnotherFocusBlock();
  assert.equal(saved.todayFocusSession.status, 'active');
  assert.equal(saved.todayFocusSession.itemIds.length, 1);
  assert.equal(get('#card').children[1].textContent, 'Card 4');
});

test('四十五分钟日预算只能安排三十加十五分钟两块，不得再开第三块', async () => {
  const pages = Array.from({ length: 6 }, (_, index) => ({ ...page('1', `Body ${index} `.repeat(20), `Card ${index + 1}`), id: `card-${index + 1}`, url: `https://moodle.telt.unsw.edu.au/mod/page/view.php?id=${index + 1}` }));
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } }, studyPlanPreferences: { dailyMinutes: 45 } });
  await context.startToday();
  assert.equal(saved.todayFocusSession.plannedMinutes, 30);
  for (let index = 0; index < 3; index++) {
    await context.reveal();
    await context.rateCard('good');
    await context.continueFocus();
  }
  await context.startAnotherFocusBlock();
  assert.equal(saved.todayFocusSession.plannedMinutes, 15);
  assert.ok(saved.todayFocusSession.itemMinutes.reduce((sum, value) => sum + value, 0) <= 12);
  while (saved.todayFocusSession.status === 'active') {
    await context.reveal();
    await context.rateCard('good');
    await context.continueFocus();
  }
  const completedSecond = structuredClone(saved.todayFocusSession);
  await context.startAnotherFocusBlock();
  assert.deepEqual(saved.todayFocusSession, completedSecond);
});

test('Sydney 日界变更后昨日学习块失效且不恢复', async () => {
  const item = { ...page('1', 'Body '.repeat(20), 'Card'), id: 'card' };
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } } });
  const beforeMidnight = Date.parse('2026-10-03T13:30:00Z');
  const afterMidnight = Date.parse('2026-10-03T14:30:00Z');
  const session = context.newFocusSession({ items: [focusQueueItem({ id: '1', title: 'One' }, item)] }, beforeMidnight);
  assert.equal(context.sydneyDayKey(beforeMidnight), '2026-10-03');
  assert.equal(context.sydneyDayKey(afterMidnight), '2026-10-04');
  assert.equal(context.normalizeTodayFocusSession(session, afterMidnight), null);
});

test('学习块内第十一张新卡仍被全局日上限阻止', async () => {
  const item = { ...page('1', 'ELEVENTH SECRET BODY '.repeat(10), 'Eleventh'), id: 'eleventh' };
  const probe = await setup();
  const dayKey = probe.context.sydneyDayKey();
  const runtime = { dayKey, newCardClaims: Array.from({ length: 9 }, (_, index) => `claimed-${index}`) };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } }, studyPlanRuntime: runtime });
  const session = context.newFocusSession({ items: [focusQueueItem({ id: '1', title: 'One' }, item)] });
  await context.persistFocusSession(session);
  await context.openFocusCurrent();
  vm.runInContext(`studyPlanRuntime = { dayKey: ${JSON.stringify(dayKey)}, newCardClaims: Array.from({ length: 10 }, (_, index) => 'claimed-' + index) }`, context);
  await context.reveal();
  assert.equal(get('#rating-actions').hidden, true);
  assert.equal(get('#card').children.some(child => child.textContent.includes('ELEVENTH SECRET BODY')), false);
  assert.match(get('#status').textContent, /今天已开始 10 个新知识点/);
  assert.equal(vm.runInContext('todayFocusSession.completed.length', context), 0);
});

test('今日学习合并所选课程截止事项并只显示安全的 due 和 close 链接', async () => {
  const now = Date.now();
  const good = { id: 'e1', courseId: '1', title: 'Assignment is due', component: 'mod_assign', eventType: 'due', timestampMs: now + 3_600_000, activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=8' };
  const close = { id: 'e2', courseId: '1', title: 'Quiz closes', component: 'mod_quiz', eventType: 'close', timestampMs: now + 172_800_000, courseUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const open = { ...good, id: 'e3', title: 'Quiz opens', eventType: 'open' };
  const bad = { ...good, id: 'e4', title: 'Evil', activityUrl: 'https://evil.example/steal' };
  const wrongCourse = { ...good, id: 'e5', courseId: '2', title: 'Wrong course' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'A'.repeat(90))], files: [], events: [close, open, bad, wrongCourse, good, { ...good }] } } });
  const plan = context.todayPlan(now);
  assert.equal(plan.deadlines.map(item => item.id).join('|'), 'e1|e2');
  context.renderTodayStudy();
  assert.match(get('#today-summary').textContent, /Assignment is due/);
  assert.equal(get('#today-deadlines').children.length, 2);
  assert.equal(get('#today-deadlines').children[0].href, good.activityUrl);
});

test('已过 due 但活动尚未 close 时继续显示补救提醒且不推断提交状态', async () => {
  const now = Date.now(), activityUrl = 'https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=8';
  const due = { id: 'due', courseId: '1', title: 'Quiz 1 due', eventType: 'due', timestampMs: now - 2 * 3_600_000, activityUrl };
  const close = { id: 'close', courseId: '1', title: 'Quiz 1 closes', eventType: 'close', timestampMs: now + 4 * 3_600_000, activityUrl };
  const expired = { id: 'expired', courseId: '1', title: 'Old quiz due', eventType: 'due', timestampMs: now - 40 * 86_400_000, activityUrl: 'https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=9' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [], files: [], events: [due, close, expired] } } });
  const plan = context.todayPlan(now);
  assert.equal(plan.deadlines.map(item => item.id).join('|'), 'due|close');
  assert.equal(context.relativeDeadline(due.timestampMs, now), '已过截止 2 小时');
  context.renderTodayStudy();
  const text = get('#today-deadlines').children.map(item => item.children.map(child => child.textContent).join(' ')).join(' ');
  assert.match(text, /已过截止/u);
  assert.doesNotMatch(text, /未提交/u);
});

test('只有截止事项且没有复习页时，一键下一步安全打开 Moodle 且不宣称完成', async () => {
  const event = { id: 'e1', courseId: '1', title: 'Report is due', eventType: 'due', timestampMs: Date.now() + 86_400_000, courseUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [], files: [], events: [event] } } });
  let opened = '';
  context.chrome.tabs.create = async ({ url }) => { opened = url; };
  context.renderTodayStudy();
  assert.equal(get('#today-study').hidden, false);
  assert.equal(get('#start-today').disabled, false);
  assert.match(get('#start-today').textContent, /紧急事项|最近事项/);
  assert.equal(get('#today-deadlines').children.length, 1);
  await context.startToday();
  assert.equal(opened, event.courseUrl);
  assert.match(get('#status').textContent, /不会把事项标记为完成/);
  assert.equal(get('#today-deadlines').children.length, 1);
  assert.equal(get('#start-today').disabled, false);
  assert.equal(get('#start-today').textContent, '同步所选课程（1 门未同步） →');
});

test('打开紧急事项后本轮保留事项并把下一步转到薄弱点', async () => {
  const now = Date.now();
  const weakPage = page('1', 'Weak concept '.repeat(20), 'Weak concept');
  const key = `${weakPage.url}|${weakPage.title}`;
  const urgent = { id: 'urgent-next', courseId: '1', title: 'Due soon', eventType: 'due', timestampMs: now + 3_600_000, courseUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [weakPage], files: [], events: [urgent] } }, reviewProgress: { 1: { [key]: { contentHash: 'pending', dueAt: new Date(now - 1000).toISOString(), introducedAt: new Date(now).toISOString(), practiceVerdict: 'incorrect' } } } });
  vm.runInContext(`reviewProgress['1'][${JSON.stringify(key)}].contentHash = hashText(library['1'].pages[0].text)`, context);
  context.chrome.tabs.create = async () => ({});
  context.renderTodayStudy();
  assert.match(get('#start-today').textContent, /紧急事项/);
  await context.startToday();
  assert.equal(get('#today-deadlines').children.length, 1);
  assert.match(get('#start-today').textContent, /薄弱点/);
});

test('快速重复点击截止主动作只打开一个标签页', async () => {
  const event = { id: 'double-click', courseId: '1', title: 'Submit once', eventType: 'due', timestampMs: Date.now() + 3_600_000, courseUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [], files: [], events: [event] } } });
  let resolveOpen;
  let calls = 0;
  context.chrome.tabs.create = async () => { calls += 1; await new Promise(resolve => { resolveOpen = resolve; }); };
  context.renderTodayStudy();
  const first = context.startToday();
  const second = context.startToday();
  assert.equal(calls, 1);
  assert.equal(get('#start-today').disabled, true);
  resolveOpen();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('从截止列表打开后本轮主动作转到下一建议', async () => {
  const first = { id: 'list-one', courseId: '1', title: 'First deadline', eventType: 'due', timestampMs: Date.now() + 3_600_000, courseUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const second = { ...first, id: 'list-two', title: 'Second deadline', timestampMs: Date.now() + 7_200_000 };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [], files: [], events: [first, second] } } });
  context.renderTodayStudy();
  get('#today-deadlines').children[0].listeners.click();
  assert.equal(get('#today-deadlines').children.length, 2);
  assert.equal(context.selectNextAction(context.todayPlan()).event.id, 'list-two');
});

test('一键下一步按紧急截止、薄弱点、普通复习、未来事项排序', async () => {
  const now = Date.now();
  const pageOne = page('1', 'Concept '.repeat(20), 'Concept');
  const key = `${pageOne.url}|${pageOne.title}`;
  const urgent = { id: 'urgent', courseId: '1', title: 'Due soon', eventType: 'due', timestampMs: now + 3_600_000, courseUrl: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' };
  const future = { ...urgent, id: 'future', title: 'Due later', timestampMs: now + 172_800_000 };
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [pageOne], files: [], events: [urgent, future] } }, reviewProgress: { 1: { [key]: { contentHash: 'pending', dueAt: new Date(now - 1000).toISOString(), introducedAt: new Date(now).toISOString(), practiceVerdict: 'incorrect' } } } });
  vm.runInContext(`reviewProgress['1'][${JSON.stringify(key)}].contentHash = hashText(library['1'].pages[0].text)`, context);
  let plan = context.todayPlan(now);
  assert.equal(context.selectNextAction(plan, now).event.id, 'urgent');
  vm.runInContext("library['1'].events = library['1'].events.filter(event => event.id !== 'urgent')", context);
  plan = context.todayPlan(now);
  assert.equal(context.selectNextAction(plan, now).type, 'review');
  assert.equal(context.selectNextAction(plan, now).candidate.weak, 1);
  vm.runInContext(`reviewProgress['1'][${JSON.stringify(key)}].practiceVerdict = null`, context);
  plan = context.todayPlan(now);
  assert.equal(context.selectNextAction(plan, now).type, 'review');
  vm.runInContext(`reviewProgress['1'][${JSON.stringify(key)}].dueAt = new Date(Date.now() + 86400000).toISOString()`, context);
  plan = context.todayPlan(now);
  assert.equal(context.selectNextAction(plan, now).event.id, 'future');
});

test('下一步只统计真正到期且正文未变化的薄弱卡，并精确打开该卡', async () => {
  const now = Date.now();
  const normal = { ...page('1', 'Normal concept '.repeat(12), 'Normal due'), id: 'normal-due' };
  const weakDue = { ...page('1', 'Weak due concept '.repeat(12), 'Weak due'), id: 'weak-due' };
  const weakFuture = { ...page('1', 'Weak future concept '.repeat(12), 'Weak future'), id: 'weak-future' };
  const weakStale = { ...page('1', 'Updated weak concept '.repeat(12), 'Weak stale'), id: 'weak-stale' };
  const records = {
    [normal.id]: { contentHash: 'pending', dueAt: new Date(now - 3000).toISOString(), introducedAt: new Date(now).toISOString() },
    [weakDue.id]: { contentHash: 'pending', dueAt: new Date(now - 2000).toISOString(), introducedAt: new Date(now).toISOString(), practiceVerdict: 'incorrect' },
    [weakFuture.id]: { contentHash: 'pending', dueAt: new Date(now + 86_400_000).toISOString(), introducedAt: new Date(now).toISOString(), practiceVerdict: 'incorrect' },
    [weakStale.id]: { contentHash: 'old-content', dueAt: new Date(now - 1000).toISOString(), introducedAt: new Date(now).toISOString(), practiceVerdict: 'incorrect' }
  };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [normal, weakDue, weakFuture, weakStale], files: [] } }, reviewProgress: { 1: records } });
  vm.runInContext("reviewProgress['1']['normal-due'].contentHash = hashText(library['1'].pages[0].text); reviewProgress['1']['weak-due'].contentHash = hashText(library['1'].pages[1].text); reviewProgress['1']['weak-future'].contentHash = hashText(library['1'].pages[2].text); cardIndex = 0", context);
  const plan = context.todayPlan(now);
  const action = context.selectNextAction(plan, now);
  assert.equal(plan.totalWeak, 1);
  assert.equal(plan.candidates[0].targetCardKey, weakDue.id);
  assert.equal(action.targetCardKey, weakDue.id);
  await context.startToday();
  assert.equal(get('#card').children[1].textContent, 'Weak due');
});

test('点击下一步前目标失效时重新计算并打开新的精确目标', async () => {
  const now = Date.now();
  const first = { ...page('1', 'First weak concept '.repeat(12), 'First weak'), id: 'first-weak' };
  const second = { ...page('1', 'Second due concept '.repeat(12), 'Second due'), id: 'second-due' };
  const records = {
    [first.id]: { contentHash: 'pending', dueAt: new Date(now - 2000).toISOString(), introducedAt: new Date(now).toISOString(), practiceVerdict: 'incorrect' },
    [second.id]: { contentHash: 'pending', dueAt: new Date(now - 1000).toISOString(), introducedAt: new Date(now).toISOString() }
  };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } }, reviewProgress: { 1: records } });
  vm.runInContext("for (const p of library['1'].pages) reviewProgress['1'][p.id].contentHash = hashText(p.text)", context);
  context.renderTodayStudy();
  assert.equal(context.selectNextAction(context.todayPlan(now), now).targetCardKey, first.id);
  vm.runInContext("reviewProgress['1']['first-weak'].dueAt = new Date(Date.now() + 86400000).toISOString(); cardIndex = 0", context);
  await context.startToday();
  assert.equal(get('#card').children[1].textContent, 'Second due');
  assert.equal(vm.runInContext('cardKey(activeCard)', context), second.id);
});

test('点击下一步前目标被删除时不会按旧索引打开错误卡片', async () => {
  const now = Date.now();
  const removed = { ...page('1', 'Removed weak concept '.repeat(12), 'Removed weak'), id: 'removed-weak' };
  const remaining = { ...page('1', 'Remaining due concept '.repeat(12), 'Remaining due'), id: 'remaining-due' };
  const records = {
    [removed.id]: { contentHash: 'pending', dueAt: new Date(now - 2000).toISOString(), introducedAt: new Date(now).toISOString(), practiceVerdict: 'incorrect' },
    [remaining.id]: { contentHash: 'pending', dueAt: new Date(now - 1000).toISOString(), introducedAt: new Date(now).toISOString() }
  };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [removed, remaining], files: [] } }, reviewProgress: { 1: records } });
  vm.runInContext("for (const p of library['1'].pages) reviewProgress['1'][p.id].contentHash = hashText(p.text)", context);
  context.renderTodayStudy();
  assert.equal(context.selectNextAction(context.todayPlan(now), now).targetCardKey, removed.id);
  vm.runInContext("library['1'].pages = library['1'].pages.filter(p => p.id !== 'removed-weak'); cardIndex = 0", context);
  await context.startToday();
  assert.equal(get('#card').children[1].textContent, 'Remaining due');
  assert.equal(vm.runInContext('cardKey(activeCard)', context), remaining.id);
});

test('提前复习不会绕过每日十个新知识点上限', async () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({ ...page('1', 'Concept '.repeat(15), `Card ${i + 1}`), id: `card-${i + 1}` }));
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const introducedAt = new Date().toISOString();
  const records = Object.fromEntries(pages.slice(0, 10).map(item => [item.id, { dueAt: future, introducedAt }]));
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } }, reviewProgress: { 1: records } });
  vm.runInContext("for (const p of library['1'].pages.slice(0, 10)) reviewProgress['1'][p.id].contentHash = hashText(p.text)", context);
  vm.runInContext('cardIndex = 9', context);
  context.nextCard(true);
  assert.equal(get('#card').children[1].textContent, 'Card 1');
  assert.match(get('#review-progress').textContent, /今日待复习 0/);
});

test('课程正文更新后旧卡片重新到期并重置复习间隔', async () => {
  const changed = page('1', 'New explanation '.repeat(10), 'Updated lecture');
  const key = `${changed.url}|${changed.title}`;
  const { context, saved, get } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [changed], files: [] } },
    reviewProgress: { 1: { [key]: { contentHash: 'old-content', intervalDays: 30, dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), introducedAt: new Date().toISOString() } } }
  });
  assert.equal(context.dueReviewPages('1', context.reviewPages('1')).pages.length, 1);
  context.nextCard();
  assert.equal(get('#card').children[1].textContent, 'Updated lecture');
  await context.reveal();
  await context.rateCard('good');
  assert.equal(saved.reviewProgress['1'][key].intervalDays, 1);
  assert.equal(saved.reviewProgress['1'][key].contentHash, context.hashText(changed.text));
});

test('本机语义索引使中文问题命中无中文字词的英文讲义', async () => {
  const lecture = page('1', 'Momentum is the product of mass and velocity. '.repeat(4), 'Physics lecture');
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'Physics' }] });
  const vector = Buffer.from([127, ...Array(1023).fill(0)]).toString('base64');
  context.message = async () => ({ data: { pages: [lecture], files: [], errors: [] } });
  context.fetch = async (url, options) => {
    if (String(url).includes('/health')) return { ok: true, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) };
    if (String(url).endsWith('/embed')) {
      assert.doesNotMatch(options.body, /moodle\.telt\.unsw\.edu\.au/);
      return { ok: true, json: async () => ({ model: 'qwen3-embedding:0.6b', dimensions: 1024, vectors: [vector] }) };
    }
    const request = JSON.parse(options.body);
    assert.equal(request.question, '什么是动量？');
    assert.match(request.sources[0].excerpt, /Momentum/);
    return { ok: true, status: 200, json: async () => ({ answer: '动量与质量、速度有关。[1]' }) };
  };
  await context.sync();
  assert.equal(Object.keys(saved.semanticIndex['1'].records).length, 1);
  get('#question').value = '什么是动量？';
  await context.ask();
  assert.match(get('#answer').textContent, /动量与质量/);
});

test('相同课程内容再次同步时复用本机向量', async () => {
  const lecture = page('1', 'Momentum is the product of mass and velocity. '.repeat(4), 'Physics lecture');
  const { context } = await setup({ courses: [{ id: '1', title: 'Physics' }] });
  const vector = Buffer.from([127, ...Array(1023).fill(0)]).toString('base64');
  let embedCalls = 0;
  context.message = async () => ({ data: { pages: [lecture], files: [], errors: [] } });
  context.fetch = async (url) => {
    if (String(url).includes('/health')) return { ok: true, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) };
    embedCalls++;
    return { ok: true, json: async () => ({ model: 'qwen3-embedding:0.6b', dimensions: 1024, vectors: [vector] }) };
  };
  await context.sync();
  await context.sync();
  assert.equal(embedCalls, 1);
});

test('整课同步在文件解析和语义构建完成前不暴露新索引，最终原子提交两份索引', async () => {
  const oldPage = page('1', 'Old saved content', 'Old lecture');
  const oldLibrary = { 1: { pages: [oldPage], files: [], syncedAt: '2026-09-20T00:00:00.000Z' } };
  const oldSemantic = { 1: { model: 'qwen3-embedding:0.6b', records: { old: { hash: 'old-hash', vector: 'old-vector' } } } };
  const file = { title: 'Lecture PDF', url: 'https://moodle.telt.unsw.edu.au/mod/resource/view.php?id=7', section: 'Week 1' };
  const lecture = page('1', 'New HTML concept '.repeat(8), 'New lecture');
  const extracted = page('1', 'Extracted PDF concept '.repeat(8), 'Lecture PDF page 1');
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }], library: oldLibrary, semanticIndex: oldSemantic });
  const writes = [];
  context.chrome.storage.local.set = async patch => {
    writes.push(structuredClone(patch));
    Object.assign(saved, structuredClone(patch));
  };
  context.chrome.tabs.sendMessage = async (_tab, message) => message.type === 'PING'
    ? { ok: true, contentVersion: '2026.10.02.1' }
    : message.type === 'SYNC_COURSE'
      ? { ok: true, contentVersion: '2026.10.02.1', data: { pages: [lecture], files: [file], errors: [] } }
      : { ok: true, contentVersion: '2026.10.02.1', data: { base64: 'ZmFrZQ==', mime: 'application/pdf' } };
  context.fetch = async (url, options) => {
    if (String(url).includes('/health')) return { ok: true, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) };
    assert.deepEqual(saved.library, oldLibrary);
    assert.deepEqual(saved.semanticIndex, oldSemantic);
    assert.equal(writes.filter(patch => patch.library || patch.semanticIndex).length, 0);
    if (String(url).endsWith('/extract')) return { ok: true, json: async () => ({ pages: [extracted], kind: 'pdf', truncatedParts: 0, skippedParts: 0, emptyParts: 0 }) };
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: 'qwen3-embedding:0.6b', dimensions: 1024, vectors: body.texts.map(() => 'new-vector') }) };
  };

  await context.sync();

  const snapshotWrites = writes.filter(patch => patch.library || patch.semanticIndex);
  assert.equal(snapshotWrites.length, 1);
  assert.deepEqual(Object.keys(snapshotWrites[0]).sort(), ['library', 'semanticIndex']);
  assert.equal(snapshotWrites[0].library['1'].pages.length, 2);
  assert.ok(Object.keys(snapshotWrites[0].semanticIndex['1'].records).length >= 2);
  assert.equal(saved.library['1'].pages[0].title, 'New lecture');
  assert.deepEqual(saved.semanticIndex, snapshotWrites[0].semanticIndex);
});

test('整课同步最终原子提交失败时保留旧持久化快照', async () => {
  const oldLibrary = { 1: { pages: [page('1', 'Old saved content', 'Old lecture')], files: [], syncedAt: '2026-09-20T00:00:00.000Z' } };
  const oldSemantic = { 1: { model: 'qwen3-embedding:0.6b', records: { old: { hash: 'old-hash', vector: 'old-vector' } } } };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: oldLibrary, semanticIndex: oldSemantic });
  const before = structuredClone(saved);
  const attempted = [];
  context.message = async () => ({ data: { pages: [page('1', 'New content '.repeat(8), 'New lecture')], files: [], errors: [] } });
  context.fetch = async (url, options) => {
    if (String(url).includes('/health')) return { ok: true, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) };
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ model: 'qwen3-embedding:0.6b', dimensions: 1024, vectors: body.texts.map(() => 'new-vector') }) };
  };
  context.chrome.storage.local.set = async patch => {
    attempted.push(structuredClone(patch));
    if (patch.library || patch.semanticIndex) throw new Error('QUOTA_BYTES exceeded');
    Object.assign(saved, structuredClone(patch));
  };

  await context.sync();

  const snapshotAttempts = attempted.filter(patch => patch.library || patch.semanticIndex);
  assert.equal(snapshotAttempts.length, 1);
  assert.deepEqual(Object.keys(snapshotAttempts[0]).sort(), ['library', 'semanticIndex']);
  assert.deepEqual(saved.library, before.library);
  assert.deepEqual(saved.semanticIndex, before.semanticIndex);
  assert.match(get('#status').textContent, /QUOTA_BYTES exceeded/);
  assert.match(get('#status').textContent, /0\/1/);
});

test('生产面板整课同步与清除通过后台课程事务并采纳权威合并状态', async () => {
  const old = { pages: [page('1', 'Old content', 'Old')], files: [] };
  const other = { pages: [page('2', 'Other window content', 'Other')], files: [] };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: old } });
  vm.runInContext(`accountId = '12345'`, context);
  context.chrome.tabs.sendMessage = async () => ({ ok: true, contentVersion: '2026.10.02.1', accountId: '12345' });
  let token = 0;
  let authorityLibrary = { 1: old, 2: other };
  let authoritySemantic = { 2: { model: 'external', records: {} } };
  const requests = [];
  context.chrome.runtime = { sendMessage: async request => {
    if (request.type === 'AI_PROXY') return { ok: false, error: 'AI_PROXY_UNREACHABLE' };
    requests.push(structuredClone(request));
    if (request.type === 'GET_COURSE_INDEX_STATE') return { ok: true, courseToken: token, library: authorityLibrary, semanticIndex: authoritySemantic };
    assert.equal(request.type, 'MUTATE_COURSE_INDEX');
    assert.equal(request.expectedToken, token);
    token++;
    if (request.action === 'delete') {
      const next = { ...authorityLibrary }; delete next[request.courseId]; authorityLibrary = next;
      const nextSemantic = { ...authoritySemantic }; delete nextSemantic[request.courseId]; authoritySemantic = nextSemantic;
      return { ok: true, courseToken: token, library: authorityLibrary, semanticIndex: authoritySemantic, reviewProgress: {} };
    }
    authorityLibrary = { ...authorityLibrary, [request.courseId]: request.courseData };
    if (request.semanticAction === 'set') authoritySemantic = { ...authoritySemantic, [request.courseId]: request.semanticData };
    return { ok: true, courseToken: token, library: authorityLibrary, semanticIndex: authoritySemantic };
  } };
  context.message = async () => ({ data: { pages: [page('1', 'Fresh content', 'Fresh')], files: [], errors: [] } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.sync();
  assert.equal(requests[1].action, 'upsert');
  assert.equal(requests[1].courseData.pages[0].title, 'Fresh');
  assert.equal(vm.runInContext(`library['2'].pages[0].title`, context), 'Other');

  const findByClass = (root, className) => root?.className === className ? root : root?.children?.map(child => findByClass(child, className)).find(Boolean);
  const clear = findByClass(get('#library-details'), 'clear-library');
  await clear.listeners.click();
  assert.equal(requests.at(-1).action, 'delete');
  assert.equal(vm.runInContext(`library['1']`, context), undefined);
  assert.equal(vm.runInContext(`library['2'].pages[0].title`, context), 'Other');
});

test('逐题自测在提交前隐藏答案，提交后才显示反馈并进入下一题', async () => {
  const { context, get, saved } = await setup({ courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [page('1', 'Momentum is mass times velocity. '.repeat(5), 'Momentum')], files: [] } } });
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).endsWith('/practice/generate')) return generatedPractice(options, 'session-123', [
      { id: 'q1', question: '动量如何计算？' },
      { id: 'q2', question: '速度增加时动量怎样变化？' }
    ]);
    return { ok: true, status: 200, json: async () => practiceV2('partial', '方向正确，但请写出质量。', '动量等于质量乘速度。', '讲义给出乘积关系。') };
  };
  context.nextCard();
  await context.startPractice();
  assert.match(calls[0].url, /\/practice\/generate$/);
  assert.equal(calls[0].body.source.title, 'Momentum');
  assert.equal(Object.hasOwn(calls[0].body, 'expectedAnswer'), false);
  assert.equal(get('#practice-question').textContent, '动量如何计算？');
  assert.equal(vm.runInContext("Object.hasOwn(practiceQuestions[0], 'answer')", context), false);
  assert.equal(get('#practice-feedback').hidden, true);
  assert.equal(get('#practice-feedback').children.length, 0);
  assert.equal(get('#practice-source').href, 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1');
  get('#practice-answer').value = '和速度有关';
  await context.submitPractice();
  assert.deepEqual(Object.keys(calls[1].body).sort(), ['attemptId', 'questionId', 'sessionId', 'studentAnswer']);
  assert.equal(calls[1].body.sessionId, 'session-123');
  assert.equal(calls[1].body.questionId, 'q1');
  assert.equal(calls[1].body.studentAnswer, '和速度有关');
  assert.equal(get('#practice-feedback').hidden, false);
  assert.match(get('#practice-feedback').children[2].textContent, /动量等于质量乘速度/);
  assert.equal(get('#practice-next').hidden, false);
  const weak = saved.reviewProgress['1']['https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1|Momentum'];
  assert.equal(weak.practiceVerdict, 'partial');
  assert.equal(weak.practiceWeakQuestion, '');
  assert.deepEqual(weak.practiceErrorTags, ['definition-confusion']);
  assert.equal(JSON.stringify(weak).includes('和速度有关'), false);
  assert.match(get('#today-summary').textContent, /可继续 Physics 的自测/u);
  context.nextPracticeQuestion();
  assert.equal(get('#practice-question').textContent, '速度增加时动量怎样变化？');
  assert.equal(get('#practice-feedback').hidden, true);
  assert.equal(get('#practice-feedback').children.length, 0);
});

test('生成响应内容摘要被篡改时拒绝题目且不写掌握记录', async () => {
  const { context, get, saved } = await setup({ courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [page('1', 'Momentum is mass times velocity. '.repeat(5), 'Momentum')], files: [] } } });
  context.fetch = async (_url, options) => generatedPractice(options, 'tampered-generate', [{ id: 'q1', question: 'What is momentum?' }], { contentDigest: '0'.repeat(64) });
  context.nextCard();
  await context.startPractice();
  assert.match(get('#practice-error').textContent, /内容绑定不一致/u);
  assert.equal(get('#practice-question').textContent, '未能生成题目');
  assert.deepEqual(saved.reviewProgress, {});
});

test('判题不可核验、内容摘要被篡改或生成后来源变化时显示待核对且不写掌握记录', async () => {
  for (const mode of ['ungradable', 'tampered-digest', 'stale-source']) {
    const item = page('1', 'Momentum is mass times velocity. '.repeat(5), mode);
    const { context, get, saved } = await setup({ courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [item], files: [] } } });
    context.fetch = async (url, options) => String(url).endsWith('/practice/generate')
      ? generatedPractice(options, 'session-v2', [{ id: 'q1', itemId: 'practice:item-v2', normalizedStemHash: 'stem-v2', variantKey: 'explanation:understand:definition', question: 'What is momentum?' }])
      : { ok: true, status: 200, json: async () => mode === 'ungradable' ? ({
          ...practiceV2('correct', '无法核验', 'Momentum is mass times velocity.'), verdict: 'ungradable',
          verification: { status: 'unverified', method: 'deterministic-rubric', reasonCodes: ['VERDICT_DISAGREES_WITH_RUBRIC'] }, criterionResults: [], errorTags: []
        }) : practiceV2('correct', '正确', 'Momentum is mass times velocity.', '', mode === 'tampered-digest' ? '0'.repeat(64) : lastPracticeDigest) };
    context.nextCard();
    await context.startPractice();
    if (mode === 'stale-source') vm.runInContext("library['1'].pages[0].text += ' changed'", context);
    get('#practice-answer').value = 'Momentum is mass times velocity.';
    await context.submitPractice();
    assert.match(get('#practice-feedback').children[0].textContent, /待核对/u);
    assert.deepEqual(saved.reviewProgress, {});
    assert.match(get('#practice-feedback').children.at(-1).textContent, /不会写入掌握/u);
  }
});

test('今日学习块的非最后一题即使 incorrect 也不完成当前条目', async () => {
  const item = { ...page('1', 'Focused practice concept '.repeat(12), 'Focused practice'), id: 'focused-practice' };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } } });
  context.fetch = async (url, options) => String(url).endsWith('/practice/generate')
    ? generatedPractice(options, 'focus-practice', [{ id: 'q1', question: '第一题秘密题目' }, { id: 'q2', question: '第二题秘密题目' }])
    : { ok: true, status: 200, json: async () => practiceV2('incorrect', '第一题秘密反馈', '第一题秘密参考答案', '第一题秘密解析') };
  await context.startToday();
  await context.startPractice();
  get('#practice-answer').value = '学生第一题秘密答案';
  await context.submitPractice();
  assert.equal(saved.todayFocusSession.status, 'active');
  assert.equal(saved.todayFocusSession.currentIndex, 0);
  assert.equal(saved.todayFocusSession.completed.length, 0);
  assert.equal(get('#focus-receipt').hidden, true);
  assert.equal(saved.reviewProgress['1']['focused-practice'].practiceVerdict, 'incorrect');
  assert.equal(get('#practice-next').hidden, false);
});

test('今日学习块最后一题按整轮最严重 verdict 原子写入复习记录与块回执', async () => {
  const item = { ...page('1', 'Atomic practice concept '.repeat(12), 'Atomic practice'), id: 'atomic-practice' };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } } });
  const writes = [];
  context.chrome.storage.local.set = async patch => { writes.push(structuredClone(patch)); Object.assign(saved, structuredClone(patch)); };
  context.fetch = async (url, options) => {
    if (String(url).endsWith('/practice/generate')) return generatedPractice(options, 'atomic-session', [{ id: 'q1', question: '严重题目不得进入块' }, { id: 'q2', question: '轻微题目不得进入块' }]);
    const request = JSON.parse(options.body);
    return request.questionId === 'q1'
      ? { ok: true, status: 200, json: async () => practiceV2('incorrect', '严重反馈不得进入块', '严重参考答案不得进入块', '严重解析不得进入块') }
      : { ok: true, status: 200, json: async () => practiceV2('correct', '正确反馈不得进入块', '正确参考答案不得进入块', '正确解析不得进入块') };
  };
  await context.startToday();
  await context.startPractice();
  get('#practice-answer').value = '学生严重题答案不得进入块';
  await context.submitPractice();
  context.nextPracticeQuestion();
  get('#practice-answer').value = '学生轻微题答案不得进入块';
  await context.submitPractice();
  const finalWrite = writes.findLast(patch => patch.reviewProgress && patch.todayFocusSession);
  assert.ok(finalWrite, '最后一题必须在同一次 storage.set 写入复习与学习块');
  assert.equal(finalWrite.reviewProgress['1']['atomic-practice'].practiceVerdict, 'incorrect');
  assert.equal(finalWrite.todayFocusSession.completed[0].outcome, 'practice:incorrect');
  assert.equal(saved.todayFocusSession.currentIndex, 0);
  assert.equal(saved.todayFocusSession.completed.length, 1);
  assert.equal(get('#focus-receipt').hidden, false);
  assert.match(get('#focus-receipt-title').textContent, /学习记录已保存/);
  const serialized = JSON.stringify(saved.todayFocusSession);
  for (const forbidden of ['严重题目', '轻微题目', '学生严重题答案', '学生轻微题答案', '严重反馈', '正确反馈', '严重参考答案', '正确参考答案']) assert.equal(serialized.includes(forbidden), false, `学习块泄露了：${forbidden}`);
});

test('今日学习块最后一题保存失败时不完成不前进并保留可重试输入', async () => {
  const item = { ...page('1', 'Retry practice concept '.repeat(12), 'Retry practice'), id: 'retry-practice' };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [item], files: [] } } });
  context.fetch = async (url, options) => {
    if (String(url).endsWith('/practice/generate')) return generatedPractice(options, 'retry-session', [{ id: 'q1', question: '重试第一题' }, { id: 'q2', question: '重试最后一题' }]);
    const request = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => practiceV2(request.questionId === 'q1' ? 'correct' : 'partial', '重试秘密反馈', '重试秘密参考答案', '重试秘密解析') };
  };
  await context.startToday();
  await context.startPractice();
  get('#practice-answer').value = '第一题答案';
  await context.submitPractice();
  context.nextPracticeQuestion();
  const focusBefore = structuredClone(saved.todayFocusSession);
  get('#practice-answer').value = '必须保留的最后一题答案';
  const originalSet = context.chrome.storage.local.set;
  context.chrome.storage.local.set = async patch => {
    if (patch.reviewProgress && patch.todayFocusSession) throw new Error('QUOTA_BYTES exceeded');
    return originalSet(patch);
  };
  await context.submitPractice();
  assert.deepEqual(saved.todayFocusSession, focusBefore);
  assert.deepEqual(saved.reviewProgress, {});
  assert.equal(get('#practice-answer').value, '必须保留的最后一题答案');
  assert.equal(get('#practice-answer').disabled, false);
  assert.equal(get('#practice-submit').hidden, false);
  assert.equal(get('#practice-submit').disabled, false);
  assert.equal(get('#focus-receipt').hidden, true);
  assert.equal(vm.runInContext('practiceSubmitted', context), false);
  assert.match(get('#status').textContent, /自测记录保存失败/);
  context.chrome.storage.local.set = originalSet;
  await context.submitPractice();
  assert.equal(saved.todayFocusSession.completed.length, 1);
  assert.equal(saved.reviewProgress['1']['retry-practice'].practiceVerdict, 'partial');
  assert.equal(get('#focus-receipt').hidden, false);
});

test('错题知识点优先进入复习队列，同一轮全部答对后解除薄弱标记', async () => {
  const weakPage = page('1', 'Weak concept '.repeat(12), 'Weak');
  const normalPage = { ...page('1', 'Normal concept '.repeat(12), 'Normal'), id: 'normal', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const now = new Date().toISOString();
  const weakKey = `${weakPage.url}|${weakPage.title}`;
  const normalKey = normalPage.id;
  const { context, get, saved } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [normalPage, weakPage], files: [] } },
    reviewProgress: { 1: {
      [normalKey]: { contentHash: 'old', dueAt: now, introducedAt: now },
      [weakKey]: { contentHash: 'pending', dueAt: now, introducedAt: now, practiceVerdict: 'incorrect', practiceWeakQuestion: '解释薄弱概念' }
    } }
  });
  vm.runInContext(`reviewProgress['1'][${JSON.stringify(weakKey)}].contentHash = hashText(library['1'].pages[1].text)`, context);
  context.nextCard();
  assert.equal(get('#card').children[1].textContent, 'Weak');
  assert.equal(get('#card').children[0].textContent, 'WEAK POINT');
  context.fetch = async (url, options) => String(url).endsWith('/practice/generate')
    ? generatedPractice(options, 'all-correct', [{ id: 'q1', question: '解释薄弱概念' }])
    : { ok: true, status: 200, json: async () => practiceV2('correct', '正确', '正确解释') };
  await context.startPractice();
  get('#practice-answer').value = '正确解释';
  await context.submitPractice();
  assert.equal(saved.reviewProgress['1'][weakKey].practiceVerdict, null);
  assert.equal(saved.reviewProgress['1'][weakKey].practiceWeakQuestion, '');
});

test('空答案不发送核对请求，也不揭示参考答案', async () => {
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Concept '.repeat(20))], files: [] } } });
  let calls = 0;
  context.fetch = async (_url, options) => { calls++; return generatedPractice(options, 'session-empty', [{ id: 'q1', question: '解释概念' }]); };
  context.nextCard();
  await context.startPractice();
  await context.submitPractice();
  assert.equal(calls, 1);
  assert.equal(get('#practice-feedback').hidden, true);
  assert.match(get('#practice-error').textContent, /请先写下/);
});

test('切换卡片后忽略较晚返回的生成结果和核对结果', async () => {
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'First '.repeat(20), 'First'), page('1', 'Second '.repeat(20), 'Second')], files: [] } } });
  let finishGenerate;
  context.fetch = async () => new Promise(resolve => { finishGenerate = resolve; });
  context.nextCard();
  const pendingGenerate = context.startPractice();
  for (let i = 0; i < 20 && typeof finishGenerate !== 'function'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finishGenerate, 'function');
  const oldDigest = practiceDigest(vm.runInContext('practiceSource.excerpt', context));
  context.nextCard();
  finishGenerate({ ok: true, status: 200, json: async () => ({ schemaVersion: 2, sessionId: 'old-session', contentDigest: oldDigest, questions: [{ id: 'q1', question: '旧题' }] }) });
  await pendingGenerate;
  assert.equal(get('#practice-panel').hidden, true);
  assert.notEqual(get('#practice-question').textContent, '旧题');

  let finishCheck;
  context.fetch = async (url, options) => String(url).endsWith('/practice/generate')
    ? generatedPractice(options, 'new-session', [{ id: 'q1', question: '新题' }])
    : new Promise(resolve => { finishCheck = resolve; });
  await context.startPractice();
  get('#practice-answer').value = '我的回答';
  const pendingCheck = context.submitPractice();
  context.nextCard();
  finishCheck({ ok: true, status: 200, json: async () => practiceV2('correct', '正确', '旧反馈答案') });
  await pendingCheck;
  assert.equal(get('#practice-panel').hidden, true);
  assert.equal(get('#practice-feedback').children.length, 0);
});

test('练习服务失败时显示错误且保留未提交的回答', async () => {
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Concept '.repeat(20))], files: [] } } });
  context.fetch = async (url, options) => String(url).endsWith('/practice/generate')
    ? generatedPractice(options, 'session-error', [{ id: 'q1', question: '解释概念' }])
    : { ok: false, status: 503, json: async () => ({ error: '模型暂不可用' }) };
  context.nextCard();
  await context.startPractice();
  get('#practice-answer').value = '我的解释';
  await context.submitPractice();
  assert.equal(get('#practice-answer').value, '我的解释');
  assert.equal(get('#practice-feedback').hidden, true);
  assert.match(get('#practice-error').textContent, /模型暂不可用/);
  assert.equal(get('#practice-submit').disabled, false);
});

test('切换课程与重新同步时清除练习状态', async () => {
  const { context, get } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: { 1: { pages: [page('1', 'First '.repeat(20), 'First')], files: [] }, 2: { pages: [page('2', 'Second '.repeat(20), 'Second')], files: [] } }
  });
  context.fetch = async (_url, options) => generatedPractice(options, 'session-course', [{ id: 'q1', question: '第一门课的题' }]);
  context.nextCard();
  await context.startPractice();
  assert.equal(get('#practice-panel').hidden, false);
  get('#review-course').value = '2';
  get('#review-course').listeners.change();
  assert.equal(get('#practice-panel').hidden, true);
  assert.equal(get('#practice-question').textContent, '');
  await context.startPractice();
  assert.equal(get('#practice-panel').hidden, false);
  context.invalidateCourse('2');
  assert.equal(get('#practice-panel').hidden, true);
  assert.equal(get('#practice-feedback').children.length, 0);
});

test('单项重试只合并目标页面与文件链接，保留复习记录并复用旧向量', async () => {
  const oldPage = page('1', 'Old concept '.repeat(12), 'Old');
  const newPage = { ...page('1', 'New concept '.repeat(12), 'New'), url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=9', id: 'new-page' };
  const retryItem = { url: newPage.url, title: 'New', section: 'Week 2', error: 'HTTP 503' };
  const oldFile = { url: 'https://moodle.telt.unsw.edu.au/pluginfile.php/1/old.pdf', title: 'Old PDF' };
  const newFile = { url: 'https://moodle.telt.unsw.edu.au/pluginfile.php/1/new.pdf', title: 'New PDF' };
  const progress = { 1: { old: { rating: 'good', dueAt: '2026-10-01T00:00:00Z' } } };
  const { context, saved, get } = await setup({
    courses: [{ id: '1', title: 'One' }], reviewProgress: progress,
    library: { 1: { pages: [oldPage], files: [oldFile], errors: ['New: HTTP 503'], failedActivities: [retryItem], unavailableActivities: [], syncedAt: '2026-09-23T00:00:00Z' } },
    semanticIndex: {}
  });
  const oldSegment = context.semanticSegments({ pages: [oldPage] }, '1').segments[0];
  const oldKey = oldSegment.key;
  saved.semanticIndex['1'] = { model: 'qwen3-embedding:0.6b', schemaVersion: 2, records: { [oldKey]: { hash: oldSegment.hash, vector: 'old-vector' } } };
  vm.runInContext(`semanticIndex['1'] = { model: 'qwen3-embedding:0.6b', schemaVersion: 2, records: { [${JSON.stringify(oldKey)}]: { hash: ${JSON.stringify(oldSegment.hash)}, vector: 'old-vector' } } }`, context);
  context.message = async (type, payload) => {
    assert.equal(type, 'RETRY_ACTIVITY');
    assert.equal(payload.courseId, '1');
    return { data: { status: 'ok', page: newPage, files: [oldFile, newFile] } };
  };
  const embedded = [];
  context.fetch = async (url, options) => {
    if (String(url).includes('/health')) return { ok: true, json: async () => ({ ok: true, state: 'ready', serviceVersion: '2026.10.02.1', provider: 'ollama', model: 'qwen3.5:9b', embeddingModel: 'qwen3-embedding:0.6b', capabilities: ['answer', 'embed', 'practice', 'practice-v2', 'vision'] }) };
    if (String(url).endsWith('/embed')) {
      const body = JSON.parse(options.body); embedded.push(...body.texts);
      return { ok: true, json: async () => ({ model: 'qwen3-embedding:0.6b', dimensions: 1024, vectors: body.texts.map(() => 'new-vector') }) };
    }
    throw new Error('unexpected request');
  };
  const row = get('#library-details').children[0].children[1].children.find(child => child.className === 'activity-retry');
  assert.ok(row);
  assert.equal(row.children[2].textContent, '重试此活动');
  await context.retryActivity({ id: '1', title: 'One' }, retryItem);
  assert.equal(saved.library['1'].pages.length, 2);
  assert.equal(saved.library['1'].files.length, 2);
  assert.equal(saved.library['1'].files[1].indexStatus, 'linked');
  assert.equal(saved.library['1'].failedActivities.length, 0);
  assert.equal(saved.library['1'].errors.length, 0);
  assert.equal(saved.library['1'].syncedAt, '2026-09-23T00:00:00Z');
  assert.deepEqual(saved.reviewProgress, progress);
  assert.equal(embedded.length, 1);
  assert.match(embedded[0], /New concept/);
  assert.equal(saved.semanticIndex['1'].records[oldKey].vector, 'old-vector');
});

test('生产面板单项重试以课程 token 提交并保留后台中的其他课程', async () => {
  const target = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'Target', section: 'Week 8', error: 'HTTP 500' };
  const base = { pages: [page('1', 'Base '.repeat(20))], files: [], errors: ['Target: HTTP 500'], failedActivities: [target] };
  const other = { pages: [page('2', 'External '.repeat(20), 'External')], files: [] };
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: base } });
  vm.runInContext(`accountId = '12345'`, context);
  context.chrome.tabs.sendMessage = async () => ({ ok: true, contentVersion: '2026.10.02.1', accountId: '12345' });
  let mutation;
  context.chrome.runtime = { sendMessage: async request => {
    if (request.type === 'GET_COURSE_INDEX_STATE') return { ok: true, courseToken: 7, library: { 1: base, 2: other }, semanticIndex: {} };
    mutation = structuredClone(request);
    return { ok: true, courseToken: 8, library: { 1: request.courseData, 2: other }, semanticIndex: {} };
  } };
  context.message = async () => ({ data: { status: 'ok', page: { ...page('1', 'Recovered '.repeat(12), 'Target'), url: target.url }, files: [] } });
  context.fetch = async () => { throw new Error('offline'); };
  await context.retryActivity({ id: '1', title: 'One' }, target);
  assert.equal(mutation.type, 'MUTATE_COURSE_INDEX');
  assert.equal(mutation.expectedToken, 7);
  assert.equal(mutation.action, 'upsert');
  assert.equal(vm.runInContext(`library['1'].pages.length`, context), 2);
  assert.equal(vm.runInContext(`library['2'].pages[0].title`, context), 'External');
});

test('单项重试仍不可访问时更新状态，不丢失其他失败项', async () => {
  const target = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'Target', section: 'Week 8', error: 'HTTP 500' };
  const other = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=9', title: 'Other', section: 'Week 9', error: 'HTTP 404' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Base '.repeat(20))], files: [], errors: ['Target: HTTP 500', 'Other: HTTP 404'], failedActivities: [target, other] } } });
  context.message = async () => ({ data: { status: 'unavailable', item: { url: target.url, title: target.title, section: target.section, reason: 'Moodle 跳回首页' } } });
  await context.retryActivity({ id: '1', title: 'One' }, target);
  assert.equal(saved.library['1'].failedActivities.length, 1);
  assert.equal(saved.library['1'].failedActivities[0].title, 'Other');
  assert.deepEqual(saved.library['1'].errors, ['Other: HTTP 404']);
  assert.equal(saved.library['1'].unavailableActivities[0].reason, 'Moodle 跳回首页');
});

test('重试保存失败时不声称成功，也不改动本机旧索引', async () => {
  const target = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'Target', section: 'Week 8', error: 'HTTP 500' };
  const old = { pages: [page('1', 'Base '.repeat(20))], files: [], errors: ['Target: HTTP 500'], failedActivities: [target] };
  const { context, saved, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: old } });
  context.message = async () => ({ data: { status: 'ok', page: { ...page('1', 'Recovered text', 'Target'), url: target.url }, files: [] } });
  context.chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
  await context.retryActivity({ id: '1', title: 'One' }, target);
  assert.equal(saved.library['1'].pages.length, 1);
  assert.equal(saved.library['1'].failedActivities.length, 1);
  assert.match(get('#status').textContent, /QUOTA_BYTES exceeded/);
});

test('重复重试只发送一次请求，重试期间禁止清除课程', async () => {
  const target = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'Target', section: 'Week 8' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Base '.repeat(20))], files: [], unavailableActivities: [target] } } });
  let finish, calls = 0;
  context.message = async () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = context.retryActivity({ id: '1', title: 'One' }, target);
  await new Promise(resolve => setImmediate(resolve));
  await context.retryActivity({ id: '1', title: 'One' }, target);
  assert.equal(calls, 1);
  const detail = context.document.querySelector('#library-details').children[0];
  await detail.children[2].listeners.click();
  assert.ok(saved.library['1']);
  finish({ data: { status: 'ok', page: { ...page('1', 'Recovered text', 'Target'), url: target.url }, files: [] } });
  await first;
  assert.equal(saved.library['1'].pages.length, 2);
});

test('一门课程重试期间禁止另一门课程写入旧快照', async () => {
  const firstTarget = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'First', section: 'Week 1' };
  const secondTarget = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=9', title: 'Second', section: 'Week 2' };
  const { context, saved } = await setup({
    courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }],
    library: {
      1: { pages: [page('1', 'One '.repeat(20))], files: [], unavailableActivities: [firstTarget] },
      2: { pages: [page('2', 'Two '.repeat(20))], files: [], unavailableActivities: [secondTarget] }
    }
  });
  let finish, retryCalls = 0;
  context.message = async () => { retryCalls++; return new Promise(resolve => { finish = resolve; }); };
  const first = context.retryActivity({ id: '1', title: 'One' }, firstTarget);
  await new Promise(resolve => setImmediate(resolve));
  await context.retryActivity({ id: '2', title: 'Two' }, secondTarget);
  assert.equal(retryCalls, 1);
  finish({ data: { status: 'unavailable', item: { ...firstTarget, reason: '尚未开放' } } });
  await first;
  assert.ok(saved.library['2']);
  assert.equal(saved.library['2'].unavailableActivities.length, 1);
});

test('同名同错误的两个活动中只删除被重试的一条错误摘要', async () => {
  const target = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'Lecture', section: 'Week 8', error: 'HTTP 500' };
  const other = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=9', title: 'Lecture', section: 'Week 9', error: 'HTTP 500' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Base '.repeat(20))], files: [], errors: ['Lecture: HTTP 500', 'Lecture: HTTP 500'], failedActivities: [target, other] } } });
  context.message = async () => ({ data: { status: 'unavailable', item: { url: target.url, title: target.title, section: target.section, reason: '尚未开放' } } });
  await context.retryActivity({ id: '1', title: 'One' }, target);
  assert.equal(saved.library['1'].failedActivities.length, 1);
  assert.equal(saved.library['1'].failedActivities[0].url, other.url);
  assert.deepEqual(saved.library['1'].errors, ['Lecture: HTTP 500']);
});

test('清除课程写入期间禁止旧页面启动活动重试', async () => {
  const target = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'Target', section: 'Week 8' };
  const { context, saved } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Base '.repeat(20))], files: [], unavailableActivities: [target] } } });
  let finishClear, retryCalls = 0;
  context.chrome.storage.local.set = patch => new Promise(resolve => { finishClear = () => { Object.assign(saved, structuredClone(patch)); resolve(); }; });
  context.message = async () => { retryCalls++; return { data: { status: 'ok', page: page('1', 'Recovered'), files: [] } }; };
  const detail = context.document.querySelector('#library-details').children[0];
  const clearing = detail.children[2].listeners.click();
  await context.retryActivity({ id: '1', title: 'One' }, target);
  assert.equal(retryCalls, 0);
  finishClear();
  await clearing;
  assert.equal(saved.library['1'], undefined);
});

test('整课同步期间锁定同一课程的清除与单项重试', async () => {
  const target = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'Target', section: 'Week 8' };
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [page('1', 'Base '.repeat(20))], files: [], unavailableActivities: [target] } } });
  let finishSync, calls = 0;
  context.message = async () => { calls++; return new Promise(resolve => { finishSync = resolve; }); };
  const syncing = context.sync();
  await new Promise(resolve => setImmediate(resolve));
  const detail = context.document.querySelector('#library-details').children[0];
  assert.equal(detail.children[2].disabled, true);
  await context.retryActivity({ id: '1', title: 'One' }, target);
  assert.equal(calls, 1);
  finishSync({ data: { pages: [page('1', 'Fresh '.repeat(20))], files: [], errors: [], failedActivities: [], unavailableActivities: [] } });
  await syncing;
});

test('课程分节优先使用 sectionGroup，并兼容中英文旧索引与文件页后缀', async () => {
  const pages = [
    { ...page('1', 'A'.repeat(90), 'A'), section: 'Week 01 · Page 2' },
    { ...page('1', 'B'.repeat(90), 'B'), section: '第1週' },
    { ...page('1', 'C'.repeat(90), 'C'), section: 'Old heading', sectionGroup: '专题：材料选择' },
    { ...page('1', 'D'.repeat(90), 'D'), section: '' }
  ];
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } } });
  assert.equal(context.pageSectionKey(pages[0]), 'week:1');
  assert.equal(context.pageSectionKey(pages[1]), 'week:1');
  assert.equal(context.sectionLabel(pages[0]), 'Week 01');
  assert.equal(context.sectionLabel(pages[2]), '专题:材料选择');
  const options = context.sectionOptions('1');
  assert.equal(options.map(item => item.key).join('|'), 'week:1|section:专题:材料选择|__unsectioned__');
  assert.equal(options[0].pages.length, 2);
  assert.equal(options[2].label, '其他内容');
});

test('提问的关键词和语义检索都严格限制在所选分节', async () => {
  const first = { ...page('1', 'Momentum alpha concept. '.repeat(5), 'Alpha'), id: 'alpha', sectionGroup: 'Week 1' };
  const second = { ...page('1', 'Momentum beta concept. '.repeat(5), 'Beta'), id: 'beta', sectionGroup: 'Week 2', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const vector = Buffer.from([127, ...Array(1023).fill(0)]).toString('base64');
  const { context } = await setup({ courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [first, second], files: [] } } });
  const segments = context.semanticSegments({ pages: [first, second] }, '1').segments;
  vm.runInContext(`semanticIndex['1'] = { model: 'qwen3-embedding:0.6b', schemaVersion: 2, records: {} }`, context);
  for (const segment of segments) vm.runInContext(`semanticIndex['1'].records[${JSON.stringify(segment.key)}] = { hash: ${JSON.stringify(segment.hash)}, vector: ${JSON.stringify(vector)} }`, context);
  context.fetch = async () => ({ ok: true, json: async () => ({ model: 'qwen3-embedding:0.6b', dimensions: 1024, vectors: [vector] }) });
  assert.equal(context.rank('Momentum', '1', 'week:2').map(item => item.title).join('|'), 'Beta');
  const semantic = await context.semanticRank('Momentum', '1', 'week:2');
  assert.equal(semantic.map(item => item.title).join('|'), 'Beta');
});

test('切换课程会重建分节并清除旧提问和复习状态', async () => {
  const one = { ...page('1', 'A'.repeat(90), 'One page'), sectionGroup: 'Week 1' };
  const two = { ...page('2', 'B'.repeat(90), 'Two page'), sectionGroup: 'Module B' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }, { id: '2', title: 'Two' }], library: { 1: { pages: [one], files: [] }, 2: { pages: [two], files: [] } } });
  get('#ask-section').value = 'week:1'; get('#answer').hidden = false; get('#answer').textContent = '旧答案';
  get('#ask-course').value = '2'; get('#ask-course').listeners.change();
  assert.equal(get('#ask-section').value, '');
  assert.equal(get('#ask-section').options[1].textContent, 'Module B（1）');
  assert.equal(get('#answer').hidden, true);
  get('#review-section').value = 'week:1';
  get('#review-course').value = '2'; get('#review-course').listeners.change();
  assert.equal(get('#review-section').value, '');
  assert.equal(get('#card').children[1].textContent, 'Two page');
  assert.equal(get('#practice-panel').hidden, true);
});

test('课程详情按分节显示覆盖数和可打开的 Moodle 来源', async () => {
  const first = { ...page('1', 'A'.repeat(90), 'Lecture A'), sectionGroup: 'Week 1' };
  const second = { ...page('1', 'B'.repeat(90), 'Lecture B'), sectionGroup: 'Week 1', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const { get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } } });
  const links = get('#library-details').children[0].children[1];
  const coverage = links.children.find(child => child.className === 'section-coverage');
  assert.ok(coverage);
  assert.match(coverage.children[0].textContent, /Week 1 · 2 个内容/);
  assert.equal(coverage.children[1].children.length, 2);
  assert.equal(coverage.children[1].children[0].href, first.url);
});

test('无分节课程只显示全部内容并禁用分节选择', async () => {
  const noSection = { ...page('1', 'A'.repeat(90), 'Overview'), section: '' };
  const { get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [noSection], files: [] } } });
  assert.equal(get('#ask-section').disabled, true);
  assert.equal(get('#ask-section').options.length, 1);
  assert.match(get('#ask-section').options[0].textContent, /暂无分节/);
  assert.equal(get('#review-section').disabled, true);
});

test('学习覆盖只采纳当前正文且可核验的自评或自测记录', async () => {
  const now = Date.parse('2026-09-23T04:00:00.000Z');
  const pages = [
    { ...page('1', 'A'.repeat(90), 'Valid rating'), id: 'rating', sectionGroup: 'Week 1' },
    { ...page('1', 'B'.repeat(90), 'Valid practice'), id: 'practice', sectionGroup: 'Week 1' },
    { ...page('1', 'C'.repeat(90), 'Bad date'), id: 'bad-date', sectionGroup: 'Week 1' },
    { ...page('1', 'D'.repeat(90), 'Changed'), id: 'changed', sectionGroup: 'Week 2' }
  ];
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } } });
  const records = {
    rating: { contentHash: context.hashText(pages[0].text), reviews: 1, rating: 'good', intervalDays: 3, lastReviewedAt: '2026-09-21T04:00:00.000Z', dueAt: '2026-09-26T04:00:00.000Z' },
    practice: { contentHash: context.hashText(pages[1].text), practiceAttempts: 1, lastPracticeAt: '2026-09-22T04:00:00.000Z', practiceVerdict: null, dueAt: '2026-09-24T04:00:00.000Z' },
    'bad-date': { contentHash: context.hashText(pages[2].text), reviews: 1, rating: 'good', intervalDays: 9, lastReviewedAt: 'not-a-date', dueAt: '2026-09-20T04:00:00.000Z' },
    changed: { contentHash: 'old-body', reviews: 2, rating: 'easy', lastReviewedAt: '2026-09-22T04:00:00.000Z', dueAt: '2026-09-20T04:00:00.000Z' }
  };
  vm.runInContext(`reviewProgress['1'] = ${JSON.stringify(records)}`, context);
  const snapshot = context.masterySnapshot('1', now);
  assert.equal(snapshot.totals.eligible, 4);
  assert.equal(snapshot.totals.practiced, 2);
  assert.equal(snapshot.totals.stable, 2);
  assert.equal(snapshot.totals.due, 0);
  assert.equal(snapshot.totals.changed, 1);
});

test('学习覆盖拒绝无时区日期、非整数次数和未知自测判定', async () => {
  const now = Date.parse('2026-09-23T04:00:00.000Z');
  const pages = ['date-only', 'string-count', 'unknown-verdict'].map((id, index) => ({ ...page('1', String(index).repeat(90), id), id, sectionGroup: 'Week 1' }));
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } } });
  const records = {
    'date-only': { contentHash: context.hashText(pages[0].text), reviews: 1, rating: 'good', lastReviewedAt: '2026-09-22', dueAt: '2026-09-24' },
    'string-count': { contentHash: context.hashText(pages[1].text), reviews: '1', rating: 'good', lastReviewedAt: '2026-09-22T04:00:00.000Z', dueAt: '2026-09-24T04:00:00.000Z' },
    'unknown-verdict': { contentHash: context.hashText(pages[2].text), practiceAttempts: 1, lastPracticeAt: '2026-09-22T04:00:00.000Z', practiceVerdict: 'unknown', dueAt: '2026-09-24T04:00:00.000Z' }
  };
  vm.runInContext(`reviewProgress['1'] = ${JSON.stringify(records)}`, context);
  const snapshot = context.masterySnapshot('1', now);
  assert.equal(snapshot.totals.eligible, 3);
  assert.equal(snapshot.totals.practiced, 0);
  assert.equal(snapshot.totals.due, 0);
  assert.equal(snapshot.totals.stable, 0);
});

test('学习覆盖区分到期与薄弱提示并按行动优先级排列分节', async () => {
  const now = Date.parse('2026-09-23T04:00:00.000Z');
  const weak = { ...page('1', 'W'.repeat(90), 'Weak'), id: 'weak', sectionGroup: 'Week 3' };
  const due = { ...page('1', 'D'.repeat(90), 'Due'), id: 'due', sectionGroup: 'Week 2' };
  const newPage = { ...page('1', 'N'.repeat(90), 'New'), id: 'new', sectionGroup: 'Week 1' };
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [newPage, due, weak], files: [] } } });
  vm.runInContext(`reviewProgress['1'] = ${JSON.stringify({
    weak: { contentHash: context.hashText(weak.text), practiceAttempts: 1, lastPracticeAt: '2026-09-22T04:00:00.000Z', practiceVerdict: 'partial', dueAt: '2026-09-23T04:00:00.000Z' },
    due: { contentHash: context.hashText(due.text), reviews: 1, rating: 'good', lastReviewedAt: '2026-09-20T04:00:00.000Z', intervalDays: 3, dueAt: '2026-09-22T04:00:00.000Z' }
  })}`, context);
  const snapshot = context.masterySnapshot('1', now);
  assert.equal(snapshot.totals.due, 2);
  assert.equal(snapshot.totals.weak, 1);
  assert.equal(snapshot.totals.partial, 1);
  assert.equal(snapshot.totals.stable, 0);
  assert.equal(snapshot.sections.map(item => item.key).join('|'), 'week:3|week:2|week:1');
});

test('学习覆盖按卡片身份去重并用课程总量计算百分比', async () => {
  const first = { ...page('1', 'A'.repeat(90), 'First'), id: 'same', sectionGroup: 'Week 1' };
  const duplicate = { ...first, sectionGroup: 'Week 9' };
  const rest = Array.from({ length: 9 }, (_, i) => ({ ...page('1', String(i).repeat(90), `Other ${i}`), id: `other-${i}`, sectionGroup: 'Week 2' }));
  const { context } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, duplicate, ...rest], files: [] } } });
  vm.runInContext(`reviewProgress['1'] = { same: { contentHash: ${JSON.stringify(context.hashText(first.text))}, reviews: 1, rating: 'hard', lastReviewedAt: '2026-09-22T00:00:00.000Z', dueAt: '2099-01-01T00:00:00.000Z' }, 'other-0': { contentHash: ${JSON.stringify(context.hashText(rest[0].text))}, practiceAttempts: 1, lastPracticeAt: '2026-09-22T00:00:00.000Z', practiceVerdict: null, dueAt: '2099-01-01T00:00:00.000Z' } }`, context);
  const snapshot = context.masterySnapshot('1', Date.parse('2026-09-23T00:00:00.000Z'));
  assert.equal(snapshot.totals.eligible, 10);
  assert.equal(snapshot.totals.practiced, 2);
  assert.equal(context.masteryCoverage(snapshot.totals), 20);
  assert.equal(snapshot.sections.some(item => item.key === 'week:9'), false);
});

test('学习覆盖渲染固定说明、同步范围提示和可读进度条', async () => {
  const target = { ...page('1', 'A'.repeat(90), 'Target'), id: 'target', sectionGroup: 'Week 4' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [target], files: [], skippedPages: 1 } } });
  context.renderMastery();
  const content = get('#mastery-content');
  const overview = content.children[0];
  const meter = overview.children.find(child => child.className === 'mastery-meter');
  const allText = JSON.stringify(content, (key, value) => key === 'listeners' ? undefined : value);
  assert.equal(meter['aria-label'], '已练习 0 项，共 1 项可练习内容');
  assert.match(allText, /不代表客观掌握程度或课程成绩/);
  assert.match(allText, /当前覆盖范围可能不完整/);
  assert.doesNotMatch(allText, /掌握率|已掌握|预测成绩|正确率/);
});

test('薄弱分节按钮精确切换分节并进入该节现有复习队列', async () => {
  const first = { ...page('1', 'A'.repeat(90), 'First'), id: 'first', sectionGroup: 'Week 1' };
  const second = { ...page('1', 'B'.repeat(90), 'Second'), id: 'second', sectionGroup: 'Week 2' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [first, second], files: [] } } });
  context.renderMastery();
  const sections = get('#mastery-content').children[1];
  const weekTwo = sections.children.find(row => row.children[0].children[0].textContent === 'Week 2');
  await weekTwo.children.at(-1).listeners.click();
  assert.equal(get('#review-section').value, 'week:2');
  assert.equal(get('#card').children[1].textContent, 'Second');
});

test('切换提问分节后忽略旧分节的异步语义结果', async () => {
  const first = { ...page('1', 'Momentum '.repeat(20), 'First'), sectionGroup: 'Week 1' };
  const second = { ...page('1', 'Force '.repeat(20), 'Second'), sectionGroup: 'Week 2', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' };
  const vector = Buffer.from([127, ...Array(1023).fill(0)]).toString('base64');
  const { context, get } = await setup({ courses: [{ id: '1', title: 'Physics' }], library: { 1: { pages: [first, second], files: [] } } });
  const segment = context.semanticSegments({ pages: [first] }, '1').segments[0];
  vm.runInContext(`semanticIndex['1'] = { model: 'qwen3-embedding:0.6b', schemaVersion: 2, records: { [${JSON.stringify(segment.key)}]: { hash: ${JSON.stringify(segment.hash)}, vector: ${JSON.stringify(vector)} } } }`, context);
  let finish;
  context.fetch = async () => new Promise(resolve => { finish = resolve; });
  get('#ask-section').value = 'week:1'; get('#question').value = 'Momentum';
  const pending = context.ask();
  get('#ask-section').value = 'week:2'; get('#ask-section').listeners.change();
  finish({ ok: true, json: async () => ({ model: 'qwen3-embedding:0.6b', dimensions: 1024, vectors: [vector] }) });
  await pending;
  assert.equal(get('#answer').hidden, true);
  assert.equal(get('#sources').children.length, 0);
});

test('按分节复习不能绕过全课程每日十个新知识点上限', async () => {
  const pages = Array.from({ length: 12 }, (_, i) => ({ ...page('1', 'Concept '.repeat(15), `Card ${i + 1}`), id: `card-${i + 1}`, sectionGroup: i < 10 ? 'Week 1' : 'Week 2' }));
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const introducedAt = new Date().toISOString();
  const records = Object.fromEntries(pages.slice(0, 10).map(item => [item.id, { dueAt: future, introducedAt, contentHash: 'x' }]));
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages, files: [] } }, reviewProgress: { 1: records } });
  get('#review-section').value = 'week:2';
  assert.equal(context.dueReviewPages('1', context.reviewPages('1', 'week:2')).pages.length, 0);
  context.nextCard();
  assert.match(get('#card').children[0].textContent, /今天的新知识点已完成|本轮到期复习已完成/);
});

test('重新同步后所选分节消失时回到全部内容并显示新卡片', async () => {
  const oldPage = { ...page('1', 'Old '.repeat(20), 'Old week'), sectionGroup: 'Week 1' };
  const newPage = { ...page('1', 'New '.repeat(25), 'New module'), sectionGroup: 'Module B', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=22' };
  const { context, get } = await setup({ courses: [{ id: '1', title: 'One' }], library: { 1: { pages: [oldPage], files: [] } } });
  get('#review-section').value = 'week:1';
  context.nextCard();
  context.message = async () => ({ data: { pages: [newPage], files: [], errors: [], failedActivities: [], unavailableActivities: [] } });
  context.fetch = async () => { throw new TypeError('offline'); };
  await context.sync();
  assert.equal(get('#review-section').value, '');
  assert.equal(get('#card').children[1].textContent, 'New module');
});

test('变化比较忽略数组重排、文件标题和 URL 参数表现差异', async () => {
  const { context } = await setup();
  const old = {
    syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: { schemaVersion: 1 }, errors: [], failedActivities: [], skippedPages: 0, skippedCourseParts: 0,
    pages: [
      { ...page('1', 'Alpha', 'A'), id: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?b=2&id=1' },
      { ...page('1', 'Beta', 'B'), id: 'stable-b', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=2' }
    ],
    files: [{ title: 'Old title', url: 'https://moodle.telt.unsw.edu.au/pluginfile.php/1/file.pdf?forcedownload=1&b=2&a=1' }],
    events: []
  };
  const current = {
    errors: [], failedActivities: [], skippedPages: 0, skippedCourseParts: 0,
    pages: [old.pages[1], { ...old.pages[0], id: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1&b=2#unrelated' }],
    files: [{ title: 'Renamed', url: 'https://moodle.telt.unsw.edu.au/pluginfile.php/1/file.pdf?a=1&b=2' }], events: []
  };
  const result = context.compareCourseSnapshots(old, current, '1', Date.now());
  assert.equal(Object.values(result.counts).filter(value => value !== 0).length, 0);
  assert.equal(result.comparisonIncomplete, false);
});

test('同一页面正文变化复用复习哈希并报告一次更新', async () => {
  const { context } = await setup();
  const oldPage = { ...page('1', 'Old body', 'Old title'), id: 'stable-page' };
  const newPage = { ...oldPage, title: 'New title', text: 'New body' };
  const old = { syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: { schemaVersion: 1 }, pages: [oldPage], files: [], events: [], errors: [], failedActivities: [] };
  const result = context.compareCourseSnapshots(old, { pages: [newPage], files: [], events: [], errors: [], failedActivities: [] }, '1');
  assert.equal(result.counts.pageModified, 1);
  assert.equal(result.items[0].type, 'pageModified');
  assert.notEqual(context.hashText(oldPage.text), context.hashText(newPage.text));
});

test('事件后备身份排除标题和时间，改期只报告调整', async () => {
  const { context } = await setup();
  const event = { id: 'moodle:1:assign:due:100:99', title: 'Task', component: 'assign', eventType: 'due', timestampMs: 2_000_000, activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=99' };
  const old = { syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: { schemaVersion: 1 }, pages: [], files: [], events: [event], errors: [], failedActivities: [] };
  const current = { pages: [], files: [], events: [{ ...event, id: 'moodle:1:assign:due:300:99', title: 'Task renamed', timestampMs: 3_000_000 }], errors: [], failedActivities: [] };
  const result = context.compareCourseSnapshots(old, current, '1', 1_000_000);
  assert.equal(result.counts.eventRescheduled, 1);
  assert.equal(result.counts.eventAdded, 0);
  assert.equal(result.counts.eventRemoved, 0);
});

test('页面读取不完整时保留新增但禁止页面和文件移除结论', async () => {
  const { context } = await setup();
  const old = {
    syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: { schemaVersion: 1 }, errors: [], failedActivities: [],
    pages: [{ ...page('1', 'Old', 'Old'), id: 'old-page' }],
    files: [{ title: 'Old.pdf', url: 'https://moodle.telt.unsw.edu.au/pluginfile.php/1/old.pdf' }], events: []
  };
  const current = { pages: [{ ...page('1', 'New', 'New'), id: 'new-page' }], files: [], events: [], errors: ['HTTP 500'], failedActivities: [] };
  const result = context.compareCourseSnapshots(old, current, '1');
  assert.equal(result.counts.pageAdded, 1);
  assert.equal(result.counts.pageRemoved, null);
  assert.equal(result.counts.fileRemoved, null);
  assert.match(context.changeSummaryText(result), /未判断页面和文件是否移除/);
});

test('文件正文未解析时不会把旧提取页误报为已移除', async () => {
  const { context } = await setup();
  const extracted = { ...page('1', 'Extracted PDF text '.repeat(10), 'Lecture PDF p1'), id: 'https://moodle.telt.unsw.edu.au/pluginfile.php/1/lecture.pdf#part=1', partNumber: 1 };
  const file = { title: 'Lecture.pdf', url: 'https://moodle.telt.unsw.edu.au/mod/resource/view.php?id=8' };
  const old = { syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: { schemaVersion: 1 }, pages: [extracted], files: [file], events: [], errors: [], failedActivities: [] };
  const current = { pages: [], files: [file], events: [], errors: [], failedActivities: [], fileExtractionSkipped: true };
  const result = context.compareCourseSnapshots(old, current, '1');
  assert.equal(result.counts.pageRemoved, null);
  assert.ok(result.withheld.includes('pageRemovals'));
});

test('首次同步和旧索引升级只建立变化基线', async () => {
  const { context } = await setup();
  const current = { pages: [{ ...page('1', 'New'), id: 'new-page' }], files: [], events: [], errors: [], failedActivities: [] };
  const first = context.compareCourseSnapshots(null, current, '1');
  assert.equal(first.firstSync, true);
  assert.equal(first.counts.pageAdded, 0);
  assert.match(context.changeSummaryText(first), /首次同步完成/);
  const migrated = context.compareCourseSnapshots({ ...current, syncedAt: '2026-09-20T00:00:00.000Z' }, current, '1');
  assert.equal(migrated.firstSync, false);
  assert.equal(migrated.baselineOnly, true);
  assert.match(context.changeSummaryText(migrated), /现有课程建立变化基线/);
});

test('重复身份不产生虚假新增，旧截止自然过期不算移除', async () => {
  const { context } = await setup();
  const duplicate = { ...page('1', 'Same'), id: 'duplicate-page' };
  const event = { id: 'moodle:1:42', title: 'Old due', timestampMs: 500, component: 'assign', eventType: 'due', activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=8' };
  const old = { syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: { schemaVersion: 1 }, pages: [], files: [], events: [event], errors: [], failedActivities: [] };
  const current = { pages: [duplicate, { ...duplicate }], files: [], events: [], errors: [], failedActivities: [] };
  const result = context.compareCourseSnapshots(old, current, '1', 1_000);
  assert.equal(result.counts.pageAdded, 0);
  assert.equal(result.counts.eventRemoved, 0);
  assert.equal(result.expiredEvents, 1);
  assert.equal(result.comparisonIncomplete, true);
});

test('旧快照存在非法身份时不把无法核实的对象报告为新增', async () => {
  const { context } = await setup();
  const old = { syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: { schemaVersion: 1 }, pages: [{ text: 'Unknown old page' }], files: [], events: [], errors: [], failedActivities: [] };
  const current = { pages: [{ ...page('1', 'Current'), id: 'current-page' }], files: [], events: [], errors: [], failedActivities: [] };
  const result = context.compareCourseSnapshots(old, current, '1');
  assert.equal(result.counts.pageAdded, 0);
  assert.equal(result.comparisonIncomplete, true);
});

test('截止同步失败时不生成截止变化并暂停移除判断', async () => {
  const { context } = await setup();
  const event = { id: 'moodle:1:42', title: 'Due', timestampMs: Date.now() + 86_400_000, component: 'assign', eventType: 'due', activityUrl: 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=8' };
  const old = { syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: { schemaVersion: 1 }, pages: [], files: [], events: [event], errors: [], failedActivities: [] };
  const result = context.compareCourseSnapshots(old, { pages: [], files: [], events: [event], eventSyncError: 'calendar failed', errors: [], failedActivities: [] }, '1');
  assert.equal(result.counts.eventAdded, 0);
  assert.equal(result.counts.eventRescheduled, 0);
  assert.equal(result.counts.eventRemoved, null);
  assert.match(context.changeSummaryText(result), /未判断截止事项是否移除/);
});

test('整课同步最终快照写入变化摘要且单项重试不改写摘要', async () => {
  const original = { ...page('1', 'Old body', 'Lecture'), id: 'stable-page' };
  const previousChanges = { schemaVersion: 1, firstSync: false, counts: { pageAdded: 0 }, items: [] };
  const { context, saved } = await setup({
    courses: [{ id: '1', title: 'One' }],
    library: { 1: { pages: [original], files: [], events: [], errors: [], failedActivities: [], syncedAt: '2026-09-20T00:00:00.000Z', lastChanges: previousChanges } }
  });
  context.message = async type => type === 'SYNC_COURSE'
    ? { data: { pages: [{ ...original, text: 'New body' }], files: [], events: [], errors: [], failedActivities: [], unavailableActivities: [] } }
    : { data: { status: 'unavailable', item: { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7', title: 'Future' } } };
  await context.sync();
  assert.equal(saved.library['1'].lastChanges.counts.pageModified, 1);
  const committed = structuredClone(saved.library['1'].lastChanges);
  const target = { url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7', title: 'Future' };
  saved.library['1'].unavailableActivities = [target];
  await context.load();
  await context.retryActivity({ id: '1', title: 'One' }, target, null, null);
  assert.deepEqual(saved.library['1'].lastChanges, committed);
});


