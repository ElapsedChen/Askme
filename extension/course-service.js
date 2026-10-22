// 后台课程服务：仅使用绑定账号、文档和课程；不向界面返回整库。
(() => {
  'use strict';
  const p = globalThis.AskmeUiProtocol;
  const origin = 'https://moodle.telt.unsw.edu.au';
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const list = value => Array.isArray(value) ? value : [];
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const key = (accountId, field) => `askme:v1:user:${accountId}:${field}`;
  const fail = code => { throw new Error(code); };
  function urlOf(value) {
    try {
      const url = new URL(value);
      if (url.origin !== origin || url.username || url.password || url.href.length > 2048 ||
          [...url.searchParams.keys()].some(name => /^(action|sesskey|delete|edit|submit|attempt|grade)$/iu.test(name))) return null;
      return url;
    } catch { return null; }
  }
  function courseAddress(value, id) {
    const url = urlOf(value);
    return url?.pathname === '/course/view.php' && url.searchParams.getAll('id').length === 1 && url.searchParams.get('id') === id
      ? `${origin}/course/view.php?id=${id}` : '';
  }
  function sourceAddress(value, courseId, isFile = false) {
    const url = urlOf(value);
    if (!url) return '';
    if (url.pathname === '/course/view.php') return courseAddress(value, courseId) ? url.href : '';
    if (/^\/mod\/(page|book|folder)\/view.php$/u.test(url.pathname) && p.id(url.searchParams.get('id')) && url.searchParams.getAll('id').length === 1) return url.href;
    if (isFile && (/^\/pluginfile\.php\//u.test(url.pathname) || /\.(pdf|docx?|pptx?|xlsx?|txt|csv)$/iu.test(url.pathname) ||
        url.pathname === '/mod/resource/view.php' && p.id(url.searchParams.get('id')) && url.searchParams.getAll('id').length === 1)) return url.href;
    return '';
  }
  const pageIdentity = page => `${String(page.id || page.url)}|${String(page.partNumber || '')}`;
  const incomplete = data => Boolean(list(data.errors).length || list(data.failedActivities).length || list(data.unavailableActivities).length ||
    list(data.fileErrors).length || data.eventSyncError || data.fileExtractionSkipped || data.assessmentStale || data.assignmentBriefStale ||
    data.skippedPages || data.truncatedPages || data.skippedCourseParts || data.skippedFiles || data.skippedFileParts);
  async function digest(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function createCourseService({ storage, sendToDocument, extractFile }) {
    if (!p || !storage?.get || !storage?.set || typeof sendToDocument !== 'function') fail('UI_SERVICE_CONFIGURATION');
    async function read(context, fields) {
      if (!p.id(context.accountId)) fail('UI_ACCOUNT_CHANGED');
      await context.assertCurrent();
      const names = fields.map(field => key(context.accountId, field));
      const raw = await storage.get(names);
      await context.assertCurrent();
      return Object.fromEntries(fields.map((field, index) => [field, raw[names[index]]]));
    }
    async function write(context, patch) {
      await context.assertCurrent();
      await storage.set(Object.fromEntries(Object.entries(patch).map(([field, value]) => [key(context.accountId, field), value])));
      await context.assertCurrent();
    }
    function coursesOf(data) {
      const courses = list(data.courses);
      if (courses.some(course => !p.id(String(course?.id || ''))) || new Set(courses.map(course => String(course.id))).size !== courses.length) fail('UI_STORAGE_CONFLICT');
      return courses;
    }
    function courseOf(data, id) {
      const course = coursesOf(data).find(item => String(item.id) === id);
      if (!course) fail('UI_COURSE_NOT_FOUND');
      const url = courseAddress(course.url, id);
      if (!url) fail('UI_COURSE_NOT_FOUND');
      return { id, title: text(course.title, 250), url, selected: course.selected === true };
    }
    async function send(context, message) {
      await context.assertCurrent();
      // 适配器必须使用 chrome.tabs.sendMessage(tabId, message, {documentId})。
      const result = await sendToDocument({ tabId: context.tabId, documentId: context.documentId }, { ...message, expectedUserId: context.accountId });
      await context.assertCurrent();
      if (result?.accountId !== context.accountId) fail('UI_ACCOUNT_CHANGED');
      if (result?.ok !== true) fail('UI_COURSE_READ_FAILED');
      return result;
    }
    function tokenOf(data, id) {
      const value = object(data.courseIndexMutationRuntime?.courseTokens)[id] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail('UI_STORAGE_CONFLICT');
      return value;
    }
    function validPage(page, id) {
      return page && String(page.courseId) === id && typeof page.text === 'string' && page.text.length <= 100000 &&
        sourceAddress(page.url, id, page.sourceType === 'file') && typeof page.id === 'string' && page.id.length <= 2300;
    }
    function pagesOf(snapshot, id) {
      return list(snapshot?.pages).filter(page => validPage(page, id));
    }
    async function sourceEntries(context, id) {
      const data = await read(context, ['courses', 'library', 'courseIndexMutationRuntime']);
      courseOf(data, id);
      const snapshot = object(data.library)[id], pages = pagesOf(snapshot, id);
      const identities = new Set();
      for (const page of pages) {
        const identity = pageIdentity(page);
        if (identities.has(identity)) fail('UI_STORAGE_CONFLICT');
        identities.add(identity);
      }
      const sourceIds = await Promise.all(pages.map(page => digest(`${id}|${pageIdentity(page)}`)));
      await context.assertCurrent();
      const entries = pages.map((page, index) => ({ sourceId: sourceIds[index], page }));
      return { entries, revision: tokenOf(data, id) };
    }
    function metadata({ sourceId, page }) {
      return { sourceId, title: text(page.title, 250), url: text(page.url, 2048), section: text(page.section, 200),
        characters: page.text.length, sourceType: page.sourceType === 'file' ? 'file' : 'page',
        stale: page.sourceStale === true, truncated: page.textTruncated === true, syncedAt: text(page.syncedAt, 40) };
    }
    function mergeSnapshot(raw, previous, course) {
      if (!Array.isArray(raw?.pages) || !Array.isArray(raw?.files) || raw.pages.length > 2000 || raw.files.length > 2000 ||
          !p.bounded(raw, 16 * 1024 * 1024) || !raw.pages.length || raw.pages.some(page => !validPage(page, course.id))) fail('UI_COURSE_READ_FAILED');
      const data = structuredClone(raw);
      if (new Set(data.pages.map(pageIdentity)).size !== data.pages.length) fail('UI_COURSE_READ_FAILED');
      if (data.files.some(file => !sourceAddress(file?.url, course.id, true))) fail('UI_COURSE_READ_FAILED');
      const oldFiles = new Map(list(previous?.files).map(file => [file.url, file]));
      data.files = data.files.map(file => {
        const old = oldFiles.get(file.url);
        const cacheEligible = old?.indexStatus === 'indexed' && pagesOf(previous, course.id).some(page => page.sourceType === 'file' && page.url.split('#')[0] === file.url.split('#')[0]);
        return { ...old, url: file.url, title: text(file.title, 250), section: text(file.section, 200), type: 'file', indexStatus: 'pending', cacheEligible };
      });
      // 事件失败时不删除旧截止事项，并且明确旧数据未被重新确认。
      if (data.eventSyncError || !Array.isArray(data.events)) {
        data.events = list(previous?.events); data.eventSyncError = '本次未完整读取截止事项，保留上次快照。'; data.eventsStale = true;
      } else if (data.events.some(item => String(item?.courseId) !== course.id)) fail('UI_COURSE_READ_FAILED');
      else data.eventsStale = false;
      if (data.assessmentParseStatus !== 'complete') {
        data.assessments = list(previous?.assessments); data.assessmentStale = data.assessmentParseStatus !== 'not-found' || data.assessments.length > 0;
      } else if (list(data.assessments).some(item => String(item?.courseId) !== course.id)) fail('UI_COURSE_READ_FAILED');
      const scan = data.assignmentBriefScan;
      if (!(scan?.complete === true && ['complete', 'not-found'].includes(data.assignmentBriefParseStatus) &&
          Number.isInteger(scan.succeeded) && scan.succeeded === list(data.assignmentBriefs).length)) {
        data.assignmentBriefs = list(previous?.assignmentBriefs); data.assignmentBriefStale = true;
      } else if (list(data.assignmentBriefs).some(item => String(item?.courseId) !== course.id)) fail('UI_COURSE_READ_FAILED');
      // 页面扫描不完整时保留缺失页；旧页只用于回查，不作为新鲜证据。
      const pagePartial = list(data.errors).length || list(data.failedActivities).length || list(data.unavailableActivities).length || data.skippedPages || data.skippedCourseParts;
      const incoming = new Map(data.pages.map(page => [pageIdentity(page), page]));
      for (const old of pagesOf(previous, course.id).filter(page => page.sourceType !== 'file')) {
        const fresh = incoming.get(pageIdentity(old));
        if ((pagePartial && !fresh) || fresh?.textTruncated && !old.textTruncated) incoming.set(pageIdentity(old), {
          ...old, sourceStale: true, sourceStaleReason: 'page-refresh-incomplete', lastGoodAt: old.syncedAt || previous.syncedAt || null
        });
      }
      data.pages = [...incoming.values()];
      data.fileErrors = []; data.indexedFiles = 0; data.skippedFiles = 0;
      data.fileExtractionSkipped = data.files.length > 0;
      data.semanticIncomplete = false; data.semanticStatus = '使用课程原文检索。';
      // 旧知识点和备考快照不可冒充按新正文重建，后续学习服务须重新生成。
      data.knowledgeUnits = []; data.assessmentPreparations = []; data.knowledgeIndexPending = true;
      return data;
    }
    async function parseFiles(context, data, previous, course) {
      const unsupported = /\.(zip|rar|7z|sldprt|sldasm|slddrw|dwg|dxf|step|stp|iges|igs|mp4|mov|png|jpe?g|webp|gif)$/iu;
      const startedAt = Date.now();
      let attempted = 0;
      for (const file of data.files) {
        if (file.indexStatus && file.indexStatus !== 'pending') continue;
        const path = new URL(file.url).pathname;
        if (unsupported.test(path) || unsupported.test(file.title)) { file.indexStatus = 'unsupported'; continue; }
        // 小批次落盘，后续从 pending 续读；不会每次都被前 30 个文件占满。
        if (!extractFile || attempted >= 5 || Date.now() - startedAt >= 45000) { file.indexStatus = 'pending'; continue; }
        attempted++;
        try {
          await context.assertCurrent();
          // 文件读取和固定 /extract 调用由可信后台适配器完成，原文件不经过 UI。
          const extracted = await extractFile(context, course, file);
          await context.assertCurrent();
          if (extracted?.unchanged === true) {
            const cached = pagesOf(previous, course.id).filter(page => page.sourceType === 'file' && page.url.split('#')[0] === file.url.split('#')[0]);
            if (!file.cacheEligible || !cached.length || cached.some(page => page.textTruncated) || cached.length !== file.indexedParts) fail('UI_FILE_READ_FAILED');
            const urls = file.url.split('#')[0];
            data.pages = data.pages.filter(page => page.sourceType !== 'file' || page.url.split('#')[0] !== urls);
            data.pages.push(...cached.map(page => ({ ...page, sourceStale: false, sourceStaleReason: '', syncedAt: new Date().toISOString() })));
            file.indexStatus = 'indexed'; file.cacheReused = true; file.contentStale = false;
            file.etag = text(extracted.etag, 512); file.lastModified = text(extracted.lastModified, 100);
            delete file.errorCode; delete file.indexError;
            continue;
          }
          if (!Array.isArray(extracted?.pages) || !p.bounded(extracted, 8 * 1024 * 1024) || extracted.pages.some(page => !validPage(page, course.id) || page.sourceType !== 'file' || page.url.split('#')[0] !== file.url.split('#')[0]) || new Set(extracted.pages.map(pageIdentity)).size !== extracted.pages.length) fail('UI_FILE_READ_FAILED');
          for (const field of ['totalParts', 'skippedParts', 'emptyParts', 'truncatedParts', 'blankParts', 'physicalParts', 'ocrParts']) if (extracted[field] !== undefined && (!Number.isSafeInteger(extracted[field]) || extracted[field] < 0)) fail('UI_FILE_READ_FAILED');
          if (extracted.emptyPages !== undefined && (!Array.isArray(extracted.emptyPages) || extracted.emptyPages.length > 100 || extracted.emptyPages.some(page => !Number.isSafeInteger(page) || page < 1 || page > 100))) fail('UI_FILE_READ_FAILED');
          // 同一文件替换成功获取的段落；失败或缺失的旧段落在下方保留为过期资料。
          const freshIds = new Set(extracted.pages.map(pageIdentity));
          data.pages = data.pages.filter(page => !freshIds.has(pageIdentity(page)));
          data.pages.push(...extracted.pages);
          const totalParts = Number.isInteger(extracted.totalParts) ? Math.max(extracted.totalParts, extracted.pages.length) : extracted.pages.length;
          const partial = !extracted.pages.length || totalParts > extracted.pages.length || extracted.skippedParts || extracted.emptyParts || extracted.truncatedParts;
          file.indexStatus = partial ? 'partial' : 'indexed'; file.indexedParts = extracted.pages.length; file.totalParts = totalParts; file.kind = text(extracted.kind, 30);
          file.etag = text(extracted.etag, 512); file.lastModified = text(extracted.lastModified, 100); file.contentDigest = text(extracted.contentDigest, 64); file.extractorVersion = text(extracted.extractorVersion, 40); file.cacheEligible = !partial; file.cacheReused = false;
          file.missingParts = Number(extracted.skippedParts || 0) + Number(extracted.emptyParts || 0);
          file.blankParts = Number(extracted.blankParts || 0); file.physicalParts = Number(extracted.physicalParts || 0);
          file.emptyPages = extracted.emptyPages || []; file.ocrParts = Number(extracted.ocrParts || 0);
          file.truncatedParts = Number(extracted.truncatedParts || 0); delete file.errorCode; delete file.indexError; delete file.contentStale;
          if (!partial) data.pages = data.pages.filter(page => page.sourceType !== 'file' || page.url.split('#')[0] !== file.url.split('#')[0] || freshIds.has(pageIdentity(page)));
        } catch (error) {
          await context.assertCurrent();
          file.indexStatus = 'failed'; file.indexError = '文件正文读取失败。';
          file.errorCode = /^FILE_[A-Z_]{1,50}$/u.test(error?.serviceCode || '') ? error.serviceCode : error?.message === 'UI_SERVICE_TIMEOUT' ? 'FILE_TIMEOUT' : 'FILE_READ_FAILED';
        }
      }
      data.fileExtractionSkipped = data.files.some(file => file.indexStatus === 'pending');
      const files = new Map(data.files.map(file => [file.url.split('#')[0], file]));
      const ids = new Set(data.pages.map(pageIdentity));
      for (const old of pagesOf(previous, course.id).filter(page => page.sourceType === 'file')) {
        const file = files.get(old.url.split('#')[0]);
        if (file?.indexStatus === 'indexed') continue;
        if (ids.has(pageIdentity(old))) continue;
        // 当扫描有缺口时也保留未重新发现的旧文件，以免坏刷新清空资料。
        if (!file && !list(data.errors).length && !list(data.failedActivities).length && !data.skippedPages && !data.skippedCourseParts) continue;
        data.pages.push({ ...old, sourceStale: true, sourceStaleReason: 'file-refresh-incomplete', lastGoodAt: old.syncedAt || previous.syncedAt || null });
        ids.add(pageIdentity(old));
        if (file) file.contentStale = true;
      }
      data.indexedFiles = data.files.filter(file => ['indexed', 'partial'].includes(file.indexStatus)).length;
      data.skippedFiles = data.files.filter(file => ['pending', 'unsupported'].includes(file.indexStatus)).length;
      data.fileErrors = data.files.filter(file => ['failed', 'partial'].includes(file.indexStatus)).map(file => `${file.title}：${file.indexStatus === 'partial' ? '文件正文读取不完整。' : '文件正文读取失败。'}`);
      data.skippedFileParts = data.files.reduce((sum, file) => sum + (Number(file.missingParts) || 0), 0);
      data.truncatedPages = data.pages.filter(page => page.textTruncated).length;
      data.fileIndexStatus = !data.files.length ? '未发现文件链接。' : data.fileExtractionSkipped
        ? '已读取页面，部分文件正文尚未解析；保留已有文件正文并标记待刷新。'
        : `已处理 ${data.indexedFiles} 个文件；失败 ${data.fileErrors.length} 个，跳过 ${data.skippedFiles} 个。`;
      return attempted;
    }
    return Object.freeze({
      async 'course.discover'(context) {
        const result = await send(context, { type: 'DISCOVER' });
        if (!Array.isArray(result.courses) || result.courses.length > 500) fail('UI_COURSE_READ_FAILED');
        const data = await read(context, ['courses']), existing = coursesOf(data), byId = new Map(existing.map(course => [String(course.id), course]));
        for (const course of result.courses) {
          const id = String(course?.id || ''), url = courseAddress(course?.url, id);
          if (!p.id(id) || !url || typeof course.title !== 'string') fail('UI_COURSE_READ_FAILED');
          const old = byId.get(id);
          byId.set(id, { ...old, id, url, title: text(course.title, 250), selected: old?.selected === true });
        }
        const next = [...byId.values()];
        await write(context, { courses: next });
        return { discovered: result.courses.length, total: next.length, items: next.slice(0, 50).map(course => courseOf({ courses: next }, String(course.id))), nextOffset: next.length > 50 ? 50 : null };
      },
      async 'course.select'(context, args) {
        const data = await read(context, ['courses']); courseOf(data, args.courseId);
        const next = coursesOf(data).map(course => String(course.id) === args.courseId ? { ...course, selected: args.selected } : course);
        await write(context, { courses: next });
        return courseOf({ courses: next }, args.courseId);
      },
      async 'source.list'(context, args) {
        const { entries, revision } = await sourceEntries(context, args.courseId);
        const items = [], selected = entries.slice(args.offset, args.offset + args.limit);
        for (const entry of selected) { const candidate = metadata(entry); if (!p.bounded([...items, candidate], 60000)) break; items.push(candidate); }
        return { items, revision, total: entries.length, nextOffset: args.offset + items.length < entries.length ? args.offset + items.length : null };
      },
      async 'source.read'(context, args) {
        const { entries, revision } = await sourceEntries(context, args.courseId), found = entries.find(item => item.sourceId === args.sourceId);
        if (!found) fail('UI_SOURCE_NOT_FOUND');
        const excerpt = found.page.text.slice(args.offset, args.offset + Math.min(args.length, 8000));
        return { ...metadata(found), id: found.sourceId, revision, offset: args.offset, text: excerpt, totalLength: found.page.text.length,
          sourceStale: found.page.sourceStale === true, nextOffset: args.offset + excerpt.length < found.page.text.length ? args.offset + excerpt.length : null };
      },
      async 'course.sync.report'(context, args) {
        const data = await read(context, ['courses', 'library']); courseOf(data, args.courseId);
        const report = globalThis.AskmeSyncHealth.report(object(data.library)[args.courseId]);
        const items = report.items.slice(args.offset, args.offset + args.limit).map(item => {
          return { ...item, url: sourceAddress(item.url, args.courseId, true) };
        });
        return { ...report.summary, items, total: report.items.length, nextOffset: args.offset + items.length < report.items.length ? args.offset + items.length : null };
      },
      async 'course.files.continue'(context, args) {
        const initial = await read(context, ['courses', 'library', 'courseIndexMutationRuntime']);
        const course = courseOf(initial, args.courseId), token = tokenOf(initial, course.id);
        if (context.expectedRevision !== undefined && context.expectedRevision !== token) fail('UI_STORAGE_CONFLICT');
        const scope = `files:${course.id}:${args.retry}`;
        const oldRuntime = object(initial.courseIndexMutationRuntime);
        if (context.operationId && list(oldRuntime.recentOperationIds).includes(context.operationId)) {
          if (object(oldRuntime.operationScopes)[context.operationId] !== scope) fail('UI_STORAGE_CONFLICT');
          return { courseId: course.id, revision: token, attempted: 0, duplicate: true, ...globalThis.AskmeSyncHealth.report(object(initial.library)[course.id]).summary };
        }
        const previous = object(initial.library)[course.id];
        if (!previous?.syncedAt) fail('UI_COURSE_READ_FAILED');
        const data = structuredClone(previous);
        if (args.retry) for (const file of data.files) if (['failed', 'partial'].includes(file.indexStatus)) file.indexStatus = 'pending';
        // 新一轮读取未完成前，旧失败文件正文不能作为新鲜证据。
        const pendingUrls = new Set(data.files.filter(file => !file.indexStatus || file.indexStatus === 'pending').map(file => file.url.split('#')[0]));
        for (const page of data.pages) if (page.sourceType === 'file' && pendingUrls.has(page.url.split('#')[0])) { page.sourceStale = true; page.sourceStaleReason = 'file-refresh-incomplete'; }
        const attempted = await parseFiles(context, data, previous, course);
        const latest = await read(context, ['courses', 'library', 'courseIndexMutationRuntime']);
        courseOf(latest, course.id);
        if (tokenOf(latest, course.id) !== token) fail('UI_STORAGE_CONFLICT');
        const runtime = object(latest.courseIndexMutationRuntime);
        const recent = list(runtime.recentOperationIds).filter(value => typeof value === 'string').slice(-99);
        if (context.operationId) recent.push(context.operationId);
        const scopes = Object.fromEntries(recent.flatMap(id => object(runtime.operationScopes)[id] ? [[id, runtime.operationScopes[id]]] : []));
        if (context.operationId) scopes[context.operationId] = scope;
        data.fileUpdatedAt = new Date().toISOString(); data.syncStatus = incomplete(data) ? 'partial' : 'succeeded';
        if (attempted) { data.knowledgeUnits = []; data.assessmentPreparations = []; data.knowledgeIndexPending = true; }
        await write(context, { library: { ...object(latest.library), [course.id]: data }, courseIndexMutationRuntime: {
          ...runtime, courseTokens: { ...object(runtime.courseTokens), [course.id]: token + 1 }, recentOperationIds: recent, operationScopes: scopes
        } });
        return { courseId: course.id, revision: token + 1, attempted, ...globalThis.AskmeSyncHealth.report(data).summary };
      },
      async 'course.sync'(context, args) {
        const initial = await read(context, ['courses', 'library', 'courseIndexMutationRuntime']);
        const course = courseOf(initial, args.courseId), token = tokenOf(initial, course.id);
        if (context.expectedRevision !== undefined && context.expectedRevision !== token) fail('UI_STORAGE_CONFLICT');
        const oldRuntime = object(initial.courseIndexMutationRuntime);
        if (context.operationId && list(oldRuntime.recentOperationIds).includes(context.operationId)) {
          if (object(oldRuntime.operationScopes)[context.operationId] !== `sync:${course.id}`) fail('UI_STORAGE_CONFLICT');
          return { courseId: course.id, revision: token, duplicate: true };
        }
        const previous = object(initial.library)[course.id];
        const result = await send(context, { type: 'SYNC_COURSE', course });
        const data = mergeSnapshot(result.data, previous, course);
        await parseFiles(context, data, previous, course);
        await context.assertCurrent();
        data.syncedAt = new Date().toISOString(); data.syncStatus = incomplete(data) ? 'partial' : 'succeeded';
        const latest = await read(context, ['courses', 'library', 'courseIndexMutationRuntime']);
        courseOf(latest, course.id);
        if (tokenOf(latest, course.id) !== token) fail('UI_STORAGE_CONFLICT');
        const runtime = object(latest.courseIndexMutationRuntime), recent = list(runtime.recentOperationIds).filter(value => typeof value === 'string').slice(-99);
        if (context.operationId) recent.push(context.operationId);
        const scopes = Object.fromEntries(recent.flatMap(id => object(runtime.operationScopes)[id] ? [[id, runtime.operationScopes[id]]] : []));
        if (context.operationId) scopes[context.operationId] = `sync:${course.id}`;
        await write(context, { library: { ...object(latest.library), [course.id]: data }, courseIndexMutationRuntime: {
          ...runtime, courseTokens: { ...object(runtime.courseTokens), [course.id]: token + 1 }, recentOperationIds: recent, operationScopes: scopes
        } });
        return { courseId: course.id, revision: token + 1, status: data.syncStatus, syncedAt: data.syncedAt,
          pageCount: data.pages.length, fileCount: data.files.length, eventCount: list(data.events).length,
          pendingFiles: data.files.filter(file => file.indexStatus === 'pending').length, fileExtractionSkipped: data.fileExtractionSkipped,
          ...(globalThis.AskmeSyncHealth?.report(data).summary || { issueCount: Math.max(list(data.errors).length, list(data.failedActivities).length) + data.fileErrors.length }),
          eventsStale: data.eventsStale === true, fileIndexStatus: data.fileIndexStatus, knowledgeIndexPending: true };
      }
    });
  }
  globalThis.AskmeCourseService = Object.freeze({ createCourseService });
})();
