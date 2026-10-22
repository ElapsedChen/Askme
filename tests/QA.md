# Askme：质量与安全核查

核查日期：2026-09-23。对象：本地 AI 服务、扩展权限与课程数据流。此文记录已验证事实和仍需在用户登录会话中验收的部分。

## 权限和数据流

| 环节 | 数据 | 权限 / 目的地 | 已知边界 |
| --- | --- | --- | --- |
| Moodle 页面 | 课程链接、用户选择课程的页面文本和文件链接 | `https://moodle.telt.unsw.edu.au/*`；扩展本机存储 | 仅在用户点击发现或同步后处理。已有两门课程真实同步结果，更多活动类型仍需验收。 |
| Moodle 日历 | 所选课程的事件 ID、标题、课程 ID、`due/open/close` 类型、时间和规范化活动链接 | 只读 GET `calendar/view.php?view=upcoming`；扩展本机存储 | 不读取日历描述、提交状态、成绩或作业/测验正文；只在用户手动同步时刷新，失败时保留旧结果。 |
| 课件解析 | 用户所选课程中最多 60 个可读取文件，单文件最多 20 MB | 扩展向本机 `127.0.0.1:4317/extract` 发送文件内容；本机 Python 解析后只把文字片段返回扩展 | 支持 PDF、DOCX、PPTX、XLSX、TXT、CSV；原文件不落盘。扫描件无法提取文字，片段上限 100 个。 |
| 语义索引 | 所选课程中最多 1200 个按标题、段落和句子形成的结构化片段，目标约 350–700 token | 扩展向本机 `127.0.0.1:4317/embed` 发送文本；本机 Ollama 编码后返回压缩向量，存入扩展本机存储 | schema v2 保存稳定片段 ID、章节路径、字符范围及相邻关系；不向 OpenAI 发送整门课程；服务不持久化索引。文本变化才重算向量；超限段数可见。 |
| 浮层、侧栏检索和复习 | 已缓存的页面标题、摘录、链接；浮层宽度和开关 | 课程数据按 Moodle 用户 ID 隔离；浮层 UI 状态使用独立非账号键保存在 `chrome.storage.local` | 无需本地 AI 服务。账号不一致时拒绝读取；扩展卸载、清理浏览器数据会影响缓存。 |
| AI 问答、讲解、复习 | 用户问题、模式及最多 5 段来源标题、URL、摘录 | 扩展向 `127.0.0.1:4317` 发送；默认只向本机 Ollama 发送问题、标题、摘录。显式选择 OpenAI 时才向 Responses API 发送这些内容；原始 URL 不进入模型请求 | 仅点击相关 AI 按钮时发送；请求体最多 32,000 字节，单段摘录最多 1,200 字符。OpenAI 模式设置 `store: false`。 |
| 回答事实核验 | 模型返回的单条事实、来源编号和短证据 | 本机服务先核对证据逐字属于对应来源，再检查条目原子性、数值、单位、技术标识和否定关系 | 属于确定性防线，不能替代完整语义蕴含模型；未通过时拒绝整份回答。 |
| 逐题自测 | 当前知识点摘录、生成问题、学生回答 | 扩展向本机 `/practice/generate` 与 `/practice/check` 发送；默认 Ollama 处理，显式配置 OpenAI 时才发送到其 API | 单请求最多 24 KB；提交前参考答案仅暂存在服务进程内存，不发送给浏览器；会话最多保留 30 分钟、100 组。模型须给出与原文逐字一致的证据片段，后端校验后才返回结果。模型判定不自动改动复习间隔。 |
| API 密钥 | `OPENAI_API_KEY` | 本地 Node 进程环境变量 | 不写入扩展代码或课程缓存。请勿将密钥放入版本库。 |

扩展声明的主机权限应限于 Moodle 和 `127.0.0.1:4317`；`storage`、`sidePanel`、`unlimitedStorage` 用于侧栏与本机课程索引。若代码增加其他网站或权限，需重新核查本表。

## 服务防护与局限

| 检查项 | 结果 |
| --- | --- |
| 来源限制 | `STUDY_EXTENSION_ID` 必须是准确的 32 位 Chrome 扩展 ID。直接启动时若未设置会报错退出（状态码 1）；测试服务在缺失、格式错误、其他扩展来源及普通网站来源下均返回 403。 |
| 监听地址 | 服务只监听 `127.0.0.1`。不向局域网开放。 |
| 输入边界 | `/answer` 接受 JSON；问题 1 至 1,500 字符；1 至 5 个来源；标题不超过 250 字符、摘录不超过 1,200 字符；请求体最多 32,000 字节。`/extract` 仅接收 Moodle 同源文件，原文件最多 20 MB，请求体最多 28 MB，解析超时 30 秒。`/embed` 每批最多 16 段、单段最多 1,400 字符、请求体最多 80,000 字节。 |
| 来源网址 | 解析 URL 后要求 `https://moodle.telt.unsw.edu.au` 精确同源且无用户名、密码。 |
| 上游调用 | `/answer` 初次生成：Ollama 最长 45 秒、OpenAI 最长 30 秒；两者随后最多用 15 秒做逐条语义核验，总上限不超过侧栏 65 秒。初次输出预算 1,000 tokens，核验 400 tokens；OpenAI 两次调用均设置 `store: false`；上游细节不回显给扩展。 |
| 回答引用 | 模型必须为每条回答返回有效来源编号和与该来源逐字一致的证据片段；编号越界、缺少证据或证据不在来源摘录中时，服务拒绝回答。侧栏同时保留可点击原文供核对。 |
| 学习模式 | 只接受 `answer`、`summary`、`quiz`；缺省为 `answer`。`quiz` 指生成原创回忆题，服务提示模型不复制或代答课程正式测验。三种模式共用输入上限及来源校验。 |
| 本机威胁 | HTTP `Origin` 可由本机程序伪造。精确扩展 ID 限制浏览器中的其他扩展，但不是抵御本机恶意程序的身份认证。 |

## 可复现验证

在 `D:\Askme` 运行：

```powershell
node --check .\server\index.mjs
node --test .\server\index.test.mjs
node --check .\extension\content.js
node --check .\extension\panel.js
node --check .\extension\background.js
node --check .\extension\learning-core.js
node --test .\tests\content.test.mjs
node --test .\tests\panel.test.mjs
node --test .\tests\background.test.mjs
node --test .\tests\learning-core.test.mjs
python -m unittest discover -s .\tests -p test_extract.py -v
```

本轮自动化结果：Node 280 项、Python 文件解析 7 项，共 **287 项通过**；扩展及服务端 JavaScript 语法检查全部通过。本机服务 `2026.09.23.11` 已启动并确认使用 Qwen3.5 9B 与 Qwen3 Embedding 0.6B，带两轮历史的真实本机 `/answer` 请求已返回有逐字证据的答案。覆盖范围包括 Moodle 课程封面右上角 Sync 标签、四个 SVG 快捷动作、跨扩展 iframe 握手、截图权限、可恢复错误提示、静态页讲解、连续问答历史、assessment 表格提取、截止事项、结构化正文与分片、知识点和未提炼页面混合学习队列、BM25/RRF/语义检索、回答原子事实核验、今日学习块、逐题自测、账号隔离、整课同步原子提交和文件解析。自动测试使用模拟课程数据；真实模型验收使用合成讲义，没有把真实 UNSW 课程内容发送到测试请求。

静态复核显示：活动页最终 URL 的路径及 `id` 要与原请求一致，且页面课程导航需指向所选课程；正文提取会移除进度和完成状态组件。Moodle 模板可能变更，仍需确认该课程导航规则不会误跳过正常活动。文本输出使用 `textContent`，课程链接显示前会核对 Moodle 同源。浏览器侧栏已完成两门课同步；语义检索和复习交互仍待实测。

## 浏览器验收状态

用户已在 Chrome 报告真实 Moodle 侧栏同步完成 2/2 门课程。0.11.0 已重构为课程、连续 AI 问答、截图、当前页讲解四个外层入口；课程卡新增 Askme Sync 标签，面板接近全高且各模块独立滚动，移除 U 标记和冗余说明；同时修复上下文失效未捕获、错误弹窗不消失、第四入口超时后不恢复、“读取不完整”误判、对话无法续问及知识单元导致其他页面从学习队列消失。MANF9543 原有 4 个文件夹活动实际跳回课程首页，应在重新同步后显示为“暂不可访问”。0.11.0 仍需在 Chrome 扩展管理页手动重新加载后做真实 Moodle 复验；当前浏览器控制入口不能接管 `chrome://extensions`。

下一轮浏览器验收需核对：重新同步后显示日历事项数量，首页 GSOE9820 Assignment Task 1 的时间应为 2026-10-02 17:00（Sydney），活动链接应为不带 `action=editsubmission` 的规范化查看链接；MANF9543 显示“暂不可访问 4 项”和语义索引数量；按分节提问不混入其他分节；逐题自测提交前不出现答案且提交后显示反馈；复习自评保存及到期排序。课程评估规则、截止日期和分数必须回到 Moodle 原文核实。





## 0.11.2 浏览器修复

真实 Chrome 验收发现内嵌 iframe 在 load 监听器绑定前开始导航，偶发向初始 Moodle 文档发送扩展源消息，造成白屏与 postMessage 错误。0.11.2 改为先绑定监听器再设置 iframe 地址，跨窗口发送失败会被转为可恢复状态；扩展来源直接由已验证扩展 ID 构造。

## 0.11.3 Chrome 握手兼容与课程卡入口

真实 Chrome 会在 Moodle 页面与 `chrome-extension://` iframe 的跨边界消息中把 `MessageEvent.source` 隐去为 `null`。0.11.3 在严格匹配来源 origin、一次性 capability 与 bindingId 的前提下兼容该行为，并保留不含凭据的握手诊断状态。课程卡的 Sync 标签固定在封面右上角，继续使用独立按钮，避免嵌套进 Moodle 的课程链接。

## 0.11.4 内嵌资源与真实 Chrome 握手

真实 Chrome 验收确认 0.11.3 的 iframe 已加载并已发送 INIT，但面板脚本没有启动。0.11.4 将 `panel.html` 依赖的样式与三个脚本作为同一组资源，仅向 UNSW Moodle 暴露，并发送不含凭据的启动信号。重新加载后宿主诊断从 `timeout/none` 变为 `ready/extension/iframe`，证明面板脚本已执行且 capability 绑定握手完成。Chrome 浏览器自动化随后按安全策略停止读取已打开的扩展 UI，因此面板内容与交互需要由用户视觉确认或在关闭扩展 UI 后继续验证 Moodle 宿主行为。


## 0.11.5 白屏渲染诊断

用户确认 0.11.4 虽已完成握手但面板仍为纯白。0.11.5 在授权与数据加载后显式恢复课程视图、重置 iframe 滚动位置，并向宿主回传仅含视图名、布局尺寸、文本长度和样式表数量的诊断结果，不包含课程文字或授权凭据。content 侧仍以扩展 origin、当前 iframe 与 bindingId 严格验证该消息；发送时实时读取导航后的 iframe.contentWindow。

## 0.11.8 修复与未完成验收（2026-09-24）

- 修复 toolbar action 仍自动打开 sidePanel 的旧行为；后台启动时设为 false，manifest 使用 popup.html。
- 修复 iframe 新增 v 参数却被后台拒绝的集成错误；仅接受合法单一版本参数，显式验证扩展协议与 host。
- 面板首次隐藏时布局尺寸可能为零；展开与 resize 后重新上报渲染状态，避免 fallback 持续覆盖。
- 四按钮去底板、下移、紫色独立样式，面板放在按钮左侧。此样式尚未在用户 Chrome 加载验收。
- 真实 Chrome 已验证：点击 Askme 截图按钮成功返回当前 Moodle 的 PNG 预览。
- 真实 Chrome 尚未通过：内嵌面板最后观测为 timeout，没有启动回包；不能宣称全部可用。
- popup 真实工具栏点击效果待用户反馈；浏览器工具明确禁止直接访问扩展 URL，未尝试绕过。
- 针对性自动测试：background/content/popup 共 74 项通过；panel 154 项通过。它们不能替代真实 Chrome 视觉与流程验收。

## 1.3.0 build 2026.09.26.14 握手竞态修复

- 修复同一 content script 的课程消息监听器抢答 `ASKME_EMBEDDED_READY_CONFIRMED`：监听器现在先按明确类型声明所有权，未知消息不读取账号且不应答。
- 同一 generation 的后台 READY 确认成为幂等终态；迟到的 iframe boot/auth/load 错误不能覆盖 `ready/confirmed`，不同 binding 不能替换已确认 binding。
- 新 generation 由后台定向撤销旧 binding；过期 binding 在诊断上报时由后台验证并撤销，撤销后的迟到 READY 不能复活旧会话。
- 每次重试使用新的 iframe 节点，授权 Promise、重试计时器和 load/error 事件均绑定 session 与 generation，旧导航乱序完成不能覆盖新 capability。
- 渲染诊断改为 panel 经 runtime 交给后台核验，再定向发送到原 Moodle document。宿主 dataset 只记录布局、枚举化 AI 状态、是否存在已选课程、课程计数和诊断来源；不包含课程 ID、课程文字、账号、问题或回答。
- 自动回归覆盖 listener 竞争、迟到错误、可信撤销、过期 binding、错误 sender/generation、诊断序列与双导航乱序。真实 Chrome 仍需重新加载 `.14`，确认 `askmeHandshake=ready`、`askmeAuth=confirmed` 且不再被迟到错误降级。
