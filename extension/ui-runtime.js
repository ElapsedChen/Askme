// runtime 是唯一入口，不建立网页 postMessage / CustomEvent 转发通道。
(() => {
  'use strict';
  const installed = new WeakMap();
  const legacyDataOperations = new Set(['AI_PROXY', 'GET_COURSE_INDEX_STATE', 'MUTATE_COURSE_INDEX', 'CLAIM_NEW_CARD', 'MUTATE_REVIEW', 'MUTATE_FOCUS', 'MARK_DEADLINE_OPENED', 'GET_OVERLAY_UI', 'SET_OVERLAY_UI', 'GET_BOUND_CURRENT_PAGE_SOURCE', 'CAPTURE_VISIBLE_MOODLE_TAB']);
  function denyLegacyContentRequest(message, sender) {
    // 页面内容脚本不得用旧通道绕开新 broker 的分页、账号和操作校验。
    if (!legacyDataOperations.has(message?.type)) return false;
    try { return new URL(sender?.url || '').origin === 'https://moodle.telt.unsw.edu.au'; } catch { return true; }
  }
  function install({ chromeApi, buildVersion, ready }) {
    if (installed.has(chromeApi.runtime)) return installed.get(chromeApi.runtime);
    const storage = chromeApi.storage.local;
    const sendToDocument = (context, message) => chromeApi.tabs.sendMessage(context.tabId,
      { ...message, ...(context.accountId ? { expectedUserId: context.accountId } : {}) }, { documentId: context.documentId });
    const accountServices = globalThis.AskmeAccountStore.createAccountStore({ storage });
    // 测试/分阶段加载可以只装资料投影；正式构建同时打包所有服务。
    const request = globalThis.AskmePlanTransport?.createPlanTransport({ extensionId: chromeApi.runtime.id });
    const courseServices = globalThis.AskmeCourseService?.createCourseService({ storage, sendToDocument,
      async extractFile(context, course, file) {
        const extractorVersion = 'askme-text-2';
        const allowNotModified = file.cacheEligible === true && file.extractorVersion === extractorVersion;
        const result = await sendToDocument(context, { type: 'FETCH_FILE', file: { ...file, allowNotModified, chunked: true } });
        await context.assertCurrent();
        if (result?.accountId !== context.accountId) throw new Error('UI_ACCOUNT_CHANGED');
        if (!result?.ok) {
          // 只传递受控分类，不把 Moodle HTML、凭据或任意错误原文送到 UI。
          const error = String(result?.error || '');
          const rangeCode = { MOODLE_ACCESS_DENIED: 'FILE_ACCESS_DENIED', MOODLE_NOT_FOUND: 'FILE_NOT_FOUND', OFFICE_RANGE_BUDGET: 'FILE_TOO_LARGE', OFFICE_RANGE_CHANGED: 'FILE_SOURCE_CHANGED',
            OFFICE_RANGE_CHANGED_URL: 'FILE_SOURCE_URL_CHANGED', OFFICE_RANGE_CHANGED_SIZE: 'FILE_SOURCE_SIZE_CHANGED',
            OFFICE_RANGE_CHANGED_ETAG: 'FILE_SOURCE_VERSION_CHANGED', OFFICE_RANGE_CHANGED_DATE: 'FILE_SOURCE_DATE_CHANGED',
            OFFICE_RANGE_UNSUPPORTED: 'FILE_RANGE_UNSUPPORTED', OFFICE_RANGE_NO_VALIDATOR: 'FILE_RANGE_UNSUPPORTED',
            OFFICE_RANGE_ABORTED: 'FILE_TIMEOUT', OFFICE_RANGE_ORIGIN: 'FILE_NOT_DOCUMENT' }[result?.errorCode];
          const serviceCode = rangeCode || (/超过 \d+ MB/u.test(error) ? 'FILE_TOO_LARGE' : /HTTP (401|403)|登录/u.test(error) ? 'FILE_ACCESS_DENIED'
            : /没有可解析|站外/u.test(error) ? 'FILE_NOT_DOCUMENT' : /abort|timeout|超时/iu.test(error) ? 'FILE_TIMEOUT' : 'FILE_READ_FAILED');
          throw Object.assign(new Error('UI_FILE_READ_FAILED'), { serviceCode });
        }
        const metadata = { etag: String(result.data?.etag || '').slice(0, 512), lastModified: String(result.data?.lastModified || '').slice(0, 100), extractorVersion };
        if (result.data?.notModified === true && allowNotModified) return { unchanged: true, ...metadata };
        if (result.data?.transferId) {
          const { transferId, size, contentDigest, mime } = result.data;
          if (typeof transferId !== 'string' || !/^[a-f0-9]{48}$/u.test(transferId)) throw new Error('UI_FILE_READ_FAILED');
          let uploadId;
          try {
            if (!Number.isSafeInteger(size) || size <= 20_000_000 || size > 100_000_000 || typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(contentDigest)) throw new Error('UI_FILE_READ_FAILED');
            if (allowNotModified && contentDigest === file.contentDigest) return { unchanged: true, ...metadata, contentDigest };
            const job = await request(context, '/extract/upload', { action: 'begin', courseId: course.id, url: file.url, title: file.title,
              section: (file.section || '').slice(0, 150), mime, size }, course.id);
            if (typeof job?.uploadId !== 'string' || !/^[a-f0-9]{48}$/u.test(job.uploadId) || job.chunkBytes !== 2_000_000) throw new Error('UI_FILE_READ_FAILED');
            uploadId = job.uploadId;
            for (let offset = 0; offset < size;) {
              await context.assertCurrent();
              const part = await sendToDocument(context, { type: 'FETCH_FILE_CHUNK', transferId, offset });
              await context.assertCurrent();
              if (part?.accountId !== context.accountId) throw new Error('UI_ACCOUNT_CHANGED');
              const expected = Math.min(2_000_000, size - offset);
              if (!part.ok || part.data?.offset !== offset || part.data.size !== expected || typeof part.data.base64 !== 'string' ||
                  part.data.base64.length !== Math.ceil(expected / 3) * 4) throw new Error('UI_FILE_READ_FAILED');
              const accepted = await request(context, '/extract/upload', { action: 'append', uploadId, offset, base64: part.data.base64 }, course.id);
              if (accepted?.nextOffset !== offset + expected) throw new Error('UI_FILE_READ_FAILED');
              offset = accepted.nextOffset;
            }
            const extracted = await request(context, '/extract/upload', { action: 'finish', uploadId }, course.id);
            uploadId = undefined;
            return { ...extracted, ...metadata, contentDigest };
          } finally {
            if (uploadId) try { await request(context, '/extract/upload', { action: 'abort', uploadId }, course.id); } catch {}
            try { await sendToDocument(context, { type: 'RELEASE_FILE_TRANSFER', transferId }); } catch {}
          }
        }
        if (typeof result.data?.base64 !== 'string' || !result.data.base64) throw new Error('UI_FILE_READ_FAILED');
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.data.base64));
        const contentDigest = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
        if (allowNotModified && contentDigest === file.contentDigest) return { unchanged: true, ...metadata, contentDigest };
        const extracted = await request(context, '/extract', { courseId: course.id, url: file.url, title: file.title, section: (file.section || '').slice(0, 150),
          mime: result.data?.mime, base64: result.data?.base64 }, course.id);
        return { ...extracted, ...metadata, contentDigest };
      }
    });
    const capture = globalThis.AskmeCaptureService?.createCaptureService({ chromeApi, sendToDocument });
    const learning = globalThis.AskmeLearningService?.createLearningService({ storage, request, sendToDocument,
      sourceRead: courseServices?.['source.read'], captureRead: capture?.read, captureRelease: capture?.release, openAuth: url => chromeApi.tabs.create({ url, active: true }) });
    const study = globalThis.AskmeStudyService?.createStudyService({ storage, request, sourceRead: courseServices?.['source.read'] });
    const skills = globalThis.AskmeConversationSkills?.createConversationSkills({ storage, request });
    const services = { ...accountServices, ...courseServices, ...learning, ...study, ...(capture ? { 'capture.take': capture.take } : {}),
      ...(skills ? { 'chat.quiz.read': skills['chat.quiz.read'], 'chat.quiz.advance': skills['chat.quiz.advance'], 'chat.quiz.check': skills['chat.quiz.check'],
        'chat.ask': (context, args) => !args.captureId && skills.matches(args.question) ? skills.begin(context, args) : learning['chat.ask'](context, args) } : {}) };
    const accounts = new Map();
    let accountEpoch = 0;
    const broker = globalThis.AskmeUiBroker.createUiBroker({ extensionId: chromeApi.runtime.id, buildVersion, services,
      async resolveAccount(target) {
        const result = await chromeApi.tabs.sendMessage(target.tabId, { type: 'PING' }, { documentId: target.documentId });
        // epoch 由后台根据绑定文档、账号和登录状态创建，不接受 UI 提供的值。
        const identity = `${target.documentId}:${result?.ok === true ? result.accountId : ''}`;
        let previous = accounts.get(target.tabId);
        if (!previous || previous.identity !== identity) { previous = { identity, epoch: ++accountEpoch }; accounts.set(target.tabId, previous); }
        return { ...result, accountEpoch: previous.epoch };
      } });
    const onMessage = (message, sender, respond) => {
      if (!['ASKME_UI_HELLO', 'ASKME_UI_REQUEST', 'ASKME_UI_DISPOSE'].includes(message?.type)) return false;
      if (!globalThis.AskmeUiProtocol.exact(message, ['type', 'payload'])) { respond({ ok: false, error: 'INVALID_UI_ENVELOPE' }); return false; }
      const method = message.type === 'ASKME_UI_HELLO' ? 'hello' : message.type === 'ASKME_UI_REQUEST' ? 'dispatch' : 'dispose';
      Promise.resolve(ready).then(() => broker[method](message.payload, sender)).then(respond, () => respond({ ok: false, error: 'UI_UNAVAILABLE' }));
      return true;
    };
    const revoke = tabId => { accounts.delete(tabId); broker.revokeTab(tabId); };
    const onUpdated = (tabId, change) => { if (change.status === 'loading' || typeof change.url === 'string') revoke(tabId); };
    const onRemoved = revoke;
    chromeApi.runtime.onMessage.addListener(onMessage);
    chromeApi.tabs.onUpdated.addListener(onUpdated);
    chromeApi.tabs.onRemoved.addListener(onRemoved);
    const controller = Object.freeze({ dispose() {
      broker.shutdown();
      accounts.clear();
      chromeApi.runtime.onMessage.removeListener(onMessage);
      chromeApi.tabs.onUpdated.removeListener(onUpdated);
      chromeApi.tabs.onRemoved.removeListener(onRemoved);
      installed.delete(chromeApi.runtime);
    } });
    installed.set(chromeApi.runtime, controller);
    return controller;
  }
  globalThis.AskmeUiRuntime = Object.freeze({ install, denyLegacyContentRequest });
})();
