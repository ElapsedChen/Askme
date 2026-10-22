import { RESOURCE, readCompletion } from './protocol.mjs';

// 适配正式服务已有的 Responses 调用，保留其检索、逐字证据检查和语义复核流程。
// 会话令牌由服务端注入；本模块不读浏览器或 Codex 凭据，也不负责持久化。
export function createPlanFetch({ getSession, model, fetchImpl = fetch }) {
  if (typeof getSession !== 'function' || typeof model !== 'string' || !model) throw new Error('PLAN_CONFIGURATION_INVALID');
  return async (url, options = {}) => {
    const target = new URL(String(url));
    if (['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port === '11434') throw new Error('LOCAL_MODEL_DISABLED');
    if (target.origin === 'https://api.openai.com' && String(url) !== `${RESOURCE}/responses`) throw new Error('PLAN_ROUTE_UNSUPPORTED');
    if (String(url) !== `${RESOURCE}/responses`) return fetchImpl(url, options);
    const session = await getSession();
    if (!session || typeof session.accessToken !== 'string' || !session.accessToken || !session.scopes?.includes('chatgpt.tokens.use.direct')) throw new Error('PLAN_AUTHORIZATION_REQUIRED');
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() + 30000) throw new Error('PLAN_SESSION_EXPIRED');
    if (!session.models?.includes(model)) throw new Error('PLAN_MODEL_UNAVAILABLE');
    if (options.method !== 'POST') throw new Error('PLAN_METHOD_INVALID');
    const original = JSON.parse(options.body);
    // 正式 Askme 的三个生成/复核分支使用此字段集合；新增功能必须显式适配。
    const accepted = new Set(['model', 'store', 'stream', 'max_output_tokens', 'instructions', 'input']);
    if (Object.keys(original).some(key => !accepted.has(key))) throw new Error('PLAN_REQUEST_UNSUPPORTED');
    const input = typeof original.input === 'string' ? [{ role: 'user', content: original.input }] : original.input;
    if (!Array.isArray(input) || !input.length || input.some(item => item?.role === 'system')) throw new Error('PLAN_INPUT_INVALID');
    const response = await fetchImpl(`${RESOURCE}/responses`, {
      ...options,
      headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, store: false, stream: true, input,
        ...(original.instructions ? { instructions: original.instructions } : {}) })
    });
    if (!response.ok) return response;
    const text = await readCompletion(response.body);
    // 只有完整流才转换为正式服务可读取的 JSON；之后仍须通过原有证据校验。
    return Response.json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
  };
}
