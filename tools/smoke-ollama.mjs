const response = await fetch('http://127.0.0.1:11434/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  signal: AbortSignal.timeout(120_000),
  body: JSON.stringify({
    model: 'qwen3.5:9b', stream: false, think: false,
    messages: [
      { role: 'system', content: '用简短中文回答，并标记给定来源编号。' },
      { role: 'user', content: '来源[1]：惯性表示物体保持运动状态的性质。用一句话解释惯性。' }
    ]
  })
});
const data = await response.json();
if (!response.ok) throw new Error(JSON.stringify(data));
console.log(JSON.stringify({ model: data.model, answer: data.message?.content, totalDurationMs: Math.round((data.total_duration || 0) / 1e6), evalCount: data.eval_count }));
