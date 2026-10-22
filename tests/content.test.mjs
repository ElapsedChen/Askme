import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const CONTENT_VERSION = String(manifest.version_name || '').split('·').at(-1).trim();
const api = vm.runInNewContext(source + '\nglobalThis.__test = { normaliseUrl, courseUrl, courseAnchorTitle, assignmentBriefUrl, structuredBriefBlocks, extractAssignmentBrief, discover, classifyMoodleDocument, currentAccount, currentStaticPageSource, structuredText, extractPage, extractCourseSections, extractUpcomingEvents, extractAssessmentFacts, extractAssessmentSnapshot, getHtml, verifyActivityCourse, clampOverlayWidth, validOverlayMessageSource, validOverlayGeneration, overlayMessageDiagnostics, validOverlayViewMessage, validOverlayReadyMessage, validOverlayActionResultMessage, validOverlayRenderStateMessage, normalizeDiscoveredCourse, mountAskmeCourseSyncControls, safeRuntimeSend, extensionRuntimeOrigin, mountAskmeOverlay, handleContentRuntimeMessage, OVERLAY_UI_KEY }; __test', { URL, Date, setTimeout, clearTimeout, AbortController, fetch: async () => ({ ok: true, url: 'https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=8', headers: { get: () => 'text/html' } }) });

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener({ type, ...event }); }
}

class FakeElement extends FakeTarget {
  constructor(tag, contentWindow = null) {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {};
    const values = {}, priorities = {};
    this.style = {
      values,
      setProperty(key, value, priority = '') { values[key] = String(value); priorities[key] = String(priority || ''); },
      getPropertyValue(key) { return values[key] ?? ''; },
      getPropertyPriority(key) { return priorities[key] ?? ''; },
      removeProperty(key) { const previous = values[key] ?? ''; delete values[key]; delete priorities[key]; return previous; }
    };
    this.contentWindow = contentWindow; this.hidden = false; this.textContent = ''; this.className = ''; this.id = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  contains(node) { return this === node || this.children.some(child => child === node || child?.contains?.(node)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  attachShadow(options) { this.shadowMode = options?.mode; this.shadowRoot = new FakeElement('shadow-root'); return this.shadowRoot; }
  setPointerCapture(pointerId) { this.captured = pointerId; }
  releasePointerCapture(pointerId) { this.released = pointerId; }
}

function overlayFixture({ width = 1000, saved = {}, denyStorage = false, runtimeThrow = false, framePostThrows = false, frameDocument = 'extension', captureError = '', courseCards = [], issueCapability = null } = {}) {
  const frameMessages = [];
  const mutationObservers = [];
  const iframeWindow = { postMessage(message, origin) { if (framePostThrows) throw new DOMException('Target origin mismatch'); frameMessages.push({ message, origin }); } };
  let currentFrameDocument = frameDocument;
  Object.defineProperty(iframeWindow, 'location', { configurable: true, get() {
    if (currentFrameDocument === 'extension') throw new DOMException('Blocked a frame with origin');
    return { href: currentFrameDocument };
  } });
  const root = new FakeElement('html');
  let frameSrcWhenHostConnected = null;
  root.append = (...children) => {
    const findFrame = node => node?.tagName === 'IFRAME' ? node : [node?.shadowRoot, ...(node?.children || [])].filter(Boolean).map(findFrame).find(Boolean);
    const frame = children.map(findFrame).find(Boolean);
    if (frame) frameSrcWhenHostConnected = frame.src || null;
    root.children.push(...children);
  };
  const doc = {
    location: { href: 'https://moodle.telt.unsw.edu.au/my/courses.php' },
    documentElement: root,
    createElement(tag) { return new FakeElement(tag, tag === 'iframe' ? iframeWindow : null); },
    querySelectorAll(selector) { return selector.includes('.dashboard-card') ? courseCards : []; },
    getElementById(id) {
      const visit = node => node.id === id ? node : node.children.map(visit).find(Boolean);
      return visit(root) || null;
    }
  };
  const win = new FakeTarget(); win.innerWidth = width; win.top = win; win.self = win;
  win.MutationObserver = class FakeMutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; mutationObservers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
    disconnect() { this.disconnected = true; }
    trigger(records = []) { if (!this.disconnected) this.callback(records, this); }
  };
  const writes = [];
  const runtimeListeners = [];
  const chromeApi = {
    runtime: {
      id: 'hmabehbhopolggfbmglhojehbjijcifi',
      getURL: path => `chrome-extension://hmabehbhopolggfbmglhojehbjijcifi/${path.replace(/^\//, '')}`,
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      async sendMessage(message) {
        if (runtimeThrow) throw new Error('Extension context invalidated.');
        if (message.type === 'ISSUE_EMBEDDED_CAPABILITY') return issueCapability ? issueCapability(message) : { ok: true, capability: 'a'.repeat(48), hostDocumentId: 'host-document' };
        if (message.type === 'GET_OVERLAY_UI') return { ok: true, value: saved['askme:v1:ui:overlay'] || null };
        if (message.type === 'SET_OVERLAY_UI') {
          const patch = { 'askme:v1:ui:overlay': structuredClone(message.value) };
          writes.push(patch); Object.assign(saved, patch); return { ok: true, value: patch['askme:v1:ui:overlay'] };
        }
        if (message.type === 'CAPTURE_VISIBLE_MOODLE_TAB') return captureError ? { ok: false, error: captureError } : { ok: true, dataUrl: 'data:image/png;base64,ZmFrZQ==' };
        return { ok: false };
      }
    },
    storage: { local: {
      async get(key) { if (denyStorage) throw new Error('Access denied'); return saved[key] === undefined ? {} : { [key]: saved[key] }; },
      async set(patch) { if (denyStorage) throw new Error('Access denied'); writes.push(patch); Object.assign(saved, patch); }
    } }
  };
  return { doc, win, chromeApi, saved, writes, frameMessages, iframeWindow, root, runtimeListeners, mutationObservers,
    runtimeMessage(message, sender = { id: 'hmabehbhopolggfbmglhojehbjijcifi' }) {
      let response;
      for (const listener of runtimeListeners) listener(message, sender, value => { response = value; });
      return response;
    },
    confirmReady({ bindingId = 'b'.repeat(48), generation = 1, hostDocumentId = 'host-document', sender = { id: 'hmabehbhopolggfbmglhojehbjijcifi' } } = {}) {
      return this.runtimeMessage({ type: 'ASKME_EMBEDDED_READY_CONFIRMED', bindingId, generation, hostDocumentId }, sender);
    },
    frameSrcWhenHostConnected: () => frameSrcWhenHostConnected,
    setFrameDocument(value) { currentFrameDocument = value; } };
}

test('扩展内嵌面板使用真实 chrome-extension origin，避免 URL.origin 返回 null', () => {
  const id = 'hmabehbhopolggfbmglhojehbjijcifi';
  const chromeApi = { runtime: { id, getURL: path => `chrome-extension://${id}/${String(path || '').replace(/^\//, '')}` } };
  assert.equal(new URL(chromeApi.runtime.getURL('/')).origin, 'null');
  assert.equal(api.extensionRuntimeOrigin(chromeApi), `chrome-extension://${id}`);
  assert.equal(api.extensionRuntimeOrigin({ runtime: { getURL: () => `chrome-extension://${id}/` } }), `chrome-extension://${id}`);
  assert.equal(api.extensionRuntimeOrigin({ runtime: { id: 'invalid', getURL: () => 'https://example.com/' } }), '');
});

test('Chrome 隐去跨扩展 MessageEvent.source 时仍以精确来源和绑定凭据完成握手', () => {
  const extensionOrigin = 'chrome-extension://hmabehbhopolggfbmglhojehbjijcifi';
  const iframeWindow = {};
  const bindingId = 'b'.repeat(48);
  const ready = { origin: extensionOrigin, source: null, data: { type: 'ASKME_EMBEDDED_READY', bindingId, generation: 1 } };
  const view = { origin: extensionOrigin, source: null, data: { type: 'ASKME_EMBEDDED_VIEW', view: 'ask', bindingId, generation: 1 } };
  assert.equal(api.validOverlayMessageSource(ready, iframeWindow), true);
  assert.equal(api.validOverlayReadyMessage(ready, extensionOrigin, iframeWindow, 1), true);
  assert.equal(api.validOverlayViewMessage(view, extensionOrigin, iframeWindow, bindingId, 1), true);
  assert.equal(api.validOverlayReadyMessage({ ...ready, origin: 'https://evil.example' }, extensionOrigin, iframeWindow, 1), false);
  assert.equal(api.validOverlayReadyMessage({ ...ready, source: {} }, extensionOrigin, iframeWindow, 1), false);
  assert.equal(api.validOverlayReadyMessage({ origin: extensionOrigin, data: ready.data }, extensionOrigin, iframeWindow, 1), false);
  assert.equal(api.validOverlayReadyMessage({ ...ready, data: { ...ready.data, generation: 2 } }, extensionOrigin, iframeWindow, 1), false);
  assert.equal(api.validOverlayViewMessage({ ...view, data: { ...view.data, bindingId: 'c'.repeat(48) } }, extensionOrigin, iframeWindow, bindingId, 1), false);
  assert.deepEqual(JSON.parse(JSON.stringify(api.overlayMessageDiagnostics(ready, extensionOrigin, iframeWindow))), { origin: 'extension', source: 'null' });
  assert.deepEqual(JSON.parse(JSON.stringify(api.overlayMessageDiagnostics({ ...ready, origin: 'https://evil.example', source: {} }, extensionOrigin, iframeWindow))), { origin: 'other', source: 'other' });
});

test('内嵌渲染诊断只接受当前绑定的有限非敏感指标', () => {
  const extensionOrigin = 'chrome-extension://hmabehbhopolggfbmglhojehbjijcifi';
  const iframeWindow = {};
  const bindingId = 'b'.repeat(48);
  const valid = { origin: extensionOrigin, source: iframeWindow, data: {
    type: 'ASKME_EMBEDDED_RENDER_STATE', bindingId, generation: 1, view: 'courses', display: 'block',
    mainWidth: 400, mainHeight: 900, textLength: 420, styleSheets: 1,
    aiState: 'ready', hasSelectedCourse: true, courseCount: 2
  } };
  assert.equal(api.validOverlayRenderStateMessage(valid, extensionOrigin, iframeWindow, bindingId, 1), true);
  assert.equal(api.validOverlayRenderStateMessage({ ...valid, origin: 'https://evil.example' }, extensionOrigin, iframeWindow, bindingId, 1), false);
  assert.equal(api.validOverlayRenderStateMessage({ ...valid, data: { ...valid.data, bindingId: 'c'.repeat(48) } }, extensionOrigin, iframeWindow, bindingId, 1), false);
  assert.equal(api.validOverlayRenderStateMessage({ ...valid, data: { ...valid.data, generation: 2 } }, extensionOrigin, iframeWindow, bindingId, 1), false);
  assert.equal(api.validOverlayRenderStateMessage({ ...valid, data: { ...valid.data, mainWidth: 999999 } }, extensionOrigin, iframeWindow, bindingId, 1), false);
  assert.equal(api.validOverlayRenderStateMessage({ ...valid, data: { ...valid.data, aiState: 'secret-state' } }, extensionOrigin, iframeWindow, bindingId, 1), false);
  assert.equal(api.validOverlayRenderStateMessage({ ...valid, data: { ...valid.data, selectedCourseId: '123', hasSelectedCourse: undefined } }, extensionOrigin, iframeWindow, bindingId, 1), false);
});

test('课程消息监听器先按类型声明所有权，不抢答内嵌 READY 确认', async () => {
  let genericResponses = 0;
  assert.equal(api.handleContentRuntimeMessage({ type: 'ASKME_EMBEDDED_READY_CONFIRMED' }, {}, () => { genericResponses++; }), false);
  assert.equal(genericResponses, 0);

  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  fixture.runtimeListeners.unshift(api.handleContentRuntimeMessage);
  let responses = 0; let value;
  for (const listener of fixture.runtimeListeners) listener({
    type: 'ASKME_EMBEDDED_READY_CONFIRMED', bindingId: 'b'.repeat(48), generation: 1, hostDocumentId: 'host-document'
  }, { id: fixture.chromeApi.runtime.id }, response => { responses++; value = response; });
  assert.equal(responses, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { ok: true });
  assert.equal(overlay.host.dataset.askmeHandshake, 'ready');
});

test('Moodle 浮层为顶层页面单例，四个主按钮按课程、问答、截图、讲解排列且不改写已有页面节点', async () => {
  const fixture = overlayFixture();
  const moodleNode = new FakeElement('main'); moodleNode.id = 'region-main'; fixture.root.append(moodleNode);
  const first = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  const second = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await first.ready;
  assert.equal(fixture.doc.getElementById('askme-moodle-overlay-root'), first.root);
  assert.equal(fixture.doc.getElementById('askme-moodle-overlay-host'), first.host);
  assert.equal(fixture.doc.getElementById('askme-host'), null);
  assert.equal(first, second);
  assert.equal(fixture.root.children[0], moodleNode);
  assert.equal(first.buttons.size, 4);
  assert.equal(first.host.shadowMode, 'closed');
  assert.equal(first.panel.shadowRoot, undefined);
  assert.deepEqual(first.root.children, [first.host, first.panel]);
  assert.equal(first.root.style.getPropertyValue('display'), 'flex');
  assert.equal(first.root.style.getPropertyPriority('display'), 'important');
  assert.equal(first.host.dataset.askmeContentVersion, CONTENT_VERSION);
  assert.equal(first.host.dataset.askmeHandshake, 'pending');
  assert.deepEqual([...first.buttons.values()].map(button => button.getAttribute('aria-label')), ['Open panel', 'Open Askme session', 'Take screenshot', 'Solve this page']);
  assert.match(first.buttons.get('courses').innerHTML, /brand-logo/u);
  assert.match(first.buttons.get('courses').innerHTML, /assets\/askme-open-panel-128\.png/u);
  const overlayCss = first.shadow.children[0].textContent;
  assert.match(overlayCss, /\.quick \{[^}]*background: rgba\(255,255,255,\.97\)/u);
  assert.match(overlayCss, /\.quick \.brand-logo \{[^}]*background: transparent;[^}]*filter: none/u);
  assert.match(overlayCss, /\.quick\[data-action="courses"\] \{[^}]*background: #715df3/u);
  assert.match(overlayCss, /:host \{[^}]*overflow: visible;[^}]*isolation: isolate/u);
  assert.match(overlayCss, /\.overlay \{[^}]*overflow: visible;[^}]*isolation: isolate/u);
  assert.match(overlayCss, /\.rail \{[^}]*top: clamp\(8px, calc\(\(100vh - 252px\) \/ 2\), 320px\)[^}]*overflow: visible/u);
  assert.match(overlayCss, /\.quick \{[^}]*overflow: visible/u);
  assert.match(overlayCss, /\.quick::after \{[^}]*right: calc\(100% \+ 10px\)[^}]*max-width: min\(230px, calc\(100vw - 24px\)\)[^}]*overflow-wrap: anywhere;[^}]*white-space: normal/u);
  assert.equal(first.root.style.getPropertyValue('overflow'), 'visible');
  assert.equal(first.root.style.getPropertyValue('isolation'), 'isolate');
  assert.equal(first.panel.style.getPropertyValue('z-index'), '1');
  assert.equal(['ask', 'capture', 'explain'].every(action => /<svg/u.test(first.buttons.get(action).innerHTML)), true);
  assert.equal([...first.buttons.values()].every(button => button.getAttribute('data-tooltip') === button.getAttribute('aria-label')), true);
  assert.equal(first.iframe.src, `chrome-extension://hmabehbhopolggfbmglhojehbjijcifi/panel.html?embedded=1&v=${CONTENT_VERSION}&g=1`);
  assert.equal(first.panel.children.includes(first.iframe), true);
  assert.equal(fixture.frameMessages.length, 0);
  first.iframe.emit('load');
  assert.equal(first.host.dataset.askmeIframe, 'loaded');
  assert.equal(first.host.dataset.askmeInit, 'sent');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.frameMessages.at(-1).message)), { type: 'ASKME_EMBEDDED_INIT', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 1 });
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: first.iframe.contentWindow, data: { type: 'ASKME_EMBEDDED_READY', bindingId: 'b'.repeat(48), generation: 1 } });
  assert.equal(first.host.dataset.askmeMessageOrigin, 'extension');
  assert.equal(first.host.dataset.askmeMessageSource, 'iframe');
  assert.equal(first.host.dataset.askmeHandshake, 'pending');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady())), { ok: true });
  assert.equal(first.host.dataset.askmeHandshake, 'ready');
  first.buttons.get('courses').emit('click');
  assert.equal(first.getState().activeView, 'courses');
  assert.equal(first.buttons.get('courses').getAttribute('aria-current'), 'page');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.frameMessages.at(-1).message)), { type: 'ASKME_OPEN_VIEW', view: 'courses', bindingId: 'b'.repeat(48), capability: 'a'.repeat(48), generation: 1 });
  first.buttons.get('ask').emit('click');
  assert.equal(first.getState().activeView, 'ask');
  assert.equal(first.buttons.get('ask').getAttribute('aria-current'), 'page');
  assert.equal(first.buttons.get('courses').getAttribute('aria-current'), null);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.frameMessages.at(-1).message)), { type: 'ASKME_OPEN_VIEW', view: 'ask', bindingId: 'b'.repeat(48), capability: 'a'.repeat(48), generation: 1 });
  first.buttons.get('explain').emit('click');
  assert.equal(first.buttons.get('explain').disabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.frameMessages.at(-1).message)), { type: 'ASKME_EXPLAIN_CURRENT_PAGE', bindingId: 'b'.repeat(48), capability: 'a'.repeat(48), generation: 1 });
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: first.iframe.contentWindow, data: { type: 'ASKME_HOST_ACTION_RESULT', action: 'explain', ok: false, message: '此页面暂时无法讲解', bindingId: 'b'.repeat(48), generation: 1 } });
  assert.equal(first.buttons.get('explain').disabled, false);
  assert.equal(first.buttons.get('explain').getAttribute('aria-busy'), 'false');
  assert.match(first.railStatusText.textContent, /无法讲解/);
});

test('360×480 视口保留完整悬浮标签，并把四个轨道按钮限制在可视高度内', async () => {
  const fixture = overlayFixture({ width: 360 });
  fixture.win.innerHeight = 480;
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  assert.equal(overlay.getState().width, 288);
  assert.deepEqual([...overlay.buttons.values()].map(button => button.getAttribute('data-tooltip')), [
    'Open panel', 'Open Askme session', 'Take screenshot', 'Solve this page'
  ]);
  const css = overlay.shadow.children[0].textContent;
  assert.match(css, /top: clamp\(8px, calc\(\(100vh - 252px\) \/ 2\), 320px\)/u);
  assert.match(css, /white-space: normal/u);
  const railTop = Math.max(8, Math.min((fixture.win.innerHeight - 252) / 2, 320));
  const railBottom = railTop + (4 * 44) + (3 * 20);
  assert.equal(railBottom <= fixture.win.innerHeight - 16, true);
});

test('light DOM iframe 在宿主连接后导航，并在带 generation 的 load 后发送 capability', async () => {
  const fixture = overlayFixture();
  const controller = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await controller.ready;
  assert.equal(fixture.frameSrcWhenHostConnected(), null);
  assert.equal(controller.panel.children.includes(controller.iframe), true);
  assert.equal(controller.iframe.src, `chrome-extension://hmabehbhopolggfbmglhojehbjijcifi/panel.html?embedded=1&v=${CONTENT_VERSION}&g=1`);
  controller.iframe.emit('load');
  assert.equal(controller.host.dataset.askmeIframe, 'loaded');
  assert.equal(controller.host.dataset.askmeInit, 'sent');
  assert.equal(fixture.frameMessages.at(-1).message.type, 'ASKME_EMBEDDED_INIT');
  assert.equal(fixture.frameMessages.at(-1).message.generation, 1);
  assert.equal(controller.panelFallback.hidden, false);
});

test('iframe 加载错误显示可执行的扩展重载原因', async () => {
  const fixture = overlayFixture();
  const controller = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await controller.ready;
  controller.iframe.emit('error');
  assert.equal(controller.host.dataset.askmeIframe, 'error');
  assert.equal(controller.host.dataset.askmeHandshake, 'iframe-error');
  assert.equal(controller.panelFallback.hidden, false);
  assert.match(controller.fallbackTitle.textContent, /加载失败/u);
  assert.match(controller.fallbackText.textContent, /chrome:\/\/extensions/u);
});

function courseCard(href, title, { position = 'static' } = {}) {
  const card = new FakeElement('article');
  const courseAnchor = {
    textContent: title,
    getAttribute(name) { return name === 'href' ? href : null; },
    closest() { return null; }
  };
  card.querySelectorAll = selector => selector === 'a[href]' ? [courseAnchor] : [];
  card.querySelector = selector => selector === '[data-askme-course-sync]'
    ? card.children.find(child => child.getAttribute?.('data-askme-course-sync') != null) || null
    : null;
  card.computedPosition = position;
  return card;
}

test('Moodle 原生课程卡封面左上角获得紫色 Askme Sync 标签，点击在握手后发送严格课程消息', async () => {
  const card = courseCard('/course/view.php?id=123&section=2', '  MANF9543 CAD/CAM  ');
  const evil = courseCard('https://evil.example/course/view.php?id=7', 'Fake course');
  const fixture = overlayFixture({ courseCards: [card, evil] });
  fixture.win.getComputedStyle = element => ({ position: element.computedPosition || 'static' });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  assert.equal(overlay.courseSyncControls.buttons.length, 1);
  const control = overlay.courseSyncControls.buttons[0];
  assert.equal(control.host.getAttribute('data-askme-course-sync'), '123');
  assert.equal(control.button.getAttribute('aria-label'), '用 Askme 同步 MANF9543 CAD/CAM');
  assert.equal(card.style.values.position, 'relative');
  assert.equal(card.children.at(-1), control.host);
  assert.match(control.host.shadowRoot.children[0].textContent, /position:absolute/u);
  assert.match(control.host.shadowRoot.children[0].textContent, /top:8px/u);
  assert.match(control.host.shadowRoot.children[0].textContent, /left:8px/u);
  assert.match(control.host.shadowRoot.children[0].textContent, /background:#715df3/u);
  control.button.emit('click', { preventDefault() {}, stopPropagation() {} });
  assert.equal(overlay.getState().activeView, 'courses');
  assert.equal(fixture.frameMessages.some(item => item.message.type === 'ASKME_SYNC_DISCOVERED_COURSE'), false);
  overlay.courseSyncControls.scan();
  assert.equal(overlay.courseSyncControls.buttons.length, 1);
  overlay.iframe.emit('load');
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: overlay.iframe.contentWindow, data: { type: 'ASKME_EMBEDDED_READY', bindingId: 'b'.repeat(48), generation: 1 } });
  fixture.confirmReady();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.frameMessages.slice(-2).map(item => item.message))), [
    { type: 'ASKME_OPEN_VIEW', view: 'courses', bindingId: 'b'.repeat(48), capability: 'a'.repeat(48), generation: 1 },
    { type: 'ASKME_SYNC_DISCOVERED_COURSE', course: { id: '123', title: 'MANF9543 CAD/CAM', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=123' }, bindingId: 'b'.repeat(48), capability: 'a'.repeat(48), generation: 1 }
  ]);
  assert.equal(overlay.syncDiscoveredCourse({ id: '123', title: 'Bad', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=123&edit=on' }), false);
});

test('Sync 标签沿用 Moodle 课程卡已有的定位上下文', () => {
  const card = courseCard('/course/view.php?id=88', 'Engineering Design', { position: 'relative' });
  const fixture = overlayFixture({ courseCards: [card] });
  fixture.win.getComputedStyle = element => ({ position: element.computedPosition || 'static' });
  const controls = api.mountAskmeCourseSyncControls(fixture.doc, () => {}, fixture.win);
  assert.equal(controls.buttons.length, 1);
  assert.equal(card.style.values.position, undefined);
  assert.equal(card.children.at(-1), controls.buttons[0].host);
});

test('浮层使用同一 light DOM flex 容器，使面板展开时把 closed-shadow 工具栏推向左侧', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  assert.equal(overlay.getState().width, 400);
  assert.equal(overlay.root.style.getPropertyValue('top'), '8px');
  assert.equal(overlay.root.style.getPropertyValue('right'), '12px');
  assert.equal(overlay.root.style.getPropertyValue('display'), 'flex');
  assert.deepEqual(overlay.root.children, [overlay.host, overlay.panel]);
  assert.equal(overlay.panel.style.getPropertyValue('height'), 'calc(100vh - 16px)');
  assert.match(overlay.shadow.children[0].textContent, /height:\s*calc\(100vh - 16px\)/u);
  assert.match(overlay.shadow.children[0].textContent, /\.rail\s*\{[^}]*order:\s*0/u);
});

test('已保存收起状态在握手完成后仍收起，用户点击才展开', async () => {
  const fixture = overlayFixture({ saved: { 'askme:v1:ui:overlay': { width: 400, open: false } } });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  assert.equal(overlay.getState().open, false);
  overlay.iframe.emit('load');
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: overlay.iframe.contentWindow,
    data: { type: 'ASKME_EMBEDDED_READY', bindingId: 'b'.repeat(48), generation: 1 } });
  fixture.confirmReady();
  assert.equal(overlay.getState().open, false);
  assert.equal(overlay.panel.hidden, true);
  overlay.buttons.get('ask').emit('click');
  assert.equal(overlay.getState().open, true);
});

test('内嵌面板握手时显示连接状态，成功后隐藏，失败时给出刷新提示而非白屏', async () => {
  const success = overlayFixture();
  const ready = api.mountAskmeOverlay(success.doc, success.win, success.chromeApi);
  await ready.ready;
  assert.equal(ready.panelFallback.hidden, false);
  ready.iframe.emit('load');
  success.win.emit('message', { origin: success.frameMessages.at(-1).origin, source: ready.iframe.contentWindow, data: { type: 'ASKME_EMBEDDED_READY', bindingId: 'b'.repeat(48), generation: 1 } });
  assert.equal(ready.panelFallback.hidden, false);
  assert.equal(ready.isEmbeddedReady(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(success.confirmReady())), { ok: true });
  assert.equal(ready.isEmbeddedReady(), true);
  assert.equal(ready.panelFallback.hidden, true);
  success.win.emit('message', { origin: success.frameMessages.at(-1).origin, source: ready.iframe.contentWindow, data: {
    type: 'ASKME_EMBEDDED_RENDER_STATE', bindingId: 'b'.repeat(48), generation: 1, view: 'courses', display: 'flex',
    mainWidth: 400, mainHeight: 700, textLength: 240, styleSheets: 1,
    aiState: 'ready', hasSelectedCourse: true, courseCount: 2
  } });
  assert.equal(ready.panelFallback.hidden, true);

  const failure = overlayFixture();
  const failed = api.mountAskmeOverlay(failure.doc, failure.win, failure.chromeApi);
  await failed.ready;
  failed.iframe.emit('load');
  failure.win.emit('message', { origin: failure.frameMessages.at(-1).origin, source: failed.iframe.contentWindow, data: {
    type: 'ASKME_EMBEDDED_AUTH_ERROR', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 1, error: 'EMBEDDED_TAB_MISMATCH'
  } });
  assert.equal(failed.panelFallback.hidden, false);
  assert.match(failed.fallbackTitle.textContent, /连接失败/);
  assert.match(failed.fallbackText.textContent, /刷新/);
});

test('同 generation READY 是终态，迟到 iframe 错误不降级；后台撤销后迟到 READY 不能复活', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  overlay.iframe.emit('load');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady())), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady())), { ok: true });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady({ bindingId: 'c'.repeat(48) }))), { ok: false, error: 'EMBEDDED_BINDING_MISMATCH' });
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: overlay.iframe.contentWindow, data: {
    type: 'ASKME_EMBEDDED_AUTH_ERROR', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 1, error: 'LATE_FAILURE'
  } });
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: overlay.iframe.contentWindow, data: {
    type: 'ASKME_EMBEDDED_BOOT_ERROR', generation: 1, error: 'LATE_BOOT_FAILURE'
  } });
  overlay.iframe.emit('error');
  assert.equal(overlay.host.dataset.askmeHandshake, 'ready');
  assert.equal(overlay.host.dataset.askmeAuth, 'confirmed');
  const diagnostic = { type: 'ASKME_EMBEDDED_RENDER_STATE', bindingId: 'b'.repeat(48), generation: 1, hostDocumentId: 'host-document', diagnosticSeq: 1,
    view: 'courses', display: 'flex', mainWidth: 398, mainHeight: 878, textLength: 1305, styleSheets: 1,
    aiState: 'ready', hasSelectedCourse: true, courseCount: 2 };
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.runtimeMessage(diagnostic))), { ok: true });
  assert.equal(overlay.host.dataset.askmeAiState, 'ready');
  assert.equal(overlay.host.dataset.askmeHasSelectedCourse, 'true');
  assert.equal(overlay.host.dataset.askmeCourseCount, '2');
  assert.equal(overlay.host.dataset.askmeDiagnosticSource, 'background-confirmed');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.runtimeMessage({ ...diagnostic, aiState: 'offline' }))), { ok: false, error: 'INVALID_EMBEDDED_RENDER_STATE' });
  assert.equal(overlay.host.dataset.askmeAiState, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.runtimeMessage({ ...diagnostic, diagnosticSeq: 2 }, { id: 'other-extension' }))), { ok: false, error: 'INVALID_EMBEDDED_RUNTIME_MESSAGE' });

  const revoked = fixture.runtimeMessage({ type: 'ASKME_EMBEDDED_BINDING_REVOKED', bindingId: 'b'.repeat(48), generation: 1, hostDocumentId: 'host-document', reason: 'EXPIRED' });
  assert.deepEqual(JSON.parse(JSON.stringify(revoked)), { ok: true });
  assert.equal(overlay.host.dataset.askmeHandshake, 'revoked');
  assert.equal(overlay.isEmbeddedReady(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady())), { ok: false, error: 'EMBEDDED_BINDING_REVOKED' });
  assert.equal(overlay.host.dataset.askmeHandshake, 'revoked');
});

test('重试内嵌导航递增 generation，旧后台确认和伪造 sender 都不能激活新面板', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  overlay.iframe.emit('load');
  assert.equal(overlay.getDiagnostics().generation, 1);
  await overlay.navigateEmbedded();
  assert.equal(overlay.getDiagnostics().generation, 2);
  assert.equal(overlay.host.dataset.askmeAiState, 'pending');
  assert.equal(overlay.host.dataset.askmeHasSelectedCourse, 'pending');
  assert.equal(overlay.host.dataset.askmeCourseCount, 'pending');
  assert.equal(overlay.host.dataset.askmeDiagnosticSource, 'pending');
  assert.match(overlay.iframe.src, /[?&]g=2$/u);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady({ generation: 1 }))), { ok: false, error: 'INVALID_EMBEDDED_RUNTIME_MESSAGE' });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady({ generation: 2, sender: { id: 'other-extension' } }))), { ok: false, error: 'INVALID_EMBEDDED_RUNTIME_MESSAGE' });
  assert.equal(overlay.isEmbeddedReady(), false);
  overlay.iframe.emit('load');
  assert.equal(fixture.frameMessages.at(-1).message.generation, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady({ generation: 2 }))), { ok: true });
  assert.equal(overlay.isEmbeddedReady(), true);
  await overlay.navigateEmbedded();
  overlay.iframe.emit('load');
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: overlay.iframe.contentWindow, data: {
    type: 'ASKME_EMBEDDED_AUTH_ERROR', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 3, error: 'EMBEDDED_TAB_MISMATCH'
  } });
  assert.equal(overlay.host.dataset.askmeHandshake, 'auth-error');
  assert.equal(overlay.host.dataset.askmeAuth, 'failed');
});

test('srcdoc 在首次握手前出现时立即失效，并阻止后续 load 和消息进入替换文档', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  const frame = overlay.iframe;
  const observer = fixture.mutationObservers.find(item => item.targets.some(entry => entry.target === frame));
  assert.ok(observer);
  frame.setAttribute('srcdoc', '<p>debug</p>');
  observer.trigger([{ type: 'attributes', attributeName: 'srcdoc', target: frame }]);
  assert.equal(overlay.isEmbeddedReady(), false);
  assert.equal(overlay.host.dataset.askmeHandshake, 'document-replaced');
  assert.equal(overlay.host.dataset.askmeAuth, 'invalidated');
  assert.equal(overlay.panelFallback.hidden, false);
  assert.match(overlay.fallbackText.textContent, /文档已被替换/u);
  assert.match(overlay.shadow.children[0].textContent, /\.panel-fallback \{[^}]*right: 32px[^}]*width: calc\(var\(--askme-width\) - 40px\)/u);
  assert.equal(fixture.frameMessages.length, 0);
  frame.emit('load');
  frame.emit('error');
  assert.equal(fixture.frameMessages.length, 0);
  fixture.win.emit('message', { origin: fixture.chromeApi.runtime.getURL('').replace(/\/$/u, ''), source: frame.contentWindow,
    data: { type: 'ASKME_EMBEDDED_BOOT_ERROR', generation: 1, error: 'late' } });
  assert.equal(overlay.host.dataset.askmeHandshake, 'document-replaced');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady())), { ok: false, error: 'EMBEDDED_DOCUMENT_REPLACED' });
});

test('srcdoc 在已确认 READY 后出现时撤销旧绑定，后续 load 不复用 READY', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  const frame = overlay.iframe;
  frame.emit('load');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady())), { ok: true });
  assert.equal(overlay.isEmbeddedReady(), true);
  const messageCount = fixture.frameMessages.length;
  const observer = fixture.mutationObservers.find(item => item.targets.some(entry => entry.target === frame));
  assert.ok(observer);
  frame.setAttribute('srcdoc', '<p>debug</p>');
  observer.trigger([{ type: 'attributes', attributeName: 'srcdoc', target: frame }]);
  assert.equal(overlay.isEmbeddedReady(), false);
  assert.equal(overlay.host.dataset.askmeHandshake, 'document-replaced');
  assert.equal(overlay.host.dataset.askmeAuth, 'invalidated');
  frame.emit('load');
  frame.emit('error');
  assert.equal(fixture.frameMessages.length, messageCount);
  fixture.win.emit('message', { origin: fixture.chromeApi.runtime.getURL('').replace(/\/$/u, ''), source: frame.contentWindow,
    data: { type: 'ASKME_EMBEDDED_BOOT_ERROR', generation: 1, error: 'late' } });
  assert.equal(overlay.host.dataset.askmeHandshake, 'document-replaced');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady())), { ok: false, error: 'EMBEDDED_DOCUMENT_REPLACED' });
});

test('能力请求未完成时 srcdoc 竞态不会向替换文档发送 capability', async () => {
  let resolveCapability;
  const capability = new Promise(resolve => { resolveCapability = resolve; });
  const fixture = overlayFixture({ issueCapability: () => capability });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  const frame = overlay.iframe;
  await Promise.resolve();
  const observer = fixture.mutationObservers.find(item => item.targets.some(entry => entry.target === frame));
  assert.ok(observer);
  frame.setAttribute('srcdoc', '<p>debug</p>');
  observer.trigger([{ type: 'attributes', attributeName: 'srcdoc', target: frame }]);
  resolveCapability({ ok: true, capability: 'a'.repeat(48), hostDocumentId: 'host-document' });
  await overlay.ready;
  assert.equal(fixture.frameMessages.length, 0);
  assert.equal(overlay.host.dataset.askmeHandshake, 'document-replaced');
  assert.equal(overlay.isEmbeddedReady(), false);
});

test('MutationObserver 发现 iframe src 改写或 panel childList 移除当前 iframe 时失效当前文档', async () => {
  const srcFixture = overlayFixture();
  const srcOverlay = api.mountAskmeOverlay(srcFixture.doc, srcFixture.win, srcFixture.chromeApi);
  await srcOverlay.ready;
  const srcFrame = srcOverlay.iframe;
  const srcObserver = srcFixture.mutationObservers.find(item => item.targets.some(entry => entry.target === srcFrame));
  srcFrame.src = `${srcFrame.src}&debug=1`;
  srcObserver.trigger([{ type: 'attributes', attributeName: 'src', target: srcFrame }]);
  assert.equal(srcOverlay.host.dataset.askmeHandshake, 'document-replaced');
  assert.equal(srcOverlay.isEmbeddedReady(), false);

  const childFixture = overlayFixture();
  const childOverlay = api.mountAskmeOverlay(childFixture.doc, childFixture.win, childFixture.chromeApi);
  await childOverlay.ready;
  const childFrame = childOverlay.iframe;
  const childObserver = childFixture.mutationObservers.find(item => item.targets.some(entry => entry.target === childFrame));
  childOverlay.panel.replaceChildren(new FakeElement('div'));
  childObserver.trigger([{ type: 'childList', target: childOverlay.panel }]);
  assert.equal(childOverlay.host.dataset.askmeHandshake, 'document-replaced');
  assert.equal(childOverlay.isEmbeddedReady(), false);
});

test('手动重试创建新 iframe 和 generation，并断开旧 observer；旧 READY 不能激活新连接', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  const oldFrame = overlay.iframe;
  const oldObserver = fixture.mutationObservers.find(item => item.targets.some(entry => entry.target === oldFrame));
  assert.ok(oldObserver);
  oldFrame.setAttribute('srcdoc', '<p>debug</p>');
  oldObserver.trigger([{ type: 'attributes', attributeName: 'srcdoc', target: oldFrame }]);
  const oldGeneration = overlay.getDiagnostics().generation;
  overlay.retryEmbedded.emit('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  const newFrame = overlay.iframe;
  assert.notEqual(newFrame, oldFrame);
  assert.equal(overlay.getDiagnostics().generation, oldGeneration + 1);
  assert.equal(oldObserver.disconnected, true);
  oldObserver.trigger([{ type: 'attributes', attributeName: 'srcdoc', target: oldFrame }]);
  assert.equal(overlay.iframe, newFrame);
  assert.equal(overlay.getDiagnostics().generation, oldGeneration + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady({ generation: oldGeneration }))), { ok: false, error: 'INVALID_EMBEDDED_RUNTIME_MESSAGE' });
  oldFrame.emit('load');
  assert.equal(fixture.frameMessages.length, 0);
  newFrame.emit('load');
  assert.equal(fixture.frameMessages.at(-1).message.generation, oldGeneration + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.confirmReady({ generation: oldGeneration + 1 }))), { ok: true });
  assert.equal(overlay.isEmbeddedReady(), true);
});

test('两个导航授权乱序完成时旧 generation 不覆盖当前 capability', async () => {
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const fixture = overlayFixture({ issueCapability: message => message.generation === 1
    ? first
    : { ok: true, capability: 'b'.repeat(48), hostDocumentId: 'host-document-2' } });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  const oldFrame = overlay.iframe;
  await overlay.navigateEmbedded();
  assert.notEqual(overlay.iframe, oldFrame);
  resolveFirst({ ok: true, capability: 'a'.repeat(48), hostDocumentId: 'host-document-1' });
  await Promise.resolve();
  oldFrame.emit('error'); oldFrame.emit('load');
  assert.equal(overlay.host.dataset.askmeIframe, 'navigating');
  assert.equal(fixture.frameMessages.length, 0);
  overlay.iframe.emit('load');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.frameMessages.at(-1).message)), {
    type: 'ASKME_EMBEDDED_INIT', capability: 'b'.repeat(48), hostDocumentId: 'host-document-2', generation: 2
  });
  assert.equal(overlay.getDiagnostics().generation, 2);
});

test('浮层宽度按边界拖动和键盘调整，并只持久化宽度与开关', async () => {
  const fixture = overlayFixture({ width: 900, denyStorage: true });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  assert.equal(overlay.getState().width, 400);
  overlay.resize.emit('pointerdown', { button: 0, pointerId: 7, clientX: 600, preventDefault() {} });
  overlay.resize.emit('pointermove', { pointerId: 7, clientX: 0 });
  assert.equal(overlay.getState().width, 720);
  overlay.resize.emit('pointerup', { pointerId: 7 });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.writes.at(-1))), { 'askme:v1:ui:overlay': { width: 720, open: true } });
  overlay.resize.emit('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(overlay.getState().width, 704);
  overlay.applyWidth(-100);
  assert.equal(overlay.getState().width, 320);
  fixture.win.innerWidth = 350; fixture.win.emit('resize');
  assert.equal(overlay.getState().width, 278);
  overlay.panelClose.emit('click');
  await Promise.resolve();
  assert.equal(overlay.getState().open, false);
  assert.deepEqual(Object.keys(fixture.writes.at(-1)['askme:v1:ui:overlay']).sort(), ['open', 'width']);
});

test('浮层在 content script 无存储权限时仍通过后台代理恢复状态', async () => {
  const fixture = overlayFixture({ width: 900, denyStorage: true, saved: { 'askme:v1:ui:overlay': { width: 512, open: false } } });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  assert.deepEqual(JSON.parse(JSON.stringify(overlay.getState())), { width: 512, open: false, activeView: 'home' });
});

test('浮层消息校验只接受来自自身 iframe 扩展源的白名单视图', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  const bindingId = 'b'.repeat(48);
  overlay.iframe.emit('load');
  const valid = { origin: 'chrome-extension://askme-id', source: overlay.iframe.contentWindow, data: { type: 'ASKME_EMBEDDED_VIEW', view: 'review', bindingId, generation: 1 } };
  assert.equal(api.validOverlayViewMessage(valid, 'chrome-extension://askme-id', overlay.iframe.contentWindow, bindingId, 1), true);
  assert.equal(fixture.win.listeners.get('message')?.length, 1);
  assert.equal(api.validOverlayViewMessage({ ...valid, origin: 'https://evil.example' }, 'chrome-extension://askme-id', overlay.iframe.contentWindow, bindingId, 1), false);
  assert.equal(api.validOverlayViewMessage({ ...valid, data: { ...valid.data, view: 'admin' } }, 'chrome-extension://askme-id', overlay.iframe.contentWindow, bindingId, 1), false);
  assert.equal(api.validOverlayViewMessage({ ...valid, source: {} }, 'chrome-extension://askme-id', overlay.iframe.contentWindow, bindingId, 1), false);
  assert.equal(api.validOverlayViewMessage({ ...valid, data: { type: 'OTHER', view: 'review', bindingId, generation: 1 } }, 'chrome-extension://askme-id', overlay.iframe.contentWindow, bindingId, 1), false);
  assert.equal(api.validOverlayViewMessage({ ...valid, data: { ...valid.data, bindingId: 'c'.repeat(48) } }, 'chrome-extension://askme-id', overlay.iframe.contentWindow, bindingId, 1), false);
  assert.equal(api.validOverlayViewMessage({ ...valid, data: { ...valid.data, generation: 2 } }, 'chrome-extension://askme-id', overlay.iframe.contentWindow, bindingId, 1), false);
});

test('截图总控件完成握手后把当前可见页直接加入问答会话', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  overlay.iframe.emit('load');
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: overlay.iframe.contentWindow, data: { type: 'ASKME_EMBEDDED_READY', bindingId: 'b'.repeat(48), generation: 1 } });
  fixture.confirmReady();
  await overlay.captureVisible();
  assert.equal(overlay.root.hidden, false);
  assert.equal(overlay.preview.hidden, true);
  assert.equal(overlay.previewImage.src, 'data:image/png;base64,ZmFrZQ==');
  assert.equal(overlay.previewDownload.href, 'data:image/png;base64,ZmFrZQ==');
  assert.equal(fixture.frameMessages.at(-1).message.type, 'ASKME_ATTACH_SCREENSHOT');
  assert.equal(fixture.frameMessages.at(-1).message.dataUrl, 'data:image/png;base64,ZmFrZQ==');
  assert.equal(fixture.frameMessages.at(-1).message.generation, 1);
  assert.equal(overlay.host.__askmeOverlayController, undefined);
});

test('运行时同步抛出 context invalidated 时转为可恢复结果，浮层不产生未处理异常', async () => {
  const direct = await api.safeRuntimeSend({ sendMessage() { throw new Error('Extension context invalidated.'); } }, { type: 'PING' });
  assert.equal(direct.ok, false);
  assert.match(direct.error, /刷新当前 Moodle 页面/);
  const fixture = overlayFixture({ runtimeThrow: true });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  assert.match(overlay.fallbackText.textContent, /刷新/);
  await overlay.captureVisible();
  assert.equal(overlay.root.hidden, false);
  assert.notEqual(overlay.buttons.get('capture').disabled, true);
  assert.match(overlay.railStatusText.textContent, /刷新当前 Moodle 页面/);
});

test('错误提示可手动关闭，截图失败后恢复按钮状态', async () => {
  const fixture = overlayFixture({ captureError: 'CAPTURE_FAILED' });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  overlay.iframe.emit('load');
  fixture.win.emit('message', { origin: fixture.frameMessages.at(-1).origin, source: overlay.iframe.contentWindow, data: { type: 'ASKME_EMBEDDED_READY', bindingId: 'b'.repeat(48), generation: 1 } });
  fixture.confirmReady();
  await overlay.captureVisible();
  assert.equal(overlay.buttons.get('capture').disabled, false);
  assert.equal(overlay.railStatus.hidden, false);
  assert.match(overlay.railStatusText.textContent, /CAPTURE_FAILED/);
  overlay.railStatusClose.emit('click');
  assert.equal(overlay.railStatus.hidden, true);
  assert.equal(overlay.railStatusText.textContent, '');
});

test('截图临时隐藏整个 light DOM 控制器，并逐项精确恢复既有可见状态和样式优先级', async () => {
  const fixture = overlayFixture({ captureError: 'CAPTURE_FAILED' });
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  overlay.iframe.emit('load'); fixture.confirmReady();
  overlay.root.style.setProperty('display', 'inline-flex', 'important');
  overlay.panel.style.setProperty('display', 'grid', 'important');
  overlay.preview.hidden = false;
  await overlay.captureVisible();
  assert.equal(overlay.root.hidden, false);
  assert.equal(overlay.root.style.getPropertyValue('display'), 'inline-flex');
  assert.equal(overlay.root.style.getPropertyPriority('display'), 'important');
  assert.equal(overlay.panel.hidden, false);
  assert.equal(overlay.panel.style.getPropertyValue('display'), 'grid');
  assert.equal(overlay.panel.style.getPropertyPriority('display'), 'important');
  assert.equal(overlay.preview.hidden, false);
});

test('QA marker 默认隐藏，只能通过显式测试选项开启并标记当前 content 版本', async () => {
  const normalFixture = overlayFixture();
  const normal = api.mountAskmeOverlay(normalFixture.doc, normalFixture.win, normalFixture.chromeApi);
  const fixture = overlayFixture();
  const qa = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi, { qaMarkers: true });
  await qa.ready;
  assert.equal(qa.qaMarkers.hidden, false);
  assert.equal(qa.qaMarkers.getAttribute('data-askme-qa-marker'), CONTENT_VERSION);
  assert.equal(qa.qaMarkers.getAttribute('aria-hidden'), 'true');
  assert.equal(qa.qaMarkers.children.length, 2);
  assert.equal(normal?.qaMarkers?.hidden, true);
});

test('临时提示到期后自动消失', async () => {
  const fixture = overlayFixture();
  const overlay = api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi);
  await overlay.ready;
  overlay.showRailStatus('临时提示', false, 1);
  assert.equal(overlay.railStatus.hidden, false);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(overlay.railStatus.hidden, true);
  assert.equal(overlay.railStatusText.textContent, '');
});

test('浮层不在 Moodle 子框架内注入', () => {
  const fixture = overlayFixture(); fixture.win.top = {};
  assert.equal(api.mountAskmeOverlay(fixture.doc, fixture.win, fixture.chromeApi), null);
  assert.equal(fixture.root.children.length, 0);
});

function anchor(href, text, section = '') {
  return {
    textContent: text,
    getAttribute(name) { return name === 'href' ? href : null; },
    closest(selector) {
      if (selector.includes('course-section')) return section ? { querySelector: () => ({ textContent: section }) } : null;
      return null;
    }
  };
}

function courseTextNode(value) {
  return { nodeType: 3, nodeValue: value, textContent: value };
}

function courseElement(attributes = {}, childNodes = []) {
  return {
    nodeType: 1,
    childNodes,
    className: attributes.class || '',
    hidden: attributes.hidden === true,
    get textContent() { return childNodes.map(child => child.textContent || '').join(''); },
    getAttribute(name) { return attributes[name] ?? null; },
    hasAttribute(name) { return Object.hasOwn(attributes, name); }
  };
}

function moodleCourseAnchor(href, childNodes, attributes = {}) {
  return {
    nodeType: 1,
    childNodes,
    get textContent() { return childNodes.map(child => child.textContent || '').join(''); },
    getAttribute(name) { return name === 'href' ? href : (attributes[name] ?? null); },
    closest(selector) { return selector.includes('block_myoverview') ? {} : null; }
  };
}

test('课程标题忽略 Moodle 收藏辅助文字并保留真实课程名', () => {
  const favourite = courseElement({ 'data-region': 'favourite-icon' }, [
    courseElement({ class: 'sr-only' }, [courseTextNode('Course is starred')])
  ]);
  const anchor = moodleCourseAnchor('/course/view.php?id=9820', [favourite, courseTextNode('GSOE9820 - Engineering Project Management - 2026 T3')]);
  assert.equal(api.courseAnchorTitle(anchor), 'GSOE9820 - Engineering Project Management - 2026 T3');
});

test('旧 Moodle 把收藏状态拼入 aria-label 时只移除明确前缀', () => {
  const polluted = moodleCourseAnchor('/course/view.php?id=9543', [], { 'aria-label': 'Course is not starred MANF9543 - Computer Aided Design' });
  assert.equal(api.courseAnchorTitle(polluted), 'MANF9543 - Computer Aided Design');
  const legitimate = moodleCourseAnchor('/course/view.php?id=1', [courseTextNode('Starred Methods in Engineering')]);
  assert.equal(api.courseAnchorTitle(legitimate), 'Starred Methods in Engineering');
});

function eventItem(attributes, links, textContent = '') {
  return {
    textContent,
    getAttribute(name) { return name === 'data-course-id' ? (attributes[name] ?? '12') : (attributes[name] ?? null); },
    querySelectorAll(selector) { return selector === 'a[href]' ? links : []; }
  };
}

test('即将发生事项只用 day 链接 Unix 秒并输出稳定字段', () => {
  const item = eventItem({
    'data-event-id': '8801',
    'data-event-component': 'mod_assign',
    'data-event-type': 'due',
    'data-event-title': '26T3 Assignment Task 1 - Submission is due'
  }, [
    anchor('/mod/assign/view.php?id=456&action=editsubmission', '26T3 Assignment Task 1 - Submission is due'),
    anchor('/calendar/view.php?view=day&time=1790114400', 'Friday, 25 September 2026 04:00')
  ], 'Friday, 25 September 2026 04:00 26T3 Assignment Task 1 - Submission is due.');
  const doc = { querySelectorAll: () => [item] };
  const events = api.extractUpcomingEvents(doc, { id: '12', title: 'MANF9543', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=12' });
  assert.equal(events.length, 1);
  const event = JSON.parse(JSON.stringify(events[0]));
  assert.equal(event.id, 'moodle:12:8801');
  assert.equal(event.courseId, '12');
  assert.equal(event.title, '26T3 Assignment Task 1 - Submission is due');
  assert.equal(event.component, 'mod_assign');
  assert.equal(event.eventType, 'due');
  assert.equal(event.timestampMs, 1790114400000);
  assert.equal(event.courseTitle, 'MANF9543');
  assert.equal(event.courseUrl, 'https://moodle.telt.unsw.edu.au/course/view.php?id=12');
  assert.equal(event.activityUrl, 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=456');
  assert.equal(event.evidence.schemaVersion, 1);
  assert.equal(event.evidence.normalizedText, 'Friday, 25 September 2026 04:00 26T3 Assignment Task 1 - Submission is due.');
  assert.equal(event.evidence.verbatim, true);
  assert.equal(event.evidence.title.source, 'data-event-title');
  assert.equal(event.evidence.dateTime.source, 'day-anchor-text');
  assert.equal('derivedDateTime' in event.evidence, false);
  assert.match(event.sourceVersion, /^[0-9a-f]+:\d+$/u);
  assert.equal(api.extractUpcomingEvents(doc, { id: '12', title: 'MANF9543', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=12' })[0].sourceVersion, event.sourceVersion);
});

test('真实 upcoming 结构可从唯一 Add submission 链接恢复 GSOE9820 截止事件', () => {
  const item = eventItem({
    class: 'block event',
    'data-course-id': '101609',
    'data-event-id': '982001',
    'data-event-component': 'mod_assign',
    'data-event-eventtype': 'due',
    'data-event-title': '26T3 Assignment Task 1 - Submission is due'
  }, [
    anchor('/calendar/view.php?view=day&time=1790924400', 'Friday, 2 October, 5:00 PM'),
    anchor('/mod/assign/view.php?id=456&action=editsubmission', 'Add submission')
  ], 'Friday, 2 October, 5:00 PM 26T3 Assignment Task 1 - Submission is due Add submission');
  const upcomingHtml = { querySelectorAll(selector) {
    assert.equal(selector, '.block.event');
    return selector === '.block.event' && item.getAttribute('class').split(/\s+/u).includes('block') && item.getAttribute('class').split(/\s+/u).includes('event') ? [item] : [];
  } };
  const [event] = api.extractUpcomingEvents(upcomingHtml, {
    id: '101609', title: 'GSOE9820 - Engineering Project Management - 2026 T3',
    url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=101609'
  });
  assert.equal(event.title, '26T3 Assignment Task 1 - Submission is due');
  assert.equal(event.eventType, 'due');
  assert.equal(event.timestampMs, 1790924400000);
  assert.equal(event.activityUrl, 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=456');
  assert.equal(event.evidence.verbatim, true);
  assert.match(event.evidence.normalizedText, /Friday, 2 October, 5:00 PM.*26T3 Assignment Task 1 - Submission is due/u);
});

test('事项只有可信 timestamp 时显式标记派生时间且不伪造逐字原文', () => {
  const item = eventItem({ 'data-event-id': '8802', 'data-event-component': 'mod_assign', 'data-event-type': 'due', 'data-event-title': 'Assignment Task 2' }, [
    anchor('/mod/assign/view.php?id=457', 'Assignment Task 2'),
    anchor('/calendar/view.php?view=day&time=1790114400', '')
  ]);
  const [event] = api.extractUpcomingEvents({ querySelectorAll: () => [item] }, { id: '12', title: 'Course', url: '/course/view.php?id=12' });
  assert.equal(event.evidence.verbatim, false);
  assert.equal(event.evidence.normalizedText, '');
  assert.equal(event.evidence.derivedDateTime.source, 'calendar-day-link-time');
  assert.equal(event.evidence.derivedDateTime.timestampMs, 1790114400000);
  assert.equal(JSON.stringify(event.evidence).includes('is due'), false);
});

test('事项解析忽略展示时间文本、拒绝站外与 javascript 活动链接并去重', () => {
  const validLinks = [
    anchor('/calendar/view.php?view=day&time=1790114400', '这段文本不是日期'),
    anchor('/mod/quiz/view.php?id=77', 'Week 3 quiz')
  ];
  const valid = eventItem({ 'data-event-component': 'mod_quiz', 'data-event-eventtype': 'close' }, validLinks);
  const duplicate = eventItem({ 'data-event-component': 'mod_quiz', 'data-event-eventtype': 'close' }, validLinks);
  const outside = eventItem({}, [
    anchor('/calendar/view.php?view=day&time=1790114500', 'Date'),
    anchor('https://evil.example/mod/assign/view.php?id=3', 'Outside')
  ]);
  const script = eventItem({}, [
    anchor('/calendar/view.php?view=day&time=1790114600', 'Date'),
    anchor('javascript:alert(1)', 'Script')
  ]);
  const badDay = eventItem({}, [
    anchor('/calendar/view.php?view=day&time=tomorrow', 'Date'),
    anchor('/mod/assign/view.php?id=4', 'Bad date')
  ]);
  const doc = { querySelectorAll: () => [valid, duplicate, outside, script, badDay] };
  const events = api.extractUpcomingEvents(doc, { id: '12', title: 'Course', url: '/course/view.php?id=12' });
  assert.equal(events.length, 1);
  assert.equal(events[0].timestampMs, 1790114400000);
  assert.equal(events[0].activityUrl, 'https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=77');
  assert.equal(events[0].eventType, 'close');
});

test('事项解析拒绝带提交参数的活动和非 day 日历链接', () => {
  const unsafe = eventItem({}, [
    anchor('/calendar/view.php?view=day&time=1790114400', 'Date'),
    anchor('/mod/assign/view.php?id=4&submit=1', 'Submit')
  ]);
  const month = eventItem({}, [
    anchor('/calendar/view.php?view=month&time=1790114400', 'Date'),
    anchor('/mod/assign/view.php?id=5', 'Month')
  ]);
  const doc = { querySelectorAll: () => [unsafe, month] };
  assert.equal(api.extractUpcomingEvents(doc, { id: '12', title: 'Course', url: '/course/view.php?id=12' }).length, 0);
});

test('事项解析不会把其他课程的日历事件混入当前课程', () => {
  const otherCourse = eventItem({ 'data-course-id': '99', 'data-event-id': 'other', 'data-event-eventtype': 'due' }, [
    anchor('/calendar/view.php?view=day&time=1790114400', 'Date'),
    anchor('/mod/assign/view.php?id=4', 'Other assignment')
  ]);
  const doc = { querySelectorAll: () => [otherCourse] };
  assert.equal(api.extractUpcomingEvents(doc, { id: '12', title: 'Course', url: '/course/view.php?id=12' }).length, 0);
});

test('课程页 assessment 表格保留明确权重、时长、CLO 与原文证据', () => {
  const makeRow = values => ({ querySelectorAll: () => values.map(textContent => ({ textContent })) });
  const table = {
    querySelectorAll(selector) {
      if (selector !== 'tr') return [];
      return [
        makeRow(['Assessment', 'Issue Date', 'Weighting', 'Length', 'Aligned CLOs', 'Due Date', 'Feedback Date']),
        makeRow(['Quizzes x 2', 'Week 1', '55% (25% Quiz 1 and 30% Quiz 2)', '90 minutes per quiz', 'CLOs 2 & 3', 'Week 4 and 9', '2 weeks after submission']),
        makeRow(['Weekly evaluation', 'Week 4', '15%', '15 mins per week', 'CLOs 1–3', 'Week 7, 8 and 9', '1 week after each evaluation'])
      ];
    },
    closest: () => ({ id: 'section-2' })
  };
  const root = { querySelectorAll: selector => selector === 'table' ? [table] : [] };
  const doc = { querySelector: () => root };
  const result = api.extractAssessmentFacts(doc, { id: '100761', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=100761' });
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'Quizzes x 2');
  assert.equal(result[0].explicitWeight, null);
  assert.equal(result[1].explicitWeight, 15);
  assert.equal(result[1].outcomesText, 'CLOs 1–3');
  assert.match(result[0].evidence, /Weighting: 55%/u);
  assert.equal(result[0].sourceUrl, 'https://moodle.telt.unsw.edu.au/course/view.php?id=100761#section-2');
  assert.equal(result[0].rowOrdinal, 1);
  assert.match(result[0].sourceVersion, /^[0-9a-f]+:\d+$/u);
  assert.equal(result[0].evidenceRef.span.start, 0);
  assert.equal(result[0].evidenceRef.span.end, result[0].evidence.length);
  assert.equal(result[0].evidenceRef.sourceVersion, result[0].sourceVersion);
});

test('assessment 标题中的唯一安全 assignment 链接建立 activity ID 关联', () => {
  const cell = (textContent, href = '') => ({
    textContent, getAttribute: () => null,
    querySelectorAll: selector => selector === 'a[href]' && href ? [anchor(href, textContent)] : []
  });
  const row = cells => ({ querySelectorAll: () => cells });
  const table = {
    querySelectorAll: selector => selector === 'tr' ? [
      row([cell('Assessment'), cell('Weighting')]),
      row([cell('Design Project', '/mod/assign/view.php?id=456'), cell('35%')]),
      row([cell('Unsafe Project', '/mod/assign/view.php?id=457&action=editsubmission'), cell('20%')])
    ] : [], closest: () => null
  };
  const doc = { querySelector: () => ({ querySelectorAll: () => [table] }) };
  const result = api.extractAssessmentSnapshot(doc, { id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' });
  assert.equal(result.items[0].assignmentActivityId, '456');
  assert.equal(result.items[0].briefLinkStatus, 'activity-url');
  assert.equal(result.items[1].assignmentActivityId, '');
  assert.equal(result.items[1].briefLinkStatus, 'ambiguous');
});

test('非 assessment 表格不会被误识别', () => {
  const row = values => ({ querySelectorAll: () => values.map(textContent => ({ textContent })) });
  const table = { querySelectorAll: () => [row(['Week', 'Topic']), row(['1', 'CAD'])], closest: () => null };
  const doc = { querySelector: () => ({ querySelectorAll: () => [table] }) };
  assert.equal(api.extractAssessmentFacts(doc, { id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' }).length, 0);
});

test('复杂合并单元格的 assessment 表不会静默错列', () => {
  const cell = (textContent, attrs = {}) => ({ textContent, ...attrs, getAttribute: name => attrs[name] == null ? null : String(attrs[name]) });
  const row = cells => ({ querySelectorAll: () => cells });
  const table = {
    querySelectorAll: selector => selector === 'tr' ? [
      row([cell('Assessment', { colSpan: 2 }), cell('Weighting')]),
      row([cell('Quiz'), cell('Details'), cell('20%')])
    ] : [],
    closest: () => null
  };
  const doc = { querySelector: () => ({ querySelectorAll: () => [table] }) };
  const result = api.extractAssessmentSnapshot(doc, { id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' });
  assert.equal(result.parseStatus, 'unsupported');
  assert.equal(result.unsupportedTables, 1);
  assert.equal(result.items.length, 0);
});

test('assessment 表异常行会被跳过并明确标记部分解析', () => {
  const row = values => ({ querySelectorAll: () => values.map(textContent => ({ textContent })) });
  const table = {
    querySelectorAll: () => [row(['Assessment', 'Weighting']), row(['Quiz', '20%']), row(['Broken row'])],
    closest: () => null
  };
  const doc = { querySelector: () => ({ querySelectorAll: () => [table] }) };
  const result = api.extractAssessmentSnapshot(doc, { id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' });
  assert.equal(result.parseStatus, 'partial');
  assert.equal(result.malformedRows, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Quiz');
});

test('assessment 行列数相同但字段语义颠倒时失败关闭', () => {
  const row = values => ({ querySelectorAll: () => values.map(textContent => ({ textContent })) });
  const table = { querySelectorAll: () => [row(['Assessment', 'Weighting']), row(['20%', 'Quiz'])], closest: () => null };
  const doc = { querySelector: () => ({ querySelectorAll: () => [table] }) };
  const result = api.extractAssessmentSnapshot(doc, { id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' });
  assert.equal(result.parseStatus, 'unsupported');
  assert.equal(result.malformedRows, 1);
  assert.equal(result.items.length, 0);
});

test('assessment 单元格被长度上限截断时明确标记部分解析', () => {
  const row = values => ({ querySelectorAll: () => values.map(textContent => ({ textContent })) });
  const table = { querySelectorAll: () => [row(['Assessment', 'Weighting']), row([`Design report ${'detail '.repeat(60)}`, '35%'])], closest: () => null };
  const doc = { querySelector: () => ({ querySelectorAll: () => [table] }) };
  const result = api.extractAssessmentSnapshot(doc, { id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' });
  assert.equal(result.parseStatus, 'partial');
  assert.equal(result.truncatedCells, 1);
  assert.equal(result.items.length, 1);
});

test('没有 assessment 表时返回 not-found 而不是伪造空成功', () => {
  const doc = { querySelector: () => ({ querySelectorAll: () => [] }) };
  const result = api.extractAssessmentSnapshot(doc, { id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' });
  assert.equal(result.parseStatus, 'not-found');
  assert.equal(result.recognizedTables, 0);
  assert.equal(result.items.length, 0);
});

test('assessment 条目超过上限时保留前三十项并标记截断', () => {
  const row = values => ({ querySelectorAll: () => values.map(textContent => ({ textContent })) });
  const table = {
    querySelectorAll: () => [row(['Assessment', 'Weighting']), ...Array.from({ length: 31 }, (_, index) => row([`Task ${index + 1}`, '1%']))],
    closest: () => null
  };
  const doc = { querySelector: () => ({ querySelectorAll: () => [table] }) };
  const result = api.extractAssessmentSnapshot(doc, { id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' });
  assert.equal(result.parseStatus, 'partial');
  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 30);
});

test('同源课程地址被规范化，站外地址和无效 ID 被拒绝', () => {
  assert.equal(api.courseUrl('/course/view.php?id=123&section=2').url, 'https://moodle.telt.unsw.edu.au/course/view.php?id=123');
  assert.equal(api.courseUrl('https://evil.example/course/view.php?id=123'), null);
  assert.equal(api.courseUrl('/course/view.php?id=abc'), null);
  assert.equal(api.normaliseUrl('https://moodle.telt.unsw.edu.au.evil.example/'), null);
});

test('作业说明地址只接受无附加参数的 HTTPS assignment view', () => {
  assert.equal(api.assignmentBriefUrl('https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=123')?.href,
    'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=123');
  assert.equal(api.assignmentBriefUrl('/mod/assign/view.php?id=7#intro')?.href,
    'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=7');
  for (const value of [
    'http://moodle.telt.unsw.edu.au/mod/assign/view.php?id=7',
    'https://evil.example/mod/assign/view.php?id=7',
    'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=7&action=editsubmission',
    'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=7&attempt=1',
    'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=7&id=8',
    'https://user@moodle.telt.unsw.edu.au/mod/assign/view.php?id=7'
  ]) assert.equal(api.assignmentBriefUrl(value), null);
});

function briefFixture({ sensitive = false, long = false } = {}) {
  const child = {
    tagName: 'P', textContent: long ? 'x'.repeat(1501) : 'Submit one CAD model and a 1200-word design justification.',
    parentElement: { closest: () => null }, querySelectorAll: () => [], closest: () => null
  };
  const root = {
    closest: selector => selector === '#region-main' || selector === '.activity-description' ? root : null,
    querySelector: () => sensitive ? { tagName: 'FORM' } : null,
    querySelectorAll: selector => selector === '*' ? [] : [child]
  };
  const breadcrumb = { getAttribute: name => name === 'href' ? '/course/view.php?id=77' : null };
  return {
    root,
    doc: {
      body: { id: 'page-mod-assign-view' }, title: 'Assignment 1',
      querySelectorAll: selector => selector === '#region-main .activity-description #intro' ? [root] : [breadcrumb],
      querySelector: () => ({ textContent: 'Assignment 1' })
    }
  };
}

test('作业说明只读取唯一 intro 并生成可回查的结构化完整版本', () => {
  const { doc } = briefFixture();
  const result = api.extractAssignmentBrief(doc, 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=91', '77', { section: 'Assessment', title: 'Assignment 1' });
  assert.equal(result.status, 'complete');
  assert.equal(result.brief.courseId, '77');
  assert.equal(result.brief.activityId, '91');
  assert.equal(result.brief.blocks.length, 1);
  assert.match(result.brief.blocks[0].text, /CAD model/u);
  assert.deepEqual([result.brief.blocks[0].charStart, result.brief.blocks[0].charEnd], [0, result.brief.blocks[0].text.length]);
  assert.match(result.brief.sourceVersion, /^[0-9a-f]+:\d+$/u);
});

test('作业说明遇到提交表单或超长内容时整项失败关闭且不泄露正文', () => {
  const sensitive = briefFixture({ sensitive: true });
  const secret = 'STUDENT_PRIVATE_SUBMISSION_CANARY';
  sensitive.root.querySelectorAll = selector => selector === '*' ? [{ getAttribute: name => name === 'name' ? `submission-${secret}` : '' }] : [];
  const first = api.extractAssignmentBrief(sensitive.doc, 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=91', '77');
  assert.equal(first.status, 'unsupported');
  assert.equal(JSON.stringify(first).includes(secret), false);
  const oversized = briefFixture({ long: true });
  const second = api.extractAssignmentBrief(oversized.doc, 'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=91', '77');
  assert.equal(second.status, 'truncated');
  assert.equal(Object.hasOwn(second, 'brief'), false);
});

test('当前账号只接受唯一的同源数字用户资料链接', () => {
  const accountDoc = links => ({
    location: { href: 'https://moodle.telt.unsw.edu.au/my/' },
    querySelectorAll: () => links
  });
  assert.equal(api.currentAccount(accountDoc([
    anchor('/user/profile.php?id=12345', 'Profile'),
    anchor('https://moodle.telt.unsw.edu.au/user/profile.php?id=12345', 'Same profile')
  ])), '12345');
  assert.throws(() => api.currentAccount(accountDoc([anchor('https://evil.example/user/profile.php?id=12345', 'Outside')])), /无法确认当前 Moodle 账号/);
  assert.throws(() => api.currentAccount(accountDoc([anchor('/user/profile.php', 'Missing id')])), /无法确认当前 Moodle 账号/);
  assert.throws(() => api.currentAccount(accountDoc([
    anchor('/user/profile.php?id=12345', 'First account'),
    anchor('/user/profile.php?id=67890', 'Second account')
  ])), /无法确认当前 Moodle 账号/);
});

test('Moodle 登录过期和访客错误页即使 HTTP 200 也失败关闭', () => {
  const node = textContent => ({ textContent });
  const login = {
    body: { id: 'page-login-index', className: 'notloggedin' },
    querySelector: selector => selector.includes('form#login') ? node('Login') : null,
    querySelectorAll: () => []
  };
  assert.deepEqual(JSON.parse(JSON.stringify(api.classifyMoodleDocument(login))), {
    ok: false, reasonCode: 'login-required', message: 'Moodle 登录已过期'
  });
  const guest = {
    body: { id: 'page-course-view', className: 'notloggedin' },
    querySelector: () => null,
    querySelectorAll: selector => selector.includes('alert-danger') ? [node('Guest access. Course or activity not accessible.')] : []
  };
  assert.equal(api.classifyMoodleDocument(guest).ok, false);
  assert.equal(api.classifyMoodleDocument(guest).reasonCode, 'login-required');
  assert.throws(() => api.currentAccount(guest), /登录已过期/u);
  const denied = {
    body: { id: 'page-course-view', className: 'loggedin' }, querySelector: () => null,
    querySelectorAll: selector => selector.includes('alert-danger') ? [node('Course or activity not accessible.')] : []
  };
  assert.equal(api.classifyMoodleDocument(denied).reasonCode, 'access-denied');
  const alternateTemplate = {
    title: 'Error | UNSW', body: { id: 'page-course-view', className: 'loggedin' },
    querySelector: selector => selector.includes('#region-main') ? node('You do not have permission to access this course or activity. '.repeat(3)) : selector.includes('h1') ? node('Error') : null,
    querySelectorAll: () => []
  };
  assert.equal(api.classifyMoodleDocument(alternateTemplate).reasonCode, 'access-denied');
  const hiddenActivity = {
    title: 'MANF9543 | UNSW', body: { id: 'page-mod-folder-view', className: 'loggedin' },
    querySelector: selector => selector.includes('#region-main') ? node('Sorry, this activity is currently hidden') : null,
    querySelectorAll: () => []
  };
  assert.equal(api.classifyMoodleDocument(hiddenActivity).reasonCode, 'access-denied');
});

test('当前页讲解只提取课程首页和 Page Book Folder 静态正文', () => {
  const doc = {
    title: 'Week 3',
    querySelector(selector) {
      if (selector.includes('#region-main')) return { innerText: 'Core concept and worked example '.repeat(8) };
      if (selector.includes('h1')) return { textContent: 'Week 3 manufacturing concepts' };
      return null;
    }
  };
  for (const url of [
    'https://moodle.telt.unsw.edu.au/course/view.php?id=12&section=3',
    'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7',
    'https://moodle.telt.unsw.edu.au/mod/book/view.php?id=8&chapterid=9',
    'https://moodle.telt.unsw.edu.au/mod/folder/view.php?id=10'
  ]) {
    const source = api.currentStaticPageSource(doc, url);
    assert.equal(source.url, url);
    assert.match(source.excerpt, /Core concept/);
  }
});

test('当前页讲解明确拒绝测验作业论坛和带交互参数的静态页', () => {
  const doc = { title: 'Unsafe', querySelector: () => ({ innerText: 'Readable text '.repeat(10), textContent: 'Unsafe' }) };
  for (const url of [
    'https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=7',
    'https://moodle.telt.unsw.edu.au/mod/assign/view.php?id=7',
    'https://moodle.telt.unsw.edu.au/mod/forum/view.php?id=7',
    'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7&action=submit',
    'https://moodle.telt.unsw.edu.au/course/view.php?id=12&edit=on'
  ]) assert.throws(() => api.currentStaticPageSource(doc, url), /只支持|交互参数/);
});

test('仪表板发现课程时去重且不接受站外仿冒链接', () => {
  const links = [
    anchor('/course/view.php?id=12', '课程 A'),
    anchor('/course/view.php?id=12&section=2', '课程 A 完整名称'),
    anchor('https://evil.example/course/view.php?id=13', '仿冒课程')
  ];
  const doc = { querySelectorAll: () => links, querySelector: () => null };
  const found = api.discover(doc, 'https://moodle.telt.unsw.edu.au/my/');
  assert.equal(found.length, 1);
  assert.equal(found[0].title, '课程 A 完整名称');
});

test('结构化正文保留标题、列表和表格行，供分片与证据定位使用', () => {
  const element = (tagName, textContent, extra = {}) => ({ tagName, textContent, parentElement: null, ...extra });
  const heading = element('H3', 'Learning outcomes');
  const paragraph = element('P', 'Students can explain design intent.');
  const item = element('LI', 'Apply constraints to a new model.', { cloneNode: () => ({ textContent: 'Apply constraints to a new model.', querySelectorAll: () => [] }) });
  const row = element('TR', '', { querySelectorAll: () => [{ textContent: 'Assessment' }, { textContent: 'Weighting' }, { textContent: '15%' }] });
  const root = { querySelectorAll: () => [heading, paragraph, item, row], textContent: 'flattened fallback' };
  assert.equal(api.structuredText(root), '### Learning outcomes\nStudents can explain design intent.\n- Apply constraints to a new model.\n| Assessment | Weighting | 15% |');
});

test('结构化正文保留直属文本和嵌套列表，不去重合法重复项并过滤隐藏噪声', () => {
  const text = value => ({ nodeType: 3, nodeValue: value, textContent: value });
  const element = (tagName, children = [], attrs = {}) => ({
    nodeType: 1, tagName: tagName.toUpperCase(), childNodes: children, hidden: attrs.hidden === true,
    getAttribute(name) { return attrs[name] ?? null; }
  });
  const root = element('div', [
    text('Intro note'),
    element('p', [text('A precise explanation.')]),
    element('ul', [
      element('li', [text('Parent item'), element('ul', [element('li', [text('Nested item')])])]),
      element('li', [text('Repeated item')]),
      element('li', [text('Repeated item')])
    ]),
    element('table', [element('tr', [element('th', [text('Assessment')]), element('td', [text('20%')])])]),
    element('p', [text('Hidden content')], { hidden: true }),
    element('nav', [text('Navigation noise')])
  ]);
  assert.equal(api.structuredText(root), 'Intro note\nA precise explanation.\n- Parent item\n- Nested item\n- Repeated item\n- Repeated item\n| Assessment | 20% |');
  assert.equal(api.structuredText(root, 12), 'Intro note\nA');
});

test('提取仅索引静态活动；文件、外部工具只保存链接；正文报告截断', () => {
  const links = [
    anchor('/mod/page/view.php?id=1', 'Week page', 'Week 1'),
    anchor('/mod/resource/view.php?id=2', 'Lecture PDF', 'Week 1'),
    anchor('/mod/url/view.php?id=3', 'External reference', 'Week 1'),
    anchor('/mod/quiz/view.php?id=4', 'Quiz', 'Week 1'),
    anchor('https://evil.example/file.pdf', 'Outside', 'Week 1')
  ];
  const clone = { textContent: '知识'.repeat(5000), querySelectorAll: () => [] };
  const root = { cloneNode: () => clone, querySelectorAll: () => links };
  const doc = { body: root, title: 'Test', querySelector: selector => selector === '#region-main' ? root : selector.includes('h1') ? { textContent: 'Test' } : null };
  const page = api.extractPage(doc, 'https://moodle.telt.unsw.edu.au/course/view.php?id=12', '12');
  assert.equal(page.text.length, 8000);
  assert.equal(page.textTruncated, true);
  assert.equal(page.links.length, 3);
  assert.deepEqual(Array.from(page.links, x => x.type), ['activity', 'file', 'reference']);
  assert.equal(page.links[0].section, 'Week 1');
});

test('课程页面不收录带操作参数的静态活动链接', () => {
  const links = [
    anchor('/mod/book/view.php?id=7&chapterid=2', 'Book chapter'),
    anchor('/mod/page/view.php?id=7&action=delete', 'Delete page'),
    anchor('/mod/folder/view.php?id=8&SeSsKeY=secret', 'Session action'),
    anchor('/mod/page/view.php?id=9&submit=1', 'Submit')
  ];
  const clone = { textContent: 'Course', querySelectorAll: () => [] };
  const root = { cloneNode: () => clone, querySelectorAll: () => links };
  const doc = { body: root, title: 'Course', querySelector: selector => selector === '#region-main' ? root : null };
  const page = api.extractPage(doc, 'https://moodle.telt.unsw.edu.au/course/view.php?id=12', '12');
  assert.equal(page.links.length, 1);
  assert.match(page.links[0].url, /chapterid=2/);
});

test('课程首页按章节切分，保留后面的周次和对应锚点', () => {
  const section = (id, title, text) => ({
    id,
    querySelector: () => ({ textContent: title }),
    cloneNode: () => ({ textContent: text, querySelectorAll: () => [] })
  });
  const root = { querySelectorAll: () => [section('section-0', 'Quick Links', 'A'.repeat(8000)), section('section-5', 'Week 3', 'Risk and budget planning')] };
  const doc = { querySelector: selector => selector === '#region-main' ? root : null };
  const result = api.extractCourseSections(doc, 'https://moodle.telt.unsw.edu.au/course/view.php?id=12', '12');
  assert.equal(result.pages.length, 3);
  assert.equal(result.pages[0].text.length, 5000);
  assert.match(result.pages[2].text, /Risk and budget/);
  assert.match(result.pages[2].url, /#section-5$/);
  assert.equal(result.pages[2].sectionGroup, 'Week 3');
  assert.equal(result.skippedParts, 0);
});

test('首页超过索引上限时报告未收录片段', () => {
  const section = { id: 'section-2', querySelector: () => ({ textContent: 'Assessment' }), cloneNode: () => ({ textContent: 'A'.repeat(205000), querySelectorAll: () => [] }) };
  const doc = { querySelector: () => ({ querySelectorAll: () => [section] }) };
  const result = api.extractCourseSections(doc, 'https://moodle.telt.unsw.edu.au/course/view.php?id=12', '12');
  assert.equal(result.pages.length, 40);
  assert.equal(result.skippedParts, 1);
});

test('静态页跳转到测验时拒绝读取，跨课程活动拒绝入库', async () => {
  await assert.rejects(api.getHtml('https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7'), /页面跳转/);
  const doc = { querySelectorAll: () => [anchor('/course/view.php?id=99', '其他课程')] };
  assert.throws(() => api.verifyActivityCourse(doc, 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7', '12'), /无法确认活动/);
});

test('活动被 Moodle 跳回原课程首页时记录为暂不可访问', async () => {
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, AbortController });
  vm.runInContext(source, context);
  vm.runInContext(`
    getHtml = async url => {
      if (url.includes('/course/')) return { doc: {}, url };
      const error = new Error('页面跳转到了其他课程或活动');
      error.code = 'ACTIVITY_RETURNED_TO_COURSE'; error.courseId = '12';
      throw error;
    };
    extractPage = (_doc, url, courseId) => ({ url, courseId, title: 'Course', text: 'Course text', links: url.includes('/course/') ? [{ title: 'Future folder', url: 'https://moodle.telt.unsw.edu.au/mod/folder/view.php?id=7', type: 'activity', section: 'Week 7' }] : [], textTruncated: false });
    globalThis.runSync = syncCourse;
  `, context);
  const result = await context.runSync({ id: '12', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=12' });
  assert.equal(result.errors.length, 0);
  assert.equal(result.unavailableActivities.length, 1);
  assert.equal(result.unavailableActivities[0].title, 'Future folder');
});

test('单个静态活动重试返回页面与文件，并拒绝站外和非静态活动', async () => {
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, AbortController });
  vm.runInContext(source, context);
  vm.runInContext(`
    getHtml = async url => ({ doc: {}, url });
    verifyActivityCourse = (_doc, _url, courseId) => { if (courseId !== '12') throw new Error('无法确认活动属于所选课程'); };
    extractPage = (_doc, url, courseId, section) => ({ url, courseId, section, title: 'Week 1', text: '课程内容', links: [
      { type: 'file', url: 'https://moodle.telt.unsw.edu.au/pluginfile.php/1/lecture.pdf', title: 'Lecture' },
      { type: 'activity', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=8', title: 'Next' }
    ] });
    globalThis.runRetry = retryActivity;
  `, context);
  const activity = { url: 'https://moodle.telt.unsw.edu.au/mod/book/view.php?id=7&chapterid=2', title: 'Book', section: 'Week 1' };
  const result = await context.runRetry('12', activity);
  assert.equal(result.status, 'ok');
  assert.equal(result.page.section, 'Week 1');
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].type, 'file');
  await assert.rejects(context.runRetry('99', activity), /无法确认活动/);
  await assert.rejects(context.runRetry('12', { ...activity, url: 'https://evil.example/mod/page/view.php?id=7' }), /静态活动地址无效/);
  await assert.rejects(context.runRetry('12', { ...activity, url: 'https://moodle.telt.unsw.edu.au/mod/quiz/view.php?id=7' }), /静态活动地址无效/);
  await assert.rejects(context.runRetry('12', { ...activity, url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7&action=delete' }), /静态活动地址无效/);
  await assert.rejects(context.runRetry('12', { ...activity, url: 'https://moodle.telt.unsw.edu.au/mod/book/view.php?id=7&sesskey=secret' }), /静态活动地址无效/);
  await assert.rejects(context.runRetry('12', { ...activity, title: 'A'.repeat(181) }), /活动信息无效/);
});

test('单个活动重试将原课程跳转分类为暂不可访问，其他失败继续报错', async () => {
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, AbortController });
  vm.runInContext(source, context);
  vm.runInContext(`
    getHtml = async () => {
      const error = new Error('页面跳转');
      error.code = 'ACTIVITY_RETURNED_TO_COURSE'; error.courseId = '12';
      throw error;
    };
    globalThis.runRetry = retryActivity;
  `, context);
  const activity = { url: 'https://moodle.telt.unsw.edu.au/mod/folder/view.php?id=7', title: 'Folder', section: 'Week 7' };
  const result = await context.runRetry('12', activity);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.item.title, 'Folder');
  assert.match(result.item.reason, /跳回课程首页/);
  await assert.rejects(context.runRetry('13', activity), /页面跳转/);
});

test('隐藏活动的权限拒绝归类为暂不可访问而不是同步失败', async () => {
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, AbortController });
  vm.runInContext(source, context);
  vm.runInContext(`
    getHtml = async url => {
      if (url.includes('/course/')) return { doc: {}, url };
      const error = new Error('Moodle 当前不允许访问此课程或活动');
      error.code = 'MOODLE_ACCESS_DENIED';
      throw error;
    };
    extractPage = (_doc, url, courseId) => ({ url, courseId, title: 'Course', text: 'Course text', links: url.includes('/course/') ? [
      { title: 'Hidden folder', url: 'https://moodle.telt.unsw.edu.au/mod/folder/view.php?id=7', type: 'activity', section: 'Week 4' }
    ] : [], textTruncated: false });
    globalThis.runSync = syncCourse;
    globalThis.runRetry = retryActivity;
  `, context);
  const synced = await context.runSync({ id: '12', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=12' });
  assert.equal(synced.errors.length, 0);
  assert.equal(synced.failedActivities.length, 0);
  assert.equal(synced.unavailableActivities.length, 1);
  assert.match(synced.unavailableActivities[0].reason, /不允许访问/u);
  const retried = await context.runRetry('12', { url: 'https://moodle.telt.unsw.edu.au/mod/folder/view.php?id=7', title: 'Hidden folder', section: 'Week 4' });
  assert.equal(retried.status, 'unavailable');
  assert.match(retried.item.reason, /不允许访问/u);
});

test('整课同步保留字符串错误并附带可重试的失败活动', async () => {
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, AbortController });
  vm.runInContext(source, context);
  vm.runInContext(`
    getHtml = async url => {
      if (url.includes('/course/')) return { doc: {}, url };
      throw new Error('HTTP 503');
    };
    extractPage = (_doc, url, courseId) => ({ url, courseId, title: 'Course', text: 'Course text', links: url.includes('/course/') ? [
      { title: 'Future page', url: 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7', type: 'activity', section: 'Week 7' }
    ] : [], textTruncated: false });
    globalThis.runSync = syncCourse;
  `, context);
  const result = await context.runSync({ id: '12', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=12' });
  assert.equal(result.errors[0], 'Future page: HTTP 503');
  assert.equal(result.failedActivities.length, 1);
  assert.equal(result.failedActivities[0].url, 'https://moodle.telt.unsw.edu.au/mod/page/view.php?id=7');
  assert.equal(result.failedActivities[0].section, 'Week 7');
  assert.equal(result.failedActivities[0].error, 'HTTP 503');
});

test('HTML 读取标识活动跳回课程的最终地址', async () => {
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, AbortController, fetch: async () => ({ ok: true, url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=12', headers: { get: () => 'text/html' } }) });
  vm.runInContext(source + '\nglobalThis.readHtml = getHtml;', context);
  await assert.rejects(context.readHtml('https://moodle.telt.unsw.edu.au/mod/folder/view.php?id=7'), error => error.code === 'ACTIVITY_RETURNED_TO_COURSE' && error.courseId === '12');
});

test('同步会继续读取 Book 页面里链接的静态章节并去重', async () => {
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, AbortController });
  vm.runInContext(source, context);
  vm.runInContext(`
    getHtml = async url => ({ doc: {}, url });
    verifyActivityCourse = () => {};
    extractPage = (_doc, url, courseId) => {
      const root = url.includes('/course/');
      const chapter = url.includes('chapterid=2');
      const next = root ? '/mod/book/view.php?id=7' : chapter ? null : '/mod/book/view.php?id=7&chapterid=2';
      return { url, courseId, title: 'Book', text: 'chapter text', links: next ? [{ url: 'https://moodle.telt.unsw.edu.au' + next, type: 'activity', title: 'Next' }] : [], textTruncated: false };
    };
    globalThis.runSync = syncCourse;
  `, context);
  const result = await context.runSync({ id: '1', url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1' });
  assert.equal(result.pages.length, 3);
  assert.equal(result.skippedPages, 0);
});

test('文件读取拒绝站外地址和超过上限的课件', async () => {
  const context = vm.createContext({
    URL, Date, setTimeout, clearTimeout, AbortController,
    fetch: async url => ({ ok: true, url, headers: { get: key => key === 'content-type' ? 'application/pdf' : '20000001' } })
  });
  vm.runInContext(source + '\nglobalThis.readFile = fetchFile;', context);
  await assert.rejects(context.readFile({ url: 'https://evil.example/lecture.pdf' }), /不支持此文件地址/);
  await assert.rejects(context.readFile({ url: 'https://moodle.telt.unsw.edu.au/pluginfile.php/1/lecture.pdf' }), /20 MB/);
});
