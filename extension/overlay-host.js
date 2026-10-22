// 此模块只负责几何布局和生命周期；课程内容与权限由 controller / broker 提供。
(() => {
  'use strict';
  const hosts = new WeakMap();
  function createShadowHost({ document: doc, window: win, createController, icons, initialWidth = 400 }) {
    if (hosts.has(doc)) return hosts.get(doc);
    if (typeof createController !== 'function') throw new Error('MISSING_PANEL_CONTROLLER');
    if (!['courses', 'ask', 'capture', 'explain'].every(action => typeof icons?.[action] === 'function')) throw new Error('MISSING_PACKAGED_ICONS');
    const node = (tag, text) => { const el = doc.createElement(tag); if (text != null) el.textContent = text; return el; };
    const root = node('div'); root.id = 'askme-shadow-host';
    for (const [name, value] of Object.entries({ position: 'fixed', inset: '8px 12px 8px auto', 'z-index': '2147483000', display: 'block', 'pointer-events': 'none', margin: '0', padding: '0', border: '0' })) root.style.setProperty(name, value, 'important');
    const shadow = root.attachShadow({ mode: 'closed' });
    const style = node('style');
    style.textContent = `
      :host{all:initial;position:fixed;inset:8px 12px 8px auto;z-index:2147483000;display:block;color-scheme:light;pointer-events:none;font-family:Inter,"Segoe UI",sans-serif}
      *{box-sizing:border-box}.shell{display:flex;height:100%;gap:10px;align-items:stretch;pointer-events:none}
      .rail{display:flex;flex-direction:column;gap:20px;flex:0 0 44px;width:44px;padding-top:clamp(12px,calc((100vh - 252px)/2),320px);pointer-events:none}
      button{font:inherit;cursor:pointer}.rail button{position:relative;width:44px;height:44px;flex:0 0 44px;padding:10px;border:0;border-radius:15px;color:#715df3;background:#fff;box-shadow:0 6px 24px #49399618;pointer-events:auto}
      .rail button:first-child{background:#715df3;color:#fff}.rail img{display:block;width:24px;height:24px;object-fit:contain}.rail svg{display:block;width:24px;height:24px}
      button:focus-visible,.resize:focus-visible{outline:3px solid #c6b9ff;outline-offset:3px}
      .rail button::after{content:attr(aria-label);position:absolute;right:54px;top:50%;transform:translateY(-50%);white-space:nowrap;background:#715df3;color:#fff;padding:8px 12px;border-radius:10px;font-size:13px;opacity:0;pointer-events:none}
      .rail button:hover::after,.rail button:focus-visible::after{opacity:1}
      .panel{position:relative;width:var(--panel-width);height:100%;border-radius:20px;border:1px solid #e5def4;background:#fff;box-shadow:0 18px 55px #2b205d38;overflow:hidden;pointer-events:auto}
      .panel[hidden]{display:none}.app{height:100%;min-height:0;overflow:hidden;color:#24202c;font:16px/1.6 Inter,"Segoe UI",sans-serif;background:#fff}
      .close{position:absolute;z-index:20;right:10px;top:10px;width:34px;height:34px;border:1px solid #e5def4;border-radius:11px;background:#fff;color:#51485c}
      .resize{position:absolute;left:0;top:48px;bottom:16px;width:8px;padding:0;border:0;background:transparent;cursor:ew-resize;touch-action:none}
      .capture-mask{position:fixed;inset:0;z-index:50;pointer-events:auto;touch-action:none;cursor:crosshair;overflow:hidden;background:#17112b55;outline:0}
      .capture-mask.selecting{background:transparent}.capture-region{position:fixed;display:none;border:2px solid #8068ff;background:transparent;box-shadow:0 0 0 20000px #17112b66;pointer-events:none}
      .capture-toolbar{position:absolute;top:18px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100vw - 24px);padding:10px 14px;border-radius:14px;background:#fff;box-shadow:0 6px 32px #20153530;color:#322b44;font:14px/1.4 "Segoe UI",sans-serif;cursor:default}
      .capture-toolbar button{flex:none;min-height:36px;padding:6px 10px;background:#f1ecff;color:#6245cb;border:0;border-radius:9px}.capture-toolbar span{min-width:0}
      @media(prefers-reduced-motion:no-preference){.panel{animation:arrive .16s ease-out}@keyframes arrive{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}}
    `;
    const shell = node('div'); shell.className = 'shell';
    const rail = node('nav'); rail.className = 'rail'; rail.setAttribute('aria-label', 'Askme');
    const panel = node('section'); panel.className = 'panel'; panel.setAttribute('aria-label', 'Askme 学习面板');
    const app = node('div'); app.className = 'app';
    const close = node('button', '×'); close.className = 'close'; close.type = 'button'; close.setAttribute('aria-label', '关闭 Askme');
    const resize = node('button'); resize.className = 'resize'; resize.type = 'button'; resize.setAttribute('aria-label', '调整 Askme 宽度');
    let open = false, disposed = false, drag = null, controller = null, width = initialWidth, captureCancel = null;
    const buttons = new Map(), listeners = [];
    const listen = (target, event, handler) => { target.addEventListener(event, handler); listeners.push(() => target.removeEventListener(event, handler)); };
    const clamp = value => Math.min(Math.max(240, Number(value) || 400), 720, Math.max(160, win.innerWidth - 78));
    const setWidth = value => { width = clamp(value); root.style.setProperty('--panel-width', `${width}px`); return width; };
    const setOpen = value => {
      if (disposed) return;
      open = value !== false; panel.hidden = !open;
      buttons.get('courses')?.setAttribute('aria-expanded', String(open));
    };
    const notifyLayout = () => controller?.layoutChanged?.({ width, open });
    function selectCaptureRegion() {
      if (disposed || captureCancel) return Promise.resolve(null);
      return new Promise(resolve => {
        const overlay = node('div'), selection = node('div'), toolbar = node('div');
        overlay.className = 'capture-mask'; overlay.tabIndex = -1; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', '拖动选择截图区域，Escape 取消');
        selection.className = 'capture-region'; toolbar.className = 'capture-toolbar';
        const hint = node('span', '拖动选择范围 · Esc 取消'), whole = node('button', '截取可见页面'), cancel = node('button', '取消');
        whole.type = cancel.type = 'button'; toolbar.append(hint, whole, cancel); overlay.append(selection, toolbar);
        const viewportWidth = win.innerWidth, viewportHeight = win.innerHeight, previousVisibility = shell.style.visibility;
        let start = null, region = null, done = false;
        const finish = value => {
          if (done) return; done = true;
          overlay.remove(); shell.style.visibility = previousVisibility; captureCancel = null;
          win.removeEventListener('resize', abort); win.removeEventListener('blur', abort); win.removeEventListener('pagehide', abort);
          buttons.get('capture')?.focus(); resolve(value);
        };
        const abort = () => finish(null); captureCancel = abort;
        const point = event => ({ x: Math.max(0, Math.min(viewportWidth, event.clientX)), y: Math.max(0, Math.min(viewportHeight, event.clientY)) });
        overlay.addEventListener('pointerdown', event => {
          if (event.button !== 0 || event.target.closest?.('.capture-toolbar')) return;
          event.preventDefault(); start = { ...point(event), pointerId: event.pointerId }; region = null;
          overlay.setPointerCapture(event.pointerId); overlay.classList.add('selecting'); selection.style.display = 'block';
          Object.assign(selection.style, { left: `${start.x}px`, top: `${start.y}px`, width: '0px', height: '0px' });
        });
        overlay.addEventListener('pointermove', event => {
          if (!start || start.pointerId !== event.pointerId) return;
          const end = point(event);
          region = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y), viewportWidth, viewportHeight };
          Object.assign(selection.style, { left: `${region.x}px`, top: `${region.y}px`, width: `${region.width}px`, height: `${region.height}px` });
        });
        overlay.addEventListener('pointerup', event => {
          if (!start || start.pointerId !== event.pointerId) return;
          overlay.releasePointerCapture?.(event.pointerId); start = null;
          if (region && region.width >= 16 && region.height >= 16) finish(region);
          else { region = null; selection.style.display = 'none'; overlay.classList.remove('selecting'); hint.textContent = '范围太小，请重新拖动'; }
        });
        overlay.addEventListener('pointercancel', abort);
        overlay.addEventListener('wheel', event => event.preventDefault(), { passive: false });
        overlay.addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); abort(); }
          else if (event.key === 'Tab') { event.preventDefault(); (shadow.activeElement === whole ? cancel : whole).focus(); }
          else if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' '].includes(event.key) && event.target === overlay) event.preventDefault();
        });
        whole.addEventListener('click', () => finish({})); cancel.addEventListener('click', abort);
        win.addEventListener('resize', abort); win.addEventListener('blur', abort); win.addEventListener('pagehide', abort);
        shell.style.visibility = 'hidden'; shadow.append(overlay); overlay.focus();
      });
    }
    const actions = [['courses', 'Open panel'], ['ask', 'Open Askme session'], ['capture', 'Take screenshot'], ['explain', 'Solve this page']];
    for (const [action, label] of actions) {
      const button = node('button'); button.type = 'button'; button.setAttribute('aria-label', label);
      // 图标由可信打包组件创建，不拼接页面提供的 SVG 或 HTML。
      const icon = icons[action](doc);
      if (!icon) throw new Error('MISSING_PACKAGED_ICON');
      button.append(icon);
      listen(button, 'click', () => {
        if (disposed) return;
        setOpen(true);
        if (action === 'courses' || action === 'ask') controller?.openView?.(action);
        else if (action === 'capture') void controller?.capture?.();
        else void controller?.explainPage?.();
        notifyLayout();
      });
      buttons.set(action, button); rail.append(button);
    }
    listen(close, 'click', () => { setOpen(false); notifyLayout(); });
    listen(win, 'resize', () => { setWidth(width); notifyLayout(); });
    listen(resize, 'pointerdown', event => {
      drag = { x: event.clientX, width, pointerId: event.pointerId };
      resize.setPointerCapture(event.pointerId); event.preventDefault();
    });
    listen(resize, 'pointermove', event => { if (drag?.pointerId === event.pointerId) setWidth(drag.width + drag.x - event.clientX); });
    const endDrag = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (resize.hasPointerCapture?.(event.pointerId)) resize.releasePointerCapture(event.pointerId);
      drag = null; notifyLayout();
    };
    listen(resize, 'pointerup', endDrag); listen(resize, 'pointercancel', endDrag);
    listen(resize, 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); setWidth(width + (event.key === 'ArrowLeft' ? 16 : -16)); notifyLayout();
    });
    panel.hidden = true;
    panel.append(app, resize, close); shell.append(rail, panel); shadow.append(style, shell); doc.documentElement.append(root);
    setWidth(width);
    setOpen(false);
    // 新页面只展示悬浮入口；返回缓存页面也不主动恢复已展开面板。
    listen(win, 'pagehide', () => setOpen(false));
    let observer;
    const host = Object.freeze({ root: app, mode: 'shadow', setOpen, setWidth, selectCaptureRegion,
      setView(view) { controller?.openView?.(view); },
      getState: () => ({ open, width, disposed }),
      scrollToTop() { app.scrollTo?.({ top: 0 }); },
      dispose() {
        if (disposed) return;
        disposed = true; captureCancel?.(); observer?.disconnect(); listeners.splice(0).forEach(remove => remove());
        void controller?.dispose?.(); root.remove(); hosts.delete(doc);
      }
    });
    hosts.set(doc, host);
    try { controller = createController(host); }
    catch (error) { host.dispose(); throw error; }
    if (typeof win.MutationObserver === 'function') {
      observer = new win.MutationObserver(() => { if (!root.isConnected) host.dispose(); });
      observer.observe(doc.documentElement, { childList: true });
    }
    return host;
  }
  globalThis.AskmeShadowHost = Object.freeze({ createShadowHost });
})();
