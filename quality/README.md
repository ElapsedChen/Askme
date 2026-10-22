# Askme 内容质量评测

本目录把“回答看起来不错”改成可重复的质量门槛。金标文件只应在本机从已同步课程索引创建；不要把 UNSW 私有课件正文提交到代码仓库。

每个 case 至少包含问题和人工确认的相关 `segmentId`。可选 `goldClaims` 把课程事实拆成原子陈述，并保存一到多个短证据片段。运行结果文件按相同 case ID 提供：

```json
{
  "cases": [{
    "id": "case-001",
    "retrieved": [{"segmentId": "seg:..."}],
    "sources": [{"number": 1, "segmentId": "seg:...", "excerpt": "..."}],
    "answerItems": [{"text": "一个原子事实", "source": 1, "evidence": "来源中的逐字证据"}]
  }]
}
```

运行：

```powershell
node .\quality\evaluate.mjs .\quality\MANF9543_GOLD.local.json .\quality\MANF9543_RUN.local.json
```

报告包含 `hit@k`、`recall@k`、`MRR@k`、引用存在率、逐字引用支持率、原子事实支持率和金标事实覆盖率。默认门槛要求引用与原子事实支持率为 100%。模板中的示例不是课程事实，必须替换后才能作为真实验收。
