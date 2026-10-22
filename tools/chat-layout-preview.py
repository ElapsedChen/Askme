from pathlib import Path
import re
import shutil

root = Path(__file__).resolve().parents[1]
out = root / 'quality/chat-preview'
out.mkdir(parents=True, exist_ok=True)
html = (root / 'extension/panel.html').read_text(encoding='utf-8')
html = re.sub(r'<script\b[^>]*>[\s\S]*?</script>', '', html)
html = html.replace('<body>', '<body class="embedded">')
html = html.replace('id="courses" class="view"', 'id="courses" class="view" hidden')
html = html.replace('aria-labelledby="tab-ask" hidden', 'aria-labelledby="tab-ask"')
html = html.replace('正在连接 UNSW Moodle', '本地布局预览 · 合成内容')
html = html.replace('AI 检查中', 'AI 服务已连接').replace('data-state="checking"', 'data-state="ready"')
html = html.replace('id="account-label">Askme', 'id="account-label">已连接 UNSW Moodle')
html = html.replace('<p id="ai-detail" class="ai-detail" role="status" aria-live="polite"></p>', '<p id="ai-detail" class="ai-detail" role="status" aria-live="polite" data-state="ready">模型：qwen3.5:9b</p>')
html = html.replace('</body>', '<button aria-label="关闭按钮占位" style="position:fixed;z-index:50;top:10px;right:10px;width:34px;min-height:34px;border:1px solid #eee;border-radius:11px;background:white">×</button></body>')
html = html.replace('<select id="ask-course" aria-label="当前课程"></select>', '<select id="ask-course" aria-label="当前课程"><option>GSOE9820 · Engineering Project Management</option></select>')
html = html.replace('aria-describedby="ask-section-help"></select>', 'aria-describedby="ask-section-help"><option>全部已同步分节</option><option>Week 1</option></select>')
html = html.replace('id="prompt-suggestions" class=', 'id="prompt-suggestions" hidden class=')
html = html.replace('<div id="chat-history" class="chat-history" aria-live="polite"></div>', '<div id="chat-history" class="chat-history" aria-live="polite"><article class="chat-message user"><p>我不太理解这两个概念的区别，可以一步步讲清楚吗？</p></article></div>')
html = html.replace('<div id="answer" class="answer" hidden></div>', '<div id="answer" class="answer">这是合成的排版示例，不是课程结论。\n\n先用一句话理解\n概念 A 描述要达到的结果；概念 B 描述为了实现结果需要完成的工作。\n\n1. 怎么区分\n先看它回答的是“为什么”，还是“具体做什么”。把一句话拆开，就更容易识别。\n\n2. 一个简单例子\n这里用演示文字检查长答案在窄侧栏中是否自然换行，来源和输入框是否仍然可用。\n\n3. 检查理解\n试着用自己的话解释，并指出判断依据。</div>')
html = html.replace('<div id="sources" class="sources" aria-live="polite"></div>', '<div id="sources" class="sources"><details class="source-disclosure"><summary>查看 2 处来源</summary><div class="source"><a href="#">演示讲义 · 第 3 页</a><p>这段合成文本用于验证引用展开后的滚动，不代表真实 Moodle 资料。</p></div></details></div>')
(out / 'panel.html').write_text(html, encoding='utf-8')
shutil.copy2(root / 'extension/panel.css', out / 'panel.css')
(out / 'assets').mkdir(exist_ok=True)
shutil.copy2(root / 'extension/assets/askme-48.png', out / 'assets/askme-48.png')
(out / 'index.html').write_text('''<!doctype html><meta charset="utf-8"><title>Askme 会话布局预览</title><style>body{margin:24px;background:#e8e8ee;font:14px system-ui}main{display:flex;gap:28px;align-items:flex-start}iframe{border:1px solid #d9d3e7;border-radius:18px;background:white}h1{font-size:18px}p{color:#645e70}</style><h1>Askme 会话布局 · 合成预览</h1><p>用于检查排版，不代表真实课程回答或扩展运行验收。</p><main><div><p>400 × 760</p><iframe title="标准侧栏" src="panel.html" width="400" height="760"></iframe></div><div><p>320 × 600</p><iframe title="紧凑侧栏" src="panel.html" width="320" height="600"></iframe></div></main>''', encoding='utf-8')
print(out)
