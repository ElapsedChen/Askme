# MANF9543 本地金标评测

该目录提供 Askme 学习内核的离线、可复现质量评测。仓库只包含虚构样例，不包含 UNSW Moodle 正文、真实题目或用户数据。

## 数据流

1. 从 Askme 本机同步索引导出 JSON。评测工具只在本机读取。
2. 生成证据目录；默认不复制正文。
3. 人工从目录选择 `span id`，在本机建立金标问题、必要证据组和事实清单。
4. 运行 Askme 得到检索 ID、引用 ID、事实 claim 和拒答状态。
5. 对不能由事实 ID 确定的生成 claim，人工或独立本地蕴含验证器写入 `adjudication`。
6. 运行评测并保存不含问题正文的指标报告。

## 从本机索引选择证据

```powershell
node .\tools\evaluate-gold.mjs catalog `
  --index D:\Askme-private\manf9543-index-export.json `
  --out D:\Askme-private\manf9543-catalog.json
```

目录默认只有 ID、材料 ID、标题、heading、页或 slide、版本 hash 与字符数。需要在完全本机的人工标注界面查看摘录时，才显式加 `--include-text`；输出文件应留在私人目录，不提交仓库。

当前索引导出可为数组，或包含 `segments`、`chunks`、`entries`、`pages` 数组的对象。条目识别 `id` / `segmentId` / `chunkId` / `pageId`。

## 金标结构

每个项目包含：

- `type`: `qa` 或 `summary`。
- `answerability`: `answerable` 或 `unanswerable`。
- `language`: 建议用 `zh`、`en`、`cross`，以便后续分组报告。
- `risk`: 建议用 `standard` 或 `high`；公式、数值、单位、deadline 和 assessment 要求属于高风险。
- `evidenceGroups`: 每个必要证据点对应一组等价 span。组内任意一个命中即可，避免重复页面或等价切块造成误判。
- `requiredFacts`: 摘要和答案必须覆盖的原子事实，以及每个事实可支持它的证据 ID。
- `versionHash`: 建标时的来源版本。课程更新后，`--catalog` 检查会报告缺失或过期证据。

不要把正式 assessment、quiz 或 exam 题目复制进金标。用课程概念编写原创问题，并保存来源 hash。

## 运行结果结构

每个结果包含：

- `retrievedEvidenceIds`: 按排名排序的检索结果。
- `citationIds`: 输出显示的全部引用。
- `claims`: 原子事实输出，包含 `factId` 和相邻 `citationIds`。
- `refused`: 是否因材料不足而拒答。
- `adjudication`: 可选的独立裁决，值为 `supported`、`unsupported` 或 `contradicted`。它用于语义改写、归纳或未知事实；不得由同一个生成回答的模型自评。

若 claim 的 `factId` 存在于金标且引用与该事实的证据相交，框架可以确定性判为 supported。未知事实默认 unsupported。

## 执行

```powershell
node .\tools\evaluate-gold.mjs validate --dataset D:\Askme-private\manf9543-gold.json

node .\tools\evaluate-gold.mjs evaluate `
  --dataset D:\Askme-private\manf9543-gold.json `
  --run D:\Askme-private\manf9543-run.json `
  --catalog D:\Askme-private\manf9543-catalog.json `
  --out D:\Askme-private\manf9543-report.json
```

仓库内虚构样例可直接验收：

```powershell
node .\tools\evaluate-gold.mjs evaluate `
  --dataset .\evaluation\examples\synthetic-gold.json `
  --run .\evaluation\examples\synthetic-run.json `
  --out $env:TEMP\askme-synthetic-report.json
```

## 指标定义

- `Recall@k`: 在前 k 个结果中命中的必要证据组比例。
- `MRR`: 第一个相关 span 的倒数排名。
- `nDCG@10`: 按 evidence group 的 gain 计分；同组等价 span 只得分一次。
- `citationPrecision`: 引用中属于金标证据的比例。
- `necessaryCitationRecall`: 被引用覆盖的必要证据组比例。
- `claimFaithfulness`: supported claim 占全部 claim 的比例。
- `correctRefusalRate`: 不可回答样本正确拒答比例。
- `keyFactRecall`: 摘要覆盖的必要事实比例。
- `factConsistency`: 摘要中 supported claim 的比例；同时报告 unsupported 与 contradicted 数量。

报告只写项目 ID、分组标签和指标，不回写问题、答案或源正文。

## 质量门

第一版按 `LEARNING_KERNEL.md`：Recall@20 ≥ 0.90、nDCG@10 ≥ 0.80、claim faithfulness ≥ 0.97、citation precision ≥ 0.95、必要引用 recall ≥ 0.90、不可回答正确拒答率 ≥ 0.95。高风险项目还应单独过滤并要求必要证据 Recall@20 和引用位置正确率为 1.00。

该工具负责确定性计分和版本检查。它不自动判断自然语言是否与证据蕴含，也不替代人工金标审核；这部分必须由独立裁决流程完成。
