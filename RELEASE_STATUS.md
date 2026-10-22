# Askme release status

## 1.12.0 · 2026.10.04.3 — 本轮正式交付

- 合并课程嵌套列表读取、周次检索、历史污染与长摘录命中窗口修复；隐藏资源及无效 Moodle 活动记录显示具体原因。
- Luna 定向回归：检索 14/14（含既有 9 项）、真实 headless DOM 4/4、Moodle 错误分类 7/7。正式包校验见 `release-1.12.0.md`。
- 后台保持 `2026.10.04.chatgpt-plan.13`，ChatGPT Luna 配置保留；不启用本地模型。
- 用户真实 Chrome 已加载 2026.10.04.3；同步完成后 MANF Week4 问答完整列出三个软件并逐项引用原文，通过。此前 UI_BUSY 恢复、GSOE Task1 日期问答、练习保存、截图和会话选择题证据可复用。
- 最终软件验收完成，详见 `.work/final-release/goal-audit-1.12.0.md`。隐藏/缺失活动、无法识别文字的图片页及不支持格式继续如实显示；不将这些资料限制宣称为完整读取。
- 本轮按用户要求结束功能扩展和反复 debug，交付现有正式包及已知限制，详见 `FINAL_RELEASE.md`。下方均为历史发布记录。

## 1.11.2 · 2026.10.04.2 — 已发布并确认真实加载

- 1.11.1 的真实 UI_BUSY、Task1 日期及练习反馈已通过；Week4 大课件恢复，GSOE 31/33 文件完整。
- 复查发现 MANF 问答仅重复标题，不能算回答质量通过；同步后另一次 UI_STALE_RESPONSE 触发共享重连修复。
- 1.11.2 已合入：同一次语义审核增加问题相关性；并发 MISMATCH 共用一次重连；静态 intro 没有语义块时支持裸文本/div/span；真正旧响应显示友好提示。
- Luna 定向门槛：相关性 6/6 与事实回归 11/11，重连竞争 3/3，实际 DOM 说明夹具 4/4。真实 Task1 作业说明仍未确认恢复，图片页限制仍保留。
- Luna 已确认后台 `.chatgpt-plan.13` 运行，ready/authenticated/gpt-5.6-luna；12 个文件语法检查通过，ZIP 41/41 字节匹配。用户重载后已确认真实前端 2026.10.04.2。新同步的 GSOE Task1 说明错误消失，746 段 / 31/33 文件完整，只余两份 PDF 的三张图片页缺口。正式证据见 `release-1.11.2.md` 及 `.work/answer-relevance/real-1.11.2.md`。

## 当前发布状态（2026-10-04）

用户已重新加载 1.11.0，真实验收发现问答、复习出题和 UI_BUSY 队列阻塞，不能宣布最终完成。1.11.1 / 2026.10.04.1 的修复已合入正式目录并通过 Luna 发布检查：14 个变动文件语法与候选一致性通过，ZIP 41/41 字节一致；后台 .12 已隐藏重启，ready/authenticated/gpt-5.6-luna。真实 Chrome 尚未加载新版。GSOE9820 的真实同步已改善为 30/33 文件完整，但 4 项待处理仍存在。下方 1.11.0 的“等待验收”及“暂停”等为历史发布记录，新的真实证据见 `.work/final-release/real-1.11.0.md`。

## 1.11.1 · 2026.10.04.1 — UI_BUSY 和验收失败修复

- 已通过 Luna 队列定向 5/5、问答/活动日期/Range/练习定向 10/10、原文与练习规则回归 13/13。没有用测试结果替代真实 Chrome 恢复结论。
- 只读操作不再等待慢写队列；写入仍按账号串行；挂起、超时、取消和重绑可以释放队列，并阻止旧任务迟到后的新写入。
- 对齐课程章节来源 URL、问答摘录与历史上限；过去截止日可回查已发现的活动日期区；出题最多纠正一次并保持原文校验。
- 强 ETag 与日期校验按主版本选择；大文件具体漂移字段、作业说明具体失败原因分别显示。
- 原 1.11.0 文件备份在 `.work/acceptance-fix/baseline-1.11.0/`；实现与测试报告在 `.work/acceptance-fix/`。后台目标版本 `2026.10.04.chatgpt-plan.12`，正式运行及包证据由 `release-1.11.1.md` 记录。

## 1.11.0 · 2026.10.03.12 — 已发布，等待重载后的真实验收

- 正式合入并保留 `.work/final-release/baseline-1.10.0/` 备份；Luna 已确认正式 ZIP 41/41 文件字节一致、完整性通过；live 后台 .11 为 ready/authenticated/gpt-5.6-luna，登录保留，lastError=null。实际 /extract 的 OCR 正例和 DreamTeam 第 28 页空白识别均通过。
- 大课件支持四路受限 HTTP Range：本地真实 176.5 MB PPTX 仅读取 274,467 字节，68/68 物理幻灯片正文恢复，无空页、截断或跳过；206、版本一致性、原域、ZIP 结构与预算均受校验。真实 Moodle 响应仍待新加载版本同步证明。
- DreamTeam 装饰空页正确排除，保留图片/正文图形/批注负例；作业 intro 兼容自身同时为 activity-description 的真实 DOM；课程新索引过滤导航伪文件。
- PDF 无文本页增加离线 CPU OCR，普通英文图片 PDF 正例和原始物理页锚点通过。极短校徽残词、部分 OCR 或低可信结果不进入问答索引。
- 已知实际限制：Week 1 PDF 第 2/20 页图片标题、Strategy PDF 第 26 页图片封底仍未可靠提取，继续标为缺口并显示页码。未将这些页伪装成空白或完整读取。
- 增加当前页面构建显示；同步缓存、原 Logo/渐变/Folder、默认收起及对话内测验保持。
- 必须由用户重载扩展与 Moodle 后，执行一次 GSOE9820“更新资料”，验证导航清理、作业说明及大课件；再完成带引用问答和一题学习反馈。未完成此项前不宣布总目标完成。

证据：`.work/final-release/office-range-qa.md`、`quality/content-office-integration-qa.md`、`blank-page-qa.md`、`ocr-qa.md`、`final-acceptance-checklist.md`。

包：`dist/Askme-1.11.0-build-2026.10.03.12.zip`，699,750 bytes。SHA256 `CED7FAC3783C1804AF2872842CAB0D5B1B610668F21538698FA1E1FB3942FABA`。实际发布报告见 `release-1.11.0.md`。ZIP 仅含扩展；本机服务及 OCR 已单独部署。

## 本轮真实验收收尾（用户反馈已刷新，2026-10-03）

- 用户要求完成此次验证后收尾。后续开发暂停，保留未完成目标和以下问题。
- 真实 Chrome 面板显示 ChatGPT 已连接 · gpt-5.6-luna；实际后台 .10 为 authenticated/ready/connected。
- 框选截图通过：GSOE9820 非测验课程首页实际拖选课程名、附加截图、一次 Luna 问答正确返回课程名。这只覆盖该次选区问答。
- 课程续读未通过：仅重试未完整文件后仍为 685 段 / 27/35 文件 / 9 项待处理。Week 4 PPTX 仍显示“文件超过 20 MB 上限”，与正式新提示不一致；实际分块链路未得到成功证据，原因尚未定位，不能用合成上传成功替代真实同步。
- 版本证据须区分磁盘 manifest 与实际已加载脚本；最终说明见 Luna 报告。本轮没有全量同步，没有新增发布，也未宣称总目标完成。

证据：`.work/large-file/quality/real-1.10.0.md`、`.work/capture-upgrade/quality/real-crop-1.10.0.md`。

## 1.10.0 · 2026.10.03.11 — 大课件分块读取与截图合并交付（已打包，待用户重载）

- 合入 1.9.0 全部截图框选、失败重试和导航过滤；保留 1.8.2 Folder、课程正文持久缓存与默认收起。
- 20–100 MB 课件改为 2 MB 分块传输；文件不会以单个超大 Chrome 消息发送。普通问答继续检索已保存正文；主动更新才检查变化。Office 媒体不解压，只抽取受限正文 XML。
- 上传绑定账号/课程、120 秒自动过期、最多两份并发且每账号一份；离开页面取消下载，失败释放资源。错误提示覆盖传输忙和传输过期。
- Luna 隔离门槛：后台 5/5、content VM 2/2、runtime VM 4/4、实际 HTTP 4/4；25 MB 合成 PPTX 分 13 块传输并保留正文首尾，原 7 页课程 PDF 回归通过。未把合成课件当成真实 Moodle 同步成果。
- 正式代码已合入，后台升级为 `2026.10.03.chatgpt-plan.10` 并隐藏重启。Luna 确认 live ready=true、authenticated=true、connected、gpt-5.6-luna；向实际后台分块传输 25,015,255 bytes PPTX，13 块成功并保留首尾正文，未调用 AI。备份在 `.work/large-file/baseline-1.9.0/`。
- 用户确认加载的仍为 1.8.2。真实课程完整读取仍为 27/35；新版本的 Week 4 PPTX 和截图框选尚待真实 Chrome 验收。1.9.0 的历史包保留，后续统一加载 1.10.0。

包：`dist/Askme-1.10.0-build-2026.10.03.11.zip`，Luna 确认 40/40 文件逐字节一致。SHA256 `B8C4AFD59BE15B467FF888D17D73CA41593895359A3ED12CA8D8857F61BA04B6`；构建指纹 `20fffcb8da2be16e7f396be0f2c9493523a5171342c5046616e4a88c38deb6b2`。

证据：`.work/large-file/quality/backend-audit.md`、`frontend-audit.md`、`http-audit.md`、`release-1.10.0.md`。

## 1.9.0 · 2026.10.03.10 — 截图框选与可靠重试（已打包，待用户重载）

- 四个浮动入口中的截图现在先进入选区模式，支持拖选、反向拖选、重选、Esc/取消和截取整个可见页面。按实际截图尺寸裁剪，兼容高 DPI；视口变化拒绝错误选区。
- 截图短期票据保留两分钟，网络/保存失败可重试同一张图；成功保存问答后清除。错误账号或文档的读取不能销毁原账号票据。重试保留问题和截图到期时间。
- 合入课程导航过滤：前后活动导航、侧栏不再误入文件列表；合法折叠章节的文件仍被发现。长页解析规则缓存标记升级为 askme-text-2，旧规则不直接复用。
- Luna 当前生产截图相关 7/7、条件缓存 5/5 通过；region schema 及实际 OffscreenCanvas DPR=2 裁剪通过。隔离真实浏览器拖选/反向/小选区重选/取消/整页及 Folder 回归通过；resize/blur 由合成事件验证。JS 语法门槛通过。
- 用户当前加载的 1.8.2 已完成真实 Chrome 整页截图 → ChatGPT Luna → 回答课程名的单次链路。新框选尚未加载，因此不宣称框选真实课程端到端已通过。

包：`dist/Askme-1.9.0-build-2026.10.03.10.zip`，Luna 确认 40/40 文件与当前正式目录字节一致。SHA256 `D371474B2F58E47EA93A45C6D842DB3D0022AFD6F413ED762916BBF4414EF105`；构建指纹 `4fa92885adc54ee1c9e2f5ab2881285ac1075ba03f066b9455c333a6ec7e29b1`。后台保持 `2026.10.03.chatgpt-plan.9`、ready=true、gpt-5.6-luna。

证据：`.work/capture-upgrade/quality/capture-audit.md`、`real-vision-baseline.md`、`.work/folder-quality/capture-host-qa-2026-10-03.md`、`.work/ingestion-upgrade/quality/extract-page-qa-2026-10-03.md`。当前完整文件实际覆盖仍为 27/35；超 20 MB 的 Week 4 已确认是 PPTX，尚未解决；9 项剩余缺口不可因候选或测试通过而删除。

## 1.8.2 已加载 / 后台 chatgpt-plan.9 — 长页分段热修复

用户已确认重载 1.8.2。Luna 在真实 Chrome 通过 Folder 未选状态、展开列表、单行省略、选择 MANF9543 后收起及课程名切换验证；ChatGPT Luna 保持连接。证据：`.work/folder-quality/real-1.8.2.md`。

后台将长页从“每页只留前 5000 字”改为分段保存，页码引用保持原始物理页，分段 id 唯一。仍保留每物理页 100000 字及 1.5 MB 输出预算，超限明确为缺口。Luna 5/5 通过，实际 4317 对 12000 字单页返回 3 段并保留尾部，确认加载了新代码。无需用户再次重载扩展。

真实 Chrome 仅重试未完整读取文件：GSOE9820 从 **657 段 / 21/35 完整文件 / 15 待处理**，变为 **685 段 / 27/35 完整文件 / 9 待处理**。没有全面重同步；尚未达到全课程完整读取。证据：`.work/sync-quality/remaining-files-2026-10-03.md`、`.work/ingestion-upgrade/quality/candidate-extract-audit.md`。

运行服务版本为 `2026.10.03.chatgpt-plan.9`。前端 ZIP 仍为下述 1.8.2 的 40 文件发布包，未改前端；ZIP 的 build-manifest 记录发布时后台 .8，与此独立部署的后台 .9 区分。导航链接过滤的真实 DOM 验收已通过，前端改动留在 `.work/ingestion-upgrade/extension/` 待下一次合并发布。

## 1.8.2 · 2026.10.03.9 — Folder 与课程正文缓存（已打包，待用户重载）

- 会话输入区改为 Folder 胶囊入口，点击展开课程弹出列表，课程名保持单行；选择后收起，可重新切换。菜单按可用空间向上/下展开，支持 Escape、点击外部关闭。保留原 Logo、62% 渐变与对话内自测。
- 课程正文、来源与校验信息持久保存在 Chrome 扩展本地存储。普通问答直接检索已保存正文；主动更新时使用 ETag / Last-Modified 检查变化，304 或内容摘要相同则复用完整正文，不重复解析。正文变化或缓存不完整则重新读取。原始 PDF 二进制不作磁盘备份。
- 后台修复 Windows Python 子进程 GBK 输出导致 Unicode PDF 失败，明确使用 UTF-8；当前运行 `2026.10.03.chatgpt-plan.8`，原 ChatGPT 登录保留。启动脚本也检查 `.py` 源码更新时间。
- Luna 定向缓存 5/5、同步回归 8/8、JS/PowerShell 语法通过；旧 `.bin` 错误分类测试改为正确的 `FILE_UNSUPPORTED`，保留无原文泄露检查。真实 7 页作业 PDF 的 `/extract` 返回 7/7 页。
- 真实 Chrome GSOE9820（已加载 1.8.1 前端、修复后后台）由 51 段 / 10/35 完整文件，改善为 657 段 / 21/35 完整文件，仍有 15 个待处理项。剩余包括超 20 MB、非文档响应和正文缺页；未宣称完整同步。
- Folder 隔离视觉验收通过：实际查看用户两张参考图，320/500 px 单行课程、图标、展开/选择/切换、Escape/外部点击、选择后焦点和已有对话底部向上展开全部通过。详情见 `design-qa.md` 和 `.work/folder-quality/folder-qa-2026-10-03.md`。新 Folder/条件缓存尚未在用户 Chrome 重载，因此以上真实同步结果不能替代新前端验收。

包：`dist/Askme-1.8.2-build-2026.10.03.9.zip`。Luna 核对 40/40 文件与正式目录字节一致、WAR 图标和版本字段一致、后台 ready=true / gpt-5.6-luna。SHA256 `25A440D2CCB80A78462B521F139D1DE53301D0D647955998DD833E9885BA74BE`；构建指纹 `52fda8d4947c8485410f55db6e17c433e2e90db784090685ebb08a83fc1e0ad1`。ZIP 仅含扩展，后台独立部署。

证据：`.work/sync-quality/pdf-failure-diagnostic.md`、`course-cache-luna-2026-10-03.md`、`course-service-gate-luna-2026-10-03.md`。截图重试候选仍留在 `.work/capture-upgrade/`，没有混入此次发布。

## 1.8.1 · 2026.10.03.8 — 同步续读与明细（待用户加载后的真实验收）

已先对齐用户完成的 1.8.0 更新，再推进同步质量。真实旧前端更新 GSOE9820 后为 51 段正文 / 35 文件 / 20 项旧版未完成计数；旧计数有重复活动错误，不能视为精确缺失数。上轮背景、会话内测验及默认收起保持。

- 文件提取改为每批最多 5 个、45 秒发起预算，每批落盘并自动继续 pending，关闭面板后可恢复。解决只读取前 30 个文件、后续永远排不到的问题。
- 增加待处理明细、分页、原文链接及独立失败文件重试；已完整读取的文件不重复下载。明确区分完整文件数、缺口和不支持格式。
- 原文失败刷新继续保留为 stale；账号/文档绑定、revision 和 operationId 校验保留。文件失败返回受控分类，不返回解析器内部错误原文。
- Luna 新同步服务定向 8/8、UI 定向 7/7、旧 shadow fixture 回归 33/33；新增同步详情 320/500px 隔离渲染检查通过。这些均不能替代新版本真实 Chrome 验收。
- 本机服务更新到 `2026.10.03.chatgpt-plan.7`，使用现有 ChatGPT 登录与模型。受限启动首次失败后已检查无监听进程，以正常当前用户权限隐藏启动成功。
- 最终 Luna 核实：服务 ready=true / gpt-5.6-luna，包 37/37 字节一致。浏览器仅剩 Week 1 PDF 标签和扩展管理页；PDF 上的 UI_ACCOUNT_UNAVAILABLE 不属于 Moodle dashboard/course 验收，未据此认定课程面板或 ChatGPT 故障。

包：`dist/Askme-1.8.1-build-2026.10.03.8.zip`，37 文件，SHA256 `54D3C1262F195116A8441167A86FF685D830E19D09213E7A8523071C3D141D0E`。构建指纹 `8afa04c3086d6f88fd3ea549713b3c8973f3988e55151075fe285967810e2a5e`。ZIP 只包含扩展；本机 server 独立部署。用户 Chrome 尚需加载新扩展，不能宣称课程已完整读入。

证据：`.work/sync-quality/`。剩余下一步：新前端加载后对 GSOE9820 继续读取、实际缺口原因和资料覆盖率进行验收；依据真实失败类别修复，之后推进截图与长期学习闭环。

## 最终本轮验收：三项交付通过（2026-10-03）

正式前端 `1.8.0 · 2026.10.03.7`，本机后台 `2026.10.03.chatgpt-plan.6`。所有验收由 GPT-5.6 Luna 执行。以下结论覆盖本次工作范围，不代表所有课程或整个 Askme 长期目标完成。

1. 背景与品牌：粉紫/淡蓝颜色加深，渐变覆盖上部 62% 并过渡至纯白，原有 Logo 和 Askme 字标保留；隔离窄屏视觉检查已通过。
2. Open session：真实 Chrome / GSOE9820 / Luna 已显示 10 条经独立审核的 WBS 中文解释及原文引用，新对话后可从历史恢复。对话内 WBS 测验实际生成 3 题；第 1 题选择 D 并提交后显示答对、解析与页 3 引用，下一题进入 2/3。历史重开保留 D 选项、解析、引用与已答 1/3 / 答对 1 题。此项完整链路通过。
3. 默认收起：用户刷新后的真实 Moodle 页面只显示四个浮动按钮，主动点击第二个按钮才打开会话；已实际确认。

实际证据：`.work/conversation/quality/browser-preflight-2026-10-03.md`。真实内容验收范围为 GSOE9820 WBS；其他课程、同步未完成项和整套长期掌握度流程未在本轮验收。没有启用本地模型。

当前扩展包：`dist/Askme-1.8.0-build-2026.10.03.7.zip`，36/36 字节匹配，SHA256 `6B6E2EB5E6712F541F5C0EA16506923354EB8226FD448902DE11C1C7C506F480`。构建指纹 `44ce23c51edd0fdee2da53c13f047bbba93dc08f2b7c54a91ccea5153dc5e1e1`。ZIP 仅包含扩展，本机后台独立部署。以下记录保留修复过程，不能覆盖以上最终状态。

## 最新验收：问答与历史已通过，测验仍在复验

真实 Chrome / GSOE9820 / Luna：已显示 10 条有来源的 WBS 中文解释；例如 scope 而非 activities、按 major project deliverable 而非 lifecycle phase 组织顶层，均能回查所引原文。新对话后从历史返回，答案与 5 条来源恢复。默认收起、浮动按钮打开及新版会话界面亦已实测。

测验此前因审核不通过/请求中断，始终 0/3，尚无作答及解析验收成功证据。当前后台为 `.chatgpt-plan.6`：生成、纠正与盲审共享 140 秒总预算，单步最多 60 秒；TimeoutError/AbortError 有单独错误码，不再与解析异常混淆。Luna 选择题回归 14/14，通过。正在使用真实 Chrome 复验测验，不能把问答成功当作测验成功。

最新扩展 ZIP SHA256：`6B6E2EB5E6712F541F5C0EA16506923354EB8226FD448902DE11C1C7C506F480`；source fingerprint：`44ce23c51edd0fdee2da53c13f047bbba93dc08f2b7c54a91ccea5153dc5e1e1`。前端仍为 1.8.0 · 2026.10.03.7；以下为迭代记录。

## 当前部署：前端 1.8.0 · 2026.10.03.7 / 后台 .chatgpt-plan.5

后台已保留逐项通过独立语义审核的回答，未通过项被剔除；全不通过仍回退原文。启动脚本除版本号外，比较运行服务 startedAt 与最新业务源码修改时间，避免同版本旧进程漏载修复。Luna 回答定向 12/12、后台相关回归 56/56、启动脚本语法和新旧源码判断通过。真实 Chrome 问答/测验的最终复验进行中，尚不能标记完成。

最新扩展 ZIP SHA256：`007E647602052B9325024AAB29C0B16F2A86E23CFCEC8CD4AA067F2C3D10BA23`；source fingerprint：`c61bacb35ab29ccb4939e2bbdeef0ed7a9a9ee96ef082d6f3f1696bd77e97e87`。下方为迭代过程记录。

### .7 真实 Chrome 验收及后台修复进行中

- 用户已刷新。Luna 确认真正的默认收起、第二个会话入口、GSOE9820 课程选择正常，ChatGPT Luna 已连接。
- 第一条真实 WBS 问答返回 UI_SERVICE_FAILED；同一对话的 WBS quiz 成功建立卡片及引用，但最终 0/3，出现继续生成按钮。未通过真实回答、作答及解析验收。
- 独立后台诊断返回 NUMERIC_FACT_UNSUPPORTED，不能据此断言与 Chrome 失败是同一错误；原 Chrome 错误尚无明细。
- 磁盘后台 `.chatgpt-plan.3` 修复：一次有校验反馈的回答纠正（所有校验仍执行）；数字/单位词界允许紧邻中文；错误日志只写固定路由、机器码、状态和耗时，不写凭据或课程内容。服务尚待重启和复验。
- 回答纠正定向 Luna 5/5，相关后台回归 42/42；数字边界回归进行中。现有 `.7` ZIP 尚不包含这些后台修复，待验证后重新打包。

后续事实：数字边界回归 11/11、真实 PDF 定向 4/4 通过，`.3` 已运行并实测；真实问答仍因 NEGATION_MISMATCH 拒绝，quiz 日志为 UNVERIFIED_QUESTIONS（36 秒），均尚未通过。

`.4` 已启用：只有具备强制独立语义审核的回答管线可以延后跨中英否定词判断；通用校验默认仍严格，来源、数字及其他检查不变。定向 10/10、相关回归 50/50 通过。选择题增加最多一次有审核反馈的重写，每次重新盲审，最长 140 秒，第二次失败仍拒绝；选择题原有及新增定向 13/13 通过。真实 Chrome 复验进行中。

本机当前后台 `.chatgpt-plan.4`；前端仍为 `1.8.0 · 2026.10.03.7`。已更新扩展 ZIP 中的构建清单（ZIP 仅为扩展包，本机 server 目录独立部署）；最新 ZIP SHA256 为 `F4AA5FF6CB2CB55AD44C4609A27D964C8F4404F72DC20C7DFF100780FB41753A`，source fingerprint 为 `7bc3ced79892157e760a39c8ede49c3a5b691cd16268f2e3a5034afe97b82f0c`。下方 SHA 属于此前后台基线。

## 1.8.0 · 2026.10.03.7 — 对话内学习与测验

三个工作项独立汇报：① 加深背景和 62% 渐变已保留；② 新版 Open session 已合入正式目录；③ 新开/刷新 Moodle 默认只显示悬浮按钮的行为已保留。

- 会话移除顶部课程/问答/练习三选项，提供返回课程、新对话、历史记录；课程选择位于输入区，正文独立滚动。
- 自然语言或“选择题自测”触发对话内测验卡片，支持 1–12 题分批生成、单选、原文解析、翻页、历史回看。生成进度取自实际已生成题量。
- 测验绑定账号、课程、会话和连续原文；缺失指定周次时提示同步对应资料，不用其他周次替代。答案在提交前不下发，已提交解析可以回看；未作答题目受服务会话有效期限制。
- 正式后台启用 `conversation-skills.js`；ChatGPT 后端保持另一对话交付的 `.chatgpt-plan.2` 登录持久化实现，未覆盖其改动。
- Luna 生产前端整合 11/11、后台对话测验 7/7 通过；候选界面 DOM 3/3、320/500px 隔离视觉验收通过。以上不代表真实用户 Chrome、真实 ChatGPT 问答与出题已通过。
- 用户明确选择日常使用 Luna；Luna 验证代理已在真实 Chrome 的 Askme 设置中看到已连接及已选择 `gpt-5.6-luna`。扩展内部管理页无法由当前浏览器工具控制，已请求用户一次性刷新扩展和 Moodle，随后继续真实验收。

包：`dist/Askme-1.8.0-build-2026.10.03.7.zip`，36/36 文件字节匹配；SHA256 `E1283E8265529FDF0A2377CAF64880D7C474FA44AE20ED37678AA8AFEE67095E`。
Source fingerprint：`1c10882960d78593ed9274df2ebd80a9c0985830f5004e6df7b710e861e32fbc`。

## 2026.10.03.6 — 独立交付①背景、③默认收起

按用户要求三个工作项分开推进。

1. 背景与品牌：顶部颜色加深为 `#efd8e6/#dfd0fa/#d8e1fb`，渐变由 50% 延长到 62%，底部纯白。Luna 隔离 500×1200 截图及 320px 溢出检查通过；预览 `.work/shadow-ui/quality/settings-visual-fixture/askme-background-deeper-500x1200.png`。
2. Open session：仍为候选，未启用。对话内 quiz 模块文件已保存但 production background 尚未 import；旧课程/问答界面继续工作。候选 controller 在 `.work/shadow-ui/extension/panel-controller.js`，不能被旧备份覆盖。
3. 默认收起：新host `open=false`，旧layout.open不恢复，pagehide关闭；四个按钮主动打开。Luna 定向 3/3，通过；未声称用户真实 Chrome 已加载此构建。

ZIP `dist/Askme-1.7.0-build-2026.10.03.6.zip`，36/36 字节一致，SHA256 `84224C3F8CA3F57F58BA827E58448CE9CADBFFA4E959C0105022C53C602EFFC2`。

后台状态需重新核对：本轮最新读取发现磁盘 service/start 版本已是 `2026.10.03.chatgpt-plan.2`，本机 4317 连接被拒绝。此前“服务保持登录运行”的记录已过时，不可当作当前事实。

## 2026.10.03.5 品牌与背景修订

正式磁盘已更新。顶部粉紫至淡蓝渐变在面板高度 50% 处完全过渡为白色；复用原折带 Logo，配深紫/亮紫 Askme 字标；非选中导航透明，选中项白底淡紫边框。课程列表与课程下拉框去掉 Moodle 的 `Course is starred` 无障碍前缀。

Luna 在隔离 Chrome 以实际 320/400/500px host 宽度检查课程和设置页，Logo 加载、长模型名换行、下半部纯白与标题清理通过。证据：`.work/shadow-ui/quality/luna-visual-acceptance-2026-10-03.md`。用户实际 Chrome 尚未确认加载此修订。

ZIP: `dist/Askme-1.7.0-build-2026.10.03.5.zip`，35/35 文件逐字节匹配；SHA256 `3C27939F1637ACACEC8B5CF706495F0865FBC45600DA857D6D86B2D1FE0767D7`。Source fingerprint: `81751efdb47cabf97bd990db92be17ed0662236a01678c26da984e83a5906fbc`。

### 持续开发状态

- `study-service`、知识单元与进度模块已装入扩展后台；独立 Luna 当前生产合同与相关后端联合回归 31/31，通过首次正确、隔日不同题、幂等、来源/账号变化和无效引用拒写。新增文件抽取 `textTruncated` 字段排除回归已通过。
- 复习计划 controller 仍在 `.work/shadow-ui/extension/panel-controller.js`，未复制到生产。该候选 controller DOM 回归 11/11；真实课程/模型/浏览器闭环未通过前不得声称完成。
- `server/learning.mjs` 已在磁盘补充经审核 evidence；静态评分标准与复习讲义不再仅因标题含 Assignment/Exam 被屏蔽，动态答题/提交地址继续排除。
- 已登录服务未重启。因此服务器磁盘修订（No 否定识别、审定引用合同、静态材料范围）尚未在运行进程激活；服务仍报告 `.chatgpt-plan.1`，不得把这一版本号当作新修订已生效的证据。

## 2026.10.03.4 设置页与连接恢复修订

正式磁盘与 ZIP 已更新，用户 Chrome 尚未重新加载此修订；当前已登录的 ChatGPT 服务未重启。

- 状态入口使用淡紫底色、边框、“设置 ›”及键盘焦点反馈。
- 连接与模型分成两张卡片，卡片间距 16px，操作按钮间距 10px、最小高度 44px；窄容器自动单列。
- 执行前绑定丢失可同账号重连一次；定向联合 fixture 41/41 通过。
- 原文否定词识别修订通过既有 8/8 与真实 PDF 定向 4/4 测试。此服务修改尚未激活，不代表真实问答已经修复。
- 设置页 DOM 8/8 通过；Luna 使用隔离 headless Chrome，以实测 320/400/500px host 宽度检查设置页和返回课程页，无水平溢出。长模型名正常换行、按钮完整显示。这不替代用户 Chrome 加载新修订后的验收。报告：`.work/shadow-ui/quality/settings-layout-check-2026-10-03.md`。

ZIP: `dist/Askme-1.7.0-build-2026.10.03.4.zip`，32/32 文件逐字节匹配。
SHA256: `45DB1598907E07CE6BEB7ECB0A5E9DB074C66E896F2F311A54933C7060ABA4D5`。
Source fingerprint: `fcb68520c529ee455c2e20dfe4247406d9e4012fa60bf7ebf46dde676533a584`。

## 1.7.0 无 iframe 面板与 ChatGPT 套餐接入

Build: `1.7.0 · 2026.10.03.3`。正式目录已更新；服务 `2026.10.03.chatgpt-plan.1` 已启动。

- Moodle 浮层直接使用 closed Shadow DOM。主入口不再创建扩展 iframe；四按钮在侧栏左侧，保留拖宽、封面 Sync、纯白紫色界面。
- 后台使用按账号、tab/document、epoch 绑定的业务 broker。旧独立面板仅提示返回 Moodle，旧通用存储/AI handler 已移除；Chrome 缓存没有清空。
- AI 仅使用普通 ChatGPT 套餐授权。登录、模型目录与显式选择、断开、问答、原文核验、图片、选择题共用同一服务。启动脚本不启动或探测 Ollama，不请求 embedding。
- 聊天支持课程会话、历史和连续追问；正文单独滚动，输入框固定。账号变化清除界面旧资料，迟到结果不写入另一课程/会话。
- 选择题直接在界面选择 A/B/C/D，支持 1/3 题；生成与盲审后才显示题目，提交后显示逐项解析、引用、下一题和分数。答题前无答案键，不以点击或分数直接写成已掌握。
- PDF/PPTX 等仍在本机抽取正文；部分同步保留上次原文并标记 stale，过期/不完整来源不用于出题。

### 当前实际状态

2026-10-03 用户完成官方登录与模型选择；Luna 读取正式 `/chatgpt/status`：HTTP 200、provider=`chatgpt-plan`、state=`connected`、model=`gpt-5.6-luna`、ready=true。
真实 Chrome 已显示新面板、课程选择和提问输入，操作期间没有再次白屏。GSOE9820 首次问答失败；一次真实后台诊断返回 HTTP 502、`NEGATION_MISMATCH`，未得到答案。连接正常不能代表问答已验收。

### 当前磁盘修订（尚未重新加载）

- ChatGPT 状态改为带边框、底色和“设置 ›”的按钮；连接与模型分成卡片，统一按钮高度、间距及窄屏换行。
- worker 丢失内存绑定时，仅在执行前的 `UI_BINDING_MISMATCH` 自动重连一次，同账号才重放；过期或账号切换不重放。Luna 定向联合 fixture 41/41。
- 否定词核验补充英文整词 `No`，修复课程原文 `No duplication` 被漏认的情况；仍保留原文核验。已登录服务尚未重启，此修订尚未生效，真实问答仍待重验。
- 以下 ZIP 与 fingerprint 属于此前发布基线，不代表这些尚未打包的磁盘修订。

独立验证全部由 GPT-5.6 Luna 执行：后台/宿主/服务 30/30，controller DOM fixture 8/8，HTTP mock 贯通 1/1，ChatGPT 服务 43/43。生产 extension 31 文件、server 16 运行文件与候选逐字节一致。它们不能代替 Chrome 可见界面和真实课程质量验收。

ZIP: `dist/Askme-1.7.0-build-2026.10.03.3.zip`，32/32 文件逐字节匹配。
SHA256: `8714555581F84F3436D6A5386210FA4337C051AB099EB221313374DAEE30C464`。
Source fingerprint: `f4b58665ecea583e1795674878cece6e03cebb887ada2b499102804955f1b3c0`。

### 未完成的验收与迁移

真实 Chrome 当前面板正常显示；拖宽/遮挡、Moodle 缓存检索到 ChatGPT 回答与引用、真实 1/3 题质量、图片和自然续期仍待完成。登录令牌只在服务内存，服务重启需重新登录。
旧今日计划、知识单元掌握记录和自由短答复习界面尚未迁入新 controller；原数据保留，新同步会把旧派生知识点标为待重建。当前可见学习入口为选择题练习，不能声称整个长期学习目标已经完成。

可恢复备份：`backups/before-chatgpt-20261002T163450Z`。部署记录：`quality/chatgpt-migration-deployment.json`。不涉及浏览器账号缓存或登录凭据的导出。

验证报告：`.work/shadow-ui/quality/`、`.work/chatgpt-production/quality/luna-backend-validation-2026-10-03.md`。

---

## 1.6.2 白屏状态与恢复修订

Build: `1.6.2 · 2026.10.03.2`，本机服务不变。

真实 Chrome 捕获到 `srcdoc=""` 覆盖扩展 iframe，而宿主仍保留旧 READY 状态。新增文档替换检测、旧连接失效和面板内恢复提示；不与调试工具循环争抢 iframe。详见 `quality/white-screen-2026-10-03.md`。新版真实 Chrome 恢复验收仍待加载。

ZIP: `dist/Askme-1.6.2-build-2026.10.03.2.zip`，24 文件与 extension 字节一致。SHA256: `5741DCB4210D94EF62DBAD37376A595645C98FC45F49BE24A21319CA3F1768D8`。

Luna：content 测试 72/72 通过，content.js 和测试语法通过；包含文档替换、旧消息、恢复 generation 和窄屏提示。真实 Chrome 新版恢复未验收。

## 1.6.1 会话体验修订

Build: `1.6.1 · 2026.10.03.1`，本机服务仍为 `2026.10.02.1`。

- 历史、答案、引用共用一个滚动区域；底部固定输入区，正文 16px。
- 压缩问答顶部，分节筛选与引用折叠；空会话才显示建议问题。
- Enter 发送、Shift+Enter 换行，保留中文输入法合成；失败时恢复原问题且不覆盖新草稿。
- 删除会话立即使旧请求失效，避免存储等待期间旧回答写入新会话。
- AI 状态按钮禁止压缩，正常模型说明收起；嵌入面板为外层关闭按钮预留 60px。
- Chrome 合成预览检查 400×760、320×600；真实扩展仍待加载新构建后验收。未宣称 AI 回答质量已解决。
- Luna 定向功能验证 6/6 通过：来源、连续追问、会话切换、键盘/IME、失败恢复草稿和删除期间的旧回答丢弃；panel.js 语法检查通过。详细证据见 `.work/1.7/quality/session-ui-luna-validation-2026-10-03.md`。
- 1.7 学习册仍在独立工作区，没有混入本次发布。ChatGPT 接入已交给新对话 `01a0fd24-6105-7202-8aad-ea4e5ec674e5`。
- ZIP: `dist/Askme-1.6.1-build-2026.10.03.1.zip`，24 个文件与 extension 字节一致；SHA256 `285FAF48F4CC82E98E8D1580D0FD2AA380EE5265626830DE7FB4F0F24D5126AA`。

以下保留 1.6.0 基线记录；它不代表 1.6.1 已通过真实 Chrome 验收。

## 1.6.0 基线

Updated: 2026-10-03 (Sydney)

Build: `1.6.0 · 2026.10.02.1`

## Implemented in this build

- Adds an Assessment Workspace diagnostic that draws at most three current KnowledgeUnits only from explicit, current CoverageLinks. Missing mappings disable the diagnostic and show the evidence gap instead of guessing the assessment scope.
- Adds the `practice-v2` contract with `correct`, `partial`, `incorrect` and `ungradable` outcomes, criterion-level results, closed error tags, source evidence references and explicit verification state.
- Separates model feedback from mastery updates. Only a verified, current-source result can change progress; unsupported, stale, conflicting or unavailable judgement remains `待核对` and never counts as mastery.
- Adds a second local Ollama judgement audit and deterministic checks for numeric, directional and negation conflicts. External-provider mode fails closed when that local audit is unavailable.
- Adds stable attempt IDs, account-serial idempotent storage, source/preparation revalidation and privacy-minimal attempt history. Student answers, questions, model answers, feedback and course prose are not persisted.
- Adds `pendingDelayed` and `delayedConfirmed` progress. Delayed confirmation requires at least 24 hours, a different item and variant, and an unassisted verified correct response.
- Keeps formal quiz, assignment, attempt, submission and grade pages outside the practice evidence path.
- Deadline questions now repair historical course snapshots with a lightweight Moodle upcoming-events refresh before retrieval. Only an exact same-course, same-assessment and same due/open/close event may reach `/answer`; thrown, empty and non-matching refresh results fail closed and never send generic Assignment Examples as evidence.
- The real UNSW upcoming-event selector is fixed to `.block.event`, with a GSOE9820 Task 1 fixture matching the live Moodle structure.
- Assessment P0 is connected to production sync. Verified Requirement, CoverageLink and PreparationSnapshot v2 records are generated and stored without course prose, student answers or AI output, then consumed by Assessment Workspace and targeted practice.
- Assignment brief and assessment versions are recomputed from their full evidence, CoverageLink requires an exact course-source span plus an explicit shared-CLO relationship, and damaged, stale or source-mismatched snapshots close the preparation gate.

- Rebuilt the Moodle overlay as four independent actions with a tall resizable panel and a standalone toolbar popup.
- Added the generated reverse-purple open-panel logo inside the original pure-purple button.
- Made course selection explicit with `已选择` / `未选择` states; unselected courses no longer appear in Ask or Study scope.
- Moved Moodle course-card Sync controls to the cover's upper-left corner.
- Added persistent per-course chat sessions, screenshot questions, current-page explanation, review, practice and assessment planning.
- Replaced the visible Moodle profile ID with `已连接 UNSW Moodle`; the numeric value remains an internal account namespace only.
- Added strict handling for expired sessions, guest pages and common HTTP 200 Moodle access-error templates.
- Added structured local-AI health states, manual retry, build/capability validation and stale-response protection.
- Preserved all last-good file pages when the parser is offline or only returns part of a document.
- Marked preserved pages stale and excluded them from knowledge extraction, keyword retrieval, semantic retrieval, review and AI evidence.
- Kept assignment briefs outside general QA/review indexes while retaining evidence-bound assessment planning.
- Fixed the real Chrome iframe startup race that posted to the initial Moodle `about:blank` document and caused target-origin errors.
- Accepts the two safe Chrome serializations of the exact configured extension origin while continuing to reject Moodle and other extensions.
- Removed the stale `Askme 1.0` footer and the visible Moodle internal profile ID.
- Repairs a common Qwen evidence-format error only when the text after an explicit `摘录:` / `excerpt:` label is still an exact source substring.
- Adds a second semantic audit for every Ollama and OpenAI answer item; unsupported paraphrases are replaced with their exact course quote instead of being shown as facts.
- Uses source titles only to validate matching course identifiers, not as evidence for the claim itself; malformed local-model output safely falls back to exact Moodle quotes.
- Classifies Moodle’s “activity is currently hidden” and same-course redirects as `暂不可访问`, retaining retry metadata without inflating the generic page-failure count.
- Connects the Moodle overlay host without an iframe, then inserts the already-observed iframe into that connected host and assigns the real extension URL; inherited `about:blank` loads are still ignored. This prevents the white compositor state where scripts and handshake can run without a visible iframe surface.
- Routes every local AI operation through the MV3 background worker. The proxy accepts only the exact Askme panel sender and a fixed endpoint/method table, enforces request size and timeout limits, disables credentials and redirects, and never accepts a caller supplied host or headers.
- Enforces the 4,000,000-byte local-AI response limit while reading the stream: strict decimal `Content-Length` preflight rejects oversized responses before locking the body, incremental byte accounting stops before copying the first crossing chunk, and cancellation plus request abort prevent continued consumption. Complete in-limit bodies are decoded once as fatal UTF-8 and then parsed as JSON.
- Shows separate actionable messages for oversized responses, interrupted response streams, invalid UTF-8 and invalid JSON instead of reporting those failures as an offline service.
- Uses a deep AI health probe that verifies Ollama and both required models, with separate states for offline, origin rejection, version mismatch, starting, degraded and model missing.
- Shows the AI probe's concrete endpoint, HTTP/Ollama reason and runtime extension ID below the status badge instead of collapsing all failures into “AI 异常”.
- Reports iframe load errors with a direct `chrome://extensions` reload action.
- Replaces the failing Windows PowerShell 5 startup path with a verified PowerShell 7 scheduled task. One task now handles login plus five-minute recovery, uses `IgnoreNew`, and removes the duplicate Run entry.
- Generates `extension/build-manifest.json` and fails tests when the manifest, content script, panel, service, port, models or key source hashes drift.
- Moves the embedded panel iframe into one light DOM flex controller while keeping the Moodle rail and every course-card Sync control in independent closed shadow roots. The iframe and rail now share one right-anchored flex row, so opening the panel pushes the rail left without creating a second controller.
- Assigns a monotonically increasing generation to every embedded navigation, capability, binding and cross-frame message. A panel `postMessage` is only a non-authoritative hint; ready state now requires the background worker to validate the exact panel document/frame/binding/generation and send a document-targeted confirmation to the original Moodle content document.
- Prevents the course-data runtime listener from answering embedded READY confirmations: every content listener now claims only its own message types before reading account state or calling `sendResponse`. A confirmed binding is idempotent for its generation, late iframe boot/auth/load failures cannot downgrade it, and only a background-directed revoke or a new generation can invalidate it.
- Replaces the iframe for each embedded retry and binds authorization, retry timers and load/error handlers to the same session and generation, so an older navigation cannot overwrite a newer capability.
- Sends minimal render diagnostics through the runtime worker for binding verification before the original Moodle document writes them to host dataset fields. The diagnostic contains only bounded layout counts, an enumerated AI health state, whether any course is selected, course count and a monotonic sequence; it contains no course ID, course text, account, question or response.
- Restores the exact pre-capture root/panel hidden state, inline display value and CSS priority after both successful and failed screenshots. A versioned magenta/cyan QA marker exists behind an explicit test-only option and remains hidden in normal use.
- Adds a fixed `x-askme-extension-id` header to every background-proxied local AI request. Service `2026.10.02.1` accepts the exact configured Origin, or a missing Origin with the exact fixed header; a wrong Origin is rejected first with a structured 403 even if the header matches.
- Adds a deterministic deadline-answer path for questions that name a concrete assessment. It binds one activity subject, a due predicate, a date, an optional time and one continuous Moodle evidence span before rendering a concise Chinese answer. Conflicting dates or times, mismatched subjects, opening dates, missing requested times and weekday/date inconsistencies return explicit extractive states and never fall through to free generation.
- Separates model generation, evidence, semantic-audit and transport failures with privacy-safe reason codes. Ollama gets at most one bounded repair for JSON/schema/evidence-format failures; date, numeric, relation, negation and semantic conflicts are not retried until something passes.
- Extends deterministic claim checks for English month-to-Chinese date rendering, exact numeric-token boundaries, bidirectional negation and a narrow English directional-relation subject/object check while preserving the decimal `0.5` and semantic-direction regressions.
- Adds the first assessment P0 data layer: pure EvidenceRef/Requirement/CoverageLink/PreparationSnapshot contracts, fail-closed stale/conflict gates, exact KU covered ranges, decimal-safe sentence boundaries and residual learning cards for material left outside extracted KUs. Ambiguous brief links and non-mapping CLO mentions cannot become preparation guidance.
- Stores auditable Moodle calendar-event evidence during sync and routes deadline/date/time questions through a same-course event retriever before ordinary page search. Exact Task 1/Task 2 identity and due/open/close intent are separated; matching events stay ahead of generic “Examples” pages, while conflicting dates are all retained for deterministic refusal.
- Removes Moodle's assistive `Course is starred` / `Course is not starred` text from discovered course titles without changing legitimate course names.
- Keeps the four-button rail on a transparent base, centers it lower in the viewport, allows wrapped left-side tooltips in narrow windows, and preserves the shared flex layout that pushes the rail left when the panel opens.
- Restricts `/answer` evidence URLs to canonical read-only Moodle course, static-resource and calendar activity paths. Arbitrary same-origin paths and URLs carrying `attempt`, `action`, `sesskey` or other operation parameters are rejected.

## Current verification

- Extension/repository Node suite: 362/362 passed. Local-service Node suite: 68/68 passed. Coverage includes deadline snapshot repair and fail-closed empty/non-matching events, production Assessment P0 persistence and gates, event-evidence retrieval, canonical service source URLs, strict background AI proxy routing, typed deadline resolution and privacy-safe failure classification.
- Python extraction suite: 7/7 passed.
- JavaScript syntax checks passed for content, panel, background, panel bootstrap, popup and server.
- Local service `2026.10.02.1` is running with Ollama, `qwen3.5:9b`, `qwen3-embedding:0.6b` and answer/embed/practice/vision capabilities when called through the fixed extension identity header.
- Deep health reports `practice-v2` in addition to answer, embed, practice and vision. A live local generate/check smoke hid answers before submission, returned privacy-safe `ungradable/unverified` for an intentionally unknown answer, then independently verified the revealed reference answer as `correct/verified`.
- GPT-5.6 Luna independently passed the 1.6.0 release gate: extension 362/362, service 68/68, extraction 7/7, build fingerprint equality, ZIP 24/24 byte equality, exact SHA-256, deep local health and the mapped-only/privacy/idempotency/delayed-retest invariants.
- The `Askme Local AI` task was registered with two triggers, exited with result `0`, has a future five-minute run, and the old duplicate `AskmeLocalAI` Run entry is absent.
- A post-upgrade `/answer` smoke test completed in 10.76 seconds and returned a Chinese explanation whose displayed evidence was an exact substring of the supplied English course excerpt.
- Candidate package `dist/Askme-1.6.0-build-2026.10.02.1.zip` contains all 24 extension files with no missing, extra or byte-mismatched entries; ZIP integrity passed. SHA-256: `4E48A1049394A2F8FE3CE88CFC16F03A409AC9DBA8C9A4BEB52128CADCC4651E`. Current source fingerprint: `427bf16eba6c5dc1bd26a8b61cf61137e7f558122f0fedf04db92d2959641bad`.
- A real local `/answer` request returned a source-grounded Chinese answer with citation `[1]`.
- The real GSOE9820 Task 1 deadline excerpt now returns the verified Chinese date/time and exact quote in 67 ms through the running service. Independent Task 2 data also passed, while conflicting deadlines, subject mismatch and weekday/date mismatch returned their explicit extractive reason codes in 1-6 ms without model calls.
- GPT-5.6 Luna independently passed the second answer-quality gate: service 57/57, repository 321/321, real localhost deadline cases, mixed full/date-only conflicts, relation argument reversal, empty/invalid generation diagnostics, leap-day and UTC date boundaries.
- Three repeated `/answer` runs against the live MANF9543 Week 1 course-page text returned HTTP 200 in 6.43 s, 9.94 s and 4.04 s; every displayed claim retained an exact Moodle quote, and unsupported paraphrases were visibly downgraded to that quote.
- Live MANF9543 resource checks confirmed folder `9056822` exposes 16 SolidWorks parts as link-only resources, folder `9056859` exposes one practice PDF plus one SolidWorks part, and hidden folder `9056860` redirects to the course page with “activity is currently hidden”; the latter must appear as `暂不可访问` rather than a generic page failure after the new build is loaded.
- Moodle single sign-on was restored in Chrome and the live Dashboard no longer shows the Session expired dialog.
- GPT-5.6 Luna confirmed the `.7` iframe regression fixture covers the real two-stage load sequence and independently closed the `.8` answer-quality blocker across Ollama and OpenAI paths.

## Browser acceptance still required

- Reload the unpacked extension once so Chrome replaces the currently loaded build with `1.6.0 · 2026.10.02.1`.
- Refresh the logged-in Moodle Dashboard once.
- Verify the panel renders visibly on first load and after “重试内嵌连接”, only one rail/panel controller exists, opening the panel pushes the rail left, and collapse/resize state persists. The host should remain `askmeHandshake=ready` and `askmeAuth=confirmed`; delayed panel errors must not replace those values.
- Verify screenshot success and failure both restore the exact panel/rail state, the normal build shows no magenta/cyan QA marker, and the AI state reports connected through service `2026.10.02.1`.
- The live Chrome Dashboard visibly shows the four-button rail and purple Sync badges on GSOE9820 and MANF9543. Verify the generated open-panel logo and course-selection feedback inside the panel, then run one real GSOE9820/MANF9543 sync if the stored snapshot is stale.
- Inspect Chrome's extension error panel after the reload. The browser control interface cannot claim `chrome://extensions/`, so this remains a manual check.
- Run the GSOE9820 Task 1 deadline question through the real panel and confirm the same verified answer and Moodle citation seen at localhost. Then run one document-backed summary and one practice flow before release sign-off.

Chrome automation can confirm the Moodle host, rail and Sync badges, but claiming the tab adds an empty `srcdoc` attribute to the cross-extension iframe in the automation representation. That produces a white automation-only surface and cannot be used as evidence about the user's normal panel. Panel acceptance must therefore use the user-visible Chrome surface until the browser controller can observe extension iframes without rewriting them.

This build is not yet marked as a final release because `1.6.0 · 2026.10.02.1` still requires real Chrome loading and acceptance against the live Moodle course. An `aiState=ready` diagnostic confirms the local health probe only; it does not replace a real course answer test.
