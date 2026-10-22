import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanSession } from './plan-session.mjs';

const grant = (extra = {}) => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: 'fixture-id',
  token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', ...extra });
async function setup({ fetchExtra, verifyExtra, registration } = {}) {
  let clock = Date.now(), nonce, refreshCount = 0, saved;
  const session = createPlanSession({ hostId: 'urn:uuid:fixture', redirectUri: 'http://127.0.0.1:4325/auth/callback', registration,
    now: () => clock, saveRegistration: async r => { saved = r; },
    verifyId: async (...args) => verifyExtra ? verifyExtra(...args, nonce) : { sub: 'fixture-sub', nonce },
    fetchImpl: async (url, opts) => {
      if (opts?.body?.get?.('grant_type') === 'authorization_code') return Response.json(grant());
      if (opts?.body?.get?.('grant_type') === 'refresh_token') refreshCount++;
      if (fetchExtra) { const result = await fetchExtra(url, opts); if (result) return result; }
      if (opts?.body?.get?.('grant_type') === 'refresh_token') return Response.json(grant({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: undefined }));
      if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-5.6-luna', display_name: 'Luna', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] });
      if (String(url).endsWith('openid-configuration')) return Response.json({ revocation_endpoint: 'https://auth.openai.com/revoke-fixture' });
      if (String(url).endsWith('revoke-fixture')) return new Response(null, { status: 200 });
      throw new Error('Unexpected fixture request');
    } });
  const auth = new URL(session.beginLogin().url); nonce = auth.searchParams.get('nonce');
  const callback = new URL('http://127.0.0.1:4325/auth/callback');
  callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture-code', client_id: registration?.clientId || 'fixture-client' });
  return { session, callback, auth, login: () => session.finishLogin(callback), advance: n => clock += n, count: () => refreshCount, saved: () => saved };
}

test('登录只保存账号映射；状态不泄露任何令牌；回调不可重放', async () => {
  const x = await setup(); await x.login(); await x.session.listModels();
  assert.deepEqual(x.saved(), { clientId: 'fixture-client', subject: 'fixture-sub' });
  assert.equal(x.session.status().models.length, 1);
  assert.doesNotMatch(JSON.stringify(x.session.status()), /fixture-(access|refresh|id)/);
  await assert.rejects(x.login(), /OAUTH_STATE_INVALID/);
});
test('身份和 state 错配均在激活会话前拒绝', async () => {
  const bad = await setup(); bad.callback.searchParams.set('state', 'wrong'); await assert.rejects(bad.login(), /OAUTH_STATE_INVALID/);
  const other = await setup({ registration: { clientId: 'saved-client', subject: 'another-account' } });
  assert.equal(other.auth.searchParams.get('client_id'), 'saved-client');
  await assert.rejects(other.login(), /IDENTITY_INVALID/);
  assert.equal(other.session.status().authenticated, false);
});
test('并发过期请求只刷新一次，下一次使用最新轮换令牌', async () => {
  const seen = [];
  const x = await setup({ fetchExtra: async (_url, opts) => {
    if (opts?.body?.get?.('grant_type') === 'refresh_token') {
      seen.push(opts.body.get('refresh_token')); assert.equal(opts.body.has('scope'), false);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } });
  await x.login(); x.advance(3550000);
  const sessions = await Promise.all(Array.from({ length: 12 }, () => x.session.getSession()));
  assert.equal(x.count(), 1); assert.ok(sessions.every(s => s.accessToken === 'new-access'));
  x.advance(3550000); await x.session.getSession();
  assert.deepEqual(seen, ['fixture-refresh', 'new-refresh']);
});
test('临时刷新失败保留会话并退避；invalid_grant 清除无效令牌', async () => {
  for (const code of ['temporarily_unavailable', 'invalid_grant']) {
    const x = await setup({ fetchExtra: async (_url, opts) => opts?.body?.get?.('grant_type') === 'refresh_token' ? Response.json({ error: code }, { status: code === 'invalid_grant' ? 400 : 503 }) : undefined });
    await x.login(); x.advance(3550000); await assert.rejects(x.session.getSession(), new RegExp(code));
    assert.equal(x.session.status().authenticated, code !== 'invalid_grant');
    await assert.rejects(x.session.getSession(), code === 'invalid_grant' ? /LOGIN_REQUIRED/ : /PLAN_REFRESH_BACKOFF/);
    assert.equal(x.count(), 1);
  }
});
test('刷新成功但丢失替换令牌时不再次使用旧令牌', async () => {
  const x = await setup({ fetchExtra: async (_u, o) => o?.body?.get?.('grant_type') === 'refresh_token' ? Response.json(grant({ refresh_token: undefined })) : undefined });
  await x.login(); x.advance(3550000); await assert.rejects(x.session.getSession(), /TOKEN_RESPONSE_INVALID/);
  assert.equal(x.session.status().authenticated, false);
});
test('断开等待刷新完成并撤销最新令牌，不允许晚到结果复活会话', async () => {
  let unlock, entered; const started = new Promise(r => entered = r), gate = new Promise(r => unlock = r); let revoked;
  const x = await setup({ fetchExtra: async (u, o) => {
    if (o?.body?.get?.('grant_type') === 'refresh_token') { entered(); await gate; }
    if (String(u).endsWith('revoke-fixture')) revoked = o.body.get('token');
  } });
  await x.login(); x.advance(3550000); const renewing = x.session.getSession(); await started;
  const out = x.session.disconnect(); unlock(); await assert.rejects(renewing, /LOGIN_REQUIRED/);
  assert.equal((await out).revoked, true); assert.equal(revoked, 'new-refresh'); assert.equal(x.session.status().authenticated, false);
});
test('退出取消推理正文；远程撤销失败有明确恢复提示', async () => {
  const x = await setup({ fetchExtra: async (u) => {
    if (String(u).endsWith('/responses')) return new Response('pending');
    if (String(u).endsWith('revoke-fixture')) return new Response(null, { status: 403 });
  } });
  await x.login(); const response = await x.session.authorizedFetch('https://api.openai.com/v1/responses', { method: 'POST' });
  const out = await x.session.disconnect(); assert.equal(out.revoked, false); assert.match(out.action, /ChatGPT/);
  await assert.rejects(response.text(), /SESSION_CHANGED/);
  await assert.rejects(x.session.getSession(), /LOGIN_REQUIRED/);
});
