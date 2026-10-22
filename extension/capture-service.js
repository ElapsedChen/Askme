// 图片短暂保存在后台；成功保存回答后销毁，短期允许失败重试。
(() => {
  'use strict';
  function createCaptureService({ chromeApi, sendToDocument }) {
    const captures = new Map();
    const remove = id => { const entry = captures.get(id); if (entry) clearTimeout(entry.timer); captures.delete(id); };
    const matches = (entry, context) => entry.accountId === context.accountId && entry.accountEpoch === context.accountEpoch &&
      entry.documentId === context.documentId && entry.tabId === context.tabId;
    async function active(context) {
      await context.assertCurrent();
      const tabs = await chromeApi.tabs.query({ active: true, windowId: context.windowId });
      if (tabs.length !== 1 || tabs[0].id !== context.tabId || new URL(tabs[0].url).origin !== 'https://moodle.telt.unsw.edu.au') throw new Error('UI_CAPTURE_INACTIVE');
    }
    async function take(context, args = {}) {
      if (args.region && globalThis.AskmeUiProtocol?.operations['capture.take'](args) !== true) throw new Error('UI_CAPTURE_INVALID_REGION');
      await active(context);
      let image;
      try {
        const hidden = await sendToDocument(context, { type: 'ASKME_CAPTURE_VISIBILITY', hidden: true });
        if (!hidden?.ok) throw new Error('UI_CAPTURE_UNAVAILABLE');
        if (args.region && (hidden.viewport?.width !== args.region.viewportWidth || hidden.viewport?.height !== args.region.viewportHeight)) throw new Error('UI_CAPTURE_RESIZED');
        await active(context);
        image = await chromeApi.tabs.captureVisibleTab(context.windowId, { format: 'png' });
        await active(context);
      } finally {
        try { await sendToDocument(context, { type: 'ASKME_CAPTURE_VISIBILITY', hidden: false }); } catch { /* 内容端的短定时器也会恢复宿主。 */ }
      }
      if (typeof image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(image) || image.length > 8000000) throw new Error('UI_CAPTURE_TOO_LARGE');
      if (args.region) image = await crop(image, args.region);
      await active(context);
      for (const [id, entry] of captures) if (entry.expiresAt <= Date.now() || matches(entry, context)) remove(id);
      if (captures.size >= 4) remove(captures.keys().next().value);
      const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
      const captureId = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
      const expiresAt = Date.now() + 120000;
      const timer = setTimeout(() => remove(captureId), 120000); timer.unref?.();
      captures.set(captureId, { accountId: context.accountId, accountEpoch: context.accountEpoch, documentId: context.documentId, tabId: context.tabId, expiresAt, image, timer });
      return { captureId, expiresAt };
    }
    async function read(context, captureId) {
      await context.assertCurrent();
      const entry = captures.get(captureId);
      if (entry?.expiresAt <= Date.now()) remove(captureId);
      if (!entry || entry.expiresAt <= Date.now() || !matches(entry, context)) throw new Error('UI_CAPTURE_EXPIRED');
      return entry.image;
    }
    function release(context, captureId) {
      const entry = captures.get(captureId);
      if (entry && matches(entry, context)) remove(captureId);
    }
    return Object.freeze({ take, read, release });
  }
  async function crop(image, region) {
    const bitmap = await createImageBitmap(await (await fetch(image)).blob());
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error('UI_CAPTURE_TOO_LARGE');
      const sx = bitmap.width / region.viewportWidth, sy = bitmap.height / region.viewportHeight;
      const x = Math.floor(region.x * sx), y = Math.floor(region.y * sy);
      const width = Math.min(bitmap.width - x, Math.ceil(region.width * sx)), height = Math.min(bitmap.height - y, Math.ceil(region.height * sy));
      const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('UI_CAPTURE_UNAVAILABLE');
      ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      const result = `data:image/png;base64,${btoa(binary)}`;
      if (result.length > 8000000) throw new Error('UI_CAPTURE_TOO_LARGE');
      return result;
    } finally { bitmap.close(); }
  }
  globalThis.AskmeCaptureService = Object.freeze({ createCaptureService });
})();
