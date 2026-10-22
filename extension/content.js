/* 只读取当前登录用户可访问的 Moodle 静态课程资料；作业说明使用独立的只读、失败关闭通道。 */
const ROOT = 'https://moodle.telt.unsw.edu.au';
const CONTENT_VERSION = '2026.10.04.3';
const COURSE_PATH = /^\/course\/view\.php$/;
const ACTIVITY_PATH = /^\/mod\/([^/]+)\/view\.php$/;
const FILE_PATH = /^\/pluginfile\.php\//;
const READABLE_MODULES = new Set(['page', 'book', 'folder']);
const REFERENCE_MODULES = new Set(['url', 'lti']);
const PAGE_TEXT_LIMIT = 8000;
const COURSE_PART_LIMIT = 5000;
const MAX_COURSE_PARTS = 40;
const MAX_HTML_BYTES = 3_000_000;
const MAX_PAGES = 80;
const MAX_FILE_BYTES = 20_000_000;
const MAX_ASSIGNMENT_BRIEFS = 30;
const ASSIGNMENT_BRIEF_TEXT_LIMIT = 12_000;
const ASSIGNMENT_BRIEF_BLOCK_LIMIT = 80;
const ASSIGNMENT_BRIEF_BLOCK_TEXT_LIMIT = 1_500;
const ASSIGNMENT_BRIEF_EXTRACTOR_VERSION = 1;
const ASSESSMENT_EXTRACTOR_VERSION = 1;
const OVERLAY_HOST_ID = 'askme-moodle-overlay-host';
const OVERLAY_ROOT_ID = 'askme-moodle-overlay-root';
const OVERLAY_PANEL_ID = 'askme-moodle-panel-shell';
const OVERLAY_IFRAME_ID = 'askme-moodle-panel-frame';
const OVERLAY_UI_KEY = 'askme:v1:ui:overlay';
const OVERLAY_VIEWS = new Set(['home', 'courses', 'ask', 'review']);
const OVERLAY_DEFAULT_WIDTH = 400;
const OVERLAY_MIN_WIDTH = 320;
const OVERLAY_MAX_WIDTH = 720;
const MOODLE_COURSE_CARD_SELECTOR = '.dashboard-card, .coursebox, .course-summaryitem, [data-region="course-content"][data-course-id]';
const OVERLAY_CONTROLLERS = new WeakMap();
const OVERLAY_ICONS = Object.freeze({
  courses: '',
  ask: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-5L6 20v-3.65a3 3 0 0 1-3-3V8a2.5 2.5 0 0 1 2.5-2.5Z"/><path class="icon-accent" d="m18.5 3 .45 1.15L20 4.6l-1.05.45L18.5 6.2l-.45-1.15L17 4.6l1.05-.45L18.5 3Z"/><path d="M7.5 10h6M7.5 13h4"/></svg>',
  capture: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="icon-accent" d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="2.5"/><circle cx="12" cy="12" r="2.1"/></svg>',
  explain: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H11a2 2 0 0 1 2 2v13a3 3 0 0 0-3-3H4V6.5Z"/><path d="M20 8v8h-6a3 3 0 0 0-1 3V6a2 2 0 0 1 2-2h2"/><path class="icon-accent" d="m19 2 .45 1.1 1.05.45-1.05.45L19 5.1 18.55 4l-1.05-.45 1.05-.45L19 2Z"/></svg>'
});

function runtimeErrorMessage(error) {
  const message = error?.message || String(error || '扩展后台暂时不可用');
  if (/Extension context invalidated/i.test(message)) return '扩展已更新，请刷新当前 Moodle 页面后重试';
  return message.slice(0, 200);
}

function safeRuntimeSend(runtime, message) {
  try {
    return Promise.resolve(runtime?.sendMessage?.(message)).catch(error => ({ ok: false, error: runtimeErrorMessage(error) }));
  } catch (error) {
    return Promise.resolve({ ok: false, error: runtimeErrorMessage(error) });
  }
}

function extensionRuntimeOrigin(chromeApi) {
  const runtimeId = String(chromeApi?.runtime?.id || '');
  if (/^[a-p]{32}$/.test(runtimeId)) return `chrome-extension://${runtimeId}`;
  const rootUrl = String(chromeApi?.runtime?.getURL?.('/') || '');
  const match = rootUrl.match(/^chrome-extension:\/\/([a-p]{32})(?:\/|$)/);
  return match ? `chrome-extension://${match[1]}` : '';
}

function normalizeDiscoveredCourse(course) {
  const id = String(course?.id ?? '');
  const title = cleanText(course?.title);
  const address = courseUrl(course?.url);
  if (!/^\d{1,12}$/.test(id) || !address || address.id !== id || address.url !== course.url || !title || title.length > 180) return null;
  return { id, title, url: address.url };
}

function mountAskmeCourseSyncControls(doc, onSync, win = globalThis) {
  const buttons = [];
  const scan = () => {
    if (typeof doc?.querySelectorAll !== 'function' || typeof onSync !== 'function') return buttons;
    for (const card of doc.querySelectorAll(MOODLE_COURSE_CARD_SELECTOR)) {
      if (!card?.append || card.querySelector?.('[data-askme-course-sync]')) continue;
      let course = null;
      for (const anchor of card.querySelectorAll?.('a[href]') || []) {
        const candidate = courseFromAnchor(anchor, doc.location?.href || ROOT);
        const normalized = normalizeDiscoveredCourse(candidate);
        if (normalized && (!course || normalized.title.length > course.title.length)) course = normalized;
      }
      if (!course) continue;
      // Moodle dashboard 的封面位于卡片顶部。让卡片成为定位容器，可把操作放在
      // 封面左上角，同时避免把 button 塞进封面的课程链接中。
      const inlinePosition = String(card.style?.position || '').trim();
      let computedPosition = '';
      try { computedPosition = String(win?.getComputedStyle?.(card)?.position || '').trim(); }
      catch {}
      if ((!inlinePosition && !computedPosition) || computedPosition === 'static') card.style?.setProperty?.('position', 'relative');
      const host = doc.createElement('span');
      host.setAttribute('data-askme-course-sync', course.id);
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = doc.createElement('style');
      style.textContent = `:host{all:initial;position:absolute;z-index:4;top:8px;left:8px;display:inline-flex;pointer-events:auto;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}button{display:inline-flex;min-height:32px;align-items:center;gap:6px;padding:6px 12px;border:1px solid rgba(255,255,255,.72);border-radius:999px;background:#715df3;color:#fff;box-shadow:0 4px 14px rgba(67,46,169,.28);cursor:pointer;font:750 12px/1.2 inherit}button:hover{border-color:#fff;background:#5f49df;box-shadow:0 6px 18px rgba(67,46,169,.34)}button:focus-visible{outline:3px solid #ffd500;outline-offset:2px}.dot{width:7px;height:7px;border:2px solid rgba(255,255,255,.72);border-radius:50%;background:#bff4de}@media(prefers-reduced-motion:reduce){button{transition:none}}`;
      const button = doc.createElement('button');
      button.type = 'button'; button.setAttribute('aria-label', `用 Askme 同步 ${course.title}`); button.setAttribute('title', '用 Askme 同步这门课程');
      const dot = doc.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
      const label = doc.createElement('span'); label.textContent = 'Sync';
      button.append(dot, label); shadow.append(style, button); card.append(host);
      button.addEventListener('click', event => {
        event?.preventDefault?.(); event?.stopPropagation?.();
        onSync(course);
      });
      buttons.push({ button, host, course });
    }
    return buttons;
  };
  scan();
  const Observer = win?.MutationObserver;
  const observer = typeof Observer === 'function' ? new Observer(() => scan()) : null;
  observer?.observe?.(doc.body || doc.documentElement, { childList: true, subtree: true });
  return { buttons, scan, disconnect: () => observer?.disconnect?.() };
}

function overlayWidthBounds(viewportWidth) {
  const available = Math.max(0, Math.floor(Number(viewportWidth) || 0) - 72);
  const max = Math.min(OVERLAY_MAX_WIDTH, available);
  return { min: Math.min(OVERLAY_MIN_WIDTH, max), max };
}

function isCourseTitleAssistiveNode(node) {
  if (!node || node.nodeType === 3) return false;
  try {
    if (typeof node.matches === 'function' && node.matches('[data-region="favourite-icon"], .sr-only, [aria-hidden="true"], [hidden]')) return true;
  } catch {}
  const getAttribute = typeof node.getAttribute === 'function' ? name => node.getAttribute(name) : () => null;
  const className = typeof node.className === 'string' ? node.className : getAttribute('class') || '';
  return getAttribute('data-region') === 'favourite-icon' ||
    /(?:^|\s)sr-only(?:\s|$)/u.test(className) ||
    getAttribute('aria-hidden') === 'true' ||
    node.hidden === true ||
    (typeof node.hasAttribute === 'function' && node.hasAttribute('hidden'));
}

function visibleCourseAnchorText(anchor) {
  const children = anchor?.childNodes;
  if (!children || typeof children[Symbol.iterator] !== 'function') return '';
  const read = node => {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? '';
    if (node !== anchor && isCourseTitleAssistiveNode(node)) return '';
    const descendants = node.childNodes;
    if (descendants && typeof descendants[Symbol.iterator] === 'function') return [...descendants].map(read).join('');
    return node.textContent || '';
  };
  return cleanText(read(anchor));
}

function cleanCourseTitle(value) {
  return cleanText(value).replace(/^Course is (?:not )?starred\b[\s:|\-\u2013\u2014]*/iu, '').trim();
}

function courseAnchorTitle(anchor) {
  const primary = [anchor?.getAttribute?.('title'), visibleCourseAnchorText(anchor)]
    .map(cleanCourseTitle)
    .filter(title => title && !/^(?:course|课程|view course)$/iu.test(title) && title.length <= 180);
  if (primary.length) return primary.reduce((best, title) => title.length > best.length ? title : best);
  return [anchor?.getAttribute?.('aria-label'), anchor?.textContent]
    .map(cleanCourseTitle)
    .find(title => title && !/^(?:course|课程|view course)$/iu.test(title) && title.length <= 180) || '';
}

function clampOverlayWidth(value, viewportWidth) {
  const { min, max } = overlayWidthBounds(viewportWidth);
  if (max <= 0) return 0;
  const number = Number.isFinite(Number(value)) ? Math.round(Number(value)) : OVERLAY_DEFAULT_WIDTH;
  return Math.min(max, Math.max(min, number));
}

function validOverlayMessageSource(event, iframeWindow) {
  // Chrome may redact MessageEvent.source to null across a web page / chrome-extension boundary.
  // Null is accepted only together with the exact extension origin and the capability-bound
  // message checks performed by each caller below. Missing/undefined and foreign windows fail.
  return !!event && (event.source === iframeWindow || event.source === null);
}

function overlayMessageDiagnostics(event, extensionOrigin, iframeWindow) {
  return {
    origin: event?.origin === extensionOrigin ? 'extension' : event?.origin ? 'other' : 'missing',
    source: event?.source === iframeWindow ? 'iframe' : event?.source === null ? 'null' : event && 'source' in event ? 'other' : 'missing'
  };
}

function validOverlayGeneration(data, generation) {
  return Number.isInteger(generation) && generation > 0 && data?.generation === generation;
}

function validOverlayViewMessage(event, extensionOrigin, iframeWindow, bindingId, generation) {
  return event?.origin === extensionOrigin && validOverlayMessageSource(event, iframeWindow) &&
    event?.data?.type === 'ASKME_EMBEDDED_VIEW' && event.data.bindingId === bindingId &&
    validOverlayGeneration(event.data, generation) &&
    typeof bindingId === 'string' && /^[0-9a-f]{48}$/.test(bindingId) && OVERLAY_VIEWS.has(event.data.view);
}

function validOverlayReadyMessage(event, extensionOrigin, iframeWindow, generation) {
  return event?.origin === extensionOrigin && validOverlayMessageSource(event, iframeWindow) &&
    event?.data?.type === 'ASKME_EMBEDDED_READY' && validOverlayGeneration(event.data, generation) &&
    typeof event.data.bindingId === 'string' && /^[0-9a-f]{48}$/.test(event.data.bindingId);
}

function validOverlayBootMessage(event, extensionOrigin, iframeWindow, generation) {
  return event?.origin === extensionOrigin && validOverlayMessageSource(event, iframeWindow) &&
    event?.data?.type === 'ASKME_EMBEDDED_BOOT' && validOverlayGeneration(event.data, generation);
}

function validOverlayBootErrorMessage(event, extensionOrigin, iframeWindow, generation) {
  return event?.origin === extensionOrigin && validOverlayMessageSource(event, iframeWindow) &&
    event?.data?.type === 'ASKME_EMBEDDED_BOOT_ERROR' && typeof event.data.error === 'string' &&
    event.data.error.length > 0 && event.data.error.length <= 160 && validOverlayGeneration(event.data, generation);
}

function validOverlayActionResultMessage(event, extensionOrigin, iframeWindow, bindingId, generation) {
  return event?.origin === extensionOrigin && validOverlayMessageSource(event, iframeWindow) && event?.data?.type === 'ASKME_HOST_ACTION_RESULT' &&
    event.data.bindingId === bindingId && typeof bindingId === 'string' && /^[0-9a-f]{48}$/.test(bindingId) &&
    validOverlayGeneration(event.data, generation) && event.data.action === 'explain' && typeof event.data.ok === 'boolean' &&
    typeof event.data.message === 'string' && event.data.message.length <= 240;
}

function validOverlayAuthErrorMessage(event, extensionOrigin, iframeWindow, embeddedInit, generation) {
  return event?.origin === extensionOrigin && validOverlayMessageSource(event, iframeWindow) && event?.data?.type === 'ASKME_EMBEDDED_AUTH_ERROR' &&
    typeof embeddedInit?.capability === 'string' && event.data.capability === embeddedInit.capability &&
    event.data.hostDocumentId === embeddedInit.hostDocumentId && validOverlayGeneration(event.data, generation) &&
    typeof event.data.error === 'string' && event.data.error.length <= 160;
}

function validOverlayRenderStateMessage(event, extensionOrigin, iframeWindow, bindingId, generation) {
  const data = event?.data;
  return event?.origin === extensionOrigin && validOverlayMessageSource(event, iframeWindow) &&
    data?.type === 'ASKME_EMBEDDED_RENDER_STATE' && data.bindingId === bindingId &&
    validOverlayGeneration(data, generation) &&
    typeof bindingId === 'string' && /^[0-9a-f]{48}$/.test(bindingId) &&
    ['courses', 'ask', 'review', 'none'].includes(data.view) &&
    ['block', 'flex', 'grid', 'none', 'other'].includes(data.display) &&
    Number.isInteger(data.mainWidth) && data.mainWidth >= 0 && data.mainWidth <= 4000 &&
    Number.isInteger(data.mainHeight) && data.mainHeight >= 0 && data.mainHeight <= 20000 &&
    Number.isInteger(data.textLength) && data.textLength >= 0 && data.textLength <= 100000 &&
    Number.isInteger(data.styleSheets) && data.styleSheets >= 0 && data.styleSheets <= 100 &&
    ['checking', 'ready', 'proxy-auth-rejected', 'offline', 'starting', 'degraded', 'model-missing', 'incompatible'].includes(data.aiState) &&
    typeof data.hasSelectedCourse === 'boolean' &&
    Number.isInteger(data.courseCount) && data.courseCount >= 0 && data.courseCount <= 1000;
}

function mountAskmeOverlay(doc = document, win = window, chromeApi = chrome, options = {}) {
  if (!doc?.documentElement || win.top !== win.self || !chromeApi?.runtime?.getURL || typeof chromeApi?.runtime?.sendMessage !== 'function') return null;
  const extensionOrigin = extensionRuntimeOrigin(chromeApi);
  if (!extensionOrigin) return null;
  const existingRoot = doc.getElementById?.(OVERLAY_ROOT_ID);
  if (existingRoot) return OVERLAY_CONTROLLERS.get(existingRoot) || null;

  const root = doc.createElement('div');
  root.id = OVERLAY_ROOT_ID;

  const host = doc.createElement('div');
  host.id = OVERLAY_HOST_ID;
  host.dataset.askmeContentVersion = CONTENT_VERSION;
  host.dataset.askmeIframe = 'pending';
  host.dataset.askmeInit = 'pending';
  host.dataset.askmeMessageOrigin = 'none';
  host.dataset.askmeMessageSource = 'none';
  host.dataset.askmeHandshake = 'pending';
  host.dataset.askmeRender = 'pending';
  host.dataset.askmeAiState = 'pending';
  host.dataset.askmeHasSelectedCourse = 'pending';
  host.dataset.askmeCourseCount = 'pending';
  host.dataset.askmeDiagnosticSource = 'pending';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    :host { all: initial; --askme-width: 400px; position: relative; z-index: 2; width: 44px; height: calc(100vh - 16px); overflow: visible; isolation: isolate; color-scheme: light; pointer-events: none; }
    *, *::before, *::after { box-sizing: border-box; }
    .overlay { position: relative; display: block; width: 44px; height: 100%; overflow: visible; isolation: isolate; pointer-events: none; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .rail { position: absolute; z-index: 6; top: clamp(8px, calc((100vh - 252px) / 2), 320px); left: 0; order: 0; display: grid; gap: 20px; margin: 0; padding: 0; overflow: visible; isolation: isolate; border: 0; background: transparent; box-shadow: none; pointer-events: auto; }
    .quick { position: relative; display: grid; width: 44px; height: 44px; place-items: center; padding: 0; overflow: visible; border: 0; border-radius: 16px; background: rgba(255,255,255,.97); color: #715df3; box-shadow: 0 12px 30px rgba(35, 29, 74, .13); cursor: pointer; transition: transform .15s ease, background .15s ease, color .15s ease, box-shadow .15s ease; }
    .quick svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .quick .brand-logo { display: block; width: 30px; height: 30px; padding: 0; border: 0; background: transparent; object-fit: contain; filter: none; pointer-events: none; }
    .quick .icon-accent { color: inherit; stroke: currentColor; }
    .quick:hover { transform: translateY(-1px); background: #f5f2ff; color: #6752e6; box-shadow: 0 14px 34px rgba(62, 48, 137, .18); }
    .quick:focus-visible, .resize:focus-visible { outline: 3px solid #ffd500; outline-offset: 2px; }
    .quick[aria-current="page"] { background: #715df3; color: #fff; box-shadow: 0 12px 30px rgba(89, 68, 212, .22); }
    .quick[aria-busy="true"] { color: #fff; background: #715df3; cursor: progress; }
    .quick[aria-busy="true"] svg { animation: askme-pulse 1s ease-in-out infinite; }
    .quick::after { content: attr(data-tooltip); position: absolute; z-index: 8; right: calc(100% + 10px); top: 50%; width: max-content; max-width: min(230px, calc(100vw - 24px)); padding: 9px 14px; overflow-wrap: anywhere; white-space: normal; transform: translate(4px, -50%); border: 0; border-radius: 12px; background: #715df3; color: #fff; box-shadow: none; font: 500 13px/1.3 "Segoe UI", sans-serif; opacity: 0; pointer-events: none; transition: opacity .12s ease, transform .12s ease; }
    .quick:hover::after, .quick:focus-visible::after { opacity: 1; transform: translate(0, -50%); }
    .quick[data-action="courses"] { color: #fff; background: #715df3; box-shadow: 0 12px 30px rgba(89,68,212,.3), inset 0 0 0 1px rgba(255,255,255,.16); }
    .quick[data-action="courses"]:hover, .quick[aria-current="page"]:hover { color: #fff; background: #6550de; }
    .quick::before { content: ""; position: absolute; right: calc(100% + 4px); top: 50%; width: 10px; height: 10px; background: #7560ed; transform: translateY(-50%) rotate(45deg); opacity: 0; pointer-events: none; }
    .quick:hover::before, .quick:focus-visible::before { opacity: 1; }
    @keyframes askme-pulse { 50% { opacity: .42; transform: scale(.9); } }
    @media (prefers-reduced-motion: reduce) { .quick, .quick::after { transition: none; } .quick[aria-busy="true"] svg { animation: none; } }
    .panel-fallback { position: fixed; z-index: 2147483004; top: 76px; right: 32px; display: grid; box-sizing: border-box; width: calc(var(--askme-width) - 40px); max-width: calc(100vw - 96px); gap: 12px; padding: 20px; border: 1px solid #d9d0f2; border-radius: 16px; background: #faf8ff; color: #24202c; text-align: left; box-shadow: 0 8px 24px rgba(43,32,93,.15); pointer-events: auto; }
    .panel-fallback[hidden] { display: none; }
    .panel-fallback strong { font-size: 15px; font-weight: 800; line-height: 1.4; }
    .panel-fallback span { color: #5d7175; font-size: 14px; font-weight: 500; line-height: 1.65; }
    .panel-close { position: fixed; z-index: 2147483005; top: 18px; right: 22px; display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid rgba(113,93,243,.16); border-radius: 11px; background: rgba(255,255,255,.9); color: #51485c; box-shadow: 0 3px 12px rgba(43,32,93,.1); cursor: pointer; font: 700 20px/1 inherit; pointer-events: auto; }
    .panel-close:hover { background: #f5f2ff; color: #6550de; }
    .resize { position: fixed; z-index: 2147483005; top: 22px; right: calc(var(--askme-width) + 7px); bottom: 22px; width: 10px; border: 0; border-radius: 8px; background: transparent; cursor: ew-resize; touch-action: none; pointer-events: auto; }
    .resize::after { content: ""; position: absolute; top: 42%; bottom: 42%; left: 3px; width: 4px; min-height: 48px; border-radius: 4px; background: #a7adb6; }
    .resize:hover::after, .resize:focus-visible::after { background: #20252d; }
    .capture-preview { position: fixed; z-index: 2147483002; top: 84px; right: 72px; display: grid; width: min(380px, calc(100vw - 92px)); max-height: calc(100vh - 108px); gap: 10px; padding: 12px; overflow: auto; border: 1px solid #cdd6d2; border-radius: 16px; background: #fff; box-shadow: 0 18px 55px rgba(17, 24, 39, .24); pointer-events: auto; }
    .capture-preview[hidden], .rail-status[hidden] { display: none; }
    .capture-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #17313a; font: 750 13px/1.35 inherit; }
    .capture-close { width: 44px; height: 44px; border: 0; border-radius: 10px; background: #eef4ef; color: #155e50; cursor: pointer; font: 800 18px/1 inherit; }
    .capture-preview img { display: block; width: 100%; max-height: 55vh; object-fit: contain; border: 1px solid #d9e5df; border-radius: 10px; background: #f7f8f3; }
    .capture-download { display: flex; min-height: 44px; align-items: center; justify-content: center; border-radius: 10px; background: #155e50; color: #fff; text-decoration: none; font: 750 12px/1.35 inherit; }
    .rail-status { position: fixed; z-index: 2147483003; top: 84px; right: calc(var(--askme-width) + 76px); display: flex; width: min(320px, calc(100vw - 92px)); align-items: flex-start; gap: 8px; padding: 10px 10px 10px 12px; border: 1px solid #d9d0f2; border-radius: 11px; background: #faf8ff; color: #3b3153; box-shadow: 0 8px 24px rgba(43,32,93,.15); pointer-events: auto; font: 650 12px/1.45 inherit; }
    :host([data-open="false"]) .rail-status, :host([data-open="false"]) .panel-fallback { right: 72px; }
    :host([data-open="false"]) .panel-close, :host([data-open="false"]) .resize { display: none; }
    .recovery-actions { display: flex; gap: 8px; }
    .recovery-actions button { min-height: 34px; padding: 0 10px; border: 1px solid #d9d0f2; border-radius: 9px; background: #fff; color: #55429c; cursor: pointer; font: 700 12px/1.2 inherit; }
    .qa-markers { position: fixed; z-index: 2147483006; right: 16px; bottom: 16px; display: flex; gap: 2px; pointer-events: none; }
    .qa-markers i { width: 12px; height: 12px; display: block; }
    .qa-markers i:first-child { background: #ff00a8; } .qa-markers i:last-child { background: #00e5ff; }
    .rail-status-text { flex: 1; padding-top: 2px; }
    .rail-status-close { display: grid; flex: 0 0 auto; width: 28px; height: 28px; place-items: center; margin: -4px -3px -4px 0; border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; font: 800 17px/1 inherit; }
    .rail-status-close:hover { background: rgba(23,49,58,.08); }
  `;
  const overlay = doc.createElement('div');
  overlay.className = 'overlay';
  const rail = doc.createElement('nav');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Askme 页面工具');
  const buttonSpecs = [
    ['courses', 'Open panel'],
    ['ask', 'Open Askme session'],
    ['capture', 'Take screenshot'],
    ['explain', 'Solve this page']
  ];
  const buttons = new Map();
  for (const [action, label] of buttonSpecs) {
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'quick'; button.dataset.action = action;
    button.setAttribute('aria-label', label); button.setAttribute('title', label);
    button.setAttribute('data-tooltip', label);
    button.innerHTML = action === 'courses'
      ? `<img class="brand-logo" src="${chromeApi.runtime.getURL('assets/askme-open-panel-128.png')}" alt="">`
      : OVERLAY_ICONS[action];
    rail.append(button); buttons.set(action, button);
  }
  const panel = doc.createElement('section'); panel.id = OVERLAY_PANEL_ID; panel.setAttribute('aria-label', 'Askme 学习面板');
  const panelClose = doc.createElement('button'); panelClose.type = 'button'; panelClose.className = 'panel-close'; panelClose.setAttribute('aria-label', '关闭 Askme 面板'); panelClose.setAttribute('title', '关闭面板'); panelClose.textContent = '×';
  const resize = doc.createElement('button');
  resize.type = 'button'; resize.className = 'resize'; resize.setAttribute('role', 'separator'); resize.setAttribute('aria-label', '调整 Askme 面板宽度');
  resize.setAttribute('aria-orientation', 'vertical'); resize.setAttribute('title', '拖动或用左右方向键调整宽度');
  let iframe = doc.createElement('iframe');
  iframe.id = OVERLAY_IFRAME_ID; iframe.title = 'Askme 学习助手'; iframe.setAttribute('allow', 'clipboard-write');
  const panelFallback = doc.createElement('div'); panelFallback.className = 'panel-fallback';
  const fallbackTitle = doc.createElement('strong'); fallbackTitle.textContent = '正在连接 Askme…';
  const fallbackText = doc.createElement('span'); fallbackText.textContent = '正在验证当前 Moodle 页面与本机学习空间。';
  panelFallback.append(fallbackTitle, fallbackText);
  const recoveryActions = doc.createElement('div'); recoveryActions.className = 'recovery-actions';
  const retryEmbedded = doc.createElement('button'); retryEmbedded.type = 'button'; retryEmbedded.textContent = '重试内嵌连接';
  const openNative = doc.createElement('button'); openNative.type = 'button'; openNative.textContent = '打开原生侧栏';
  recoveryActions.append(retryEmbedded, openNative); panelFallback.append(recoveryActions);
  const preview = doc.createElement('section'); preview.className = 'capture-preview'; preview.hidden = true; preview.setAttribute('aria-label', '当前 Moodle 页面截图预览');
  const previewHead = doc.createElement('div'); previewHead.className = 'capture-head';
  const previewTitle = doc.createElement('strong'); previewTitle.textContent = '当前可见页面截图';
  const previewClose = doc.createElement('button'); previewClose.type = 'button'; previewClose.className = 'capture-close'; previewClose.setAttribute('aria-label', '关闭截图预览'); previewClose.textContent = '×';
  const previewImage = doc.createElement('img'); previewImage.alt = '当前 Moodle 可见页面截图预览';
  const previewDownload = doc.createElement('a'); previewDownload.className = 'capture-download'; previewDownload.textContent = '下载 PNG'; previewDownload.setAttribute('download', 'askme-moodle-page.png');
  previewHead.append(previewTitle, previewClose); preview.append(previewHead, previewImage, previewDownload);
  const railStatus = doc.createElement('div'); railStatus.className = 'rail-status'; railStatus.hidden = true; railStatus.setAttribute('role', 'status'); railStatus.setAttribute('aria-live', 'polite');
  const railStatusText = doc.createElement('span'); railStatusText.className = 'rail-status-text';
  const railStatusClose = doc.createElement('button'); railStatusClose.type = 'button'; railStatusClose.className = 'rail-status-close'; railStatusClose.setAttribute('aria-label', '关闭提示'); railStatusClose.textContent = '×';
  railStatus.append(railStatusText, railStatusClose);
  const qaMarkers = doc.createElement('div');
  qaMarkers.className = 'qa-markers'; qaMarkers.hidden = options.qaMarkers !== true;
  qaMarkers.setAttribute('data-askme-qa-marker', CONTENT_VERSION); qaMarkers.setAttribute('aria-hidden', 'true');
  qaMarkers.append(doc.createElement('i'), doc.createElement('i'));
  overlay.append(rail, panelFallback, resize, panelClose, preview, railStatus, qaMarkers); shadow.append(style, overlay);

  const setImportant = (element, property, value) => element.style.setProperty(property, value, 'important');
  const configureIframe = frame => {
    frame.id = OVERLAY_IFRAME_ID; frame.title = 'Askme 学习助手'; frame.setAttribute('allow', 'clipboard-write');
    for (const [property, value] of Object.entries({ display: 'block', width: '100%', height: '100%', margin: '0', padding: '0', border: '0', background: '#fff', 'box-sizing': 'border-box' })) setImportant(frame, property, value);
    return frame;
  };
  for (const [property, value] of Object.entries({ position: 'fixed', 'z-index': '2147483000', top: '8px', right: '12px', display: 'flex', 'align-items': 'flex-start', gap: '10px', margin: '0', padding: '0', overflow: 'visible', isolation: 'isolate', border: '0', background: 'transparent', 'pointer-events': 'none' })) setImportant(root, property, value);
  for (const [property, value] of Object.entries({ position: 'relative', 'z-index': '1', width: `${OVERLAY_DEFAULT_WIDTH}px`, height: 'calc(100vh - 16px)', margin: '0', padding: '0', border: '1px solid rgba(113,93,243,.12)', 'border-radius': '20px', overflow: 'hidden', background: '#fff', 'box-shadow': '0 18px 55px rgba(43,32,93,.22)', 'pointer-events': 'auto', 'box-sizing': 'border-box' })) setImportant(panel, property, value);
  configureIframe(iframe);
  panel.append(iframe);
  root.append(host, panel);

  const postToEmbedded = message => {
    // 调试工具或页面替换 iframe 文档后，不再向错误的文档发送能力凭据。
    if (frameDocumentInvalid || iframe.getAttribute('srcdoc') !== null) return false;
    try { iframe.contentWindow?.postMessage(message, extensionOrigin); return true; }
    catch { return false; }
  };
  let width = clampOverlayWidth(OVERLAY_DEFAULT_WIDTH, win.innerWidth);
  let open = true;
  let uiHydrated = false;
  let activeView = 'home';
  let drag = null;
  let embeddedReady = false;
  let embeddedBindingId = '';
  let iframeLoaded = false;
  let frameDocumentInvalid = false;
  let frameObserver = null;
  let embeddedInit = null;
  let generation = 0;
  let activeSessionId = 0;
  let sessionSerial = 0;
  let bindingRevoked = false;
  let diagnosticSeq = 0;
  let handshakeTimer = null;
  let handshakeAttempts = 0;
  let railStatusTimer = null;
  let explainActionTimer = null;
  const pendingCourseSyncs = new Map();
  const applyWidth = value => {
    width = clampOverlayWidth(value, win.innerWidth);
    host.style.setProperty('--askme-width', `${width}px`);
    root.style.setProperty('--askme-width', `${width}px`);
    setImportant(panel, 'width', `${width}px`);
    resize.setAttribute('aria-valuemin', String(overlayWidthBounds(win.innerWidth).min));
    resize.setAttribute('aria-valuemax', String(overlayWidthBounds(win.innerWidth).max));
    resize.setAttribute('aria-valuenow', String(width));
    return width;
  };
  const applyOpen = value => {
    open = value !== false;
    panel.hidden = !open || !uiHydrated;
    setImportant(panel, 'display', panel.hidden ? 'none' : 'block');
    panelFallback.hidden = !open || embeddedReady || !uiHydrated;
    host.dataset.open = String(open);
    host.dataset.askmeVisibility = panel.hidden ? 'hidden' : 'visible';
    syncRailState();
  };
  const syncRailState = () => {
    for (const [action, view] of [['courses', 'courses'], ['ask', 'ask']]) {
      const button = buttons.get(action);
      if (!button) continue;
      if (open && activeView === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute?.('aria-current');
    }
  };
  const selectView = view => {
    if (!OVERLAY_VIEWS.has(view)) return false;
    activeView = view; syncRailState();
    return true;
  };
  const persist = () => safeRuntimeSend(chromeApi.runtime, { type: 'SET_OVERLAY_UI', value: { width, open } });
  const sendView = view => {
    if (!selectView(view)) return;
    applyOpen(true);
    if (embeddedReady && embeddedBindingId && embeddedInit?.capability) postToEmbedded({ type: 'ASKME_OPEN_VIEW', view, bindingId: embeddedBindingId, capability: embeddedInit.capability, generation });
  };
  const postDiscoveredCourse = course => {
    if (!embeddedReady || !embeddedBindingId || !embeddedInit?.capability) return false;
    return postToEmbedded({ type: 'ASKME_SYNC_DISCOVERED_COURSE', course, bindingId: embeddedBindingId, capability: embeddedInit.capability, generation });
  };
  const syncDiscoveredCourse = value => {
    const course = normalizeDiscoveredCourse(value);
    if (!course) return false;
    sendView('courses');
    if (!postDiscoveredCourse(course)) pendingCourseSyncs.set(course.id, course);
    return true;
  };
  const dismissRailStatus = () => {
    if (railStatusTimer) clearTimeout(railStatusTimer);
    railStatusTimer = null; railStatusText.textContent = ''; railStatus.hidden = true;
  };
  const showRailStatus = (text, isError = false, timeoutMs = isError ? 10_000 : 6_000) => {
    if (railStatusTimer) clearTimeout(railStatusTimer);
    railStatusText.textContent = String(text || '').slice(0, 240); railStatus.hidden = !railStatusText.textContent;
    railStatus.style.setProperty('border-color', isError ? '#e9bbaa' : '#cddfd6');
    railStatus.style.setProperty('background', isError ? '#fff7f4' : '#f6fbf7');
    railStatus.setAttribute('role', isError ? 'alert' : 'status');
    if (!railStatus.hidden && timeoutMs > 0) { railStatusTimer = setTimeout(dismissRailStatus, timeoutMs); railStatusTimer?.unref?.(); }
  };
  const afterPaint = () => new Promise(resolve => (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)) : setTimeout(resolve, 0)));
  const captureVisible = async () => {
    if (!embeddedReady || !embeddedBindingId || !embeddedInit?.capability) {
      const connectionMessage = /刷新/u.test(fallbackText.textContent)
        ? fallbackText.textContent
        : '学习面板仍在连接，请稍后重试。';
      showRailStatus(connectionMessage, true);
      return;
    }
    const button = buttons.get('capture');
    const suspended = {
      rootHidden: root.hidden,
      rootDisplay: root.style?.getPropertyValue?.('display') ?? '',
      rootDisplayPriority: root.style?.getPropertyPriority?.('display') ?? '',
      panelHidden: panel.hidden,
      panelDisplay: panel.style?.getPropertyValue?.('display') ?? '',
      panelDisplayPriority: panel.style?.getPropertyPriority?.('display') ?? '',
      open,
      previewHidden: preview.hidden
    };
    button.disabled = true; button.setAttribute('aria-busy', 'true'); preview.hidden = true;
    showRailStatus('正在截取当前可见页面…'); root.hidden = true; setImportant(root, 'display', 'none');
    try {
      await afterPaint();
      const result = await safeRuntimeSend(chromeApi.runtime, { type: 'CAPTURE_VISIBLE_MOODLE_TAB' });
      if (!result?.ok || typeof result.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.dataUrl) || result.dataUrl.length > 12_000_000) {
        throw new Error(result?.message || result?.error || '截图结果无效');
      }
      previewImage.src = result.dataUrl; previewDownload.href = result.dataUrl;
      previewDownload.setAttribute('download', `askme-moodle-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      const attached = postToEmbedded({
        type: 'ASKME_ATTACH_SCREENSHOT', dataUrl: result.dataUrl,
        capturedAt: new Date().toISOString(), bindingId: embeddedBindingId,
        capability: embeddedInit?.capability || '', generation
      });
      preview.hidden = true;
      showRailStatus(attached ? '截图已加入 Askme 会话，可以直接提问。' : '截图已完成，但学习面板尚未连接。', !attached);
    } catch (error) { showRailStatus(`无法截图：${error?.message || '请确认当前 Moodle 标签处于前台。'}`, true); }
    finally {
      root.hidden = suspended.rootHidden;
      if (suspended.rootDisplay) root.style.setProperty('display', suspended.rootDisplay, suspended.rootDisplayPriority);
      else root.style.removeProperty?.('display');
      open = suspended.open;
      panel.hidden = suspended.panelHidden;
      if (suspended.panelDisplay) panel.style.setProperty('display', suspended.panelDisplay, suspended.panelDisplayPriority);
      else panel.style.removeProperty?.('display');
      preview.hidden = suspended.previewHidden;
      host.dataset.open = String(open);
      host.dataset.askmeVisibility = panel.hidden ? 'hidden' : 'visible';
      syncRailState();
      button.disabled = false; button.setAttribute('aria-busy', 'false');
    }
  };
  buttons.get('courses').addEventListener('click', () => sendView('courses'));
  buttons.get('ask').addEventListener('click', () => sendView('ask'));
  buttons.get('capture').addEventListener('click', () => { void captureVisible(); });
  buttons.get('explain').addEventListener('click', () => {
    applyOpen(true);
    if (!embeddedReady || !embeddedBindingId) { showRailStatus('学习面板仍在连接，请稍后重试。', true); return; }
    if (explainActionTimer) return;
    showRailStatus('正在读取当前静态课程页面…');
    buttons.get('explain').disabled = true; buttons.get('explain').setAttribute('aria-busy', 'true');
    if (!postToEmbedded({ type: 'ASKME_EXPLAIN_CURRENT_PAGE', bindingId: embeddedBindingId, capability: embeddedInit.capability, generation })) {
      buttons.get('explain').disabled = false; buttons.get('explain').setAttribute('aria-busy', 'false');
      showRailStatus('学习面板连接已变化，请刷新当前 Moodle 页面。', true); return;
    }
    explainActionTimer = setTimeout(() => {
      explainActionTimer = null;
      buttons.get('explain').disabled = false; buttons.get('explain').setAttribute('aria-busy', 'false');
      showRailStatus('讲解请求超时，请刷新当前 Moodle 页面后重试。', true);
    }, 15_000);
    explainActionTimer?.unref?.();
  });
  panelClose.addEventListener('click', () => { applyOpen(false); void persist(); });
  railStatusClose.addEventListener('click', dismissRailStatus);
  previewClose.addEventListener('click', () => { preview.hidden = true; previewImage.src = ''; previewDownload.href = ''; });
  resize.addEventListener('pointerdown', event => {
    if (event.button != null && event.button !== 0) return;
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    resize.setPointerCapture?.(event.pointerId); event.preventDefault?.();
  });
  resize.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    applyWidth(drag.startWidth + drag.startX - event.clientX);
  });
  const finishDrag = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    resize.releasePointerCapture?.(event.pointerId); drag = null; void persist();
  };
  resize.addEventListener('pointerup', finishDrag); resize.addEventListener('pointercancel', finishDrag);
  resize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); applyWidth(width + (event.key === 'ArrowLeft' ? 16 : -16)); void persist();
  });
  const onResize = () => { const before = width; applyWidth(width); if (before !== width) void persist(); };
  const onMessage = event => {
    if (frameDocumentInvalid || iframe.getAttribute('srcdoc') !== null) return;
    const embeddedWindow = iframe.contentWindow;
    if (typeof event?.data?.type === 'string' && event.data.type.startsWith('ASKME_')) {
      const diagnostics = overlayMessageDiagnostics(event, extensionOrigin, embeddedWindow);
      host.dataset.askmeMessageOrigin = diagnostics.origin;
      host.dataset.askmeMessageSource = diagnostics.source;
    }
    if (!embeddedReady && validOverlayBootErrorMessage(event, extensionOrigin, embeddedWindow, generation)) {
      host.dataset.askmeHandshake = 'boot-error';
      fallbackTitle.textContent = 'Askme 面板启动失败';
      fallbackText.textContent = `内嵌脚本未能完成启动：${event.data.error}`;
    } else if (validOverlayBootMessage(event, extensionOrigin, embeddedWindow, generation)) {
      if (!embeddedReady) host.dataset.askmeHandshake = 'booted';
    } else if (!bindingRevoked && validOverlayReadyMessage(event, extensionOrigin, embeddedWindow, generation)) {
      host.dataset.askmeReadyHint = String(event.data.stage || 'received').slice(0, 32);
    } else if (embeddedReady && validOverlayViewMessage(event, extensionOrigin, embeddedWindow, embeddedBindingId, generation)) selectView(event.data.view);
    else if (embeddedReady && validOverlayActionResultMessage(event, extensionOrigin, embeddedWindow, embeddedBindingId, generation)) {
      if (explainActionTimer) clearTimeout(explainActionTimer);
      explainActionTimer = null;
      buttons.get('explain').disabled = false; buttons.get('explain')?.setAttribute('aria-busy', 'false');
      showRailStatus(event.data.message, !event.data.ok);
    }
    else if (!embeddedReady && validOverlayAuthErrorMessage(event, extensionOrigin, embeddedWindow, embeddedInit, generation)) {
      host.dataset.askmeHandshake = 'auth-error';
      host.dataset.askmeAuth = 'failed';
      fallbackTitle.textContent = 'Askme 连接失败';
      fallbackText.textContent = `请刷新当前 Moodle 页面后重试。${event.data.error ? `（${event.data.error}）` : ''}`;
    }
  };
  const onRuntimeMessage = (message, sender, sendResponse) => {
    if (!['ASKME_EMBEDDED_READY_CONFIRMED', 'ASKME_EMBEDDED_BINDING_REVOKED', 'ASKME_EMBEDDED_RENDER_STATE'].includes(message?.type)) return false;
    if (frameDocumentInvalid || iframe.getAttribute('srcdoc') !== null) {
      sendResponse?.({ ok: false, error: 'EMBEDDED_DOCUMENT_REPLACED' }); return false;
    }
    const trusted = validBackgroundSender(sender, chromeApi) && message.generation === generation && message.hostDocumentId === embeddedInit?.hostDocumentId &&
      typeof message.bindingId === 'string' && /^[0-9a-f]{48}$/.test(message.bindingId);
    if (!trusted) {
      sendResponse?.({ ok: false, error: 'INVALID_EMBEDDED_RUNTIME_MESSAGE' }); return false;
    }
    if (message.type === 'ASKME_EMBEDDED_BINDING_REVOKED') {
      if (embeddedBindingId && message.bindingId !== embeddedBindingId) {
        sendResponse?.({ ok: false, error: 'EMBEDDED_BINDING_MISMATCH' }); return false;
      }
      bindingRevoked = true; embeddedReady = false; embeddedBindingId = '';
      host.dataset.askmeHandshake = 'revoked'; host.dataset.askmeAuth = 'revoked';
      panelFallback.hidden = !open;
      fallbackTitle.textContent = 'Askme 连接已失效';
      fallbackText.textContent = '内嵌连接已由扩展后台撤销，请重试内嵌连接。';
      sendResponse?.({ ok: true }); return false;
    }
    if (message.type === 'ASKME_EMBEDDED_RENDER_STATE') {
      if (!embeddedReady || bindingRevoked || message.bindingId !== embeddedBindingId ||
          !validOverlayRenderStateMessage({ origin: extensionOrigin, source: iframe.contentWindow, data: message }, extensionOrigin, iframe.contentWindow, embeddedBindingId, generation) ||
          !Number.isInteger(message.diagnosticSeq) || message.diagnosticSeq <= diagnosticSeq || message.diagnosticSeq > 1_000_000_000) {
        sendResponse?.({ ok: false, error: 'INVALID_EMBEDDED_RENDER_STATE' }); return false;
      }
      diagnosticSeq = message.diagnosticSeq;
      host.dataset.askmeLayout = `${message.view}:${message.display}:${message.mainWidth}x${message.mainHeight}:text-${message.textLength}:css-${message.styleSheets}`;
      host.dataset.askmeAiState = message.aiState;
      host.dataset.askmeHasSelectedCourse = String(message.hasSelectedCourse);
      host.dataset.askmeCourseCount = String(message.courseCount);
      host.dataset.askmeDiagnosticSource = 'background-confirmed';
      sendResponse?.({ ok: true }); return false;
    }
    if (bindingRevoked) { sendResponse?.({ ok: false, error: 'EMBEDDED_BINDING_REVOKED' }); return false; }
    if (embeddedReady) {
      const sameBinding = message.bindingId === embeddedBindingId;
      sendResponse?.(sameBinding ? { ok: true } : { ok: false, error: 'EMBEDDED_BINDING_MISMATCH' });
      return false;
    }
    embeddedReady = true; embeddedBindingId = message.bindingId;
    host.dataset.askmeHandshake = 'ready'; host.dataset.askmeAuth = 'confirmed';
    if (handshakeTimer) clearTimeout(handshakeTimer); handshakeTimer = null;
    panelFallback.hidden = true;
    if (embeddedInit?.capability) postToEmbedded({ type: 'ASKME_OPEN_VIEW', view: activeView, bindingId: embeddedBindingId, capability: embeddedInit.capability, generation });
    for (const course of pendingCourseSyncs.values()) postDiscoveredCourse(course);
    pendingCourseSyncs.clear();
    sendResponse?.({ ok: true });
    return false;
  };
  win.addEventListener('resize', onResize); win.addEventListener('message', onMessage);
  chromeApi.runtime.onMessage?.addListener?.(onRuntimeMessage);
  const sendInit = () => {
    if (!frameDocumentInvalid && iframeLoaded && embeddedInit) {
      const sent = postToEmbedded({ type: 'ASKME_EMBEDDED_INIT', ...embeddedInit, generation });
      host.dataset.askmeInit = sent ? 'sent' : 'post-failed';
    }
  };
  const continueHandshake = (sessionId = activeSessionId, sessionGeneration = generation) => {
    if (sessionId !== activeSessionId || sessionGeneration !== generation || embeddedReady || bindingRevoked || !iframeLoaded || !embeddedInit) return;
    sendInit(); handshakeAttempts++;
    if (handshakeAttempts < 24) {
      handshakeTimer = setTimeout(() => continueHandshake(sessionId, sessionGeneration), 400);
      handshakeTimer?.unref?.();
    }
    else {
      host.dataset.askmeHandshake = 'timeout';
      fallbackTitle.textContent = 'Askme 连接超时';
      fallbackText.textContent = host.dataset.askmeMessageOrigin === 'none'
        ? '内嵌脚本没有执行，请重新加载 Askme 后刷新 Moodle 页面。'
        : '内嵌面板初始化未完成，请重新加载 Askme 后刷新 Moodle 页面。';
    }
  };
  doc.documentElement.append(root);
  applyWidth(width); applyOpen(open);
  const uiReady = safeRuntimeSend(chromeApi.runtime, { type: 'GET_OVERLAY_UI' }).then(result => {
    const value = result?.ok ? result.value : null;
    if (value && typeof value === 'object') { applyWidth(value.width); open = value.open !== false; }
  }).catch(() => {}).finally(() => { uiHydrated = true; applyOpen(open); });
  const invalidateFrameDocument = reason => {
    if (frameDocumentInvalid) return;
    frameDocumentInvalid = true; embeddedReady = false; embeddedBindingId = '';
    embeddedInit = null; bindingRevoked = true; iframeLoaded = false;
    if (handshakeTimer) clearTimeout(handshakeTimer); handshakeTimer = null;
    host.dataset.askmeIframe = reason; host.dataset.askmeHandshake = 'document-replaced';
    host.dataset.askmeAuth = 'invalidated'; host.dataset.askmeLayout = 'unavailable';
    host.dataset.askmeAiState = 'unknown'; host.dataset.askmeDiagnosticSource = 'document-invalidated';
    fallbackTitle.textContent = '学习面板被外部操作中断';
    fallbackText.textContent = '面板文档已被替换。若正在自动调试，请先结束调试，再点击“重试内嵌连接”恢复。已保存的课程和对话仍然保留。';
    panelFallback.hidden = !open || !uiHydrated;
  };
  const navigateEmbedded = async () => {
    frameObserver?.disconnect(); frameObserver = null;
    const replaceFrame = generation > 0;
    const attemptGeneration = generation + 1;
    const sessionId = ++sessionSerial;
    generation = attemptGeneration; activeSessionId = sessionId;
    embeddedReady = false; embeddedBindingId = ''; embeddedInit = null; iframeLoaded = false; frameDocumentInvalid = false; handshakeAttempts = 0; bindingRevoked = false; diagnosticSeq = 0;
    if (handshakeTimer) clearTimeout(handshakeTimer); handshakeTimer = null;
    host.dataset.askmeGeneration = String(generation); host.dataset.askmeAuth = 'pending';
    host.dataset.askmeHandshake = 'pending'; host.dataset.askmeLayout = 'pending'; host.dataset.askmeIframe = 'navigating';
    host.dataset.askmeAiState = 'pending'; host.dataset.askmeHasSelectedCourse = 'pending'; host.dataset.askmeCourseCount = 'pending'; host.dataset.askmeDiagnosticSource = 'pending';
    fallbackTitle.textContent = '正在连接 Askme…'; fallbackText.textContent = '正在验证当前 Moodle 页面与本机学习空间。';
    if (uiHydrated && open) panelFallback.hidden = false;
    if (replaceFrame) {
      const nextFrame = configureIframe(doc.createElement('iframe'));
      panel.replaceChildren(nextFrame); iframe = nextFrame;
    }
    const sessionFrame = iframe;
    const expectedSrc = `${extensionOrigin}/panel.html?embedded=1&v=${encodeURIComponent(CONTENT_VERSION)}&g=${attemptGeneration}`;
    const currentSession = () => sessionFrame === iframe && sessionId === activeSessionId && attemptGeneration === generation;
    const checkFrameDocument = () => {
      if (!currentSession()) return;
      if (sessionFrame.getAttribute('srcdoc') !== null) invalidateFrameDocument('srcdoc-replaced');
      else if (sessionFrame.src !== expectedSrc || (typeof panel.contains === 'function' && !panel.contains(sessionFrame))) invalidateFrameDocument('frame-replaced');
    };
    sessionFrame.addEventListener('load', () => {
      if (!currentSession()) return;
      checkFrameDocument();
      if (frameDocumentInvalid) return;
      // READY 只属于当前文档；后续导航不能沿用旧的成功状态。
      if (embeddedReady && iframeLoaded) { invalidateFrameDocument('document-reloaded'); return; }
      iframeLoaded = true; host.dataset.askmeIframe = 'loaded'; handshakeAttempts = 0; continueHandshake(sessionId, attemptGeneration);
    });
    sessionFrame.addEventListener('error', () => {
      if (sessionFrame !== iframe || sessionId !== activeSessionId || attemptGeneration !== generation) return;
      if (frameDocumentInvalid) return;
      host.dataset.askmeIframe = 'error';
      if (embeddedReady) return;
      host.dataset.askmeHandshake = 'iframe-error';
      panelFallback.hidden = !open;
      fallbackTitle.textContent = 'Askme 面板加载失败';
      fallbackText.textContent = 'Chrome 没有提交扩展面板文档；请在 chrome://extensions 重新加载 Askme，再刷新当前 Moodle 页面。';
    });
    sessionFrame.src = expectedSrc;
    if (typeof win.MutationObserver === 'function') {
      frameObserver = new win.MutationObserver(checkFrameDocument);
      frameObserver.observe(sessionFrame, { attributes: true, attributeFilter: ['src', 'srcdoc'] });
      frameObserver.observe(panel, { childList: true });
    }
    const result = await safeRuntimeSend(chromeApi.runtime, { type: 'ISSUE_EMBEDDED_CAPABILITY', generation: attemptGeneration });
    if (sessionId !== activeSessionId || attemptGeneration !== generation || frameDocumentInvalid) return false;
    if (!result?.ok || typeof result.capability !== 'string' || typeof result.hostDocumentId !== 'string') {
      host.dataset.askmeInit = 'issue-failed'; host.dataset.askmeHandshake = 'auth-error';
      host.dataset.askmeAuth = 'failed';
      fallbackTitle.textContent = 'Askme 连接失败'; fallbackText.textContent = '无法验证当前 Moodle 页面，请刷新当前 Moodle 页面后重试。'; return false;
    }
    embeddedInit = { capability: result.capability, hostDocumentId: result.hostDocumentId, generation: attemptGeneration };
    handshakeAttempts = 0; continueHandshake(sessionId, attemptGeneration);
    return true;
  };
  retryEmbedded.addEventListener('click', () => { void navigateEmbedded().catch(() => false); });
  openNative.addEventListener('click', async () => {
    const result = await safeRuntimeSend(chromeApi.runtime, { type: 'OPEN_NATIVE_SIDE_PANEL' });
    showRailStatus(result?.ok ? '已打开 Askme 原生侧栏。' : '无法打开原生侧栏，请从扩展菜单打开 Askme。', !result?.ok);
  });
  const authorization = navigateEmbedded().catch(() => { host.dataset.askmeInit = 'issue-failed'; host.dataset.askmeHandshake = 'auth-error'; host.dataset.askmeAuth = 'failed'; fallbackTitle.textContent = 'Askme 连接失败'; fallbackText.textContent = '无法连接扩展后台，请重新加载 Askme 后刷新页面。'; return false; });
  const ready = Promise.all([uiReady, authorization]);
  const controller = { root, host, shadow, panel, panelClose, panelFallback, fallbackTitle, fallbackText, get iframe() { return iframe; }, resize, buttons, preview, previewImage, previewDownload, railStatus, railStatusText, railStatusClose, retryEmbedded, openNative, qaMarkers, ready, authorization, navigateEmbedded, sendView, syncDiscoveredCourse, captureVisible, applyWidth, applyOpen, showRailStatus, dismissRailStatus, isEmbeddedReady: () => embeddedReady, getDiagnostics: () => ({ generation, mounted: host.dataset.askmeMounted, auth: host.dataset.askmeAuth, layout: host.dataset.askmeLayout, visibility: host.dataset.askmeVisibility }), getState: () => ({ width, open, activeView }) };
  host.dataset.askmeMounted = 'true';
  OVERLAY_CONTROLLERS.set(root, controller);
  controller.courseSyncControls = mountAskmeCourseSyncControls(doc, syncDiscoveredCourse, win);
  return controller;
}

function normaliseUrl(value, base = ROOT) {
  try {
    const url = new URL(value, base);
    if (url.origin !== ROOT || url.username || url.password || !/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

function readableActivityUrl(url) {
  const module = url?.pathname.match(ACTIVITY_PATH)?.[1];
  return READABLE_MODULES.has(module) && /^\d{1,12}$/.test(url.searchParams.get('id') || '') &&
    url.searchParams.getAll('id').length === 1 &&
    ![...url.searchParams.keys()].some(key => /^(action|sesskey|delete|edit|submit|attempt|grade)$/i.test(key));
}

function assignmentBriefUrl(value, base = ROOT) {
  const url = normaliseUrl(value, base);
  if (!url || url.protocol !== 'https:' || url.pathname !== '/mod/assign/view.php') return null;
  const keys = [...url.searchParams.keys()];
  const ids = url.searchParams.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || ids.length !== 1 || !/^\d{1,12}$/u.test(ids[0])) return null;
  return new URL(`${ROOT}/mod/assign/view.php?id=${encodeURIComponent(ids[0])}`);
}

function briefTextHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

function sensitiveBriefDom(root) {
  if (!root?.querySelectorAll) return true;
  const direct = 'form,input,textarea,select,option,button,iframe,object,embed,[contenteditable],[data-region*="submission" i],[data-region*="feedback" i],[data-region*="grade" i],[data-region*="attempt" i],.submissionstatustable,.gradingtable,.submissionaction,.submissionlinks';
  try { if (root.querySelector?.(direct)) return true; } catch { return true; }
  const token = /(?:submission|assignsubmission|feedback|assignfeedback|grading|grade|attempt|response|draft|filesubmission)/iu;
  for (const element of root.querySelectorAll('*')) {
    const identity = `${element.getAttribute?.('id') || ''} ${element.getAttribute?.('class') || ''} ${element.getAttribute?.('name') || ''} ${element.getAttribute?.('data-region') || ''} ${element.getAttribute?.('aria-label') || ''}`;
    if (token.test(identity)) return true;
  }
  return false;
}

function assignmentBriefErrorCode(error) {
  if (error?.code === 'MOODLE_NOT_FOUND') return 'not-found';
  if (error?.code === 'MOODLE_ACCESS_DENIED') return 'forbidden';
  const code = String(error?.message || error || '').toLocaleLowerCase('en-AU');
  if (/login|登录/u.test(code)) return 'login-required';
  if (/abort|timeout|超时/u.test(code)) return 'timeout';
  if (/http 401|http 403/u.test(code)) return 'forbidden';
  if (/http 404/u.test(code)) return 'not-found';
  if (/redirect|跳转/u.test(code)) return 'unexpected-redirect';
  if (/course|课程/u.test(code)) return 'course-mismatch';
  if (/sensitive|submission|feedback|grade|attempt/u.test(code)) return 'sensitive-dom';
  if (/truncated|过大/u.test(code)) return 'truncated';
  if (/^empty$/u.test(code)) return 'empty-intro';
  if (/intro|template|unsupported/u.test(code)) return 'unsupported-template';
  return 'read-failed';
}

function structuredBriefBlocks(root) {
  if (!root?.querySelectorAll || sensitiveBriefDom(root)) return { blocks: [], parseStatus: 'unsupported-sensitive-dom' };
  const elements = [...root.querySelectorAll('h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,pre,code,tr,caption,figcaption')];
  const blocks = [];
  let total = 0;
  for (const element of elements) {
    const tag = String(element.tagName || '').toLowerCase();
    const parent = element.parentElement?.closest?.('p,li,dt,dd,blockquote,pre,code,tr,figcaption');
    if (parent && parent !== element) continue;
    if (tag === 'tr') {
      const table = element.closest?.('table');
      const rows = table ? [...(table.querySelectorAll?.('tr') || [])] : [];
      const cells = [...(element.querySelectorAll?.(':scope > th, :scope > td') || [])];
      if (rows.length > 40 || cells.length > 12) return { blocks: [], parseStatus: 'truncated' };
    }
    let text = tag === 'tr'
      ? [...(element.querySelectorAll?.(':scope > th, :scope > td') || [])].map(cell => cleanText(cell.textContent)).filter(Boolean).join(' | ')
      : cleanText(element.textContent);
    if (!text) continue;
    if (text.length > ASSIGNMENT_BRIEF_BLOCK_TEXT_LIMIT || blocks.length >= ASSIGNMENT_BRIEF_BLOCK_LIMIT || total + text.length > ASSIGNMENT_BRIEF_TEXT_LIMIT) {
      return { blocks: [], parseStatus: 'truncated' };
    }
    const kind = /^h[2-6]$/u.test(tag) ? 'heading' : tag === 'li' ? 'list-item' : tag === 'tr' ? 'table-row' : tag === 'pre' || tag === 'code' ? 'code' : 'paragraph';
    const charStart = total + (blocks.length ? 1 : 0);
    const charEnd = charStart + text.length;
    blocks.push({ blockId: `brief-block:${blocks.length + 1}`, kind, ordinal: blocks.length + 1, charStart, charEnd, text });
    total = charEnd;
  }
  // 有些 Moodle 说明只有 div、span 或裸文本；仍只读取已隔离且无敏感控件的 intro。
  if (!blocks.length) {
    const plain = structuredText(root, ASSIGNMENT_BRIEF_TEXT_LIMIT + 1);
    if (plain.length > ASSIGNMENT_BRIEF_TEXT_LIMIT) return { blocks: [], parseStatus: 'truncated' };
    for (const line of plain.split('\n').map(cleanText).filter(Boolean)) {
      if (line.length > ASSIGNMENT_BRIEF_BLOCK_TEXT_LIMIT || blocks.length >= ASSIGNMENT_BRIEF_BLOCK_LIMIT || total + line.length + (blocks.length ? 1 : 0) > ASSIGNMENT_BRIEF_TEXT_LIMIT) return { blocks: [], parseStatus: 'truncated' };
      const charStart = total + (blocks.length ? 1 : 0), charEnd = charStart + line.length;
      blocks.push({ blockId: `brief-block:${blocks.length + 1}`, kind: 'paragraph', ordinal: blocks.length + 1, charStart, charEnd, text: line });
      total = charEnd;
    }
  }
  return { blocks, parseStatus: blocks.length ? 'complete' : 'empty' };
}

function extractAssignmentBrief(doc, pageUrl, courseId, discovered = {}) {
  const source = assignmentBriefUrl(pageUrl);
  const selectedId = String(courseId || '');
  if (!source || !/^\d{1,12}$/u.test(selectedId)) return { status: 'failed', errorCode: 'invalid-url' };
  if (doc?.body?.id !== 'page-mod-assign-view') return { status: 'unsupported', errorCode: 'unknown-template' };
  try { verifyActivityCourse(doc, source.href, selectedId); }
  catch { return { status: 'failed', errorCode: 'course-mismatch' }; }
  const roots = [...(doc.querySelectorAll?.('#region-main .activity-description #intro, #region-main #intro.activity-description') || [])];
  if (roots.length !== 1 || !roots[0].closest?.('#region-main') || !roots[0].closest?.('.activity-description')) {
    return { status: 'unsupported', errorCode: 'intro-boundary' };
  }
  const structured = structuredBriefBlocks(roots[0]);
  if (structured.parseStatus !== 'complete') return { status: structured.parseStatus === 'truncated' ? 'truncated' : 'unsupported', errorCode: structured.parseStatus };
  const activityId = source.searchParams.get('id');
  const title = cleanText(doc.querySelector?.('.page-header-headings h1, #page-header h1, h1')?.textContent || discovered.title).slice(0, 180);
  const section = cleanText(discovered.section).slice(0, 120);
  // textHash 与 sourceVersion 都可由完整 blocks 原文重算；任何 block、范围、顺序或类型变化都会使内核拒绝该 brief。
  const textHash = briefTextHash(structured.blocks.map(block => block.text).join(' '));
  return {
    status: 'complete',
    brief: {
      schemaVersion: 1, id: `assign-brief:${selectedId}:${activityId}`, courseId: selectedId, activityId,
      sourceUrl: source.href, title: title || cleanText(discovered.title).slice(0, 180) || `Assignment ${activityId}`,
      section, blocks: structured.blocks, textHash,
      sourceVersion: briefTextHash(`${source.href}\n${textHash}\n${ASSIGNMENT_BRIEF_EXTRACTOR_VERSION}`),
      extractorVersion: ASSIGNMENT_BRIEF_EXTRACTOR_VERSION, parseStatus: 'complete', syncedAt: new Date().toISOString()
    }
  };
}

function cleanText(value) { return (value || '').replace(/\s+/g, ' ').trim(); }

function structuredText(root, maxChars = Infinity) {
  if (!root) return '';
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : Infinity;
  if (!root.childNodes && !root.children?.length) {
    let elements = [];
    try { elements = [...(root.querySelectorAll?.('h1,h2,h3,h4,h5,h6,p,li,dt,dd,caption,tr,pre,blockquote') || [])]; }
    catch { return cleanText(root.innerText || root.textContent || '').slice(0, limit); }
    if (!elements.length) return cleanText(root.innerText || root.textContent || '').slice(0, limit);
    const blocks = [];
    for (const element of elements) {
      const tag = String(element.tagName || '').toLowerCase();
      const parentBlock = element.parentElement?.closest?.('p,li,dt,dd,blockquote,pre,tr');
      if (parentBlock) continue;
      let text = '';
      if (tag === 'tr') {
        let cells = [];
        try { cells = [...(element.querySelectorAll?.(':scope > th, :scope > td') || [])]; }
        catch { cells = [...(element.querySelectorAll?.('th,td') || [])]; }
        text = cells.map(cell => cleanText(cell.textContent)).filter(Boolean).join(' | ');
        if (text) text = `| ${text} |`;
      } else if (tag === 'pre') {
        text = String(element.textContent || '').replace(/\r\n?/gu, '\n').split('\n').map(line => line.replace(/[\t ]+/gu, ' ').trimEnd()).join('\n').trim();
      } else if (tag === 'li') {
        const clone = element.cloneNode?.(true);
        if (clone?.querySelectorAll) for (const nested of clone.querySelectorAll('ul,ol')) nested.remove?.();
        text = cleanText(clone?.textContent ?? element.textContent);
      } else text = cleanText(element.textContent);
      if (!text) continue;
      if (/^h[1-6]$/u.test(tag)) text = `${'#'.repeat(Number(tag[1]))} ${text}`;
      else if (tag === 'li') text = `- ${text}`;
      blocks.push(text);
      if (blocks.join('\n').length >= limit) break;
    }
    return (blocks.join('\n').trim() || cleanText(root.innerText || root.textContent || '')).slice(0, limit);
  }

  const skipTags = new Set(['script', 'style', 'template', 'noscript', 'svg', 'canvas', 'nav', 'form', 'button', 'input', 'select', 'textarea']);
  const atomicTags = new Set(['p', 'blockquote', 'dt', 'dd', 'caption', 'pre']);
  let output = '';
  let pending = '';
  let stopped = false;
  const tagOf = node => String(node?.tagName || node?.nodeName || '').toLowerCase();
  const childrenOf = node => [...(node?.childNodes || node?.children || [])];
  const hidden = node => {
    if (!node || node.nodeType === 3) return false;
    const tag = tagOf(node);
    if (skipTags.has(tag) || node.hidden === true || node.getAttribute?.('aria-hidden') === 'true') return true;
    const style = String(node.getAttribute?.('style') || '').replace(/\s+/gu, '').toLowerCase();
    return style.includes('display:none') || style.includes('visibility:hidden');
  };
  const append = value => {
    const text = String(value || '').trim();
    if (!text || stopped) return;
    const prefix = output ? '\n' : '';
    output += `${prefix}${text}`.slice(0, Math.max(0, limit - output.length));
    if (output.length >= limit) stopped = true;
  };
  const flushPending = () => { append(cleanText(pending)); pending = ''; };
  const inlineText = (node, excluded = new Set()) => {
    let value = '';
    const visit = current => {
      if (!current || hidden(current) || excluded.has(tagOf(current))) return;
      if (current.nodeType === 3) { value += current.nodeValue || current.textContent || ''; return; }
      if (tagOf(current) === 'br') { value += '\n'; return; }
      const children = childrenOf(current);
      if (!children.length) value += current.textContent || '';
      else for (const child of children) visit(child);
    };
    visit(node);
    return value.replace(/[\t ]+/gu, ' ').replace(/ *\n */gu, '\n').trim();
  };
  const walk = node => {
    if (!node || stopped || hidden(node)) return;
    if (node.nodeType === 3) { pending += ` ${node.nodeValue || node.textContent || ''}`; return; }
    const tag = tagOf(node);
    if (/^h[1-6]$/u.test(tag)) { flushPending(); append(`${'#'.repeat(Number(tag[1]))} ${cleanText(inlineText(node))}`); return; }
    if (tag === 'tr') {
      flushPending();
      const cells = childrenOf(node).filter(child => ['th', 'td'].includes(tagOf(child))).map(cell => cleanText(inlineText(cell))).filter(Boolean);
      if (cells.length) append(`| ${cells.join(' | ')} |`);
      return;
    }
    if (tag === 'li') {
      // Moodle 章节和活动本身也是 li；按容器遍历才能保留 div 中的标题与嵌套列表。
      const children = childrenOf(node);
      if (children.some(child => /^(?:div|section|article|main|header|footer|p|table|blockquote|h[1-6])$/u.test(tagOf(child)))) {
        flushPending();
        for (const child of children) walk(child);
        flushPending();
        return;
      }
      flushPending(); append(`- ${cleanText(inlineText(node, new Set(['ul', 'ol'])))}`);
      // 列表也可能隔着 span 等内联容器；找到最外层子列表后交给 walk，避免遗漏或重复。
      const nestedLists = parent => {
        for (const child of childrenOf(parent)) {
          if (hidden(child)) continue;
          if (['ul', 'ol'].includes(tagOf(child))) walk(child);
          else nestedLists(child);
        }
      };
      nestedLists(node);
      return;
    }
    if (atomicTags.has(tag)) {
      flushPending();
      const value = tag === 'pre'
        ? inlineText(node).replace(/\r\n?/gu, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim()
        : cleanText(inlineText(node));
      append(value);
      return;
    }
    for (const child of childrenOf(node)) walk(child);
    flushPending();
  };
  walk(root);
  flushPending();
  return output.trim();
}

function courseUrl(value, base = ROOT) {
  const url = normaliseUrl(value, base);
  if (!url || !COURSE_PATH.test(url.pathname)) return null;
  const id = url.searchParams.get('id');
  if (!/^\d+$/.test(id || '')) return null;
  return { id, url: `${ROOT}/course/view.php?id=${encodeURIComponent(id)}` };
}

function courseFromAnchor(anchor, base) {
  const address = courseUrl(anchor.getAttribute('href'), base);
  if (!address) return null;
  const title = courseAnchorTitle(anchor);
  if (!title) return null;
  const preferred = !!anchor.closest('.block_myoverview, .block_recentlyaccessedcourses, .course-info-container');
  return { ...address, title, preferred };
}

function discover(doc = document, pageUrl = doc.location?.href || location.href) {
  const courses = new Map();
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const item = courseFromAnchor(anchor, pageUrl);
    if (!item) continue;
    const previous = courses.get(item.id);
    if (!previous || (item.preferred && !previous.preferred) || (item.preferred === previous.preferred && item.title.length > previous.title.length)) {
      courses.set(item.id, item);
    }
  }
  const current = courseUrl(pageUrl);
  if (current) {
    const title = cleanText(doc.querySelector('.page-header-headings h1, h1')?.textContent);
    courses.set(current.id, { ...current, title: title || courses.get(current.id)?.title || `Course ${current.id}` });
  }
  return [...courses.values()].map(({ preferred, ...course }) => course);
}

function classifyMoodleDocument(doc) {
  if (!doc || (!doc.querySelector && !doc.querySelectorAll)) return { ok: false, reasonCode: 'invalid-document', message: 'Moodle 页面无法读取' };
  if (doc.querySelector?.('form#login, form[action*="/login/index.php"], .loginerrors, [data-region="login"]')) {
    return { ok: false, reasonCode: 'login-required', message: 'Moodle 登录已过期' };
  }
  const bodyIdentity = `${doc.body?.id || ''} ${doc.body?.className || ''}`;
  if (/(?:^|\s)(?:notloggedin|pagelayout-login)(?:\s|$)|page-login-index/iu.test(bodyIdentity)) {
    return { ok: false, reasonCode: 'login-required', message: 'Moodle 登录已过期' };
  }
  const errorNodes = [...(doc.querySelectorAll?.('#region-main .alert-danger, #region-main .alert, #region-main .errorbox, #region-main [role="alert"], #region-main #notice, #region-main [data-region="notification"], .loginerrors, .errormessage, .exceptionmessage') || [])].slice(0, 16);
  const mainText = cleanText(doc.querySelector?.('#region-main, main, [role="main"]')?.textContent || '').slice(0, 2400);
  const diagnosticText = cleanText([doc.title || '', doc.querySelector?.('.page-header-headings h1, h1')?.textContent || '', ...errorNodes.map(node => node.textContent || ''), mainText].join(' ')).slice(0, 4000);
  const accessBannerText = cleanText([doc.title || '', doc.querySelector?.('.page-header-headings h1, h1')?.textContent || '', ...errorNodes.map(node => node.textContent || ''), mainText.slice(0, 600)].join(' ')).slice(0, 1800);
  // 只在错误页面或错误通知中识别缺失记录，不能把讲义中的例句当成活动错误。
  const recordErrorText = cleanText([...errorNodes.map(node => node.textContent || ''), ...(/^Error\b/iu.test(doc.title || '') ? [mainText] : [])].join(' '));
  if (/(?:can't find data record in database|can not find data record|invalid course module id|invalidrecord|找不到数据记录)/iu.test(recordErrorText)) {
    return { ok: false, reasonCode: 'not-found', message: 'Moodle 活动记录不存在' };
  }
  if (/(?:session (?:has )?(?:timed out|expired)|your session has timed out|please log in|log in again|you are not logged in|请登录|重新登录|登录已过期)/iu.test(diagnosticText)) {
    return { ok: false, reasonCode: 'login-required', message: 'Moodle 登录已过期' };
  }
  if (/(?:activity is currently hidden|this activity is hidden|此活动当前隐藏)/iu.test(accessBannerText) || /(?:course or activity not accessible|guest access|access denied|you cannot access|not available to you|you do not have permission|无权访问|没有权限|无法访问)/iu.test(diagnosticText)) {
    return { ok: false, reasonCode: 'access-denied', message: 'Moodle 当前不允许访问此课程或活动' };
  }
  return { ok: true, reasonCode: '', message: '' };
}

function currentAccount(doc = document, pageUrl = doc.location?.href || globalThis.location?.href || `${ROOT}/`) {
  const access = classifyMoodleDocument(doc);
  if (!access.ok) {
    const error = new Error(access.message); error.code = access.reasonCode === 'login-required' ? 'MOODLE_LOGIN_REQUIRED' : 'MOODLE_ACCESS_DENIED';
    throw error;
  }
  const ids = new Set();
  for (const anchor of doc.querySelectorAll?.('.usermenu a[href], [data-region="user-menu"] a[href], a[href*="/user/profile.php"]') || []) {
    try {
      const url = new URL(anchor.getAttribute('href'), pageUrl);
      if (url.origin !== ROOT || url.pathname !== '/user/profile.php' || url.username || url.password) continue;
      const values = url.searchParams.getAll('id');
      if (values.length === 1 && /^\d{1,12}$/.test(values[0])) ids.add(values[0]);
    } catch {}
  }
  if (ids.size !== 1) throw new Error('无法确认当前 Moodle 账号，请刷新页面后重试');
  return [...ids][0];
}

function currentStaticPageSource(doc = document, pageUrl = doc.location?.href || location.href) {
  const url = normaliseUrl(pageUrl);
  if (!url) throw new Error('当前页面不是 UNSW Moodle 页面');
  const keys = [...url.searchParams.keys()];
  let pageKind = '';
  if (COURSE_PATH.test(url.pathname)) {
    if (!/^\d{1,12}$/.test(url.searchParams.get('id') || '') || url.searchParams.getAll('id').length !== 1 ||
        keys.some(key => !['id', 'section'].includes(key)) || (url.searchParams.has('section') && (!/^\d{1,6}$/.test(url.searchParams.get('section') || '') || url.searchParams.getAll('section').length !== 1))) {
      throw new Error('当前课程页面地址包含交互参数，已拒绝讲解');
    }
    pageKind = '课程首页';
  } else {
    const module = url.pathname.match(ACTIVITY_PATH)?.[1] || '';
    if (!READABLE_MODULES.has(module) || !/^\d{1,12}$/.test(url.searchParams.get('id') || '') || url.searchParams.getAll('id').length !== 1) {
      throw new Error('只支持课程首页、Page、Book 和 Folder 等静态只读页面；测验、作业、论坛和提交页面不会读取');
    }
    const allowed = module === 'book' ? new Set(['id', 'chapterid']) : new Set(['id']);
    if (keys.some(key => !allowed.has(key)) || (url.searchParams.has('chapterid') && (!/^\d{1,12}$/.test(url.searchParams.get('chapterid') || '') || url.searchParams.getAll('chapterid').length !== 1))) {
      throw new Error('当前活动地址包含交互参数，已拒绝讲解');
    }
    pageKind = module === 'page' ? 'Page' : module === 'book' ? 'Book' : 'Folder';
  }
  const main = doc.querySelector?.('#region-main, main, [role="main"]');
  const readable = main?.cloneNode ? main.cloneNode(true) : main;
  if (readable?.querySelectorAll) removeNoise(readable);
  const text = structuredText(readable, PAGE_TEXT_LIMIT + 1);
  if (text.length < 40) throw new Error('当前静态页面没有足够的可读课程文字');
  const title = cleanText(doc.querySelector?.('.page-header-headings h1, #page-header h1, main h1, h1')?.textContent || doc.title || pageKind).slice(0, 180);
  const courseIds = COURSE_PATH.test(url.pathname) ? [url.searchParams.get('id')] :
    [...doc.querySelectorAll('.breadcrumb a[href], nav[aria-label="Breadcrumb"] a[href], #page-header a[href]')]
      .map(anchor => courseUrl(anchor.getAttribute('href'), url.href)?.id).filter(Boolean);
  if (!courseIds.length || new Set(courseIds).size !== 1) throw new Error('无法确认当前页面所属课程');
  return { courseId: courseIds[0], title: title || pageKind, url: url.href, excerpt: text.slice(0, PAGE_TEXT_LIMIT), truncated: text.length > PAGE_TEXT_LIMIT, pageKind };
}

function validBackgroundSender(sender, chromeApi = chrome) {
  if (!sender || sender.id !== chromeApi.runtime?.id) return false;
  if (!sender.url) return true;
  try { return sender.url === chromeApi.runtime.getURL('background.js'); }
  catch { return false; }
}

function sectionFor(anchor) {
  const section = anchor.closest('li.course-section, [data-region="section"], li.section');
  if (!section) return '';
  return cleanText(section.querySelector('.sectionname, .section-title, h2, h3')?.textContent).slice(0, 120);
}

function linkTitle(anchor, target) {
  const title = cleanText(anchor.getAttribute('aria-label') || anchor.textContent || anchor.getAttribute('title'));
  if (title) return title.slice(0, 180);
  try { return decodeURIComponent(target.pathname.split('/').pop()).slice(0, 180); }
  catch { return target.pathname.split('/').pop(); }
}

function eventActivityUrl(value, base = ROOT) {
  const url = normaliseUrl(value, base);
  const module = url?.pathname.match(ACTIVITY_PATH)?.[1];
  if (!url || !module || !/^\d{1,12}$/.test(url.searchParams.get('id') || '') || url.searchParams.getAll('id').length !== 1) return null;
  const keys = [...url.searchParams.keys()];
  const editSubmission = module === 'assign' && url.searchParams.get('action') === 'editsubmission' && keys.every(key => key === 'id' || key === 'action');
  if (keys.some(key => /^(action|sesskey|delete|edit|submit|attempt|grade)$/i.test(key)) && !editSubmission) return null;
  return new URL(`${ROOT}${url.pathname}?id=${encodeURIComponent(url.searchParams.get('id'))}`);
}

function extractUpcomingEvents(doc, course) {
  const address = courseUrl(course?.url);
  const selectedId = String(course?.id ?? address?.id ?? '');
  if (!address || address.id !== selectedId) return [];
  const courseTitle = cleanText(course?.title).slice(0, 180) || `Course ${selectedId}`;
  const events = [];
  const seen = new Set();
  const containers = doc.querySelectorAll?.('.block.event') || [];
  for (const item of containers) {
    if (cleanText(item.getAttribute?.('data-course-id')) !== selectedId) continue;
    const anchors = [...(item.querySelectorAll?.('a[href]') || [])];
    const day = anchors.map(anchor => normaliseUrl(anchor.getAttribute('href'), address.url)).find(url =>
      url?.pathname === '/calendar/view.php' && url.searchParams.get('view') === 'day' &&
      /^\d{1,12}$/.test(url.searchParams.get('time') || '') && url.searchParams.getAll('time').length === 1);
    if (!day) continue;
    const unixSeconds = Number(day.searchParams.get('time'));
    const timestampMs = unixSeconds * 1000;
    if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) continue;
    const activity = anchors.map(anchor => ({ anchor, url: eventActivityUrl(anchor.getAttribute('href'), address.url) })).find(candidate => candidate.url);
    if (!activity) continue;
    const module = activity.url.pathname.match(ACTIVITY_PATH)?.[1] || '';
    const component = cleanText(item.getAttribute?.('data-event-component')).slice(0, 80) || `mod_${module}`;
    const eventType = cleanText(item.getAttribute?.('data-event-type') || item.getAttribute?.('data-event-eventtype')).slice(0, 40) || 'other';
    const title = cleanText(item.getAttribute?.('data-event-title') || activity.anchor.getAttribute('aria-label') ||
      activity.anchor.textContent || activity.anchor.getAttribute('title')).slice(0, 180);
    if (!title) continue;
    const activityUrl = activity.url.href;
    const key = `${selectedId}\n${activityUrl}\n${timestampMs}\n${component}\n${eventType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rawId = cleanText(item.getAttribute?.('data-event-id')).slice(0, 80);
    const dayAnchor = anchors.find(anchor => {
      const url = normaliseUrl(anchor.getAttribute?.('href'), address.url);
      return url?.href === day.href;
    });
    const dayText = cleanText(dayAnchor?.textContent || dayAnchor?.getAttribute?.('aria-label') || dayAnchor?.getAttribute?.('title')).slice(0, 240);
    const rawText = cleanText(item.textContent).slice(0, 800);
    // 只有 Moodle 同一事件容器中确实包含标题和可见日期文字时，才把它标为逐字证据。
    const verbatim = !!(rawText && dayText && rawText.includes(dayText) && rawText.includes(title));
    const evidence = {
      schemaVersion: 1,
      rawText: verbatim ? rawText : '',
      normalizedText: verbatim ? rawText : '',
      verbatim,
      title: { value: title, source: item.getAttribute?.('data-event-title') ? 'data-event-title' : 'activity-anchor-text' },
      dateTime: { value: dayText, source: 'day-anchor-text' },
      eventType: { value: eventType, source: item.getAttribute?.('data-event-type') || item.getAttribute?.('data-event-eventtype') ? 'data-event-type' : 'fallback' }
    };
    if (!verbatim) evidence.derivedDateTime = { timestampMs, source: 'calendar-day-link-time' };
    const sourceVersion = briefTextHash(`${activityUrl}\n${timestampMs}\n${JSON.stringify(evidence)}`);
    events.push({
      id: rawId ? `moodle:${selectedId}:${rawId}` : `moodle:${selectedId}:${component}:${eventType}:${timestampMs}:${activity.url.searchParams.get('id')}`,
      courseId: selectedId,
      title,
      component,
      eventType,
      timestampMs,
      courseTitle,
      courseUrl: address.url,
      activityUrl,
      sourceVersion,
      evidence
    });
  }
  return events.sort((a, b) => a.timestampMs - b.timestampMs || a.title.localeCompare(b.title));
}

async function syncCourseEvents(course) {
  const address = courseUrl(course?.url);
  if (!address || address.id !== String(course?.id)) throw new Error('课程地址无效');
  const calendar = await getHtml(`${ROOT}/calendar/view.php?view=upcoming`);
  const finalCalendar = normaliseUrl(calendar.url);
  if (!finalCalendar || finalCalendar.pathname !== '/calendar/view.php' || finalCalendar.searchParams.get('view') !== 'upcoming' ||
      finalCalendar.searchParams.getAll('view').length !== 1 || [...finalCalendar.searchParams.keys()].some(key => key !== 'view')) {
    throw new Error('Moodle 日历跳转到了非预期页面');
  }
  return { events: extractUpcomingEvents(calendar.doc, { ...course, id: address.id, url: address.url }) };
}

function assessmentColumn(value) {
  const label = cleanText(value).toLocaleLowerCase('en-AU');
  if (/^(?:assessment|assessment task|task|考核|考核项目|作业)$/u.test(label)) return 'title';
  if (/issue|release|发布|布置/u.test(label)) return 'issueText';
  if (/weight|占比|权重/u.test(label)) return 'weightingText';
  if (/length|duration|time allowed|时长|时间/u.test(label)) return 'lengthText';
  if (/clo|learning outcome|课程学习成果|学习成果/u.test(label)) return 'outcomesText';
  if (/due|截止/u.test(label)) return 'dueText';
  if (/feedback|反馈/u.test(label)) return 'feedbackText';
  return '';
}

function assessmentCellSpan(cell, name) {
  const property = name === 'rowspan' ? cell?.rowSpan : cell?.colSpan;
  const attribute = Number(cell?.getAttribute?.(name));
  return Number.isInteger(property) && property > 0 ? property : Number.isInteger(attribute) && attribute > 0 ? attribute : 1;
}

function extractAssessmentSnapshot(doc, course) {
  const address = courseUrl(course?.url);
  const courseId = String(course?.id ?? address?.id ?? '');
  if (!address || address.id !== courseId) return { items: [], parseStatus: 'invalid-course', recognizedTables: 0, unsupportedTables: 0, malformedRows: 0, truncated: false };
  const root = doc.querySelector?.('#region-main, main, [role="main"]') || doc;
  const output = [], seen = new Set();
  let recognizedTables = 0, unsupportedTables = 0, malformedRows = 0, truncatedCells = 0, truncated = false;
  for (const table of root.querySelectorAll?.('table') || []) {
    const rows = [...(table.querySelectorAll?.('tr') || [])];
    if (rows.length < 2) continue;
    let headerIndex = -1, headerCells = [], headers = [], fields = [];
    for (let index = 0; index < Math.min(rows.length - 1, 3); index++) {
      const candidateCells = [...(rows[index].querySelectorAll?.('th,td') || [])];
      const candidateHeaders = candidateCells.map(cell => cleanText(cell.textContent).slice(0, 100));
      const candidateFields = candidateHeaders.map(assessmentColumn);
      if (candidateFields.includes('title') && candidateFields.filter(Boolean).length >= 2) {
        headerIndex = index; headerCells = candidateCells; headers = candidateHeaders; fields = candidateFields; break;
      }
    }
    if (!fields.includes('title') || fields.filter(Boolean).length < 2) continue;
    recognizedTables++;
    const hasMergedCells = rows.some(row => [...(row.querySelectorAll?.('th,td') || [])]
      .some(cell => assessmentCellSpan(cell, 'rowspan') > 1 || assessmentCellSpan(cell, 'colspan') > 1));
    if (hasMergedCells || headerIndex > 0) { unsupportedTables++; continue; }
    const section = table.closest?.('li.course-section, [data-region="section"]');
    const sectionId = /^section-\d+$/u.test(section?.id || '') ? section.id : '';
    const sourceUrl = sectionId ? `${address.url}#${sectionId}` : address.url;
    for (const [rowOffset, row] of rows.slice(headerIndex + 1).entries()) {
      const rawCells = [...(row.querySelectorAll?.('th,td') || [])];
      if (rawCells.length !== fields.length) { if (rawCells.length) malformedRows++; continue; }
      const originalCells = rawCells.map(cell => cleanText(cell.textContent));
      if (originalCells.some(value => value.length > 300)) truncatedCells++;
      const cells = originalCells.map(value => value.slice(0, 300));
      if (!cells.length) continue;
      const fact = {};
      for (let index = 0; index < fields.length; index++) if (fields[index] && cells[index]) fact[fields[index]] = cells[index];
      const title = cleanText(fact.title).slice(0, 180);
      if (title.length < 2 || assessmentColumn(title) === 'title') continue;
      // 同列数并不代表列语义正确；明显颠倒或无意义的行必须失败关闭。
      if (!/\p{L}/u.test(title) || (fact.weightingText && !/\d/u.test(fact.weightingText))) { malformedRows++; continue; }
      const canonical = title.normalize('NFKC').toLocaleLowerCase('en-AU').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 80);
      if (!canonical) continue;
      let id = `assessment:${courseId}:${canonical}`, suffix = 2;
      while (seen.has(id)) id = `assessment:${courseId}:${canonical}:${suffix++}`;
      seen.add(id);
      const exactWeight = String(fact.weightingText || '').match(/^\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/u);
      const evidence = headers.map((header, index) => header && cells[index] ? `${header}: ${cells[index]}` : '').filter(Boolean).join(' | ').slice(0, 1400);
      const titleIndex = fields.indexOf('title');
      const titleCell = titleIndex >= 0 ? rawCells[titleIndex] : null;
      const assignCandidates = [...(titleCell?.querySelectorAll?.('a[href]') || [])].map(anchor => normaliseUrl(anchor.getAttribute('href'), address.url))
        .filter(url => url?.pathname === '/mod/assign/view.php');
      const validAssign = assignCandidates.map(url => assignmentBriefUrl(url.href)).filter(Boolean);
      const assignmentActivityId = assignCandidates.length === 1 && validAssign.length === 1 ? validAssign[0].searchParams.get('id') : '';
      const sourceVersion = briefTextHash(`${sourceUrl}\n${evidence}\nassessment-row-v${ASSESSMENT_EXTRACTOR_VERSION}`);
      output.push({
        schemaVersion: 1, id, courseId, title, issueText: String(fact.issueText || ''), weightingText: String(fact.weightingText || ''),
        explicitWeight: exactWeight && Number(exactWeight[1]) <= 100 ? Number(exactWeight[1]) : null,
        lengthText: String(fact.lengthText || ''), outcomesText: String(fact.outcomesText || ''), dueText: String(fact.dueText || ''),
        feedbackText: String(fact.feedbackText || ''), evidence, sourceUrl, sourceVersion, extractorVersion: ASSESSMENT_EXTRACTOR_VERSION,
        rowOrdinal: rowOffset + 1,
        evidenceRef: { schemaVersion: 1, courseId, sourceKind: 'assessment-row', sourceId: id, sourceVersion, span: { start: 0, end: evidence.length }, quote: evidence, url: sourceUrl },
        assignmentActivityId,
        briefLinkStatus: assignmentActivityId ? 'activity-url' : assignCandidates.length ? 'ambiguous' : 'none'
      });
      if (output.length >= 30) { truncated = true; break; }
    }
    if (truncated) break;
  }
  const parseStatus = unsupportedTables || malformedRows || truncatedCells || truncated ? (output.length ? 'partial' : 'unsupported')
    : recognizedTables ? 'complete' : 'not-found';
  return { items: output, parseStatus, recognizedTables, unsupportedTables, malformedRows, truncatedCells, truncated };
}

function extractAssessmentFacts(doc, course) { return extractAssessmentSnapshot(doc, course).items; }

function removeNoise(root) {
  root.querySelectorAll('script, style, template, noscript, svg, canvas, nav, form, button, input, select, textarea, [hidden], [style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [style*="visibility:hidden"], .activity-navigation, .secondary-navigation, .usermenu, .block, .coursecompletion, .completionprogress, .progress, [role="progressbar"], .activity-completion, [data-region="completion-info"], .userprogress, .user-progress, [class*="sia-chrome"], [aria-hidden="true"]').forEach(el => el.remove());
}

function extractCourseSections(doc, url, courseId) {
  const root = doc.querySelector?.('#region-main');
  const sections = root ? [...root.querySelectorAll('li.course-section, [data-region="section"]')] : [];
  const pages = [];
  let skippedParts = 0;
  for (const section of sections) {
    const title = cleanText(section.querySelector('.sectionname, .section-title, h2, h3')?.textContent || section.id || '课程章节').slice(0, 180);
    const clone = section.cloneNode(true);
    removeNoise(clone);
    const scanLimit = COURSE_PART_LIMIT * (MAX_COURSE_PARTS - pages.length) + 1;
    const text = structuredText(clone, scanLimit);
    const total = Math.ceil(text.length / COURSE_PART_LIMIT);
    const sourceUrl = /^section-\d+$/.test(section.id || '') ? `${url}#${section.id}` : url;
    for (let i = 0; i < total; i++) {
      if (pages.length >= MAX_COURSE_PARTS) { skippedParts += total - i; break; }
      pages.push({ id: `${sourceUrl}:part-${i + 1}`, courseId, url: sourceUrl, title: `${title} · ${i + 1}/${total}`, section: title, sectionGroup: title, text: text.slice(i * COURSE_PART_LIMIT, (i + 1) * COURSE_PART_LIMIT), textTruncated: false, links: [], syncedAt: new Date().toISOString() });
    }
  }
  return { pages, skippedParts };
}

function extractPage(doc, url, courseId, section = '') {
  const root = doc.querySelector('#region-main') || doc.querySelector('main, [role="main"]') || doc.body;
  if (!root) throw new Error('页面缺少正文');
  const clone = root.cloneNode(true);
  removeNoise(clone);
  const title = cleanText(doc.querySelector('.page-header-headings h1, h1')?.textContent || doc.title).slice(0, 180);
  const fullText = structuredText(clone, PAGE_TEXT_LIMIT + 1);
  const links = [];
  const seen = new Set();
  for (const anchor of root.querySelectorAll('a[href]')) {
    // 前后活动导航不是本页资料；保留真实正文、课程卡片和文件夹内的链接。
    if (anchor.closest('nav, .activity-navigation, .secondary-navigation, .usermenu, .block')) continue;
    const target = normaliseUrl(anchor.getAttribute('href'), url);
    if (!target) continue;
    const module = target.pathname.match(ACTIVITY_PATH)?.[1];
    const isFile = FILE_PATH.test(target.pathname) || /\.(pdf|docx?|pptx?|xlsx?|txt|csv|zip)$/i.test(target.pathname) || module === 'resource';
    const type = isFile ? 'file' : assignmentBriefUrl(target.href) ? 'assignment-brief' : readableActivityUrl(target) ? 'activity' : REFERENCE_MODULES.has(module) ? 'reference' : null;
    if (!type || seen.has(target.href)) continue;
    seen.add(target.href);
    links.push({ url: target.href, title: linkTitle(anchor, target), type, section: sectionFor(anchor) || section });
  }
  return { id: url, courseId, url, title, section, sectionGroup: section || title, text: fullText.slice(0, PAGE_TEXT_LIMIT), textTruncated: fullText.length > PAGE_TEXT_LIMIT, links, syncedAt: new Date().toISOString() };
}

async function getHtml(value) {
  const url = normaliseUrl(value);
  if (!url) throw new Error('Moodle 地址无效');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const finalUrl = normaliseUrl(response.url);
    if (!finalUrl) throw new Error('跳转到了 Moodle 站外');
    if (/\/login\/|\/auth\//.test(finalUrl.pathname)) throw new Error('Moodle 登录已过期');
    if (finalUrl.pathname !== url.pathname || finalUrl.searchParams.get('id') !== url.searchParams.get('id')) {
      const error = new Error('页面跳转到了其他课程或活动');
      if (ACTIVITY_PATH.test(url.pathname) && COURSE_PATH.test(finalUrl.pathname)) {
        error.code = 'ACTIVITY_RETURNED_TO_COURSE';
        error.courseId = finalUrl.searchParams.get('id');
      }
      throw error;
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) throw new Error('页面不是 HTML');
    if (Number(response.headers.get('content-length')) > MAX_HTML_BYTES) throw new Error('HTML 页面过大');
    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) throw new Error('HTML 页面过大');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const access = classifyMoodleDocument(doc);
    if (!access.ok) {
      const error = new Error(access.message); error.code = access.reasonCode === 'login-required' ? 'MOODLE_LOGIN_REQUIRED' : access.reasonCode === 'not-found' ? 'MOODLE_NOT_FOUND' : 'MOODLE_ACCESS_DENIED';
      throw error;
    }
    return { doc, url: response.url };
  } finally { clearTimeout(timer); }
}

const fileTransfers = new Map();
const fileDownloadControllers = new Set();
let fileFetches = 0;
function releaseFileTransfer(id) {
  const entry = fileTransfers.get(id);
  if (entry) { clearTimeout(entry.timer); fileTransfers.delete(id); }
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => {
  for (const controller of fileDownloadControllers) controller.abort();
  for (const id of fileTransfers.keys()) releaseFileTransfer(id);
});
function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件编码失败'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(blob);
  });
}
async function fileTransferChunk(message, accountId) {
  const entry = fileTransfers.get(message.transferId);
  if (!entry || entry.accountId !== accountId || entry.expiresAt <= Date.now()) throw new Error('文件传输已过期');
  if (message.type === 'RELEASE_FILE_TRANSFER') { releaseFileTransfer(message.transferId); return { released: true }; }
  if (!Number.isSafeInteger(message.offset) || message.offset < 0 || message.offset >= entry.blob.size || message.offset % 2_000_000 !== 0) throw new Error('文件分块位置无效');
  const chunk = entry.blob.slice(message.offset, message.offset + 2_000_000);
  const base64 = await blobBase64(chunk);
  if (currentAccount() !== accountId) { releaseFileTransfer(message.transferId); throw new Error('同步期间 Moodle 登录账号发生变化'); }
  return { base64, offset: message.offset, size: chunk.size };
}

async function fetchFile(file, accountId) {
  const url = normaliseUrl(file?.url);
  if (!url || !(FILE_PATH.test(url.pathname) || url.pathname === '/mod/resource/view.php' || /\.(pdf|docx?|pptx?|xlsx?|txt|csv)$/i.test(url.pathname))) throw new Error('不支持此文件地址');
  for (const [id, entry] of fileTransfers) if (entry.expiresAt <= Date.now() || entry.accountId !== accountId) releaseFileTransfer(id);
  if (fileFetches + fileTransfers.size >= 2) throw new Error('文件传输忙，请稍后重试');
  fileFetches++;
  const maxBytes = file.chunked === true ? 100_000_000 : MAX_FILE_BYTES;
  const controller = new AbortController();
  fileDownloadControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), file.chunked === true ? 90_000 : 30_000);
  try {
    const headers = {};
    if (file.allowNotModified === true) {
      if (typeof file.etag === 'string' && file.etag.length <= 512 && !/[\r\n]/u.test(file.etag)) headers['If-None-Match'] = file.etag;
      if (typeof file.lastModified === 'string' && file.lastModified.length <= 100 && !/[\r\n]/u.test(file.lastModified)) headers['If-Modified-Since'] = file.lastModified;
    }
    const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'follow', signal: controller.signal, headers });
    if (!normaliseUrl(response.url)) throw new Error('文件跳转到了 Moodle 站外');
    const etag = (response.headers.get('etag') || '').slice(0, 512), lastModified = (response.headers.get('last-modified') || '').slice(0, 100);
    if (response.status === 304 && file.allowNotModified === true && Object.keys(headers).length) return { notModified: true, etag: etag || file.etag || '', lastModified: lastModified || file.lastModified || '' };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!normaliseUrl(response.url)) throw new Error('文件跳转到了 Moodle 站外');
    const mime = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].toLowerCase();
    if (mime.includes('html')) {
      // 资源隐藏时 Moodle 返回 HTML；仅限量读取错误页分类，绝不把它当文档正文入库。
      if (Number(response.headers.get('content-length')) > MAX_HTML_BYTES || !response.body) throw new Error('此资源没有可解析的文档正文');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let html = '', bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { html += decoder.decode(); break; }
          bytes += value.byteLength;
          if (bytes > MAX_HTML_BYTES) throw new Error('此资源没有可解析的文档正文');
          html += decoder.decode(value, { stream: true });
        }
      } finally { await reader.cancel(); }
      const access = classifyMoodleDocument(new DOMParser().parseFromString(html, 'text/html'));
      if (!access.ok) throw Object.assign(new Error(access.message), { code: access.reasonCode === 'not-found' ? 'MOODLE_NOT_FOUND' : 'MOODLE_ACCESS_DENIED' });
      throw new Error('此资源没有可解析的文档正文');
    }
    if (/^(image|audio|video)\//.test(mime)) throw new Error('此资源没有可解析的文档正文');
    const officeFile = /\.(pptx|docx|xlsx)$/i.test(new URL(response.url).pathname) || mime.includes('officedocument');
    const readOfficeText = async () => {
      if (!officeFile || !globalThis.AskmeOfficeRange) throw new Error(`文件超过 ${maxBytes / 1_000_000} MB 上限`);
      // 大型 Office 只传输全部正文 XML，媒体留在 Moodle；引用仍指向原始课程文件。
      const selected = await globalThis.AskmeOfficeRange.extract({ url: response.url, signal: controller.signal, maxBytes: MAX_FILE_BYTES });
      const base64 = await blobBase64(selected.blob);
      if (controller.signal.aborted) throw Object.assign(new Error('文件读取超时'), { code: 'OFFICE_RANGE_ABORTED' });
      if (currentAccount() !== accountId) throw new Error('同步期间 Moodle 登录账号发生变化');
      return { base64, mime: selected.blob.type || mime, size: selected.blob.size,
        etag: selected.metadata.etag || '', lastModified: selected.metadata.lastModified || '' };
    };
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); return await readOfficeText(); }
    if (!response.body) throw new Error('无法读取文件流');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); chunks.length = 0; return await readOfficeText(); }
      chunks.push(value);
    }
    const blob = new Blob(chunks, { type: mime });
    chunks.length = 0;
    if (size > MAX_FILE_BYTES) {
      // 大文件只在当前文档内短期保留，通过小块消息发送，避免 Chrome 消息体上限。
      const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      if (controller.signal.aborted) throw new Error('文件传输已取消');
      if (currentAccount() !== accountId) throw new Error('同步期间 Moodle 登录账号发生变化');
      const contentDigest = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
      const transferId = [...crypto.getRandomValues(new Uint8Array(24))].map(n => n.toString(16).padStart(2, '0')).join('');
      const expiresAt = Date.now() + 120_000;
      const expiry = setTimeout(() => releaseFileTransfer(transferId), 120_000);
      fileTransfers.set(transferId, { blob, accountId, expiresAt, timer: expiry });
      return { transferId, contentDigest, mime, size, etag, lastModified };
    }
    const base64 = await blobBase64(blob);
    return { base64, mime, size, etag, lastModified };
  } finally { fileFetches--; fileDownloadControllers.delete(controller); clearTimeout(timer); }
}

function verifyActivityCourse(doc, pageUrl, courseId) {
  const breadcrumb = doc.querySelectorAll('.breadcrumb a[href], nav[aria-label="Breadcrumb"] a[href], #page-header a[href]');
  const ids = [...breadcrumb].map(anchor => courseUrl(anchor.getAttribute('href'), pageUrl)?.id).filter(Boolean);
  if (!ids.length || ids.some(id => id !== courseId)) throw new Error('无法确认活动属于所选课程');
}

function activityDatesUrl(value) {
  const url = normaliseUrl(value);
  if (!url || typeof value !== 'string' || url.href !== value || !/^\/mod\/(assign|quiz)\/view\.php$/u.test(url.pathname)) return null;
  const keys = [...url.searchParams.keys()], ids = url.searchParams.getAll('id');
  if (keys.length !== 1 || keys[0] !== 'id' || ids.length !== 1 || !/^\d{1,12}$/u.test(ids[0])) return null;
  return new URL(`${ROOT}${url.pathname}?id=${encodeURIComponent(ids[0])}`);
}

function extractActivityDates(doc, pageUrl, courseId) {
  const source = activityDatesUrl(pageUrl);
  if (!source) throw new Error('活动日期地址无效');
  const module = source.pathname.split('/')[2];
  if (doc?.body?.id !== `page-mod-${module}-view`) throw new Error('活动日期页面模板不受支持');
  verifyActivityCourse(doc, source.href, String(courseId));
  const title = cleanText(doc.querySelector?.('.page-header-headings h1, #page-header h1, h1')?.textContent).slice(0, 180);
  if (!title) throw new Error('活动日期页面缺少标题');
  // 只读取 Moodle 明确的静态日期区域；intro、提交状态和评分表不属于此来源。
  const roots = [...doc.querySelectorAll('#region-main .activity-information .activity-dates')];
  if (roots.length !== 1 || sensitiveBriefDom(roots[0])) return [];
  const hidden = element => {
    for (let node = element; node; node = node.parentElement) {
      const style = String(node.getAttribute?.('style') || '').replace(/\s+/gu, '').toLowerCase();
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true' || style.includes('display:none') || style.includes('visibility:hidden')) return true;
    }
    return false;
  };
  const dateRow = element => {
    if (hidden(element)) return null;
    const excerpt = cleanText(element.textContent);
    const match = /^(Due|Opened|Opens|Closed|Closes):\s*(\S.*)$/iu.exec(excerpt);
    if (!match || excerpt.length > 400 || !/\d/u.test(match[2]) || /(?:^|\s)(?:Due|Opened|Opens|Closed|Closes):/iu.test(match[2]) ||
        element.querySelector('script,style,template,noscript') || [...element.querySelectorAll('*')].some(child => hidden(child))) return null;
    return { title, url: source.href, excerpt, eventType: /^due$/iu.test(match[1]) ? 'due' : /^open/iu.test(match[1]) ? 'open' : 'close' };
  };
  const sources = [], seen = new Set();
  for (const element of [roots[0], ...roots[0].querySelectorAll('div,p,li')]) {
    const row = dateRow(element);
    if (!row || [...element.querySelectorAll('div,p,li')].some(child => dateRow(child)) || seen.has(row.excerpt)) continue;
    seen.add(row.excerpt); sources.push(row);
  }
  // 过多或混合的日期行不截断后冒充完整静态来源。
  return sources.length <= 6 ? sources : [];
}

async function readActivityDates(course, activities) {
  const address = courseUrl(course?.url);
  if (!address || address.id !== String(course?.id) || address.url !== course.url) throw new Error('课程地址无效');
  if (!Array.isArray(activities) || activities.length < 1 || activities.length > 3) throw new Error('活动日期读取数量无效');
  const selected = activities.map(activity => {
    const url = typeof activity?.url === 'string' && activity.url.length <= 2048 ? activityDatesUrl(activity.url) : null;
    if (!url || url.href !== activity.url || typeof activity.title !== 'string' || activity.title.length > 180) throw new Error('活动日期读取参数无效');
    return url;
  });
  const sources = [], visited = new Set();
  for (const url of selected) {
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    const fetched = await getHtml(url.href);
    const finalUrl = activityDatesUrl(fetched.url);
    if (!finalUrl || finalUrl.href !== url.href) throw new Error('活动日期页面跳转到了其他地址');
    sources.push(...extractActivityDates(fetched.doc, finalUrl.href, address.id));
  }
  return { sources };
}

async function retryActivity(courseId, activity) {
  const selectedId = String(courseId ?? '');
  if (!/^\d{1,12}$/.test(selectedId)) throw new Error('课程 ID 无效');
  if (!activity || typeof activity !== 'object' || typeof activity.url !== 'string' || activity.url.length > 2048 ||
      typeof activity.title !== 'string' || activity.title.length > 180 ||
      typeof activity.section !== 'string' || activity.section.length > 120) throw new Error('活动信息无效');
  const address = normaliseUrl(activity.url);
  if (!readableActivityUrl(address)) throw new Error('静态活动地址无效');
  const item = { url: address.href, title: cleanText(activity.title), section: cleanText(activity.section) };
  try {
    const result = await getHtml(address.href);
    verifyActivityCourse(result.doc, result.url, selectedId);
    const page = extractPage(result.doc, result.url, selectedId, item.section || item.title);
    return { status: 'ok', page, files: page.links.filter(link => link.type === 'file') };
  } catch (error) {
    if ((error.code === 'ACTIVITY_RETURNED_TO_COURSE' && error.courseId === selectedId) || error.code === 'MOODLE_ACCESS_DENIED') {
      return { status: 'unavailable', item: { ...item, reason: error.code === 'MOODLE_ACCESS_DENIED' ? 'Moodle 当前不允许访问此活动' : 'Moodle 将此活动跳回课程首页' } };
    }
    throw error;
  }
}

async function syncCourse(course) {
  const address = courseUrl(course?.url);
  if (!address || address.id !== String(course?.id)) throw new Error('课程地址无效');
  const home = await getHtml(address.url);
  const main = extractPage(home.doc, home.url, address.id);
  let events = [];
  let eventSyncError = '';
  try {
    ({ events } = await syncCourseEvents({ ...course, id: address.id, url: address.url, title: course?.title || main.title }));
  } catch (error) { eventSyncError = error?.message || String(error); }
  const sections = extractCourseSections(home.doc, home.url, address.id);
  const assessmentSnapshot = extractAssessmentSnapshot(home.doc, { ...course, id: address.id, url: address.url });
  if (sections.pages.length) { main.text = main.title; main.textTruncated = false; main.section = '课程首页'; main.sectionGroup = '课程首页'; }
  const pages = [main, ...sections.pages];
  const files = new Map(main.links.filter(link => link.type === 'file').map(link => [link.url, link]));
  const activities = main.links.filter(link => link.type === 'activity');
  const allAssignmentLinks = [...new Map(main.links.filter(link => link.type === 'assignment-brief').map(link => [assignmentBriefUrl(link.url)?.searchParams.get('id'), link])).values()]
    .filter(link => assignmentBriefUrl(link.url));
  const assignmentLinks = allAssignmentLinks.slice(0, MAX_ASSIGNMENT_BRIEFS);
  const queued = new Set(activities.map(link => link.url));
  const errors = [];
  const failedActivities = [];
  const unavailableActivities = [];
  let processed = 0;
  while (processed < activities.length && processed < MAX_PAGES - 1) {
    const link = activities[processed++];
    try {
      if (!readableActivityUrl(normaliseUrl(link.url))) throw new Error('静态活动地址无效');
      const activity = await getHtml(link.url);
      verifyActivityCourse(activity.doc, activity.url, address.id);
      const page = extractPage(activity.doc, activity.url, address.id, link.section || link.title);
      pages.push(page);
      for (const file of page.links.filter(item => item.type === 'file')) files.set(file.url, file);
      for (const nested of page.links.filter(item => item.type === 'activity')) {
        if (!queued.has(nested.url)) { queued.add(nested.url); activities.push(nested); }
      }
    } catch (error) {
      if ((error.code === 'ACTIVITY_RETURNED_TO_COURSE' && error.courseId === address.id) || error.code === 'MOODLE_ACCESS_DENIED') unavailableActivities.push({ title: link.title, url: link.url, section: link.section || '', reason: error.code === 'MOODLE_ACCESS_DENIED' ? 'Moodle 当前不允许访问此活动' : 'Moodle 将此活动跳回课程首页' });
      else {
        errors.push(`${link.title}: ${error.message}`);
        failedActivities.push({ url: link.url, title: link.title, section: link.section || '', error: error.message });
      }
    }
  }
  const skippedPages = activities.length - processed;
  const truncatedPages = pages.filter(page => page.textTruncated).length;
  const assignmentBriefs = [];
  const assignmentBriefResults = [];
  for (const link of assignmentLinks) {
    const canonical = assignmentBriefUrl(link.url);
    const activityId = canonical?.searchParams.get('id') || '';
    try {
      const fetched = await getHtml(canonical.href);
      const finalUrl = assignmentBriefUrl(fetched.url);
      if (!finalUrl || finalUrl.searchParams.get('id') !== activityId) throw new Error('assignment-redirect');
      const extracted = extractAssignmentBrief(fetched.doc, finalUrl.href, address.id, link);
      if (extracted.status !== 'complete' || !extracted.brief) throw new Error(extracted.errorCode || extracted.status);
      assignmentBriefs.push(extracted.brief);
      assignmentBriefResults.push({ activityId, status: 'complete', errorCode: '', attemptedAt: new Date().toISOString(), lastSuccessAt: extracted.brief.syncedAt });
    } catch (error) {
      assignmentBriefResults.push({ activityId, status: 'failed', errorCode: assignmentBriefErrorCode(error), attemptedAt: new Date().toISOString(), lastSuccessAt: null });
    }
  }
  const assignmentBriefScan = {
    discovered: allAssignmentLinks.length,
    attempted: assignmentLinks.length,
    succeeded: assignmentBriefResults.filter(item => item.status === 'complete').length,
    failed: assignmentBriefResults.filter(item => item.status !== 'complete').length,
    overflow: Math.max(0, allAssignmentLinks.length - assignmentLinks.length),
    complete: assignmentBriefResults.every(item => item.status === 'complete') && allAssignmentLinks.length === assignmentLinks.length
  };
  const assignmentBriefParseStatus = !allAssignmentLinks.length ? 'not-found' : assignmentBriefScan.complete ? 'complete' : 'partial';
  return {
    pages, files: [...files.values()], assessments: assessmentSnapshot.items,
    assessmentParseStatus: assessmentSnapshot.parseStatus,
    assessmentParseIssues: assessmentSnapshot.unsupportedTables + assessmentSnapshot.malformedRows + assessmentSnapshot.truncatedCells,
    assessmentTruncated: assessmentSnapshot.truncated,
    assignmentBriefs, assignmentBriefResults, assignmentBriefParseStatus, assignmentBriefScan,
    events, eventSyncError, errors, failedActivities, unavailableActivities,
    truncated: skippedPages > 0 || truncatedPages > 0 || sections.skippedParts > 0,
    skippedPages, truncatedPages, skippedCourseParts: sections.skippedParts
  };
}

const CONTENT_RUNTIME_MESSAGE_TYPES = new Set(['PING', 'DISCOVER', 'GET_CURRENT_PAGE_SOURCE', 'SYNC_COURSE', 'SYNC_COURSE_EVENTS', 'READ_ACTIVITY_DATES', 'FETCH_FILE', 'FETCH_FILE_CHUNK', 'RELEASE_FILE_TRANSFER', 'RETRY_ACTIVITY']);

function handleContentRuntimeMessage(message, sender, sendResponse) {
    // 同一 content script 还有内嵌握手监听器。先按消息类型声明所有权，避免课程
    // 监听器对 READY 确认等后台定向消息做账号校验并抢先 sendResponse。
    if (!CONTENT_RUNTIME_MESSAGE_TYPES.has(message?.type)) return false;
    let accountId;
    try { accountId = currentAccount(); }
    catch (error) { sendResponse({ ok: false, contentVersion: CONTENT_VERSION, error: error.message }); return false; }
    if (message?.type === 'PING') { sendResponse({ ok: true, contentVersion: CONTENT_VERSION, accountId }); return false; }
    if (message?.expectedUserId !== accountId) { sendResponse({ ok: false, contentVersion: CONTENT_VERSION, accountId, error: 'Moodle 登录账号与 Askme 数据空间不一致' }); return false; }
    const finish = payload => {
      try {
        const current = currentAccount();
        if (current !== accountId) return sendResponse({ ok: false, contentVersion: CONTENT_VERSION, accountId: current, error: '同步期间 Moodle 登录账号发生变化' });
        sendResponse({ ...payload, contentVersion: CONTENT_VERSION, accountId });
      } catch (error) { sendResponse({ ok: false, contentVersion: CONTENT_VERSION, error: error.message }); }
    };
    if (message?.type === 'DISCOVER') { sendResponse({ ok: true, contentVersion: CONTENT_VERSION, accountId, courses: discover() }); return false; }
    if (message?.type === 'GET_CURRENT_PAGE_SOURCE') {
      if (!validBackgroundSender(sender)) { sendResponse({ ok: false, contentVersion: CONTENT_VERSION, accountId, error: '当前页面读取请求来源无效' }); return false; }
      try { sendResponse({ ok: true, contentVersion: CONTENT_VERSION, accountId, source: currentStaticPageSource() }); }
      catch (error) { sendResponse({ ok: false, contentVersion: CONTENT_VERSION, accountId, error: error.message }); }
      return false;
    }
    if (message?.type === 'SYNC_COURSE') {
      syncCourse(message.course).then(data => finish({ ok: true, data })).catch(error => finish({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'SYNC_COURSE_EVENTS') {
      syncCourseEvents(message.course).then(data => finish({ ok: true, data })).catch(error => finish({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === 'READ_ACTIVITY_DATES') {
      if (!validBackgroundSender(sender)) { finish({ ok: false, error: '活动日期读取请求来源无效' }); return false; }
      readActivityDates(message.course, message.activities).then(data => finish({ ok: true, data })).catch(error => finish({ ok: false, error: error.message }));
      return true;
    }
    if (['FETCH_FILE', 'FETCH_FILE_CHUNK', 'RELEASE_FILE_TRANSFER'].includes(message?.type)) {
      if (!validBackgroundSender(sender)) { finish({ ok: false, error: '文件读取请求来源无效' }); return false; }
      const operation = message.type === 'FETCH_FILE' ? fetchFile(message.file, accountId) : fileTransferChunk(message, accountId);
      operation.then(data => finish({ ok: true, data })).catch(error => finish({ ok: false, error: error.message,
        ...(/^(?:OFFICE_RANGE_[A-Z_]{1,30}|MOODLE_ACCESS_DENIED|MOODLE_NOT_FOUND)$/u.test(error?.code || '') ? { errorCode: error.code } : {}) }));
      return true;
    }
    if (message?.type === 'RETRY_ACTIVITY') {
      retryActivity(message.courseId, message.activity).then(data => finish({ ok: true, data })).catch(error => finish({ ok: false, error: error.message }));
      return true;
    }
    return false;
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(handleContentRuntimeMessage);
}

// 浮层与课程读取彼此独立；只在顶层 Moodle 文档挂载一次，不触碰页面正文。
if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof chrome !== 'undefined') {
  mountAskmeShadow(document, window, chrome);
  window.addEventListener('pageshow', event => { if (event.persisted) mountAskmeShadow(document, window, chrome); });
}

// 新浮层从独立组件装配，不再创建或导航 iframe。
function mountAskmeShadow(doc, win, chromeApi) {
  if (win.top !== win || doc.getElementById('askme-shadow-host')) return;
  const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
  const client = globalThis.AskmeContentUiClient.createContentUiClient({ runtime: chromeApi.runtime, buildVersion: CONTENT_VERSION,
    hostInstanceId: [...bytes].map(b => b.toString(16).padStart(2, '0')).join('') });
  const icons = Object.fromEntries(['courses', 'ask', 'capture', 'explain'].map(action => [action, document => {
    if (action === 'courses') { const icon = document.createElement('img'); icon.src = chromeApi.runtime.getURL('assets/askme-open-panel-48.png'); icon.alt = ''; return icon; }
    // 仅解析随扩展打包的静态图标字符串，不接受网页或模型 HTML。
    const holder = document.createElement('div'); holder.innerHTML = OVERLAY_ICONS[action];
    const icon = holder.firstElementChild; icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.8'); return icon;
  }]));
  let controller;
  const host = globalThis.AskmeShadowHost.createShadowHost({ document: doc, window: win, icons,
    createController: host => (controller = globalThis.AskmePanelController.createPanelController({ host, client, document: doc, buildVersion: CONTENT_VERSION, brandLogoUrl: chromeApi.runtime.getURL('assets/askme-128.png'), folderIconUrl: chromeApi.runtime.getURL('assets/folder.svg'), courseIconUrl: chromeApi.runtime.getURL('assets/journal-text.svg') })) });
  doc.getElementById('askme-shadow-host')?.setAttribute('data-askme-content-version', CONTENT_VERSION);
  const sync = mountAskmeCourseSyncControls(doc, course => { host.setOpen(true); controller.selectDiscoveredCourse?.(course.id); controller.openView('courses'); }, win);
  let restoreTimer;
  const visibility = (message, sender, respond) => {
    if (message?.type !== 'ASKME_CAPTURE_VISIBILITY' || !validBackgroundSender(sender, chromeApi)) return false;
    try {
      if (message.expectedUserId !== currentAccount()) throw new Error('ACCOUNT_CHANGED');
      clearTimeout(restoreTimer);
      const root = doc.getElementById('askme-shadow-host');
      if (!root) throw new Error('HOST_MISSING');
      root.style.setProperty('visibility', message.hidden === true ? 'hidden' : 'visible', 'important');
      if (message.hidden === true) restoreTimer = setTimeout(() => root.style.setProperty('visibility', 'visible', 'important'), 5000);
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => respond({ ok: true, viewport: { width: win.innerWidth, height: win.innerHeight } })));
      return true;
    } catch { respond({ ok: false }); return false; }
  };
  chromeApi.runtime.onMessage.addListener(visibility);
  win.addEventListener('pagehide', () => { clearTimeout(restoreTimer); sync.disconnect(); host.dispose();
    chromeApi.runtime.onMessage.removeListener(visibility); void client.dispose(); }, { once: true });
  return host;
}
