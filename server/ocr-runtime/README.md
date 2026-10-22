# 本地 PDF OCR 依赖

固定 `tesseract.js 7.0.0`，`@tesseract.js-data/eng 1.0.0` 和 `@tesseract.js-data/chi_sim 1.0.0`。
完整依赖树和 npm integrity 见 package-lock.json。运行时从本目录读取已安装的语言数据，禁止自动下载；无需 Ollama 或其他 LLM。

部署时将此目录及 node_modules、tessdata 一起复制到目标 server/ocr-runtime。也可在部署前执行 `npm ci --ignore-scripts --no-audit --no-fund`，再执行 `node prepare-data.mjs` 把固定语言包复制到本地统一 langPath。服务运行要求 Node.js 和已有 PyMuPDF、Pillow Python 环境。

集成：在 PDF 空白页判定后调用 `enrich_empty_pdf_pages(data, result)`。仅无文字且没有 blankKind 的页会处理，最多 8 页、每页 150 万 RGB 像素、总预算 18 秒。英语模型和 PSM 3 自动版面优先；英语无结果且预算至少剩余 4 秒才尝试中英文模型。额外页保持 `ocr.status=page-budget`。成功页保留 physical number，并增加 extractionMethod、ocrConfidence、ocr。partial 页的残词不写入正文，不作为课程回答证据，继续保留内容缺口；no-text-detected 不能作为空白页依据。OCR 不读取图表或照片的视觉含义。

验证尚未由实现代理执行，必须交给指定 GPT-5.6 Luna：核对真实 PDF 第 2、20 页标题；核对无文字图片封底不被判空白；核对已有文本页不调用 OCR、低置信页保留缺口、页码不漂移、超过 8 页/超时保留缺口、本地离线数据路径、Windows 无弹窗且超时无遗留进程。根提取器分块时必须传播 extractionMethod/ocrConfidence/ocr，部分识别不能变为完整覆盖。

来源： https://github.com/naptha/tesseract.js 和 https://github.com/naptha/tessdata

彩色线条补偿：先识别原 RGB 图；预算允许时，对 RGB 最大通道以 150 阈值保留暗色字，额外识别一次。仅当额外结果整段通过原置信度门槛、可靠字数至少增加 4 字或 25% 且置信度不低于原结果时采用。结果记录 imagePass；无法满足条件就保留原结果或缺口。两通道共同受单页 5 秒/总计 18 秒预算约束，不增加像素上限。
