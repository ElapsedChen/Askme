# 本地 AI 服务

## Assessment P0 数据边界（2026-10-01）

考核准备的第一阶段内核位于扩展侧 `extension/assessment-kernel.js`，不调用本机模型，也不读 DOM 或 storage。服务端没有获得 assignment brief、提交内容、attempt、成绩或反馈的新入口。普通问答和 assignment brief 继续隔离；brief 只从内容脚本已验证的静态 intro block 构建 requirement，不能进入普通问答、语义索引或知识单元。

服务 API 不消费 assignment brief、Requirement、CoverageLink 或 PreparationSnapshot。扩展会在整课同步事务内构建并持久化最小 `PreparationSnapshot`，只保存 requirement、coverage 和来源版本/范围的可复验身份，不复制课程正文、学生答案或 AI 输出。Assessment Workspace 和考核定向练习会把持久化对象与当前 Moodle 来源重新比对；schema、ID、课程、考核、覆盖或 sourceVersion 任一不一致都会失败关闭。跨文档通用 SourceSpan 和服务端覆盖核验仍属于后续阶段。

## 接口与数据边界

Chrome 面板通过扩展后台代理调用 `GET http://127.0.0.1:4317/health?deep=1` 检查服务、Ollama 和必需模型；快速的 `/health` 只证明 Askme HTTP 服务在监听。后台只接受精确的 Askme `panel.html` 发送者，并把固定端点和 HTTP 方法映射到 `127.0.0.1:4317`，不接受调用方提供主机、请求头或重定向目标。后台向每个本机请求固定加入 `x-askme-extension-id: <chrome.runtime.id>`，调用方不能覆盖。服务构建 `2026.09.30.1` 接受精确 `chrome-extension://<配置 ID>` Origin，或接受没有 Origin 且携带精确扩展 ID 头的后台请求；错误 Origin 即使同时带正确头也会优先拒绝，并返回结构化 403。这样内嵌扩展 iframe 不依赖页面上下文中的跨源或 Private Network Access 行为。深度检查返回 `ready`、`starting`、`degraded` 或 `model-missing`，并短时缓存探针结果。面板再经相同代理调用 `POST /answer`，请求体为 `{ "mode": "answer|summary|quiz", "question": "...", "history": [{ "role": "user|assistant", "content": "..." }], "sources": [{ "title": "...", "url": "https://moodle.telt.unsw.edu.au/...", "excerpt": "..." }] }`。`mode` 和 `history` 可省略，`mode` 默认 `answer`。连续问答最多发送最近 8 条历史；历史只用于理解“它”“继续”等指代，不能作为课程事实依据。成功响应保留 `answer`，并增加 `quality` 与 `verificationMethod`；降级或错误响应可带隐私安全的枚举 `reasonCode`。前端仍可只读取 `answer` 或 `error`。答案中的 `[1]` 对应请求中的第一条来源。

课件通过 `POST /extract` 在本机解析。扩展仅从 Moodle 同源读取用户所选课程的文件，单个文件最多 20 MB；请求包含课程 ID、文件 URL、标题、章节、MIME 和 base64 内容。服务用 Python/PyMuPDF 提取 PDF 页及 DOCX、PPTX、XLSX、TXT、CSV 文本，返回最多 100 个带页码或幻灯片编号的片段。原始文件不落盘，解析结果保存在扩展本机索引。图片扫描件若没有可提取文字，会明确报错。若超过 100 个片段，响应中的 `skippedParts` 会报告未索引数量。运行依赖系统 Python 和 PyMuPDF。

中文提问没有直接命中已索引文本时，扩展向 `POST /translate` 只发送原问题。本机 Ollama 返回最多 8 个英文检索词，扩展再检索已同步材料；课程正文不进入这一步的模型请求。生成答案时仍使用原问题。翻译失败则保留原检索结果，不因此制造来源。此功能仅在本机 Ollama 模式启用。

同步时，侧栏调用 `POST /embed` 把选定课程的文字切成最多 1200 段，每段约 1000 字符，每批最多 16 段，交给本机 `qwen3-embedding:0.6b` 编码。服务只返回压缩后的 1024 维向量，不保存原文或向量；向量与文字索引同存于扩展本机 `chrome.storage.local`。再次同步时按文本摘要复用未变化的向量。提问时同一接口只编码问题，侧栏在当前课程的向量中查找相关片段，并与关键词结果合并，最多 5 条进入 `/answer`。模型缺失或服务不可用时回退到关键词检索。

扩展从当前登录 Moodle 页面的唯一同源用户资料链接取得数字用户 ID，并把 `courses`、`library`、`reviewProgress`、`semanticIndex`、`chatHistory` 写入该用户的独立物理键。每个内容脚本请求带预期用户 ID，返回前再次核对页面账号。整课同步期间正文、文件页、向量和变化摘要只在内存构建，最后用一次 `chrome.storage.local.set` 同时提交课程库与语义索引；最终写入失败时旧快照保持不变。

逐题自测使用 `POST /practice/generate`，传入当前知识点的 `{source:{title,url,excerpt}}`，返回随机 `sessionId` 和 1 至 3 道 `{id,question}`。参考答案、解析和摘录暂存在服务进程内存，最多保留 30 分钟、100 组练习；不写入磁盘，也不在提交前发送给浏览器。学生提交后，侧栏调用 `POST /practice/check`，只发送 `{sessionId,questionId,studentAnswer}`，服务根据自己保存的题目和来源返回 `{verdict,feedback,modelAnswer,explanation}`；判定为 `correct`、`partial` 或 `incorrect`。两接口只接受 Moodle 同源静态讲义和文件来源，排除测验、作业与提交页面，单请求最多 24 KB。模型还必须返回与摘录逐字一致的证据片段，服务校验后才向侧栏返回题目或反馈。侧栏始终提供 Moodle 原文链接；模型反馈不会自动改变复习安排。

`/answer` 只接受准确的 Chrome 扩展来源 ID、1 至 5 条 UNSW Moodle 同源 HTTPS 来源、最多 1500 字的问题及每条最多 1200 字的摘录。服务不会自行读取 Moodle、Cookie 或密码，也不持久化收到的课程文本。同步时送往本机嵌入模型的是所选课程文字片段；问答模型只收到问题、来源标题和摘录。原始 Moodle URL 仅用于本地校验，不进入模型请求。来源内容可能含有恶意指令，因此系统提示明确要求模型把它当作普通材料。

## 提供者

默认 `STUDY_AI_PROVIDER=ollama`。服务仅向固定地址 `http://127.0.0.1:11434` 的 `/api/chat` 与 `/api/embed` 发送请求，不接受自定义 Ollama URL。问答模型默认 `qwen3.5:9b`，嵌入模型默认 `qwen3-embedding:0.6b`，可分别用 `OLLAMA_MODEL` 和 `EMBED_MODEL` 设置已下载模型。Ollama 不需要 API 密钥。本机已将 Ollama 0.34.2 安装在 `D:\Ollama`，模型安装在 `D:\OllamaModels`；模型清单确认两者分别约 6.6 GB 和 639 MB。真实模型生成、`/answer` 与 `/embed` 调用均已通过。首次加载问答模型及回答约 48 秒，嵌入模型会另占内存或显存。

如需 OpenAI，设置 `STUDY_AI_PROVIDER=openai` 和 `OPENAI_API_KEY`；可用 `OPENAI_MODEL` 改模型，默认 `gpt-5`。服务使用 Responses API，并设置 `store: false`。密钥只从启动服务的进程环境变量读取，不放进扩展或课程索引。两种提供者共用同一个 `/answer` 契约。

PowerShell 7 启动示例：

```powershell
chcp 65001; $OutputEncoding = [System.Text.UTF8Encoding]::new()
Set-Location -LiteralPath 'D:\Askme\server'
$env:STUDY_EXTENSION_ID = '从 chrome://extensions 复制的 32 位扩展 ID'
$env:STUDY_AI_PROVIDER = 'ollama'
$env:OLLAMA_MODEL = 'qwen3.5:9b'
$env:EMBED_MODEL = 'qwen3-embedding:0.6b'
node .\index.mjs
```

OpenAI 模式只需将 `STUDY_AI_PROVIDER` 改为 `openai`，在同一终端设置 `OPENAI_API_KEY`，然后重新启动服务。`STUDY_EXTENSION_ID` 错误或缺失时服务会拒绝启动。服务仅监听 `127.0.0.1`。

## 可靠性边界

模型必须在文本中给出本次请求存在的 `[n]` 来源编号，并为每个结构化事实返回与对应摘录逐字一致的证据。编号越界、证据不存在、日期时间字段冲突、否定方向相反或关键技术标识没有出现在证据中都会被拒绝。双方都符合明确英文方向关系句式时，服务还比较关系主语、宾语和方向；这是一项窄范围结构核验，不是通用自然语言推理。明确询问某项考核截止日期或时间时，服务会先完成确定性解析，且不会把未解决状态交给自由生成模型：同一来源内能唯一绑定活动主体、due 谓词、日期和所需时间字段时输出中文；不同日期或同日不同明确时间返回 `DEADLINE_CONFLICT`，同日 date-only 重复与唯一完整时间兼容。主体不匹配、只有开放时间、缺少具体时间或其他不唯一情况返回对应的提取式降级状态和连续原文。证据显式星期与 UTC 日历日期不一致时返回 `DEADLINE_WEEKDAY_MISMATCH`；没有星期时不补写。月份只按白名单映射，不使用宽松日期解析，不补写来源没有的时区，也不宣称冲突记录中的任一个有效。自动核验仍不能取代学生对 Moodle 原文的最终核对。来源片段不足、扫描件无法提取文字、超过文件上限或课程信息过期时，答案可能不完整；服务提示模型说明依据不足。模型不应复制或代答正式测验及可提交作业。

本机 Ollama 未启动、模型缺失、服务超时，以及 OpenAI 密钥或额度问题会返回区分原因的中文错误。服务不把上游原始错误响应返回侧栏。`/answer` 的初次生成在 Ollama 最多等待 45 秒、OpenAI 最多等待 30 秒，随后两种提供方都最多再用 15 秒逐条核验语义支持；初次输出最多约 1000 token，核验最多 400 token。上游成功但正文为空时返回 `GENERATION_EMPTY_RESPONSE`，响应 JSON 无法解析时返回 `GENERATION_INVALID_RESPONSE`，两者不会混入网络不可达状态。Ollama 仅在生成结果的 JSON、结构、原子性或逐字证据格式失败时执行一次最长 25 秒、700 token 的修复，修复结果重新经过完整证据和语义核验；数值冲突、日期冲突、否定冲突、语义不支持或审计服务故障不会触发盲目重试。语义审计超时、不可用或响应无效时失败关闭；`supported=false` 返回课程原文并标记 `SEMANTIC_UNSUPPORTED`，不会把改写后的模型陈述当作成功答案。服务日志只记录随机请求号、阶段、枚举原因、耗时、条目数和长度，不记录问题、上游正文或课程正文。Origin 与固定扩展 ID 头用于阻止普通网页直接调用或绕过后台代理；扩展 ID 不是秘密，本机进程仍可伪造这些 HTTP 字段，因此这不是本机进程之间的身份认证。

`/health` 返回服务构建版本和配置；`/health?deep=1` 还调用 Ollama 的版本与模型清单接口，只有两个必需模型都存在才返回 `ready`。`start-askme.ps1` 会核对精确构建版本、`qwen3.5:9b`、`qwen3-embedding:0.6b` 以及 Ollama 实际模型清单；旧服务仅在确认监听进程属于 `D:\Askme\server\index.mjs` 时自动替换，未知端口占用者不会被结束。

普通问答和摘要要求模型返回结构化条目。每条条目包含解释、来源编号和逐字证据；服务确认该证据确实存在于对应摘录后，才将解释与证据返回侧栏。JSON 无效、来源越界或证据不匹配均返回可操作错误，不以仅有合法 `[n]` 编号作为充分依据。

逐题练习的 Ollama 调用单次最多等待 90 秒；若 Ollama 返回临时 5xx，服务会短暂等待后重试一次。练习会话随服务重启丢失，侧栏可重新生成题目。

## 验证

```powershell
Set-Location -LiteralPath 'D:\Askme'
node --check .\server\index.mjs
node --test .\server\index.test.mjs
```

本地模拟测试覆盖两种提供者契约、来源 URL 不发送给模型、恶意来源与超限输入拒绝、扩展来源限制、无编号及越界编号拒绝、上游错误提示、逐题练习来源证据和 PDF 提取。真实本机 Ollama 已通过合成讲义的题目生成与回答反馈；UNSW 课程材料的题目质量和侧栏交互仍需真实使用验证。
