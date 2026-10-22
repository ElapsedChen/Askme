const endpoint = 'http://127.0.0.1:4317';
const headers = { Origin: 'chrome-extension://hmabehbhopolggfbmglhojehbjijcifi', 'Content-Type': 'application/json' };
const source = {
  title: 'Synthetic mechanics lecture',
  url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1',
  excerpt: 'Momentum equals mass times velocity. If mass stays constant, greater velocity gives greater momentum. Force can change momentum over time.'
};

async function post(path, body) {
  const response = await fetch(`${endpoint}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${data.error || ''}`);
  return data;
}

const generated = await post('/practice/generate', { source });
if (!/^[A-Za-z0-9_-]{32}$/.test(generated.sessionId) || !Array.isArray(generated.questions) || !generated.questions.length || generated.questions.some(item => Object.keys(item).sort().join(',') !== 'id,question')) throw new Error('生成响应包含无效字段或提前泄露答案');
const result = await post('/practice/check', { sessionId: generated.sessionId, questionId: generated.questions[0].id, attemptId: `attempt:smoke-${Date.now()}`, studentAnswer: 'I do not know.' });
if (!['correct', 'partial', 'incorrect', 'ungradable'].includes(result.verdict) || !result.modelAnswer || !result.feedback || !result.verification) throw new Error('判题响应无效');
const confirmed = await post('/practice/check', { sessionId: generated.sessionId, questionId: generated.questions[0].id, attemptId: `attempt:smoke-confirm-${Date.now()}`, studentAnswer: result.modelAnswer });
if (confirmed.verdict !== 'correct' || confirmed.verification?.status !== 'verified') throw new Error('正确参考答案未通过独立核验');
console.log(JSON.stringify({ questions: generated.questions.length, answersHiddenBeforeSubmit: true, unknownVerdict: result.verdict, unknownVerification: result.verification.status, correctVerdict: confirmed.verdict, correctVerification: confirmed.verification.status, feedbackReturned: true }));
