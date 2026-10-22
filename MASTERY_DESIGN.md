# Askme：课程学习覆盖与薄弱分节设计

## 1. 目标与边界

本视图回答三个可操作的问题：

1. 这门课程目前有多少已同步知识点进入过练习？
2. 哪些分节存在到期复习或薄弱提示，应当先处理？
3. 哪些知识点近期出现过相对顺利的学习记录？

产品入口可以使用用户熟悉的“课程掌握度”，但视图标题与指标必须写成 **“学习覆盖与薄弱分节”**。当前数据仅来自用户自评、复习排程和本机模型对原创自测的反馈，不能测量考试能力或客观掌握程度。因此：

- 不显示单一“掌握分”“能力分”或红黄绿成绩等级。
- 不使用“已掌握”“掌握率”“正确率”“预测成绩”等文案。
- 覆盖百分比只表示当前课程内容中有学习记录的比例。
- “薄弱提示”只表示本机模型最近给出“部分正确／需复习”的反馈。
- “近期稳定”只表示近期记录符合下述排程规则，不表示学生已永久掌握。

固定说明文案：

> 这些指标来自你的自评、复习日期和本机 AI 自测反馈，只用于安排下一步学习，不代表客观掌握程度或课程成绩。

## 2. 最小视图

将视图放在现有“复习”页、课程和分节选择器之后，复习卡片之前。首版不新增独立导航页。

### 2.1 课程概览卡

标题：`学习覆盖`

主行：`已练习 X / Y 个知识点（Z%）`

次行按非零项展示：

`待复习 D · 薄弱提示 W · 近期稳定 S`

覆盖进度条只编码 `X / Y`，无成功或失败颜色含义。进度条的无障碍名称为：

`已练习 X 个，共 Y 个可练习知识点`

概览卡下方始终提供“指标说明”，展开后显示第 1 节的固定说明以及各指标定义。

### 2.2 分节列表

每个分节一行：

```text
Week 3                                      8 / 12 已练习
覆盖 67%       待复习 3       薄弱提示 2       近期稳定 4
[复习这一节 →]
```

- 标题使用现有 `sectionLabel(page)`；空标题显示 `其他内容`。
- 分节合并使用现有 `sectionKey()`，因此 `Week 01` 与 `Week 1` 属于同一行。
- 点击整行或按钮时，设置现有 `review-course` 与 `review-section`，再进入该分节的现有复习队列。
- 有薄弱提示时按钮为 `复习薄弱点 →`；无薄弱但有待复习时为 `处理到期复习 →`；其他情况为 `继续练习 →`。
- 不在首版增加图表、预测曲线、等级徽章或跨课程排行榜。

## 3. 数据口径

### 3.1 可练习知识点集合

对当前课程的 `library[courseId].pages` 使用与现有复习功能一致的资格条件：

```js
String(page.courseId) === String(courseId)
&& typeof page.text === 'string'
&& page.text.trim()
&& page.text.length > 80
&& safeLink(page.url)
```

然后按 `cardKey(page)` 去重。首次出现的当前页面决定标题和分节。这样概览分母与真实卡片身份一致，重复页面不会放大指标。

记去重后的集合为 `eligiblePages`，数量为 `Y`。

### 3.2 当前有效记录

页面 `page` 对应：

```js
entry = reviewProgress[courseId]?.[cardKey(page)]
current = entry && entry.contentHash === hashText(page.text)
```

只有 `current` 为真时，记录才可用于“已练习”“薄弱提示”和“近期稳定”。课程内容更新后，旧哈希记录仍可保留供排程识别，但不再证明当前内容已练习。

无 `contentHash` 的旧版记录按非当前记录处理，不能猜测其有效性。

### 3.3 已练习与覆盖

某知识点满足以下条件时计为“已练习”：

```js
current && (
  Number(entry.reviews) > 0
  || Number(entry.practiceAttempts) > 0
  || Boolean(entry.lastReviewedAt)
  || Boolean(entry.lastPracticeAt)
)
```

分节指标：

- `已练习 X`：该分节满足条件的知识点数。
- `覆盖 Z%`：`X / Y_section`，使用整数四舍五入；分母为 0 时显示 `—`，不显示 `0%`。
- 课程概览使用所有分节去重后的 `X_course / Y_course`，不能对各分节百分比求平均。

文案解释：

> 练习覆盖表示当前同步内容中，至少做过一次卡片自评或自测的知识点比例。

### 3.4 待复习

“待复习”要与现有 `dueReviewPages()` 中已学习内容的排程一致。某知识点满足任一条件时计入：

1. 存在记录且 `contentHash !== hashText(page.text)`，即内容更新后需要重新核对；
2. `current` 为真，且 `dueTime(entry) <= now`。

从未练习的新知识点不计入“待复习”，另由覆盖缺口表达。每天最多引入 10 个新点的额度也不计入本指标，否则同一课程会随课程排列顺序而改变统计。

若分节包含哈希变化记录，在展开说明中追加：`其中 N 个知识点因内容更新需要重新核对。`

文案解释：

> 待复习表示复习日期已到，或同步后的课程正文发生变化；不代表此前回答错误。

### 3.5 薄弱提示

某知识点满足以下全部条件时计入：

```js
current
&& ['partial', 'incorrect'].includes(entry.practiceVerdict)
```

不要求 `dueAt <= now`。当前实现会把此类记录立即设为到期，但统计定义不依赖这一副作用，避免未来排程调整后漏掉薄弱提示。

显示时合并两类数量：

- `部分正确 P`
- `需复习 I`

列表默认只显示总数 `薄弱提示 W`；展开后显示分类。不得改写为“错误 W”“未掌握 W”或“掌握不足”。

文案解释：

> 薄弱提示来自本机 AI 对最近一次原创自测回答的反馈，可能有误；请结合 Moodle 原文核对。

### 3.6 近期稳定

“近期”固定为从 `now` 向前 14 × 24 小时。某知识点必须先满足 `current`、`dueTime(entry) > now`，并且没有当前薄弱提示，再满足以下任一证据：

**用户自评路径**

```js
['good', 'easy'].includes(entry.rating)
&& Number(entry.intervalDays) >= 3
&& now - Date.parse(entry.lastReviewedAt) >= 0
&& now - Date.parse(entry.lastReviewedAt) <= 14 * 86_400_000
```

**AI 自测路径**

```js
Boolean(entry.lastPracticeAt)
&& entry.practiceVerdict == null
&& now - Date.parse(entry.lastPracticeAt) >= 0
&& now - Date.parse(entry.lastPracticeAt) <= 14 * 86_400_000
```

所有日期都必须能被 `Date.parse` 解析，且不能位于未来；无效日期不计入。`practiceVerdict == null` 只有在同时存在 `lastPracticeAt` 时才可解释为最近一次自测得到 `correct`，从而兼容当前 `recordPracticeOutcome()` 的存储方式。

如果记录仍有 `partial` 或 `incorrect`，即使存在更早的 `good/easy` 自评也不能计为近期稳定。

文案解释：

> 近期稳定表示最近 14 天内曾自评“记得／很熟”，且复习间隔至少 3 天，或最近一次 AI 自测反馈为正确；同时下一次复习尚未到期。这仍是学习记录，不是客观掌握认证。

## 4. 分节状态与排序

### 4.1 行内提示

一行最多显示一个行动提示，按以下优先级：

1. `有 W 个薄弱提示`：`W > 0`
2. `有 D 个待复习`：`W = 0 && D > 0`
3. `还有 U 个未练习`：`W = 0 && D = 0 && X < Y`
4. `本轮暂无待处理项`：其他情况

第 4 类不写“本节已掌握”。

### 4.2 默认排序

排序键依次为：

1. 薄弱提示数降序；
2. 待复习数降序；
3. 未练习数 `Y - X` 降序；
4. 首次出现在当前 `eligiblePages` 中的顺序升序。

这样首屏优先展示有明确行动依据的分节，同时在完全没有学习记录时保持 Moodle 原始顺序。首版不提供“最好／最差”排序，因为数据不支持能力排名。

## 5. 空状态与异常状态

| 条件 | 文案 | 动作 |
| --- | --- | --- |
| 未选择课程 | `先选择一门已同步课程，查看学习覆盖和薄弱提示。` | 聚焦课程选择器 |
| 课程尚未同步或索引不存在 | `这门课程还没有本机索引。请先同步课程。` | `前往同步 →` |
| 有索引但无合格知识点 | `已同步内容中暂时没有可生成复习卡片的正文。可检查资料是否只有链接、正文过短或尚未成功解析。` | `查看同步详情 →` |
| `Y > 0 && X = 0` | `还没有练习记录。可从任一分节开始；覆盖数据会在首次自评或自测后出现。` | `开始第一个知识点 →` |
| `W = 0` | `当前没有薄弱提示。这只表示尚无当前内容的“部分正确／需复习”AI 反馈。` | 不显示庆祝性结论 |
| `D = 0` | `当前没有到期复习。仍可继续覆盖未练习内容或提前复习。` | `继续练习 →`（有未练习时） |
| 所有记录哈希过期 | `课程内容已更新，原练习记录不再计入当前覆盖。请重新核对这些知识点。` | `重新核对 →` |
| 记录日期无效 | 不向用户显示技术错误；该记录不计入对应时间指标 | 可在开发日志记录 |

## 6. 与现有实现的映射

首版计算不需要新增持久化字段：

| 指标 | 现有来源 |
| --- | --- |
| 课程与分节 | `library[courseId].pages`、`sectionGroup`、`section` |
| 卡片身份 | `cardKey(page)` |
| 当前内容 | `entry.contentHash` 与 `hashText(page.text)` |
| 已练习 | `reviews`、`practiceAttempts`、`lastReviewedAt`、`lastPracticeAt` |
| 待复习 | `dueAt`、内容哈希变化 |
| 薄弱提示 | `practiceVerdict` |
| 近期稳定 | `rating`、`intervalDays`、`lastReviewedAt`、`lastPracticeAt`、`practiceVerdict`、`dueAt` |

建议实现为无副作用纯函数：

```js
masterySnapshot(courseId, now) => {
  totals: { eligible, practiced, due, weak, stable, changed },
  sections: [{ key, label, eligible, practiced, due, weak, partial, incorrect, stable, changed, firstIndex }]
}
```

函数只读取当前 `library` 与 `reviewProgress`，不调用 `dueReviewPages()`，避免统计过程消耗或受全局每日新卡额度影响。评分、自测、同步、清除索引或切换课程后重新计算即可。

## 7. 验收测试

以下测试应冻结 `now`，直接验证纯计算结果和最终文案。

1. **无记录覆盖**：同一分节 3 个合格页面，无记录。期望 `eligible=3, practiced=0, due=0, weak=0, stable=0, coverage=0%`，显示“还没有练习记录”。
2. **有效自评记录**：页面哈希一致，`reviews=1, rating=good, intervalDays=3`，`lastReviewedAt` 在 2 天内且 `dueAt` 在未来。期望 `practiced=1, stable=1, due=0`。
3. **到期不等于薄弱**：有效记录 `rating=good`，但 `dueAt <= now`。期望 `due=1, weak=0, stable=0`。
4. **AI 薄弱提示**：有效记录 `practiceVerdict=partial`、`lastPracticeAt` 有效、`dueAt=now`。期望 `practiced=1, due=1, weak=1, partial=1, stable=0`；文案含“薄弱提示”，不含“未掌握”。
5. **正确自测的保守解释**：有效记录有 `lastPracticeAt`、`practiceVerdict=null`、未来 `dueAt`。期望 `stable=1`；同一记录缺少 `lastPracticeAt` 时 `stable=0`。
6. **旧自评不算近期**：`good/easy` 的 `lastReviewedAt` 超过 14 天。期望 `stable=0`。
7. **内容更新失效**：记录存在但哈希与页面正文不一致。期望 `practiced=0, changed=1, due=1, weak=0, stable=0`，显示重新核对提示。
8. **旧版无哈希记录**：记录有 `reviews` 但无 `contentHash`。按内容无法核实处理，期望 `practiced=0, changed=1, due=1, weak=0, stable=0`。
9. **重复卡片去重**：两个页面拥有相同 `cardKey`。期望课程与分节分母只计 1；首次页面决定分节。
10. **分节归并**：`Week 01`、`Week 1 · Page 2` 和文件页派生标题归入同一 `week:1`；无标题页归入 `其他内容`。
11. **分节排序**：A 节 `weak=1`，B 节 `due=5`，C 节 `unpracticed=8`。期望顺序 A、B、C；完全相同则保持 Moodle 首次出现顺序。
12. **课程汇总不平均百分比**：A 节 1/1、B 节 1/9。期望课程覆盖为 2/10=20%，不是 55%。
13. **未来和无效日期**：`lastReviewedAt` 位于未来或无法解析。期望不计入近期稳定，渲染不抛错。
14. **每日新卡额度不影响统计**：改变其他课程当天 `introducedAt` 数量。期望本课程 `eligible/practiced/due/weak/stable` 完全不变。
15. **用户动作后实时刷新**：完成一次评分或自测后，概览与对应分节行同步更新；不需要重新打开侧栏。
16. **清除与重新同步**：清除课程索引后显示未同步空状态；同步相同正文后恢复统计；同步变化正文后旧记录不计入当前覆盖。
17. **无障碍文案**：进度条可被读屏读为 `已练习 X 个，共 Y 个可练习知识点`；颜色不是薄弱与到期的唯一表达方式；行按钮有独立可理解名称。
18. **禁用能力结论**：对所有状态做文本快照，确保不出现“掌握率”“已掌握”“预测成绩”“正确率”或把 AI 反馈称为客观判断的文案。

## 8. 首版完成标准

- 使用当前本机数据即可渲染课程概览和全部分节，无迁移、无网络请求。
- 概览和分节数字遵循同一套去重、哈希有效性和时间规则。
- 用户能从优先分节一键进入现有复习流程。
- 每个指标在界面内均有可见解释，明确其自评或 AI 反馈来源。
- 空状态、正文变化和旧记录不会造成虚假的“已掌握”结论。
- 第 7 节的计算、排序、文案与无障碍测试全部通过。
