// 仅在后台加载。closed shadow 不承担授权；每次读取、提交和返回都重新核对绑定。
(() => {
  'use strict';
  const protocol = globalThis.AskmeUiProtocol;
  const failure = code => ({ ok: false, error: code });
  const random = () => {
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  };
  // 逐个核对服务实现；发现课程、切换模型、截图和练习创建都可能写入状态。
  const readOperations = new Set(['ui.bootstrap', 'course.list', 'course.view', 'course.sync.report', 'source.list', 'source.read',
    'chat.list', 'chat.read', 'chat.quiz.read', 'study.units', 'study.plan', 'ai.status']);
  const executionBudget = op => readOperations.has(op) ? 15_000
    : ['course.sync', 'course.files.continue'].includes(op) ? 180_000
      : ['chat.ask', 'page.explain'].includes(op) ? 240_000
        : ['choice.generate', 'chat.quiz.advance'].includes(op) ? 180_000
          : ['practice.start', 'practice.submit', 'choice.check', 'chat.quiz.check'].includes(op) ? 150_000 : 30_000;
  const queueBudgetMs = 240_000;
  function createUiBroker({ extensionId, buildVersion, resolveAccount, services, now = Date.now, randomToken = random, ttlMs = 30 * 60_000 }) {
    if (!protocol || typeof resolveAccount !== 'function' || !services || !/^[a-p]{32}$/u.test(extensionId)) throw new Error('INVALID_BROKER_CONFIGURATION');
    const bindings = new Map(), hosts = new Map(), queues = new Map();
    let generation = 0;
    const key = sender => `${sender.tab.id}:${sender.documentId}`;
    const invalidate = (binding, reason = 'UI_BINDING_EXPIRED') => {
      if (!binding) return;
      binding.abortCode = reason;
      binding.controller.abort(); bindings.delete(binding.bindingId);
      if (hosts.get(binding.hostKey) === binding) hosts.delete(binding.hostKey);
    };
    const prune = () => { for (const binding of bindings.values()) if (binding.expiresAt <= now()) invalidate(binding); };
    const current = binding => bindings.get(binding.bindingId) === binding && hosts.get(binding.hostKey) === binding && binding.expiresAt > now() && !binding.controller.signal.aborted;
    const resolve = async binding => {
      let timer;
      try {
        const result = await Promise.race([
          resolveAccount(Object.freeze({ tabId: binding.tabId, windowId: binding.windowId, documentId: binding.documentId })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('UI_ACCOUNT_TIMEOUT')), 3000); })
        ]);
        return result?.ok === true && protocol.id(result.accountId) && result.contentVersion === buildVersion &&
          Number.isSafeInteger(result.accountEpoch) && result.accountEpoch >= 0 ? { accountId: result.accountId, accountEpoch: result.accountEpoch } : null;
      } finally { clearTimeout(timer); }
    };
    const check = async binding => {
      if (!current(binding)) throw new Error('UI_BINDING_EXPIRED');
      const account = await resolve(binding);
      if (!current(binding)) throw new Error('UI_BINDING_EXPIRED');
      if (!account || account.accountId !== binding.accountId || account.accountEpoch !== binding.accountEpoch) { invalidate(binding, 'UI_ACCOUNT_CHANGED'); throw new Error('UI_ACCOUNT_CHANGED'); }
    };
    async function hello(message, sender) {
      if (!protocol.validSender(sender, extensionId) || !protocol.hello(message, buildVersion)) return failure('INVALID_UI_HELLO');
      prune();
      if (bindings.size >= 32 && !hosts.has(key(sender))) return failure('UI_SESSION_LIMIT');
      // 新宿主立即废弃旧宿主；账号探测迟到也不能让旧 hello 复活。
      const hostKey = key(sender);
      invalidate(hosts.get(hostKey));
      const bindingId = randomToken();
      if (!protocol.token(bindingId) || bindings.has(bindingId)) return failure('UI_BINDING_FAILURE');
      const binding = { bindingId, hostKey, hostInstanceId: message.hostInstanceId, tabId: sender.tab.id, windowId: sender.tab.windowId,
        documentId: sender.documentId, accountId: '', generation: ++generation, expiresAt: now() + ttlMs, controller: new AbortController(), readInFlight: 0, writeInFlight: 0, seen: new Set() };
      hosts.set(hostKey, binding); bindings.set(bindingId, binding);
      try {
        const account = await resolve(binding);
        if (!current(binding)) return failure('UI_BINDING_EXPIRED');
        if (!account) { invalidate(binding); return failure('UI_ACCOUNT_UNAVAILABLE'); }
        Object.assign(binding, account);
        return { ok: true, value: { protocolVersion: 1, bindingId, generation: binding.generation, ...account, expiresAt: binding.expiresAt } };
      } catch { invalidate(binding); return failure('UI_ACCOUNT_UNAVAILABLE'); }
    }
    async function dispatch(message, sender) {
      if (!protocol.validSender(sender, extensionId) || !protocol.request(message)) return failure('INVALID_UI_REQUEST');
      const fail = code => ({ ...failure(code), requestId: message.requestId, generation: message.generation });
      prune();
      const binding = bindings.get(message.bindingId);
      if (!binding || binding.hostKey !== key(sender) || binding.windowId !== sender.tab.windowId || binding.generation !== message.generation || !binding.accountId) return fail('UI_BINDING_MISMATCH');
      if (typeof services[message.op] !== 'function') return fail('UI_OPERATION_UNAVAILABLE');
      if (binding.seen.has(message.requestId)) return fail('UI_REQUEST_REPLAY');
      const readOnly = readOperations.has(message.op), lane = readOnly ? 'readInFlight' : 'writeInFlight';
      // 写任务不能耗尽读取容量；每类仍有限流，避免不断点击堆积无界任务。
      if (binding[lane] >= 4) return fail('UI_BUSY');
      if (binding.seen.size >= 4096) { invalidate(binding); return fail('UI_BINDING_EXPIRED'); }
      binding[lane]++; binding.seen.add(message.requestId);
      // 客户端参数复制后只读；后续异步不得使用可变全局 accountId。
      const args = Object.freeze(structuredClone(message.args));
      const controller = new AbortController();
      let state = 'queued', abortCode = '', deadlineAt = 0, timer, queue, settle;
      const result = new Promise(resolveResult => { settle = resolveResult; });
      const assertOperation = async () => {
        if (state === 'running' && now() >= deadlineAt) cancel('UI_SERVICE_TIMEOUT');
        if (controller.signal.aborted || state === 'settled') throw new Error(abortCode || 'UI_BINDING_EXPIRED');
        await check(binding);
        // 身份探测也是异步边界；超时旧任务不能在探测返回后继续写入。
        if (state === 'running' && now() >= deadlineAt) cancel('UI_SERVICE_TIMEOUT');
        if (controller.signal.aborted || state === 'settled') throw new Error(abortCode || 'UI_BINDING_EXPIRED');
      };
      const context = Object.freeze({ accountId: binding.accountId, tabId: binding.tabId, documentId: binding.documentId,
        windowId: binding.windowId, accountEpoch: binding.accountEpoch, expectedRevision: message.expectedRevision, operationId: message.operationId,
        generation: binding.generation, signal: controller.signal, assertCurrent: assertOperation });
      const run = async () => {
        try {
          await assertOperation();
          const value = await services[message.op](context, args);
          await assertOperation();
          if (!protocol.bounded(value, 65536)) return fail('UI_RESPONSE_TOO_LARGE');
          return { ok: true, requestId: message.requestId, generation: binding.generation, value };
        } catch (error) {
          const safe = ['UI_BINDING_EXPIRED', 'UI_ACCOUNT_CHANGED', 'UI_ACCOUNT_TIMEOUT', 'UI_QUEUE_TIMEOUT', 'UI_COURSE_NOT_FOUND', 'UI_SOURCE_NOT_FOUND', 'UI_SESSION_NOT_FOUND', 'UI_STORAGE_CONFLICT',
            'UI_SOURCE_CHANGED', 'UI_SERVICE_FAILED', 'UI_SERVICE_TIMEOUT', 'UI_SERVICE_RESPONSE_INVALID', 'UI_CALENDAR_UNAVAILABLE', 'UI_COURSE_READ_FAILED',
            'UI_PRACTICE_EXPIRED', 'UI_CAPTURE_INACTIVE', 'UI_CAPTURE_UNAVAILABLE', 'UI_CAPTURE_TOO_LARGE', 'UI_CAPTURE_EXPIRED', 'UI_CAPTURE_RESIZED', 'UI_CAPTURE_INVALID_REGION', 'UI_AUTH_URL_INVALID'];
          const serviceCodes = ['LOGIN_REQUIRED', 'MODEL_SELECTION_REQUIRED', 'PLAN_MODEL_UNAVAILABLE', 'BUSY', 'UNVERIFIED_QUESTIONS', 'CHOICE_TIMEOUT',
            'SESSION_EXPIRED', 'ALREADY_ANSWERED', 'SOURCE_CHANGED', 'REQUEST_CONTEXT_CHANGED', 'INVALID_QUESTIONS',
            'NEGATION_MISMATCH', 'ATOMICITY_FAILED', 'NUMERIC_FACT_UNSUPPORTED', 'IDENTIFIER_UNSUPPORTED', 'DIRECTION_MISMATCH', 'AUDIT_UNAVAILABLE'];
          return fail(serviceCodes.includes(error?.serviceCode) ? error.serviceCode : safe.includes(error?.message) ? error.message : 'UI_OPERATION_FAILED');
        }
      };
      const drain = () => {
        if (!queue || queue.active) return;
        const next = queue.pending.shift();
        if (next) { queue.active = next; next.start(); }
        else if (queues.get(binding.accountId) === queue) queues.delete(binding.accountId);
      };
      const finish = value => {
        if (state === 'settled') return;
        state = 'settled'; clearTimeout(timer);
        binding.controller.signal.removeEventListener('abort', bindingAborted);
        binding[lane]--;
        if (queue) {
          if (queue.active === job) queue.active = null;
          else { const index = queue.pending.indexOf(job); if (index >= 0) queue.pending.splice(index, 1); }
        }
        settle(value);
        drain();
      };
      const cancel = code => {
        if (state === 'settled') return;
        abortCode = code;
        // 先撤销操作权限再放行队列；无法主动取消的服务迟到后仍会被 assertCurrent 拦截。
        controller.abort();
        if (['UI_SERVICE_TIMEOUT', 'UI_QUEUE_TIMEOUT'].includes(code)) console.warn(JSON.stringify({ event: 'askme_ui_operation_cancelled', code }));
        finish(fail(code));
      };
      const bindingAborted = () => cancel(binding.abortCode === 'UI_ACCOUNT_CHANGED' ? 'UI_ACCOUNT_CHANGED' : 'UI_BINDING_EXPIRED');
      const job = { start() {
        if (state === 'settled') return;
        state = 'running'; clearTimeout(timer);
        deadlineAt = now() + executionBudget(message.op);
        timer = setTimeout(() => cancel('UI_SERVICE_TIMEOUT'), executionBudget(message.op));
        // 无论上游是否支持 AbortSignal，用户请求和队列都在操作预算内结束。
        void run().then(finish, () => finish(fail('UI_OPERATION_FAILED')));
      } };
      binding.controller.signal.addEventListener('abort', bindingAborted, { once: true });
      if (binding.controller.signal.aborted) { cancel('UI_BINDING_EXPIRED'); return result; }
      if (readOnly) job.start();
      else {
        // 显式队列可移除已取消的等待项，不能让取消的 tail 越过尚在执行的写任务。
        queue = queues.get(binding.accountId);
        if (!queue) { queue = { active: null, pending: [] }; queues.set(binding.accountId, queue); }
        queue.pending.push(job);
        timer = setTimeout(() => cancel('UI_QUEUE_TIMEOUT'), queueBudgetMs);
        drain();
      }
      return result;
    }
    return Object.freeze({ hello, dispatch,
      dispose(message, sender) {
        if (!protocol.validSender(sender, extensionId) || !protocol.exact(message, ['bindingId', 'generation']) || !protocol.token(message.bindingId)) return failure('INVALID_UI_DISPOSE');
        const binding = bindings.get(message.bindingId);
        if (!binding || binding.hostKey !== key(sender) || binding.windowId !== sender.tab.windowId || binding.generation !== message.generation) return failure('UI_BINDING_MISMATCH');
        invalidate(binding); return { ok: true };
      },
      revokeTab(tabId) { for (const binding of bindings.values()) if (binding.tabId === tabId) invalidate(binding); },
      shutdown() { for (const binding of bindings.values()) invalidate(binding); }
    });
  }
  globalThis.AskmeUiBroker = Object.freeze({ createUiBroker });
})();
