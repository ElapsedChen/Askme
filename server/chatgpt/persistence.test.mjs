import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanSession } from './plan-session.mjs';

function fixture() {
  let saved = null, registration, clock = Date.now(), refreshCount = 0, temporaryFailure = false, invalid = false;
  const store = { persistent: true, load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); }, clear: async () => { saved = null; } };
  function instance() {
    return createPlanSession({ hostId: 'urn:uuid:fixture', redirectUri: 'http://127.0.0.1:4325/auth/callback', registration, credentialStore: store, now: () => clock,
      saveRegistration: async value => { registration = value; }, verifyId: async (_t, _c, nonce) => ({ sub: 'fixture-subject', nonce }),
      fetchImpl: async (url, options = {}) => {
        const grant = options.body?.get?.('grant_type');
        if (grant) {
          if (grant === 'refresh_token') {
            refreshCount++;
            if (temporaryFailure) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
            if (invalid) return Response.json({ error: 'invalid_grant' }, { status: 400 });
            assert.equal(options.body.get('refresh_token'), 'fixture-refresh');
          }
          return Response.json({ access_token: grant === 'refresh_token' ? 'rotated-access' : 'fixture-access', refresh_token: grant === 'refresh_token' ? 'rotated-refresh' : 'fixture-refresh', token_type: 'Bearer', id_token: 'fixture-id', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' });
        }
        if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'chosen-model', display_name: 'Chosen model', visibility: 'list' }] });
        if (String(url).endsWith('openid-configuration')) return Response.json({ revocation_endpoint: 'https://auth.openai.com/revoke' });
        if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 });
        assert.fail('不应调用推理');
      }
    });
  }
  async function login(s) {
    const auth = new URL(s.beginLogin().url), cb = new URL('http://127.0.0.1:4325/auth/callback');
    cb.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture-code', client_id: 'fixture-client' });
    await s.finishLogin(cb); await s.listModels(); await s.setSelectedModel('chosen-model');
  }
  return { instance, login, store, snapshot: () => saved, advance: () => { clock += 3600001; }, count: () => refreshCount,
    tempFailure: () => { temporaryFailure = true; }, invalid: () => { invalid = true; } };
}
test('登录及所选模型持久化，重建会话后无需OAuth恢复并轮换保存', async () => {
  const f = fixture(), initial = f.instance(); await f.login(initial);
  const restored = f.instance(); assert.equal((await restored.restore()).restored, true);
  assert.equal(restored.status().authenticated, true); assert.equal(restored.status().persistentCredentials, true);
  assert.equal(restored.getSelectedModel(), 'chosen-model');
  f.advance(); await Promise.all([restored.getSession(), restored.getSession()]);
  assert.equal(f.count(), 1); assert.equal(f.snapshot().credentials.refreshToken, 'rotated-refresh');
  await restored.disconnect(); assert.equal(f.snapshot(), null);
  assert.equal((await f.instance().restore()).restored, false);
});
test('断网保留加密恢复记录，明确无效授权才删除', async () => {
  for (const terminal of [false, true]) {
    const f = fixture(); await f.login(f.instance()); const s = f.instance(); await s.restore(); f.advance();
    terminal ? f.invalid() : f.tempFailure(); await assert.rejects(s.getSession());
    assert.equal(f.snapshot() === null, terminal); assert.equal(s.status().authenticated, !terminal);
  }
});
test('恢复凭据不能绑定到另一host/client/subject；状态不包含令牌', async () => {
  const f = fixture(); await f.login(f.instance());
  assert.doesNotMatch(JSON.stringify(f.instance().status()), /fixture-access|fixture-refresh/);
  f.snapshot().hostId = 'different-host';
  const s = f.instance(); assert.equal((await s.restore()).restored, false); assert.equal(s.status().authenticated, false); assert.equal(f.snapshot(), null);
});
test('磁盘写失败不谎报保存成功，清除旧轮换记录并可重试保存当前令牌', async () => {
  const f = fixture(), s = f.instance(); await f.login(s);
  const save = f.store.save; f.store.save = async () => { throw new Error('fixture disk full'); }; f.advance();
  await assert.rejects(s.getSession(), /CREDENTIAL_STORE_WRITE_FAILED/);
  assert.equal(s.status().persistentCredentials, false); assert.equal(f.snapshot(), null);
  f.store.save = save; const recovered = await s.getSession();
  assert.equal(recovered.accessToken, 'rotated-access'); assert.equal(f.snapshot().credentials.refreshToken, 'rotated-refresh');
});
