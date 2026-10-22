import test from 'node:test';
import assert from 'node:assert/strict';
import { atomicClaimParts, verifyAtomicClaim, verifyGroundedItems } from './claim-verifier.mjs';

test('回答条目只能含一个原子事实', () => {
  assert.deepEqual(atomicClaimParts('Feed rate affects finish. Cutting speed affects heat.'), ['Feed rate affects finish', 'Cutting speed affects heat']);
  assert.equal(verifyAtomicClaim('Feed rate affects finish. Cutting speed affects heat.', 'Feed rate affects finish. Cutting speed affects heat.').ok, false);
  assert.equal(verifyAtomicClaim('进给速度影响表面质量；切削速度影响温度。', '进给速度影响表面质量；切削速度影响温度。').ok, false);
});

test('数值、单位和技术标识必须逐项出现在证据中', () => {
  assert.equal(verifyAtomicClaim('The recommended speed is 1200 rpm.', 'The recommended speed is 1200 rpm for aluminium.').ok, true);
  assert.match(verifyAtomicClaim('The recommended speed is 1500 rpm.', 'The recommended speed is 1200 rpm for aluminium.').reason, /数值或单位/u);
  assert.match(verifyAtomicClaim('CADCAM uses tool paths.', 'CAM uses tool paths.').reason, /技术标识/u);
});

test('中文紧邻数字单位时保留单位并支持中英文证据互核', () => {
  for (const [claim, evidence] of [
    ['100%法则适用于整个范围', 'The 100% Rule applies to the whole scope.'],
    ['100% Rule applies to the whole scope', '100%法则适用于整个范围。'],
    ['部件是5 mm厚的钢板', 'The plate is 5 mm thick.'],
    ['The plate is 5 mm thick', '部件是5 mm厚的钢板。']
  ]) {
    const result = verifyAtomicClaim(claim, evidence);
    assert.equal(result.ok, true, `${claim} / ${evidence}`);
  }
});

test('无来源中文数字仍拒绝，且不同单位不互相等价', () => {
  const unsupported = verifyAtomicClaim('100%法则适用于整个范围', '规则覆盖完整范围，不包含比例。');
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, 'NUMERIC_FACT_UNSUPPORTED');

  for (const [claim, evidence] of [
    ['速度是5m', '速度是5mm。'],
    ['速度是5mm', '速度是5m。']
  ]) {
    const result = verifyAtomicClaim(claim, evidence);
    assert.equal(result.ok, false, `${claim} / ${evidence}`);
    assert.equal(result.code, 'NUMERIC_FACT_UNSUPPORTED');
  }
});

test('课程拉丁标识中的数字不拆成数值事实', () => {
  const result = verifyAtomicClaim('GSOE9820课程包含项目管理', 'GSOE9820课程包含项目管理。');
  assert.equal(result.ok, true);
  assert.deepEqual(result.checkedNumbers, []);
  assert.deepEqual(result.checkedIdentifiers, ['gsoe9820']);

  const changed = verifyAtomicClaim('课程编号是GSOE9820', '课程编号是GSOE9821。');
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'IDENTIFIER_UNSUPPORTED');
});

test('证据中没有否定关系时拒绝新增否定结论', () => {
  assert.equal(verifyAtomicClaim('The process does not require coolant.', 'The process may require coolant.').ok, false);
  assert.equal(verifyAtomicClaim('The process does not require coolant.', 'The process does not require coolant.').ok, true);
  assert.equal(verifyAtomicClaim('The task is due on Friday.', 'The task is not due on Friday.').ok, false);
  assert.equal(verifyAtomicClaim('The task is not due on Friday.', 'The task is due on Friday.').ok, false);
  assert.equal(verifyAtomicClaim('The task cannot be submitted on Friday.', 'The task can be submitted on Friday.').ok, false);
});

test('批量核验同时检查来源归属和每条事实', () => {
  const sources = [{ excerpt: 'Spindle speed is 1200 rpm for this operation.' }];
  assert.equal(verifyGroundedItems([{ text: 'Spindle speed is 1200 rpm.', source: 1, evidence: 'Spindle speed is 1200 rpm' }], sources).ok, true);
  assert.equal(verifyGroundedItems([{ text: 'Spindle speed is 2000 rpm.', source: 1, evidence: 'Spindle speed is 1200 rpm' }], sources).ok, false);
});

test('小数句点不会把单个事实错误拆开', () => {
  assert.deepEqual(atomicClaimParts('The speed is 0.5 m.'), ['The speed is 0.5 m']);
  assert.equal(verifyAtomicClaim('速度为 0.5 m', 'The speed is 0.5 m.').ok, true);
  assert.equal(verifyAtomicClaim('速度为 0.05 m', 'The speed is 0.5 m.').ok, false);
  assert.equal(verifyAtomicClaim('速度为 5 m', 'The speed is 0.5 m.').ok, false);
  assert.equal(verifyAtomicClaim('速度为 0.5 cm', 'The speed is 0.5 m.').ok, false);
});

test('英文日期时间可支持精确中文转述但拒绝任一字段变化', () => {
  const evidence = 'Friday, 2 October 2026 17:00 Assignment Task 1 submission is due.';
  assert.equal(verifyAtomicClaim('Assignment Task 1 的截止时间是 2026 年 10 月 2 日（星期五）17:00', evidence).ok, true);
  assert.equal(verifyAtomicClaim('Assignment Task 1 的截止时间是 2026 年 10 月 2 日 17:00', 'Friday, 2 October 2026 5:00 PM Assignment Task 1 submission is due.').ok, true);
  for (const wrong of [
    'Assignment Task 1 的截止时间是 2026 年 11 月 3 日 17:00',
    'Assignment Task 1 的截止时间是 2026 年 2 月 10 日 17:00',
    'Assignment Task 1 的截止时间是 2027 年 10 月 2 日 17:00',
    'Assignment Task 1 的截止时间是 2026 年 10 月 2 日 16:00',
    'Assignment Task 1 的截止时间是 2026 年 10 月 2 日 17:30',
    'Assignment Task 1 的截止时间是 2026 年 10 月 2 日（星期四）17:00'
  ]) assert.equal(verifyAtomicClaim(wrong, evidence).ok, false, wrong);
});

test('比较与变化方向必须和证据一致', () => {
  assert.equal(verifyAtomicClaim('提高进给速度会降低表面粗糙度', 'Increasing feed rate increases surface roughness.').ok, false);
  assert.equal(verifyAtomicClaim('提高进给速度会增加表面粗糙度', 'Increasing feed rate increases surface roughness.').ok, true);
  assert.equal(verifyAtomicClaim('Lower cutting speed reduces heat.', 'Decreasing cutting speed reduces heat.').ok, true);
});

test('窄范围英文方向关系必须保持主语和宾语顺序', () => {
  assert.equal(verifyAtomicClaim('Increasing feed rate increases surface roughness.', 'Increasing the feed rate increases the surface roughness.').ok, true);
  const swapped = verifyAtomicClaim('Increasing surface roughness increases feed rate.', 'Increasing feed rate increases surface roughness.');
  assert.equal(swapped.ok, false);
  assert.equal(swapped.code, 'RELATION_ARGUMENT_MISMATCH');
  const mismatched = verifyAtomicClaim('Increasing cutting speed increases surface roughness.', 'Increasing feed rate increases surface roughness.');
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, 'RELATION_ARGUMENT_MISMATCH');
  assert.equal(verifyAtomicClaim('Increasing surface roughness reduces feed rate.', 'Increasing feed rate reduces surface roughness.').code, 'RELATION_ARGUMENT_MISMATCH');
  assert.equal(verifyAtomicClaim('提高进给速度会增加表面粗糙度', 'Increasing feed rate increases surface roughness.').ok, true);
});
