import { createRemoteJWKSet, jwtVerify } from 'jose';
import { authorization, callback, RESOURCE, same } from './protocol.mjs';

const ISSUER = 'https://auth.openai.com';
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const terminalRefresh = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });

async function verifyIdentity(token, clientId, nonce, subject) {
  const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: clientId,
    requiredClaims: ['sub', 'exp', 'iat', ...(nonce ? ['nonce'] : [])] });
  if ((nonce && !same(payload.nonce, nonce)) || (subject && payload.sub !== subject)) throw failure('IDENTITY_INVALID');
  return payload;
}

// 单账号、单进程会话。凭据只能交给注入的受保护存储，不返回浏览器。
// verifyId 仅用于注入测试；正式代码必须使用默认的签名校验。
export function createPlanSession({ hostId, redirectUri, registration, saveRegistration = async () => {},
  credentialStore, fetchImpl = fetch, now = Date.now, verifyId = verifyIdentity } = {}) {
  const redirect = new URL(redirectUri);
  if (!hostId || redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.pathname !== '/auth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) throw failure('PLAN_CONFIGURATION_INVALID');
  let pending, credentials, catalog = [], refreshing, exchanging = false, signingOut = false;
  let epoch = 0, retryAt = 0, lastError = null, selectedModel = null, persistenceDirty = false;
  const controllers = new Set();
  function clear() { credentials = undefined; catalog = []; retryAt = 0; selectedModel = null; persistenceDirty = false; }
  async function persist() {
    if (!credentialStore) return;
    try {
      await credentialStore.save({ version: 1, hostId, clientId: registration.clientId, subject: registration.subject, credentials, catalog, selectedModel });
      persistenceDirty = false;
    } catch {
      persistenceDirty = true; lastError = 'CREDENTIAL_STORE_WRITE_FAILED';
      // 轮换后的旧凭据不可留作下次恢复；当前新令牌保留在内存，可重试写入。
      await credentialStore.clear().catch(() => {});
      throw failure('CREDENTIAL_STORE_WRITE_FAILED', 503);
    }
  }
  async function clearSaved() { if (credentialStore) await credentialStore.clear(); }
  async function tokenRequest(body) {
    let r;
    try { r = await fetchImpl(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20000), redirect: 'error' }); }
    catch { throw failure('TOKEN_NETWORK_ERROR', 503); }
    let data;
    try { data = await r.json(); } catch { throw failure(r.ok ? 'TOKEN_RESPONSE_INVALID' : `TOKEN_HTTP_${r.status}`, r.ok ? 502 : r.status); }
    if (!r.ok) {
      const rawCode = typeof data.error === 'string' ? data.error : data.error?.code;
      const code = terminalRefresh.has(rawCode) || ['invalid_client', 'slow_down', 'temporarily_unavailable', 'refresh_token_too_early'].includes(rawCode) ? rawCode : `TOKEN_HTTP_${r.status}`;
      const error = failure(code, r.status);
      const retry = Number(r.headers.get('retry-after'));
      error.retryMs = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 300000) : 30000;
      throw error;
    }
    return data;
  }
  function parseTokens(token, previous) {
    const scopes = token.scope === undefined && previous ? previous.scopes : String(token.scope || '').split(' ');
    if (!scopes.includes('chatgpt.tokens.use.direct')) throw failure('PLAN_SCOPE_MISSING');
    if (!token.access_token || typeof token.access_token !== 'string' || !token.refresh_token || typeof token.refresh_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(token.expires_in) || token.expires_in <= 30) throw failure('TOKEN_RESPONSE_INVALID', 502);
    return { accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: now() + token.expires_in * 1000, scopes: [...scopes] };
  }
  async function refresh() {
    if (refreshing) return refreshing;
    if (lastError === 'invalid_client') throw failure('invalid_client', 400);
    if (retryAt > now()) throw failure('PLAN_REFRESH_BACKOFF', 503);
    const current = credentials;
    if (!current) throw failure('LOGIN_REQUIRED', 401);
    const generation = epoch;
    const run = (async () => {
      try {
        const token = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.clientId,
          refresh_token: current.refreshToken, resource: RESOURCE }));
        const next = parseTokens(token, current);
        if (token.id_token) await verifyId(token.id_token, registration.clientId, undefined, registration.subject);
        if (generation !== epoch) throw failure('SESSION_CHANGED', 409);
        // 最新 access / refresh / scope / expiry 一次替换，永不复用已轮换的旧刷新令牌。
        credentials = next; retryAt = 0; lastError = null;
        await persist();
      } catch (error) {
        if (generation === epoch) {
          lastError = error.code || 'IDENTITY_INVALID';
          if (terminalRefresh.has(error.code) || ['PLAN_SCOPE_MISSING', 'TOKEN_RESPONSE_INVALID', 'IDENTITY_INVALID'].includes(error.code) || !error.code) { clear(); await clearSaved(); }
          else retryAt = now() + (error.retryMs || 30000);
        }
        throw error.code ? error : failure('IDENTITY_INVALID');
      }
    })();
    refreshing = run;
    try { await run; } finally { if (refreshing === run) refreshing = undefined; }
  }
  async function getSession() {
    if (signingOut || !credentials) throw failure('LOGIN_REQUIRED', 401);
    if (persistenceDirty) await persist();
    if (credentials.expiresAt <= now() + 60000) await refresh();
    if (signingOut || !credentials) throw failure('LOGIN_REQUIRED', 401);
    return { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt,
      scopes: [...credentials.scopes], models: catalog.map(m => m.slug) };
  }
  // 推理和模型请求从这里发送，退出时取消在途调用，并拒绝晚到结果。
  async function authorizedFetch(url, options = {}) {
    if (![`${RESOURCE}/models`, `${RESOURCE}/responses`].includes(String(url))) throw failure('PLAN_ROUTE_UNSUPPORTED');
    const session = await getSession(), generation = epoch, controller = new AbortController();
    if (signingOut || !credentials || credentials.accessToken !== session.accessToken) throw failure('SESSION_CHANGED', 409);
    controllers.add(controller);
    try {
      const headers = new Headers(options.headers); headers.set('Authorization', `Bearer ${session.accessToken}`);
      const signal = AbortSignal.any([controller.signal, options.signal || AbortSignal.timeout(180000)]);
      const result = await fetchImpl(url, { ...options, headers, signal, redirect: 'error' });
      if (generation !== epoch) throw failure('SESSION_CHANGED', 409);
      // 控制器保持到流读完或断开；返回包装流保证断开也能取消正文消费。
      if (!result.body) { controllers.delete(controller); return result; }
      const reader = result.body.getReader();
      const body = new ReadableStream({
        async pull(target) {
          try {
            if (signingOut || generation !== epoch) throw failure('SESSION_CHANGED', 409);
            const { done, value } = await reader.read();
            if (signingOut || generation !== epoch) throw failure('SESSION_CHANGED', 409);
            if (done) { controllers.delete(controller); target.close(); } else target.enqueue(value);
          } catch (e) { controllers.delete(controller); target.error(e); await reader.cancel().catch(() => {}); }
        },
        async cancel() { controllers.delete(controller); controller.abort(); await reader.cancel().catch(() => {}); }
      });
      return new Response(body, { status: result.status, headers: result.headers });
    } catch (e) { controllers.delete(controller); throw e; }
  }
  return {
    async restore() {
      if (!credentialStore || credentials || exchanging || signingOut) return { restored: false };
      let record;
      try { record = await credentialStore.load(); }
      catch { lastError = 'CREDENTIAL_STORE_UNREADABLE'; return { restored: false }; }
      if (!record) return { restored: false };
      const saved = record.credentials;
      if (record.version !== 1 || record.hostId !== hostId || record.clientId !== registration?.clientId || record.subject !== registration?.subject ||
          !saved || typeof saved.accessToken !== 'string' || !saved.accessToken || typeof saved.refreshToken !== 'string' || !saved.refreshToken || !Number.isFinite(saved.expiresAt) ||
          !Array.isArray(saved.scopes) || !saved.scopes.includes('chatgpt.tokens.use.direct')) {
        lastError = 'CREDENTIAL_IDENTITY_MISMATCH'; await clearSaved(); return { restored: false };
      }
      credentials = saved;
      catalog = Array.isArray(record.catalog) ? record.catalog.filter(m => typeof m?.slug === 'string' && typeof m.name === 'string').map(({ slug, name }) => ({ slug, name })) : [];
      selectedModel = typeof record.selectedModel === 'string' && catalog.some(m => m.slug === record.selectedModel) ? record.selectedModel : null;
      return { restored: true };
    },
    getSelectedModel() { return selectedModel; },
    async setSelectedModel(model) {
      if (model !== null && !catalog.some(m => m.slug === model)) throw failure('PLAN_MODEL_UNAVAILABLE');
      if (!credentials || signingOut) throw failure('LOGIN_REQUIRED', 401);
      selectedModel = model; await persist();
    },
    beginLogin() {
      if (credentials || exchanging || signingOut) throw failure('BUSY', 409);
      const auth = authorization(hostId, redirectUri, registration);
      pending = auth.attempt;
      return { url: auth.url };
    },
    async finishLogin(url) {
      if (exchanging || signingOut) throw failure('BUSY', 409);
      if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) throw failure('OAUTH_CALLBACK_INVALID');
      const attempt = pending, exchange = callback(url, attempt), generation = epoch;
      pending = undefined; exchanging = true;
      try {
        const token = await tokenRequest(exchange.body);
        const id = await verifyId(token.id_token, exchange.clientId, attempt.nonce, attempt.subject);
        // 测试注入也必须满足同一身份约束。
        if (!id.sub || !same(id.nonce, attempt.nonce) || (attempt.subject && id.sub !== attempt.subject)) throw failure('IDENTITY_INVALID');
        const next = parseTokens(token);
        const selected = { clientId: exchange.clientId, subject: id.sub };
        if (generation !== epoch) throw failure('SESSION_CHANGED', 409);
        await saveRegistration(selected);
        if (generation !== epoch) throw failure('SESSION_CHANGED', 409);
        registration = selected; credentials = next; catalog = []; selectedModel = null; lastError = null; retryAt = 0;
        await persist();
        return { authenticated: true };
      } finally { exchanging = false; }
    },
    status() { return { authenticated: !!credentials && !signingOut, expiresAt: credentials?.expiresAt,
      state: signingOut ? 'disconnecting' : !credentials ? 'login-required' : credentials.expiresAt <= now() + 60000 ? 'renewal-required' : 'connected',
      models: catalog.map(m => ({ ...m })), lastError, persistentCredentials: !!credentialStore?.persistent && !persistenceDirty }; },
    getSession, authorizedFetch,
    async listModels() {
      const generation = epoch;
      const r = await authorizedFetch(`${RESOURCE}/models`);
      if (!r.ok) { await r.body?.cancel(); throw failure(`MODELS_HTTP_${r.status}`, r.status); }
      const data = await r.json();
      if (!Array.isArray(data.models)) throw failure('MODELS_RESPONSE_INVALID', 502);
      if (generation !== epoch) throw failure('SESSION_CHANGED', 409);
      catalog = data.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string').map(m => ({ slug: m.slug, name: m.display_name || m.slug }));
      if (!catalog.some(m => m.slug === selectedModel)) selectedModel = null;
      await persist();
      return catalog.map(m => ({ ...m }));
    },
    async disconnect() {
      if (signingOut || exchanging) throw failure('BUSY', 409);
      signingOut = true; pending = undefined;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      // 等待正在轮换的令牌，再撤销最新会话，避免退出与刷新互相覆盖。
      if (refreshing) await refreshing.catch(() => {});
      const current = credentials; epoch++; clear();
      let revoked = !current, localClearFailed = false;
      // 先擦除本机恢复记录，再尝试远程撤销；断网也不能让重启恢复已退出的会话。
      try { await clearSaved(); } catch { localClearFailed = true; }
      try {
        if (current) {
          const d = await fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (!d.ok) throw failure('DISCOVERY_FAILED');
          const endpoint = new URL((await d.json()).revocation_endpoint);
          if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password) throw failure('ENDPOINT_INVALID');
          for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
            try {
              const r = await fetchImpl(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: current.refreshToken, token_type_hint: 'refresh_token', client_id: registration.clientId }), signal: AbortSignal.timeout(10000), redirect: 'error' });
              revoked = r.status === 200;
              await r.body?.cancel();
              if (!revoked && r.status < 500) break;
            } catch {}
            if (!revoked && attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      } catch {} finally { signingOut = false; }
      if (localClearFailed) { lastError = 'CREDENTIAL_STORE_CLEAR_FAILED'; throw failure(lastError, 503); }
      lastError = revoked ? null : 'REMOTE_REVOCATION_UNCONFIRMED';
      return { revoked, authenticated: false, action: revoked ? null : '在 ChatGPT 设置中断开 Askme' };
    }
  };
}
