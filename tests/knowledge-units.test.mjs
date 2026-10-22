import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../extension/learning-core.js');
globalThis.AskmeLearningCore = core;
const units = require('../extension/knowledge-units.js');

function segments() {
  return [
    { id: 's1', courseId: '100761', artifactId: 'a1', pageId: 'p1', title: 'CAD lecture', headingPath: ['Week 2', 'Parametric modelling'], charStart: 100, text: 'Parametric modelling is defined as a modelling approach in which dimensions and constraints control geometry. It supports design intent.' },
    { id: 's2', courseId: '100761', artifactId: 'a2', pageId: 'p2', title: 'Workshop', headingPath: ['Week 3', 'Parametric modelling'], charStart: 20, text: 'Parametric modelling is the use of parameters and relations to preserve design intent when geometry changes.' },
    { id: 's3', courseId: '100761', artifactId: 'a3', pageId: 'p3', title: 'Machining', headingPath: ['Week 4', 'Cutting speed'], charStart: 0, text: 'Cutting speed is defined as the relative surface speed between the tool and workpiece. spindleSpeed = cuttingSpeed / circumference.' }
  ];
}

test('从明确定义和具体小节提取稳定知识单元并绑定多来源证据', () => {
  const result = units.buildKnowledgeUnits(segments(), { courseId: '100761' });
  const parametric = result.find(item => item.canonicalLabel === 'parametric modelling');
  assert.ok(parametric);
  assert.equal(parametric.sourceSegmentIds.length, 2);
  assert.match(parametric.id, /^ku:/u);
  assert.equal(parametric.evidence[0].charStart >= 20, true);
  assert.equal(parametric.evidence.every(item => item.quote && item.segmentId), true);
});

test('知识单元身份不随证据顺序和正文补充而改变', () => {
  const first = units.buildKnowledgeUnits(segments(), { courseId: '100761' }).find(item => item.canonicalLabel === 'parametric modelling');
  const changed = segments().reverse();
  changed[1] = { ...changed[1], text: `${changed[1].text} This extra sentence does not redefine the concept.` };
  const second = units.buildKnowledgeUnits(changed, { courseId: '100761' }).find(item => item.canonicalLabel === 'parametric modelling');
  assert.equal(first.id, second.id);
  assert.notEqual(first.contentHash, second.contentHash);
});

test('不会把通用周次标题或单字符公式变量当作知识点', () => {
  const result = units.buildKnowledgeUnits([{ id: 's', courseId: '1', artifactId: 'a', pageId: 'p', headingPath: ['Week 1'], text: 'x = y + 1. This sentence explains a worked example without defining a named concept.' }], { courseId: '1' });
  assert.equal(result.some(item => /week 1|^x$/iu.test(item.label)), false);
});

test('不会把重复字符占位正文当作知识点标题', () => {
  const result = units.buildKnowledgeUnits([{ id: 's', courseId: '1', artifactId: 'a', pageId: 'p', headingPath: ['NNNNNNNNNN'], text: 'NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN.' }], { courseId: '1' });
  assert.equal(result.length, 0);
});

test('中文定义可以生成带原文位置的知识单元', () => {
  const result = units.buildKnowledgeUnits([{ id: 'z1', courseId: '1', artifactId: 'a', pageId: 'p', headingPath: ['刀具寿命'], charStart: 50, text: '刀具寿命是指刀具从开始切削到达到规定磨损限度的有效切削时间。它受速度和材料影响。' }], { courseId: '1' });
  const unit = result.find(item => item.label === '刀具寿命');
  assert.ok(unit);
  assert.equal(unit.evidence[0].charStart, 50);
});

test('掌握记录绑定知识点内容版本并按题目保存最小尝试事实', () => {
  const unit = units.buildKnowledgeUnits(segments(), { courseId: '100761' })[0];
  const record = units.masteryRecord(unit);
  const updated = units.recordAttempt(record, { questionId: 'q:transfer:1', rating: 'again', evidenceSegmentIds: ['s1', 's1', 's2'], answeredAt: '2026-09-23T01:00:00.000Z' });
  assert.equal(updated.state, 'relearning');
  assert.deepEqual(updated.attempts[0].evidenceSegmentIds, ['s1', 's2']);
  assert.equal(JSON.stringify(updated).includes('student answer'), false);
});

test('小数点不会切断原子句且位置范围保持精确', () => {
  const text = 'Use 0.5 mm allowance. Apply 1.2 N load. The ratio is 3.14.';
  const spans = units.sentenceSpans(text);
  assert.deepEqual(spans.map(item => item.text), [
    'Use 0.5 mm allowance.',
    'Apply 1.2 N load.',
    'The ratio is 3.14.'
  ]);
  for (const span of spans) assert.equal(text.slice(span.start, span.end), span.text);
});

test('知识单元只覆盖可证明范围并保留定义后的条件、步骤和限制', () => {
  const text = 'Feed rate is defined as travel per revolution. Use 0.5 mm only when the tool is stable. Step 1.2 requires coolant. Maximum ratio is 3.14.';
  const input = [{ id: 's1', courseId: '1', artifactId: 'a1', pageId: 'p1', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1', headingPath: ['Feed rate'], charStart: 0, text }];
  const result = units.buildKnowledgeUnits(input, { courseId: '1' });
  const definition = result.find(item => item.canonicalLabel === 'feed rate');
  assert.ok(definition);
  assert.equal(definition.schemaVersion, units.KNOWLEDGE_UNIT_SCHEMA_VERSION);
  assert.deepEqual(definition.coveredRanges, [{ pageId: 'p1', segmentId: 's1', start: 0, end: text.indexOf('.') + 1 }]);
  const residual = units.residualLearningSpans(input, result, { minLength: 1 });
  assert.match(residual.map(item => item.text).join(' '), /0\.5 mm.*Step 1\.2.*3\.14/u);
  assert.equal(residual.every(item => text.slice(item.start, item.end) === item.text), true);
});

test('知识点身份绑定课程且不受输入顺序影响，来源版本进入内容版本', () => {
  const base = [
    { id: 's1', courseId: '1', artifactId: 'a1', pageId: 'p1', sourceVersion: 'v1', charStart: 0, headingPath: ['Feed rate'], text: 'Feed rate is defined as travel per revolution.' },
    { id: 's2', courseId: '1', artifactId: 'a2', pageId: 'p2', sourceVersion: 'v1', charStart: 0, headingPath: ['Feed rate'], text: 'Feed rate is the commanded tool travel per revolution.' }
  ];
  const first = units.buildKnowledgeUnits(base, { courseId: '1' }).find(item => item.canonicalLabel === 'feed rate');
  const reordered = units.buildKnowledgeUnits([...base].reverse(), { courseId: '1' }).find(item => item.canonicalLabel === 'feed rate');
  const changedVersion = units.buildKnowledgeUnits(base.map(item => ({ ...item, sourceVersion: 'v2' })), { courseId: '1' }).find(item => item.canonicalLabel === 'feed rate');
  const otherCourse = units.buildKnowledgeUnits(base.map(item => ({ ...item, courseId: '2' })), { courseId: '2' }).find(item => item.canonicalLabel === 'feed rate');
  assert.equal(first.id, reordered.id);
  assert.equal(first.id, changedVersion.id);
  assert.notEqual(first.contentHash, changedVersion.contentHash);
  assert.notEqual(first.id, otherCourse.id);
  assert.equal(units.knowledgeUnitState({ ...first, schemaVersion: 1 }), 'stale');
});

test('knowledgeUnitState 拒绝 evidence 与 coveredRanges 边界不一致或越界', () => {
  const unit = units.buildKnowledgeUnits(segments(), { courseId: '100761' })[0];
  assert.equal(units.knowledgeUnitState(unit), 'current');
  assert.equal(units.knowledgeUnitState({ ...unit, coveredRanges: [{ ...unit.coveredRanges[0], end: unit.coveredRanges[0].end + 1 }] }), 'needsReview');
  assert.equal(units.knowledgeUnitState({ ...unit, coveredRanges: [...unit.coveredRanges, unit.coveredRanges[0]] }), 'needsReview');
  assert.equal(units.knowledgeUnitState({ ...unit, evidence: [{ ...unit.evidence[0], charStart: -1 }] }), 'needsReview');
});
