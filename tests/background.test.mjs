import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

function todaySydney() {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const field = type => parts.find(part => part.type === type)?.value || '';
  return `${field('year')}-${field('month')}-${field('day')}`;
}

test('截图具有持久 captureVisibleTab 权限，同时业务读取仍限制在 Moodle', () => {
  assert.equal(manifest.host_permissions.includes('https://moodle.telt.unsw.edu.au/*'), true);
  assert.equal(manifest.host_permissions.includes('<all_urls>'), true);
  assert.equal(manifest.permissions.includes('activeTab'), true);
  for (const permission of ['tabs', 'downloads']) assert.equal(manifest.permissions.includes(permission), false);
});

test('内嵌面板全部运行资源只向 UNSW Moodle 暴露', () => {
  assert.equal(manifest.web_accessible_resources.length, 1);
  const exposed = manifest.web_accessible_resources[0];
  assert.deepEqual(exposed.matches, ['https://moodle.telt.unsw.edu.au/*']);
  assert.deepEqual(new Set(exposed.resources), new Set([
    'panel.html', 'panel.css', 'panel.js', 'panel-bootstrap.js', 'learning-core.js', 'knowledge-units.js', 'assessment-kernel.js', 'unit-progress.js',
    'assets/askme-16.png', 'assets/askme-32.png', 'assets/askme-48.png', 'assets/askme-128.png',
    'assets/askme-open-panel-48.png', 'assets/askme-open-panel-128.png'
  ]));
});

function setup(initial = {}, options = {}) {
  const saved = structuredClone(initial);
  const sessionSaved = structuredClone(options.session || {});
  const writes = [];
  const tabMessages = [];
  const captures = [];
  let listener;
  const chrome = {
    sidePanel: { setPanelBehavior() {} },
    storage: { local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.map(key => [key, structuredClone(saved[key])]));
      },
      async set(patch) { if (options.failSet) throw new Error('disk full'); writes.push(structuredClone(patch)); Object.assign(saved, structuredClone(patch)); },
      setAccessLevel() {}
    }, session: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.map(key => [key, structuredClone(sessionSaved[key])]));
      },
      async set(patch) { Object.assign(sessionSaved, structuredClone(patch)); },
      setAccessLevel() {}
    } },
    tabs: {
      async query(query) { return [{ id: options.activeTabId ?? 7, windowId: query.windowId }]; },
      async captureVisibleTab(windowId, details) {
        captures.push({ windowId, details });
        if (options.captureFailure) throw new Error(options.captureFailure);
        return options.captureData || 'data:image/png;base64,ZmFrZQ==';
      },
      async sendMessage(tabId, message, target) {
        tabMessages.push({ tabId, message: structuredClone(message), target: structuredClone(target) });
        if (options.tabMessageResult) return structuredClone(options.tabMessageResult);
        return { ok: true, contentVersion: '2026.09.24.11', accountId: message.expectedUserId, source: {
          title: 'Week 3', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7', excerpt: 'Course concept '.repeat(10), pageKind: 'Page', truncated: false
        } };
      }
    },
    runtime: {
      id: 'askme-id',
      getURL: path => `chrome-extension://askme-id/${path}`,
      onInstalled: { addListener() {} },
      onMessage: { addListener(callback) { listener = callback; } }
    }
  };
  vm.runInContext(script, vm.createContext({
    chrome, crypto, Date, Intl, Promise, Set, URL, ArrayBuffer, Uint8Array, AbortController, TextDecoder,
    setTimeout: options.setTimeoutImpl || setTimeout, clearTimeout: options.clearTimeoutImpl || clearTimeout,
    fetch: options.fetchImpl || (async () => { throw new TypeError('offline'); })
  }));
  const send = (message, sender = {}) => new Promise(resolve => {
    const async = listener(message, sender, resolve);
    if (!async) resolve(undefined);
  });
  return { saved, sessionSaved, send, writes, tabMessages, captures };
}

test('本机 AI 后台代理只接受 Askme 面板的固定端点和方法', async () => {
  const requests = [];
  const fixture = setup({}, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ answer: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const panelSender = { url: 'chrome-extension://askme-id/panel.html', frameId: 0, documentId: 'panel-document' };
  const accepted = await fixture.send({ type: 'AI_PROXY', endpoint: '/answer', method: 'POST', body: {
    question: 'What is CAD?', sources: [{ title: 'Lecture', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=1', excerpt: 'CAD is computer aided design.' }]
  } }, panelSender);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.answer, 'ok');
  assert.equal(requests[0].url, 'http://127.0.0.1:4317/answer');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].options.headers)), {
    'x-askme-extension-id': 'askme-id',
    'content-type': 'application/json'
  });
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'error');

  const contentSender = { url: 'https://moodle.telt.unsw.edu.au/my/', frameId: 0, tab: { id: 7 }, documentId: 'host' };
  assert.equal((await fixture.send({ type: 'AI_PROXY', endpoint: '/health?deep=1', method: 'GET', body: null }, contentSender)).error, 'INVALID_AI_PROXY_SENDER');
  assert.equal((await fixture.send({ type: 'AI_PROXY', endpoint: 'http://evil.example/', method: 'GET', body: null }, panelSender)).error, 'INVALID_AI_PROXY_ROUTE');
  assert.equal((await fixture.send({ type: 'AI_PROXY', endpoint: '/answer', method: 'GET', body: null }, panelSender)).error, 'INVALID_AI_PROXY_ROUTE');
  assert.equal(requests.length, 1);
});

test('本机 AI 后台 GET/POST 固定携带运行时身份且调用方不能覆盖请求头', async () => {
  const requests = [];
  const fixture = setup({}, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response('{}', { status: 200 });
  } });
  await fixture.send({
    type: 'AI_PROXY', endpoint: '/health?deep=1', method: 'GET', body: null,
    headers: { 'x-askme-extension-id': 'attacker', authorization: 'secret' }
  }, panelSender);
  await fixture.send({
    type: 'AI_PROXY', endpoint: '/answer', method: 'POST', body: { question: 'q' },
    headers: { 'x-askme-extension-id': 'attacker', origin: 'https://evil.example' }
  }, panelSender);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].options.headers)), { 'x-askme-extension-id': 'askme-id' });
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1].options.headers)), {
    'x-askme-extension-id': 'askme-id',
    'content-type': 'application/json'
  });
});

test('本机 AI 后台代理接受 capability 已绑定形态的内嵌面板并保留服务 HTTP 状态', async () => {
  const fixture = setup({}, { fetchImpl: async () => new Response(null, { status: 403 }) });
  const embeddedSender = {
    url: 'chrome-extension://askme-id/panel.html?embedded=1&v=2026.10.02.1&g=1',
    frameId: 2, tab: { id: 7 }, documentId: 'panel-document'
  };
  const result = await fixture.send({ type: 'AI_PROXY', endpoint: '/health?deep=1', method: 'GET', body: null, timeoutMs: 4_500 }, embeddedSender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, status: 403, responseOk: false, data: null });
});

const panelSender = { url: 'chrome-extension://askme-id/panel.html', frameId: 0, documentId: 'panel-document' };
const healthProxyRequest = { type: 'AI_PROXY', endpoint: '/health?deep=1', method: 'GET', body: null, timeoutMs: 1_000 };
const RESPONSE_LIMIT = 4_000_000;
const encoder = new TextEncoder();

function streamResponse(chunks, { status = 200, headers = {} } = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[index++]);
    }
  }), { status, headers });
}

async function sendProxyResponse(response, options = {}) {
  const fixture = setup({}, { ...options, fetchImpl: options.fetchImpl || (async () => response) });
  return fixture.send(options.message || healthProxyRequest, options.sender || panelSender);
}

test('AI 代理以字节流读取跨块中文和 emoji，且不调用 Response 便捷正文方法', async () => {
  const source = JSON.stringify({ text: '制造 😀 课程内容' });
  const bytes = encoder.encode(source);
  const split = source.indexOf('😀');
  const prefixBytes = encoder.encode(source.slice(0, split)).length;
  const response = streamResponse([
    bytes.subarray(0, prefixBytes + 1),
    bytes.subarray(prefixBytes + 1, prefixBytes + 3),
    bytes.subarray(prefixBytes + 3)
  ]);
  for (const method of ['text', 'json', 'arrayBuffer', 'blob']) Object.defineProperty(response, method, { value() { throw new Error(`${method} forbidden`); } });
  const result = await sendProxyResponse(response);
  assert.equal(result.ok, true);
  assert.equal(result.data.text, '制造 😀 课程内容');
});

test('AI 代理接受恰好四百万字节并在四百万零一字节处拒绝', async () => {
  const exact = JSON.stringify({ x: 'a'.repeat(RESPONSE_LIMIT - 8) });
  assert.equal(encoder.encode(exact).byteLength, RESPONSE_LIMIT);
  const accepted = await sendProxyResponse(streamResponse([encoder.encode(exact)]));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.x.length, RESPONSE_LIMIT - 8);

  const oversized = JSON.stringify({ x: 'a'.repeat(RESPONSE_LIMIT - 7) });
  assert.equal(encoder.encode(oversized).byteLength, RESPONSE_LIMIT + 1);
  const rejected = await sendProxyResponse(streamResponse([encoder.encode(oversized)]));
  assert.equal(rejected.error, 'AI_PROXY_RESPONSE_TOO_LARGE');
});

test('AI 代理按 UTF-8 字节限制响应，中文字符数较少也不能绕过上限', async () => {
  const chinese = JSON.stringify({ x: '界'.repeat(Math.floor(RESPONSE_LIMIT / 3) + 1) });
  assert.ok(chinese.length < RESPONSE_LIMIT);
  assert.ok(encoder.encode(chinese).byteLength > RESPONSE_LIMIT);
  const result = await sendProxyResponse(streamResponse([encoder.encode(chinese)]));
  assert.equal(result.error, 'AI_PROXY_RESPONSE_TOO_LARGE');
});

test('超大 Content-Length 在锁定和首次 read 前拒绝并支持空白与超大十进制值', async () => {
  let getReaders = 0, cancelled = 0, signal;
  const body = {
    locked: false,
    getReader() { getReaders++; throw new Error('must not lock'); },
    cancel() { cancelled++; return Promise.resolve(); }
  };
  const response = { status: 200, ok: true, headers: { get: () => '  999999999999999999999999999999999999  ' }, body };
  const result = await sendProxyResponse(response, { fetchImpl: async (_url, options) => { signal = options.signal; return response; } });
  assert.equal(result.error, 'AI_PROXY_RESPONSE_TOO_LARGE');
  assert.equal(getReaders, 0);
  assert.equal(cancelled, 1);
  assert.equal(signal.aborted, true);
});

test('Content-Length 缺失、非法、零、精确上限或偏小均继续按实际流字节读取', async () => {
  for (const declared of [null, '', 'invalid', '-1', '1e7', '4,000,001', '0', '1', String(RESPONSE_LIMIT)]) {
    const headers = declared == null ? {} : { 'content-length': declared };
    const result = await sendProxyResponse(streamResponse([encoder.encode('{"answer":"完整"}')], { headers }));
    assert.equal(result.ok, true, `content-length=${declared}`);
    assert.equal(result.data.answer, '完整');
  }
});

test('跨上限后不读取哨兵块，并取消、终止和释放 reader', async () => {
  let reads = 0, cancelled = 0, released = 0, signal;
  const values = [new Uint8Array(RESPONSE_LIMIT), new Uint8Array(1), encoder.encode('{"sentinel":true}')];
  const reader = {
    async read() { const value = values[reads++]; return value ? { done: false, value } : { done: true }; },
    cancel() { cancelled++; return Promise.resolve(); },
    releaseLock() { released++; }
  };
  const response = { status: 200, ok: true, headers: new Headers(), body: { getReader: () => reader } };
  const result = await sendProxyResponse(response, { fetchImpl: async (_url, options) => { signal = options.signal; return response; } });
  assert.equal(result.error, 'AI_PROXY_RESPONSE_TOO_LARGE');
  assert.equal(reads, 2);
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  assert.equal(signal.aborted, true);
});

test('单个大块、很多小块和零长度块都按同一字节计数路径处理', async () => {
  const largeValue = 'a'.repeat(200_000);
  const single = await sendProxyResponse(streamResponse([encoder.encode(JSON.stringify({ value: largeValue }))]));
  assert.equal(single.data.value.length, 200_000);

  const manyBytes = encoder.encode(JSON.stringify({ answer: 'm'.repeat(10_000) }));
  let manyIndex = 0;
  const manyResponse = { status: 200, ok: true, headers: new Headers(), body: { getReader: () => ({
    async read() { return manyIndex < manyBytes.length ? { done: false, value: Uint8Array.of(manyBytes[manyIndex++]) } : { done: true }; },
    releaseLock() {}
  }) } };
  const many = await sendProxyResponse(manyResponse);
  assert.equal(many.data.answer.length, 10_000);

  let index = 0;
  const sequence = [new Uint8Array(0), new Uint8Array(0), encoder.encode('{"answer":"zero"}'), new Uint8Array(0)];
  const zeroResponse = { status: 200, ok: true, headers: new Headers(), body: { getReader: () => ({
    async read() { return index < sequence.length ? { done: false, value: sequence[index++] } : { done: true }; },
    releaseLock() {}
  }) } };
  const zeros = await sendProxyResponse(zeroResponse);
  assert.equal(zeros.data.answer, 'zero');
});

test('空 body、空流、204、空 403 和合法 JSON 500 保留传输与 HTTP 状态', async () => {
  const cases = [
    [new Response(null, { status: 200 }), { ok: true, status: 200, responseOk: true, data: null }],
    [new Response(null, { status: 200, headers: { 'content-length': String(RESPONSE_LIMIT + 1) } }), { ok: true, status: 200, responseOk: true, data: null }],
    [streamResponse([]), { ok: true, status: 200, responseOk: true, data: null }],
    [new Response(null, { status: 204 }), { ok: true, status: 204, responseOk: true, data: null }],
    [new Response(null, { status: 205 }), { ok: true, status: 205, responseOk: true, data: null }],
    [new Response(null, { status: 403 }), { ok: true, status: 403, responseOk: false, data: null }],
    [new Response('{"error":"server"}', { status: 500 }), { ok: true, status: 500, responseOk: false, data: { error: 'server' } }],
    [new Response('{"answer":"mime-free"}', { status: 200, headers: { 'content-type': 'text/plain' } }), { ok: true, status: 200, responseOk: true, data: { answer: 'mime-free' } }]
  ];
  for (const [response, expected] of cases) {
    const result = await sendProxyResponse(response);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
  }
});

test('HTML、空白、非法 JSON、非法 UTF-8 和截断 UTF-8 获得固定解析错误', async () => {
  for (const value of ['<html>error</html>', '   \r\n', '{"broken":']) {
    const result = await sendProxyResponse(streamResponse([encoder.encode(value)]));
    assert.equal(result.error, 'AI_PROXY_INVALID_JSON');
    assert.equal(result.status, 200);
  }
  for (const value of [Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xf0, 0x9f, 0x98)]) {
    const result = await sendProxyResponse(streamResponse([value]));
    assert.equal(result.error, 'AI_PROXY_INVALID_UTF8');
    assert.equal(result.status, 200);
  }
});

test('getReader 和 read 异常区分为响应读取失败，fetch 异常区分为不可达', async () => {
  let getReaderAborted = false;
  const getReaderFailure = { status: 502, ok: false, headers: new Headers(), body: { locked: false, getReader() { throw new Error('reader failed'); }, cancel() { getReaderAborted = true; } } };
  assert.deepEqual(JSON.parse(JSON.stringify(await sendProxyResponse(getReaderFailure))), { ok: false, error: 'AI_PROXY_RESPONSE_READ_FAILED', status: 502 });
  assert.equal(getReaderAborted, true);

  let readCancelled = false, readReleased = false;
  const readFailure = { status: 503, ok: false, headers: new Headers(), body: { getReader: () => ({
    read() { throw new Error('read failed'); }, cancel() { readCancelled = true; }, releaseLock() { readReleased = true; }
  }) } };
  assert.deepEqual(JSON.parse(JSON.stringify(await sendProxyResponse(readFailure))), { ok: false, error: 'AI_PROXY_RESPONSE_READ_FAILED', status: 503 });
  assert.equal(readCancelled, true);
  assert.equal(readReleased, true);

  const unreachable = await sendProxyResponse(null, { fetchImpl: async () => { throw new TypeError('connection refused'); } });
  assert.equal(unreachable.error, 'AI_PROXY_UNREACHABLE');
  const unrelatedAbort = await sendProxyResponse(null, { fetchImpl: async () => { throw new DOMException('external abort', 'AbortError'); } });
  assert.equal(unrelatedAbort.error, 'AI_PROXY_UNREACHABLE');
});

test('非法流块立即终止并报告读取失败', async () => {
  let cancelled = 0, released = 0, signal;
  const response = { status: 502, ok: false, headers: new Headers(), body: { getReader: () => ({
    async read() { return { done: false, value: new DataView(new ArrayBuffer(4)) }; },
    cancel() { cancelled++; }, releaseLock() { released++; }
  }) } };
  const result = await sendProxyResponse(response, { fetchImpl: async (_url, options) => { signal = options.signal; return response; } });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, error: 'AI_PROXY_RESPONSE_READ_FAILED', status: 502 });
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  assert.equal(signal.aborted, true);
});

test('响应读取超时会立即取消和终止，不会被读取错误覆盖', async () => {
  let cancelled = 0, released = 0, signal;
  const response = { status: 200, ok: true, headers: new Headers(), body: { getReader: () => ({
    read() { return new Promise(() => {}); },
    cancel() { cancelled++; return Promise.resolve(); },
    releaseLock() { released++; }
  }) } };
  const result = await sendProxyResponse(response, {
    fetchImpl: async (_url, options) => { signal = options.signal; return response; },
    setTimeoutImpl: callback => setTimeout(callback, 5),
    clearTimeoutImpl: clearTimeout
  });
  assert.equal(result.error, 'AI_PROXY_TIMEOUT');
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  assert.equal(signal.aborted, true);
});

test('取消抛错、拒绝或永不完成都不覆盖超限错误或拖住返回', async () => {
  const cancelBehaviors = [
    () => { throw new Error('cancel throw'); },
    () => Promise.reject(new Error('cancel reject')),
    () => new Promise(() => {})
  ];
  for (const cancel of cancelBehaviors) {
    let getReaders = 0;
    const response = { status: 200, ok: true, headers: new Headers({ 'content-length': String(RESPONSE_LIMIT + 1) }), body: {
      locked: false, getReader() { getReaders++; throw new Error('must not lock'); }, cancel
    } };
    const result = await sendProxyResponse(response);
    assert.equal(result.error, 'AI_PROXY_RESPONSE_TOO_LARGE');
    assert.equal(getReaders, 0);
  }
});

test('正常完成只释放 reader，不取消或终止请求', async () => {
  let index = 0, cancelled = 0, released = 0, signal;
  const chunks = [encoder.encode('{"ok":true}')];
  const response = { status: 200, ok: true, headers: new Headers(), body: { getReader: () => ({
    async read() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
    cancel() { cancelled++; }, releaseLock() { released++; }
  }) } };
  const result = await sendProxyResponse(response, { fetchImpl: async (_url, options) => { signal = options.signal; return response; } });
  assert.equal(result.data.ok, true);
  assert.equal(cancelled, 0);
  assert.equal(released, 1);
  assert.equal(signal.aborted, false);
});

test('HTTP 500 的超大正文仍受相同字节上限约束', async () => {
  const result = await sendProxyResponse(streamResponse([new Uint8Array(RESPONSE_LIMIT), new Uint8Array(1)], { status: 500, headers: { 'content-length': '1' } }));
  assert.equal(result.error, 'AI_PROXY_RESPONSE_TOO_LARGE');
});

test('真实 chunked HTTP 响应越界后会中止连接且不会等待读取哨兵', async t => {
  let sentinelAttempted = false;
  let sentinelTimer;
  let resolveClosed;
  const clientClosed = new Promise(resolve => { resolveClosed = resolve; });
  const server = createServer((request, response) => {
    request.socket.once('close', resolveClosed);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(Buffer.alloc(RESPONSE_LIMIT, 0x20));
    response.write(Buffer.from([0x20]));
    sentinelTimer = setTimeout(() => {
      sentinelAttempted = true;
      response.end('{"sentinel":true}');
    }, 250);
  });
  t.after(() => {
    clearTimeout(sentinelTimer);
    server.close();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const result = await sendProxyResponse(null, {
    fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${address.port}/oversized`, options)
  });
  assert.equal(result.error, 'AI_PROXY_RESPONSE_TOO_LARGE');
  await Promise.race([clientClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('client did not close oversized stream')), 1_000))]);
  assert.equal(sentinelAttempted, false);
});

function message(identity, overrides = {}) {
  return { type: 'CLAIM_NEW_CARD', userId: '12345', dayKey: todaySydney(), identity, ...overrides };
}

function reviewMessage(courseId, cardKey, overrides = {}) {
  return {
    type: 'MUTATE_REVIEW', userId: '12345', courseId: String(courseId), cardKey,
    contentHash: `hash:${cardKey.length}`, operationId: `op:${courseId}:${cardKey}`, action: 'rate', rating: 'good',
    now: Date.now(), focusItemId: null, focusOutcome: '', ...overrides
  };
}

function practiceReviewMessage(attemptId, overrides = {}) {
  const now = Date.now();
  const cardKey = 'ku:motion';
  return reviewMessage('1', cardKey, {
    operationId: attemptId, action: 'practice', verdict: 'incorrect', rating: undefined, knowledgeUnit: true, now,
    attempt: {
      attemptId, itemId: `practice:item-${attemptId.slice(-4)}`, knowledgeUnitId: cardKey,
      sourceVersionHashes: [`hash:${cardKey.length}`], preparationSnapshotId: 'prep:1', normalizedStemHash: `stem-${attemptId.slice(-4)}`,
      variantKey: `scenario:apply:${attemptId.slice(-4)}`, verdict: 'incorrect', errorTags: ['transfer-failure'], hintLevel: 0,
      answerViewed: false, answeredAt: new Date(now).toISOString(), dueAt: new Date(now + 86_400_000).toISOString()
    }, ...overrides
  });
}

function courseIndexMessage(courseId, operationId, overrides = {}) {
  return {
    type: 'MUTATE_COURSE_INDEX', userId: '12345', courseId: String(courseId), operationId,
    expectedToken: 0, action: 'upsert', courseData: { pages: [{ id: `page-${courseId}` }], files: [] },
    semanticAction: 'set', semanticData: { model: 'test', records: { [`record-${courseId}`]: { hash: 'h', vector: 'v' } } },
    ...overrides
  };
}

function openedDeadlineMessage(userId = '12345', overrides = {}) {
  return {
    type: 'MARK_DEADLINE_OPENED', userId, dayKey: todaySydney(),
    deadlineIdHash: 'abc123:20', sourceSnapshotHash: 'def456:40', openedAt: new Date().toISOString(), ...overrides
  };
}

test('截止事项今日已打开状态按账号隔离并幂等合并', async () => {
  const { saved, send } = setup();
  const first = await send(openedDeadlineMessage('12345'));
  const duplicate = await send(openedDeadlineMessage('12345'));
  const other = await send(openedDeadlineMessage('67890'));
  assert.equal(first.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(other.ok, true);
  assert.equal(saved['askme:v1:user:12345:openedDeadlinesToday'].entries.length, 1);
  assert.equal(saved['askme:v1:user:67890:openedDeadlinesToday'].entries.length, 1);
  assert.notEqual(saved['askme:v1:user:12345:openedDeadlinesToday'], saved['askme:v1:user:67890:openedDeadlinesToday']);
});

test('截止事项今日已打开后台拒绝旧日、非法 hash 和存储失败', async () => {
  const normal = setup();
  assert.equal((await normal.send(openedDeadlineMessage('12345', { dayKey: '2000-01-01' }))).error, 'INVALID_DEADLINE_OPEN');
  assert.equal((await normal.send(openedDeadlineMessage('12345', { deadlineIdHash: 'raw title' }))).error, 'INVALID_DEADLINE_OPEN');
  const failing = setup({}, { failSet: true });
  const result = await failing.send(openedDeadlineMessage());
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
});

test('重复占用同一新卡是幂等的', async () => {
  const { saved, send } = setup();
  assert.equal((await send(message('a'))).ok, true);
  assert.equal((await send(message('a'))).ok, true);
  assert.deepEqual(saved['askme:v1:user:12345:studyPlanRuntime'].newCardClaims, ['a']);
});

test('每天第 11 张新卡被拒绝', async () => {
  const { send } = setup();
  for (let i = 0; i < 10; i++) assert.equal((await send(message(`card-${i}`))).ok, true);
  const result = await send(message('card-10'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'NEW_LIMIT_REACHED');
  assert.equal(result.count, 10);
});

test('两个窗口并发争用最后一个额度时只有一个成功', async () => {
  const key = 'askme:v1:user:12345:studyPlanRuntime';
  const { saved, send } = setup({ [key]: { dayKey: todaySydney(), newCardClaims: Array.from({ length: 9 }, (_, i) => `old-${i}`) } });
  const results = await Promise.all([send(message('window-a')), send(message('window-b'))]);
  assert.equal(results.filter(item => item.ok).length, 1);
  assert.equal(results.filter(item => item.error === 'NEW_LIMIT_REACHED').length, 1);
  assert.equal(saved[key].newCardClaims.length, 10);
});

test('Sydney 日期变化后旧额度自动清零', async () => {
  const key = 'askme:v1:user:12345:studyPlanRuntime';
  const { saved, send } = setup({ [key]: { dayKey: '2000-01-01', newCardClaims: Array.from({ length: 10 }, (_, i) => `old-${i}`) } });
  assert.equal((await send(message('new-day'))).ok, true);
  assert.deepEqual(saved[key], { dayKey: todaySydney(), newCardClaims: ['new-day'] });
});

test('拒绝非法账号、日期、卡片标识和过期日期消息', async () => {
  const { send } = setup();
  assert.equal((await send(message('a', { userId: '../x' }))).error, 'INVALID_CLAIM');
  assert.equal((await send(message('', {}))).error, 'INVALID_CLAIM');
  assert.equal((await send(message('a', { dayKey: '2026-99-99' }))).error, 'STALE_DAY');
  assert.equal((await send(message('a', { dayKey: '2000-01-01' }))).error, 'STALE_DAY');
});

test('存储失败时不报告占用成功', async () => {
  const { send } = setup({}, { failSet: true });
  const result = await send(message('a'));
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
});

test('后台把当日已写入复习记录的新卡与运行时占用合并计数', async () => {
  const runtimeKey = 'askme:v1:user:12345:studyPlanRuntime';
  const reviewKey = 'askme:v1:user:12345:reviewProgress';
  const introducedAt = new Date().toISOString();
  const reviewProgress = { 1: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`card-${i}`, { introducedAt, contentHash: `hash-${i}` }])) };
  const { send } = setup({ [runtimeKey]: { dayKey: todaySydney(), newCardClaims: [] }, [reviewKey]: reviewProgress });
  assert.equal((await send(message('new-card'))).ok, true);
  const rejected = await send(message('overflow-card'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'NEW_LIMIT_REACHED');
});

test('两个面板并发评分不同知识点时后台串行合并且不丢记录', async () => {
  const key = 'askme:v1:user:12345:reviewProgress';
  const { saved, send } = setup({ [key]: {} });
  const results = await Promise.all([send(reviewMessage('1', 'card-a')), send(reviewMessage('2', 'card-b'))]);
  assert.equal(results.every(item => item.ok), true);
  assert.equal(saved[key]['1']['card-a'].reviews, 1);
  assert.equal(saved[key]['2']['card-b'].reviews, 1);
});

test('相同复习 operationId 重发保持幂等且不增加次数', async () => {
  const key = 'askme:v1:user:12345:reviewProgress';
  const { saved, send } = setup({ [key]: {} });
  const mutation = reviewMessage('1', 'card-a');
  assert.equal((await send(mutation)).ok, true);
  const repeated = await send(mutation);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.duplicate, true);
  assert.equal(saved[key]['1']['card-a'].reviews, 1);
});

test('相同 attemptId 跨窗口重试只记录一次且不同 attempt 并发都保留', async () => {
  const fixture = setup();
  const first = practiceReviewMessage('attempt:practice0001');
  const duplicate = structuredClone(first);
  const second = practiceReviewMessage('attempt:practice0002');
  const [a, b] = await Promise.all([fixture.send(first), fixture.send(second)]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const repeated = await fixture.send(duplicate);
  assert.equal(repeated.duplicate, true);
  const entry = fixture.saved['askme:v1:user:12345:reviewProgress']['1']['ku:motion'];
  assert.equal(entry.practiceAttempts, 2);
  assert.deepEqual(entry.unitProgress.attempts.map(item => item.attemptId).sort(), ['attempt:practice0001', 'attempt:practice0002']);
  const serialized = JSON.stringify(entry);
  for (const forbidden of ['studentAnswer', 'modelAnswer', 'feedback', 'question']) assert.equal(serialized.includes(forbidden), false);
});

test('评分和今日学习块完成在同一次存储写入中提交', async () => {
  const reviewKey = 'askme:v1:user:12345:reviewProgress';
  const focusKey = 'askme:v1:user:12345:todayFocusSession';
  const itemId = 'v1:1:abc:def';
  const session = {
    schemaVersion: 1, dayKey: todaySydney(), status: 'active', plannedMinutes: 8, usedMinutesBefore: 0,
    itemIds: [itemId], itemMinutes: [8], currentIndex: 0, completed: [], skipped: [], invalidated: [],
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: null
  };
  const { saved, send, writes } = setup({ [reviewKey]: {}, [focusKey]: session });
  const result = await send(reviewMessage('1', 'card-a', { focusItemId: itemId, focusOutcome: 'good' }));
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.ok(writes[0][reviewKey]['1']['card-a']);
  assert.equal(writes[0][focusKey].completed[0].id, itemId);
  assert.equal(saved[focusKey].completed.length, 1);
});

test('今日学习块已被另一窗口完成时不重复累计复习', async () => {
  const reviewKey = 'askme:v1:user:12345:reviewProgress';
  const focusKey = 'askme:v1:user:12345:todayFocusSession';
  const itemId = 'v1:1:abc:def';
  const timestamp = new Date().toISOString();
  const session = { schemaVersion: 1, dayKey: todaySydney(), status: 'active', itemIds: [itemId], currentIndex: 0, completed: [], skipped: [], updatedAt: timestamp };
  const { saved, send } = setup({ [reviewKey]: {}, [focusKey]: session });
  assert.equal((await send(reviewMessage('1', 'card-a', { operationId: 'op:first', focusItemId: itemId, focusOutcome: 'good' }))).ok, true);
  const duplicate = await send(reviewMessage('1', 'card-a', { operationId: 'op:second', focusItemId: itemId, focusOutcome: 'good' }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(saved[reviewKey]['1']['card-a'].reviews, 1);
});

test('复习事务输入非法或存储失败时不会报告成功', async () => {
  const invalid = setup();
  assert.equal((await invalid.send(reviewMessage('x', 'card-a'))).error, 'INVALID_REVIEW_MUTATION');
  const failing = setup({}, { failSet: true });
  const result = await failing.send(reviewMessage('1', 'card-a'));
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
});

test('浮层 UI 状态只允许 UNSW Moodle content script 经后台读写', async () => {
  const key = 'askme:v1:ui:overlay';
  const { saved, send } = setup({ [key]: { width: 480, open: true } });
  const sender = { url: 'https://moodle.telt.unsw.edu.au/my/courses.php' };
  assert.deepEqual(JSON.parse(JSON.stringify(await send({ type: 'GET_OVERLAY_UI' }, sender))), { ok: true, value: { width: 480, open: true } });
  const written = await send({ type: 'SET_OVERLAY_UI', value: { width: 612.4, open: false } }, sender);
  assert.deepEqual(JSON.parse(JSON.stringify(written)), { ok: true, value: { width: 612, open: false } });
  assert.deepEqual(saved[key], { width: 612, open: false });
  assert.equal((await send({ type: 'GET_OVERLAY_UI' }, { url: 'https://evil.example/' })).error, 'INVALID_SENDER');
  assert.equal((await send({ type: 'SET_OVERLAY_UI', value: { width: 999, open: true } }, sender)).error, 'INVALID_OVERLAY_UI');
});

test('当前可见页截图只接受前台顶层 Moodle sender 且不写入存储', async () => {
  const normal = setup();
  const result = await normal.send({ type: 'CAPTURE_VISIBLE_MOODLE_TAB' }, moodleSender());
  assert.equal(result.ok, true);
  assert.equal(result.dataUrl, 'data:image/png;base64,ZmFrZQ==');
  assert.deepEqual(JSON.parse(JSON.stringify(normal.captures)), [{ windowId: 2, details: { format: 'png' } }]);
  assert.equal(normal.writes.length, 0);
  assert.equal((await normal.send({ type: 'CAPTURE_VISIBLE_MOODLE_TAB' }, { ...moodleSender(), frameId: 2 })).error, 'INVALID_CAPTURE_SENDER');
  assert.equal((await setup({}, { activeTabId: 8 }).send({ type: 'CAPTURE_VISIBLE_MOODLE_TAB' }, moodleSender())).error, 'CAPTURE_TAB_NOT_ACTIVE');
  assert.equal((await setup({}, { captureData: 'https://evil.example/image.png' }).send({ type: 'CAPTURE_VISIBLE_MOODLE_TAB' }, moodleSender())).error, 'INVALID_CAPTURE_RESULT');
  const denied = await setup({}, { captureFailure: 'Either the activeTab permission or all_urls is required' }).send({ type: 'CAPTURE_VISIBLE_MOODLE_TAB' }, moodleSender());
  assert.equal(denied.error, 'CAPTURE_PERMISSION_REQUIRED');
  assert.match(denied.message, /扩展管理页重新加载/);
  const failed = await setup({}, { captureFailure: 'tab closed' }).send({ type: 'CAPTURE_VISIBLE_MOODLE_TAB' }, moodleSender());
  assert.equal(failed.error, 'CAPTURE_FAILED');
  assert.match(failed.message, /Moodle 标签页/);
});

function moodleSender(tabId = 7, documentId = 'host-document') {
  return { url: 'https://moodle.telt.unsw.edu.au/my/courses.php', frameId: 0, documentId, tab: { id: tabId, windowId: 2 } };
}

function embeddedPanelSender(tabId = 7, documentId = 'panel-document', frameId = 3) {
  return { url: 'chrome-extension://askme-id/panel.html?embedded=1&g=1', frameId, documentId, tab: { id: tabId } };
}

test('真实版本化 iframe 地址可授权，外部扩展和重复参数不能兑换凭据', async () => {
  const content = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  const version = content.match(/const CONTENT_VERSION = '([^']+)'/)[1];
  for (const [url, allowed] of [
    [`chrome-extension://askme-id/panel.html?embedded=1&v=${version}&g=1`, true],
    [`chrome-extension://other-id/panel.html?embedded=1&v=${version}&g=1`, false],
    ['chrome-extension://askme-id/panel.html?embedded=1&embedded=1', false],
    ['chrome-extension://askme-id/panel.html?embedded=1&v=invalid', false],
    ['chrome-extension://askme-id/panel.html?embedded=1&v=2026.09.24.11&v=2026.09.24.11', false]
  ]) {
    const fixture = setup();
    const issued = await fixture.send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender());
    const result = await fixture.send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: issued.capability, hostDocumentId: issued.hostDocumentId, generation: 1 }, { ...embeddedPanelSender(), url });
    assert.equal(result.ok, allowed, url);
  }
});

test('内嵌 capability 只向顶层 Moodle content document 签发并只能兑换一次', async () => {
  const { send } = setup();
  assert.equal((await send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, { ...moodleSender(), frameId: 2 })).error, 'INVALID_EMBEDDED_HOST');
  assert.equal((await send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, { ...moodleSender(), documentId: '' })).error, 'INVALID_EMBEDDED_HOST');
  const issued = await send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender());
  assert.match(issued.capability, /^[0-9a-f]{48}$/);
  const redeemed = await send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: issued.capability, hostDocumentId: issued.hostDocumentId, generation: 1 }, embeddedPanelSender());
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.tabId, 7);
  assert.match(redeemed.bindingId, /^[0-9a-f]{48}$/);
  assert.equal((await send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: issued.capability, hostDocumentId: issued.hostDocumentId, generation: 1 }, embeddedPanelSender())).error, 'INVALID_EMBEDDED_CAPABILITY');
});

test('后台只把当前 binding 与 generation 的 ready 确认定向发送给原 Moodle document', async () => {
  const fixture = setup({}, { tabMessageResult: { ok: true } });
  const issued = await fixture.send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender());
  const sender = embeddedPanelSender();
  const redeemed = await fixture.send({
    type: 'REDEEM_EMBEDDED_CAPABILITY', capability: issued.capability,
    hostDocumentId: issued.hostDocumentId, generation: 1
  }, sender);
  const confirmed = await fixture.send({ type: 'CONFIRM_EMBEDDED_READY', bindingId: redeemed.bindingId, generation: 1 }, sender);
  assert.deepEqual(JSON.parse(JSON.stringify(confirmed)), { ok: true });
  assert.deepEqual(fixture.tabMessages.at(-1), {
    tabId: 7,
    message: { type: 'ASKME_EMBEDDED_READY_CONFIRMED', bindingId: redeemed.bindingId, generation: 1, hostDocumentId: 'host-document' },
    target: { documentId: 'host-document' }
  });
  const before = fixture.tabMessages.length;
  assert.equal((await fixture.send({ type: 'CONFIRM_EMBEDDED_READY', bindingId: redeemed.bindingId, generation: 2 }, { ...sender, url: 'chrome-extension://askme-id/panel.html?embedded=1&g=2' })).error, 'EMBEDDED_BINDING_MISMATCH');
  assert.equal((await fixture.send({ type: 'CONFIRM_EMBEDDED_READY', bindingId: 'c'.repeat(48), generation: 1 }, sender)).error, 'EXPIRED_EMBEDDED_BINDING');
  assert.equal(fixture.tabMessages.length, before);
});

test('新 generation 由后台定向撤销旧 binding，渲染诊断经 binding 核验后才送达宿主', async () => {
  const fixture = setup({}, { tabMessageResult: { ok: true } });
  const issued = await fixture.send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender());
  const sender = embeddedPanelSender();
  const redeemed = await fixture.send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: issued.capability, hostDocumentId: issued.hostDocumentId, generation: 1 }, sender);
  const report = {
    type: 'REPORT_EMBEDDED_RENDER_STATE', bindingId: redeemed.bindingId, generation: 1, diagnosticSeq: 1,
    view: 'courses', display: 'flex', mainWidth: 398, mainHeight: 878, textLength: 1305, styleSheets: 1,
    aiState: 'ready', hasSelectedCourse: true, courseCount: 2
  };
  assert.deepEqual(JSON.parse(JSON.stringify(await fixture.send(report, sender))), { ok: true });
  assert.deepEqual(fixture.tabMessages.at(-1), {
    tabId: 7,
    message: { type: 'ASKME_EMBEDDED_RENDER_STATE', bindingId: redeemed.bindingId, generation: 1, hostDocumentId: 'host-document', diagnosticSeq: 1,
      view: 'courses', display: 'flex', mainWidth: 398, mainHeight: 878, textLength: 1305, styleSheets: 1,
      aiState: 'ready', hasSelectedCourse: true, courseCount: 2 },
    target: { documentId: 'host-document' }
  });
  const beforeInvalid = fixture.tabMessages.length;
  assert.equal((await fixture.send({ ...report, aiState: 'account-12345' }, sender)).error, 'INVALID_EMBEDDED_RENDER_STATE');
  assert.equal(fixture.tabMessages.length, beforeInvalid);
  assert.equal((await fixture.send({ ...report, generation: 2 }, { ...sender, url: 'chrome-extension://askme-id/panel.html?embedded=1&g=2' })).error, 'EMBEDDED_BINDING_MISMATCH');
  assert.equal(fixture.tabMessages.at(-1).message.type, 'ASKME_EMBEDDED_BINDING_REVOKED');
  assert.equal(fixture.tabMessages.some(item => item.message.type === 'ASKME_EMBEDDED_RENDER_STATE' && item.message.generation === 2), false);

  await fixture.send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 2 }, moodleSender());
  const revoked = fixture.tabMessages.at(-1);
  assert.equal(revoked.message.type, 'ASKME_EMBEDDED_BINDING_REVOKED');
  assert.equal(revoked.message.bindingId, redeemed.bindingId);
  assert.equal(revoked.message.generation, 1);
  assert.equal(revoked.target.documentId, 'host-document');
});

test('过期 binding 的诊断由后台撤销且不把 panel 自报状态写给宿主', async () => {
  const fixture = setup({}, { tabMessageResult: { ok: true } });
  const issued = await fixture.send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender());
  const sender = embeddedPanelSender();
  const redeemed = await fixture.send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: issued.capability, hostDocumentId: issued.hostDocumentId, generation: 1 }, sender);
  fixture.sessionSaved['askme:session:embeddedBindings'][redeemed.bindingId].expiresAt = Date.now() - 1;
  const result = await fixture.send({
    type: 'REPORT_EMBEDDED_RENDER_STATE', bindingId: redeemed.bindingId, generation: 1, diagnosticSeq: 1,
    view: 'courses', display: 'flex', mainWidth: 398, mainHeight: 878, textLength: 1305, styleSheets: 1,
    aiState: 'offline', hasSelectedCourse: false, courseCount: 0
  }, sender);
  assert.equal(result.error, 'EXPIRED_EMBEDDED_BINDING');
  assert.equal(fixture.tabMessages.length, 1);
  assert.equal(fixture.tabMessages[0].message.type, 'ASKME_EMBEDDED_BINDING_REVOKED');
  assert.equal(fixture.tabMessages.some(item => item.message.type === 'ASKME_EMBEDDED_RENDER_STATE'), false);
});

test('当前页来源请求严格绑定 panel 文档、frame、tab 与 Moodle host document', async () => {
  const fixture = setup();
  const issued = await fixture.send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender());
  const panelSender = embeddedPanelSender();
  const redeemed = await fixture.send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: issued.capability, hostDocumentId: issued.hostDocumentId, generation: 1 }, panelSender);
  const message = { type: 'GET_BOUND_CURRENT_PAGE_SOURCE', bindingId: redeemed.bindingId, userId: '12345' };
  const result = await fixture.send(message, panelSender);
  assert.equal(result.ok, true);
  assert.equal(result.accountId, '12345');
  assert.deepEqual(fixture.tabMessages[0].target, { documentId: 'host-document' });
  assert.equal(fixture.tabMessages[0].tabId, 7);
  assert.equal((await fixture.send(message, embeddedPanelSender(7, 'other-panel-document'))).error, 'EMBEDDED_BINDING_MISMATCH');
  assert.equal((await fixture.send(message, embeddedPanelSender(8))).error, 'EMBEDDED_BINDING_MISMATCH');
  assert.equal((await fixture.send({ ...message, userId: '../bad' }, panelSender)).error, 'INVALID_BOUND_PAGE_REQUEST');
});

test('当前页来源代理拒绝账号不一致、站外来源与过期 binding', async () => {
  async function boundFixture(options = {}) {
    const fixture = setup({}, options);
    const issued = await fixture.send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender());
    const sender = embeddedPanelSender();
    const redeemed = await fixture.send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: issued.capability, hostDocumentId: issued.hostDocumentId, generation: 1 }, sender);
    return { ...fixture, sender, message: { type: 'GET_BOUND_CURRENT_PAGE_SOURCE', bindingId: redeemed.bindingId, userId: '12345' }, bindingId: redeemed.bindingId };
  }
  const wrongAccount = await boundFixture({ tabMessageResult: { ok: true, contentVersion: '2026.09.24.11', accountId: '999', source: { title: 'Page', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7', excerpt: 'x'.repeat(80) } } });
  assert.equal((await wrongAccount.send(wrongAccount.message, wrongAccount.sender)).error, 'INVALID_PAGE_SOURCE');
  const outside = await boundFixture({ tabMessageResult: { ok: true, contentVersion: '2026.09.24.11', accountId: '12345', source: { title: 'Page', url: 'https://evil.example/', excerpt: 'x'.repeat(80) } } });
  assert.equal((await outside.send(outside.message, outside.sender)).error, 'INVALID_PAGE_SOURCE');
  const expired = await boundFixture();
  expired.sessionSaved['askme:session:embeddedBindings'][expired.bindingId].expiresAt = Date.now() - 1;
  assert.equal((await expired.send(expired.message, expired.sender)).error, 'EXPIRED_EMBEDDED_BINDING');
});

test('内嵌 capability 拒绝过期、标签和宿主 document 不匹配', async () => {
  const { send, sessionSaved } = setup();
  const first = await send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender());
  assert.equal((await send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: first.capability, hostDocumentId: first.hostDocumentId, generation: 1 }, embeddedPanelSender(8))).error, 'EMBEDDED_TAB_MISMATCH');
  assert.equal((await send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: first.capability, hostDocumentId: 'other-document', generation: 1 }, embeddedPanelSender())).error, 'EMBEDDED_DOCUMENT_MISMATCH');
  sessionSaved['askme:session:embeddedCapabilities'][first.capability].expiresAt = Date.now() - 1;
  assert.equal((await send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: first.capability, hostDocumentId: first.hostDocumentId, generation: 1 }, embeddedPanelSender())).error, 'EXPIRED_EMBEDDED_CAPABILITY');
});

test('同一标签的新 Moodle document 会撤销旧 document 的 capability', async () => {
  const { send } = setup();
  const old = await send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender(7, 'old-document'));
  await send({ type: 'ISSUE_EMBEDDED_CAPABILITY', generation: 1 }, moodleSender(7, 'new-document'));
  assert.equal((await send({ type: 'REDEEM_EMBEDDED_CAPABILITY', capability: old.capability, hostDocumentId: old.hostDocumentId, generation: 1 }, embeddedPanelSender())).error, 'INVALID_EMBEDDED_CAPABILITY');
});

test('两个面板从同一学习块版本推进时只接受一个并返回陈旧冲突', async () => {
  const focusKey = 'askme:v1:user:12345:todayFocusSession';
  const itemIds = ['v1:1:abc:3:def:4', 'v1:1:aaa:3:bbb:4'];
  const timestamp = new Date().toISOString();
  const base = {
    schemaVersion: 1, dayKey: todaySydney(), status: 'active', plannedMinutes: 8, usedMinutesBefore: 0,
    itemIds, itemMinutes: [4, 4], currentIndex: 0, completed: [], skipped: [], invalidated: [],
    startedAt: timestamp, updatedAt: timestamp, endedAt: null
  };
  const { saved, send } = setup({ [focusKey]: base });
  const first = { type: 'MUTATE_FOCUS', userId: '12345', operationId: 'focus:first', expectedUpdatedAt: timestamp, next: { ...base, currentIndex: 1, updatedAt: timestamp } };
  const second = { type: 'MUTATE_FOCUS', userId: '12345', operationId: 'focus:second', expectedUpdatedAt: timestamp, next: { ...base, status: 'ended', endedAt: timestamp, updatedAt: timestamp } };
  const results = await Promise.all([send(first), send(second)]);
  assert.equal(results.filter(item => item.ok).length, 1);
  assert.equal(results.filter(item => item.error === 'STALE_FOCUS').length, 1);
  assert.equal(saved[focusKey].currentIndex, 1);
  assert.ok(Date.parse(saved[focusKey].updatedAt) > Date.parse(timestamp));
});

test('学习块 mutation operationId 幂等且拒绝包含原文式非法项目标识', async () => {
  const focusKey = 'askme:v1:user:12345:todayFocusSession';
  const timestamp = new Date().toISOString();
  const base = {
    schemaVersion: 1, dayKey: todaySydney(), status: 'active', plannedMinutes: 4, usedMinutesBefore: 0,
    itemIds: ['v1:1:abc:3:def:4'], itemMinutes: [4], currentIndex: 0, completed: [], skipped: [], invalidated: [],
    startedAt: timestamp, updatedAt: timestamp, endedAt: null
  };
  const { send } = setup({ [focusKey]: base });
  const message = { type: 'MUTATE_FOCUS', userId: '12345', operationId: 'focus:once', expectedUpdatedAt: timestamp, next: { ...base, status: 'ended', endedAt: timestamp, updatedAt: new Date(Date.now() + 1).toISOString() } };
  assert.equal((await send(message)).ok, true);
  assert.equal((await send(message)).duplicate, true);
  const bad = { ...message, operationId: 'focus:bad', expectedUpdatedAt: message.next.updatedAt, next: { ...message.next, itemIds: ['https://moodle.telt.unsw.edu.au/secret'] } };
  assert.equal((await send(bad)).error, 'INVALID_FOCUS_MUTATION');
});

test('两个窗口并发提交不同课程时后台 fresh-read 合并且都保留', async () => {
  const libraryKey = 'askme:v1:user:12345:library';
  const semanticKey = 'askme:v1:user:12345:semanticIndex';
  const { saved, send } = setup({ [libraryKey]: {}, [semanticKey]: {} });
  const results = await Promise.all([send(courseIndexMessage('1', 'course:one')), send(courseIndexMessage('2', 'course:two'))]);
  assert.equal(results.every(result => result.ok), true);
  assert.deepEqual(Object.keys(saved[libraryKey]).sort(), ['1', '2']);
  assert.deepEqual(Object.keys(saved[semanticKey]).sort(), ['1', '2']);
  assert.deepEqual(Object.keys(results[1].library).sort(), ['1', '2']);
});

test('同课程同步与清除使用 token CAS 且 operationId 重发幂等', async () => {
  const libraryKey = 'askme:v1:user:12345:library';
  const semanticKey = 'askme:v1:user:12345:semanticIndex';
  const reviewKey = 'askme:v1:user:12345:reviewProgress';
  const { saved, send } = setup({ [libraryKey]: { 1: { pages: [], files: [] } }, [semanticKey]: { 1: { model: 'old', records: {} } }, [reviewKey]: { 1: { card: {} } } });
  const clear = courseIndexMessage('1', 'course:clear', { action: 'delete', deleteReviewProgress: true });
  const staleSync = courseIndexMessage('1', 'course:sync');
  const [clearResult, syncResult] = await Promise.all([send(clear), send(staleSync)]);
  assert.equal(clearResult.ok, true);
  assert.equal(syncResult.error, 'STALE_COURSE_INDEX');
  assert.equal(saved[libraryKey]['1'], undefined);
  assert.equal(saved[semanticKey]['1'], undefined);
  assert.equal(saved[reviewKey]['1'], undefined);
  const repeated = await send(clear);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.courseToken, 1);
});
