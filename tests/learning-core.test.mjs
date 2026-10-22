import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../extension/learning-core.js');

const page = (overrides = {}) => ({
  id: 'p1', courseId: '100761', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1',
  title: 'Lecture 2', section: 'Week 2', sectionGroup: 'Week 2',
  text: '1. DESIGN INTENT\n\nDesign intent records how a model should respond to change.\n\nFormula\n\nF = ma. The unit of force is newton.\n\nCommon mistake\n\nDo not confuse mass with force.',
  ...overrides
});

test('结构化切块保留来源位置、标题路径和稳定身份', () => {
  const first = core.structureAwareSegments([page()], '100761', { minTokens: 10, targetTokens: 18, maxTokens: 35, overlapTokens: 4 });
  const second = core.structureAwareSegments([page()], '100761', { minTokens: 10, targetTokens: 18, maxTokens: 35, overlapTokens: 4 });
  assert.ok(first.length >= 2);
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id));
  assert.ok(first.every(item => item.charStart >= 0 && item.charEnd > item.charStart));
  assert.ok(first.some(item => item.headingPath.some(value => /DESIGN INTENT/u.test(value))));
  assert.equal(first[0].nextId, first[1].id);
  assert.equal(first[1].prevId, first[0].id);
});

test('切块不会在短公式与说明之间按固定字符硬切', () => {
  const segments = core.structureAwareSegments([page()], '100761', { minTokens: 5, targetTokens: 30, maxTokens: 80, overlapTokens: 0 });
  const formula = segments.find(item => item.text.includes('F = ma'));
  assert.ok(formula);
  assert.match(formula.text, /unit of force/u);
});

test('长段按句界切分时保留小数且每个 segment 都是原文精确切片', () => {
  const text = [
    'Use 0.5 mm allowance for the first operation.',
    'Apply 1.2 N load during the second operation!',
    'Keep the ratio at 3.14 for final verification?',
    'Record the result without changing the source wording.'
  ].join('  ');
  const segments = core.structureAwareSegments([page({ text })], '100761', { minTokens: 1, targetTokens: 8, maxTokens: 12, overlapTokens: 0 });
  assert.ok(segments.length >= 3);
  for (const segment of segments) assert.equal(segment.text, text.slice(segment.charStart, segment.charEnd));
  assert.equal(segments.some(segment => /(?:0\.|\.5|1\.|\.2|3\.|\.14)$/u.test(segment.text)), false);
  assert.match(segments.map(segment => segment.text).join(' '), /0\.5.*1\.2.*3\.14/u);
});

test('中文分词和 BM25 能召回精确概念并提升标题命中', () => {
  const segments = core.structureAwareSegments([
    page({ id: 'a', title: '刀具补偿', text: '刀具半径补偿用于修正实际刀具半径与编程轨迹之间的差异。' }),
    page({ id: 'b', title: '装配约束', text: '装配约束用于定义零件之间的位置关系。' })
  ], '100761', { minTokens: 2, targetTokens: 50, maxTokens: 90, overlapTokens: 0 });
  const results = core.bm25Search('刀具半径补偿有什么作用', segments);
  assert.equal(results[0].pageId, 'a');
  assert.ok(results[0].bm25Score > 0);
});

test('RRF 奖励两个召回器共同命中的候选', () => {
  const a = { id: 'a', text: 'A' }, b = { id: 'b', text: 'B' }, c = { id: 'c', text: 'C' };
  const fused = core.reciprocalRankFusion([[a, b], [c, a]], { k: 10 });
  assert.equal(fused[0].id, 'a');
  assert.equal(fused[0].matchedRankings.length, 2);
});

test('多样化会抑制重复片段并保留不同材料覆盖', () => {
  const selected = core.diversifyCandidates([
    { id: 'a1', artifactId: 'a', text: 'design intent parameter relation', rrfScore: 1 },
    { id: 'a2', artifactId: 'a', text: 'design intent parameter relations', rrfScore: 0.99 },
    { id: 'b1', artifactId: 'b', text: 'feature tree rebuild order', rrfScore: 0.85 }
  ], { limit: 2, lambda: 0.6 });
  assert.deepEqual(selected.map(item => item.id), ['a1', 'b1']);
});

test('邻块扩展只沿同一材料的稳定链接展开', () => {
  const segments = core.structureAwareSegments([page()], '100761', { minTokens: 5, targetTokens: 12, maxTokens: 25, overlapTokens: 0 });
  assert.ok(segments.length >= 2);
  const expanded = core.expandNeighbors([segments[1]], segments);
  assert.ok(expanded.some(item => item.relation === 'previous'));
  assert.ok(expanded.some(item => item.relation === 'match'));
});

test('回答上下文合并同页邻块且不会跨页错配来源', () => {
  const segments = core.structureAwareSegments([page()], '100761', { minTokens: 5, targetTokens: 12, maxTokens: 25, overlapTokens: 0 });
  const current = segments[1];
  const contextual = core.contextualizeCandidates([current], segments, { maxChars: 1200 });
  assert.match(contextual[0].excerpt, /命中内容/u);
  assert.ok(contextual[0].contextSegmentIds.includes(current.id));
  const otherPage = { ...segments[0], id: 'other', pageId: 'different', nextId: current.id };
  const isolated = core.contextualizeCandidates([{ ...current, prevId: 'other' }], [otherPage, current]);
  assert.equal(isolated[0].contextSegmentIds.includes('other'), false);
});

test('问题类型与动态建议根据当前证据变化', () => {
  assert.equal(core.classifyQuery('Compare climb milling vs conventional milling'), 'compare');
  assert.equal(core.classifyQuery('推导这个公式并解释单位'), 'formula');
  const suggestions = core.promptSuggestions({ title: 'Climb milling', hasFormula: true, mode: 'ask', assessmentObjective: '选择合适的铣削方式' });
  assert.equal(suggestions.length, 3);
  assert.ok(suggestions.some(value => value.includes('公式')));
  assert.ok(suggestions.some(value => value.includes('选择合适的铣削方式')));
});
