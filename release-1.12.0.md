# Askme 1.12.0 发布核查

日期：2026-10-04（Windows PowerShell 7）

## 构建身份

- Extension：`1.12.0 · 2026.10.04.3`
- Server：`2026.10.04.chatgpt-plan.13`（保持运行，不重启）
- Provider：`chatgpt-plan`
- ZIP：`dist/Askme-1.12.0-build-2026.10.04.3.zip`
- ZIP SHA-256：`59278624EBFFA664548763BB165D0FBB34F18354F2536611111D5007495CA450`
- ZIP 检查：41/41 文件，byte-for-byte match，zip integrity passed

## 候选核对

本轮 5 个候选文件为：

- `.work/retrieval-fix/content.js`
- `.work/retrieval-fix/ui-runtime.js`
- `.work/retrieval-fix/sync-health.js`
- `.work/retrieval-fix/extension/learning-core.js`
- `.work/retrieval-fix/extension/learning-service.js`

5 个候选文件与正式目录一致；`content.js` 仅按正式版本要求使用 `CONTENT_VERSION = '2026.10.04.3'`。候选和生产共 10 个文件的 `node --check` 已通过，随后只修正了生产 content 版本字符串，没有重复语法检查。

## 构建门槛

- `node tools/build-manifest.mjs` 成功。
- 构建指纹：`b4ee24e33035b601e94202cf338a694037e7f673e9fa6dc577bba04ced7d0b78`。
- `python tools/package-release.py` 成功。
- ZIP 内容与 extension 目录 41/41 字节匹配，完整性通过。

## 服务与验收边界

后台保持 `2026.10.04.chatgpt-plan.13`，本轮未重启服务。本次删除了 `panel-controller.js` 中日常 UI 文案“当前页面构建：2026.10.04.3”，未改变其他逻辑、版本或服务。旧包 SHA-256 `25E7592277752C551A53BF564C8CE0B0C80AE1BE37BED733ABFE872765D5FD00` 已由本次同版本纯文案重打包替代。

打包门槛未操作 Chrome 或调用 AI。其后 Luna 已在真实 Chrome 确认 build `2026.10.04.3`，并在 MANF 同步完成后验证首次问答：Solidworks、Fusion360、Denford VR Software 三项完整列出，来源卡对应原文全部三项，问答通过。记录见 `.work/retrieval-fix/manf-post-update-1.12.0-sources.json`；不把旧会话保留的更新前摘录当作新版采集结果。
