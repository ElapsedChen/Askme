import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorization, callback, readCompletion, requestBody } from './protocol.mjs';

test('OAuth 回调拒绝错配状态、不同账号注册和动态占位 ID', () => {
  const { attempt, url } = authorization('urn:uuid:fixture', 'http://127.0.0.1:4325/auth/callback');
  assert.equal(new URL(url).searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(new URL(url).searchParams.get('resource'), 'https://api.openai.com/v1');
  const cb = new URL('http://127.0.0.1:4325/auth/callback');
  cb.search = new URLSearchParams({ state: attempt.state, code: 'fixture', client_id: 'oaiapp_test' });
  assert.equal(callback(cb, attempt).body.get('redirect_uri'), attempt.redirectUri);
  cb.searchParams.set('state', 'wrong'); assert.throws(() => callback(cb, attempt), /STATE/);
  cb.searchParams.set('state', attempt.state); cb.searchParams.set('client_id', 'dynamic_agent_client'); assert.throws(() => callback(cb, attempt), /CLIENT/);
  cb.searchParams.set('client_id', 'oaiapp_other'); assert.throws(() => callback(cb, { ...attempt, clientId: 'oaiapp_original' }), /CLIENT/);
});
test('请求保留必要历史，过滤原始 URL 和账号字段，使用套餐支持的请求格式', () => {
  const req = requestBody('gpt-5.6-luna', '解释', [{ title: '测试材料', excerpt: '仅供协议验证，非真实课程。', url: 'https://private.invalid', account: 'private-account' }], [{ role: 'user', content: '前一问' }]);
  assert.equal(req.stream, true); assert.equal(req.store, false);
  assert.ok(!JSON.stringify(req).includes('private'));
  assert.equal(req.input.length, 2); assert.ok(!('max_output_tokens' in req));
  assert.throws(() => requestBody('x', 'y', []), /SOURCES/);
});
async function* stream(events, size = 3) {
  const bytes = Buffer.from(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
test('跨字节中文 SSE 完整完成才返回答案', async () => {
  assert.equal(await readCompletion(stream([{ type: 'response.output_text.delta', delta: '中文回答' }, { type: 'response.completed', response: { status: 'completed' } }])), '中文回答');
});
test('部分输出后限额、断流、不完整结果不能冒充成功', async () => {
  const partial = { type: 'response.output_text.delta', delta: '部分回答' };
  await assert.rejects(readCompletion(stream([partial])), /STREAM_INTERRUPTED/);
  await assert.rejects(readCompletion(stream([partial, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), /usage_limit/);
  await assert.rejects(readCompletion(stream([partial, { type: 'response.incomplete' }])), /INCOMPLETE/);
});
