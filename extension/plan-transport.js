// 只在后台运行：固定本机路由，账号头由已验证上下文生成。
(() => {
  'use strict';
  const routes = Object.freeze({
    '/chatgpt/status': [ 'GET', 6000, 0 ], '/chatgpt/connect': ['POST', 15000, 100],
    '/chatgpt/models': ['POST', 15000, 100], '/chatgpt/select': ['POST', 15000, 300],
    '/chatgpt/disconnect': ['POST', 15000, 100], '/answer': ['POST', 155000, 32000],
    '/translate': ['POST', 70000, 32000], '/vision/answer': ['POST', 115000, 12000000],
    '/choice/generate': ['POST', 155000, 28000], '/choice/check': ['POST', 10000, 32000],
    '/practice/generate': ['POST', 110000, 32000], '/practice/check': ['POST', 105000, 32000],
    '/extract': ['POST', 45000, 28000000], '/extract/upload': ['POST', 45000, 2800000]
  });
  function createPlanTransport({ extensionId, fetchImpl = fetch }) {
    return async function request(context, endpoint, data, courseId) {
      const route = routes[endpoint];
      if (!route || !globalThis.AskmeUiProtocol.id(context.accountId)) throw new Error('UI_INVALID_SERVICE_REQUEST');
      if (courseId !== undefined && !globalThis.AskmeUiProtocol.id(courseId)) throw new Error('UI_COURSE_NOT_FOUND');
      const [method, timeout, max] = route;
      const body = method === 'POST' ? JSON.stringify(data || {}) : undefined;
      if (body && new TextEncoder().encode(body).byteLength > max) throw new Error('UI_REQUEST_TOO_LARGE');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`askme:${extensionId}:${context.accountId}`));
      const accountKey = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
      await context.assertCurrent();
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeout);
      let reader;
      try {
        if (context.signal?.aborted) abort();
        const response = await fetchImpl(`http://127.0.0.1:4317${endpoint}`, {
          method, body, headers: { 'x-askme-extension-id': extensionId, 'x-askme-account': accountKey,
            ...(courseId ? { 'x-askme-course': courseId } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
          credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal
        });
        // 抽取页在后台保存；其余结果不得超过控制通道上限。
        const maxBytes = ['/extract', '/extract/upload'].includes(endpoint) ? 4000000 : 65536;
        reader = response.body?.getReader();
        if (!reader) throw new Error('UI_SERVICE_RESPONSE_INVALID');
        const chunks = []; let bytes = 0;
        while (true) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > maxBytes) { abort(); throw new Error('UI_RESPONSE_TOO_LARGE'); }
          chunks.push(next.value);
        }
        const buffer = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
        let value;
        try { value = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw new Error('UI_SERVICE_RESPONSE_INVALID'); }
        await context.assertCurrent();
        if (!response.ok) {
          const code = typeof value?.reasonCode === 'string' && /^[A-Z_]{1,60}$/u.test(value.reasonCode) ? value.reasonCode : `HTTP_${response.status}`;
          throw Object.assign(new Error('UI_SERVICE_FAILED'), { serviceCode: code });
        }
        return value;
      } catch (error) {
        if (error?.message === 'UI_RESPONSE_TOO_LARGE') throw error;
        if (controller.signal.aborted) throw new Error(context.signal?.aborted ? 'UI_BINDING_EXPIRED' : 'UI_SERVICE_TIMEOUT');
        throw error;
      } finally { clearTimeout(timer); context.signal?.removeEventListener('abort', abort); try { reader?.releaseLock(); } catch {} }
    };
  }
  globalThis.AskmePlanTransport = Object.freeze({ createPlanTransport });
})();
