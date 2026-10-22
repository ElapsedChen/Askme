// 资料检索与会话留在后台；UI 只接收当前课程、当前会话的有限结果。
(() => {
  'use strict';
  const p = globalThis.AskmeUiProtocol, core = globalThis.AskmeLearningCore;
  const array = value => Array.isArray(value) ? value : [];
  const key = (context, field) => `askme:v1:user:${context.accountId}:${field}`;
  const random = () => { const b = new Uint8Array(16); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };
  const safeUrl = value => { try { const u = new URL(value); return u.origin === 'https://moodle.telt.unsw.edu.au' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
  const sourceView = source => ({ title: String(source.title || '课程资料').slice(0, 250), url: safeUrl(source.url), excerpt: String(source.excerpt || source.text || '').slice(0, 6000) });
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
  function createLearningService({ storage, request, sourceRead, sendToDocument, openAuth, captureRead, captureRelease = () => {} }) {
    const practice = new Map();
    async function read(context, courseId) {
      const fields = ['courses', 'library', 'chatSessions'], names = fields.map(f => key(context, f));
      const stored = await storage.get(names); await context.assertCurrent();
      const data = Object.fromEntries(fields.map((f, i) => [f, stored[names[i]]]));
      const course = array(data.courses).find(c => String(c.id) === courseId);
      if (!course) throw new Error('UI_COURSE_NOT_FOUND');
      return { ...data, course, content: data.library?.[courseId] || {} };
    }
    function findSession(data, courseId, sessionId) {
      const session = array(data.chatSessions?.[courseId]?.sessions).find(s => s.id === sessionId);
      if (!session) throw new Error('UI_SESSION_NOT_FOUND');
      return session;
    }
    async function saveTurn(context, courseId, sessionId, question, answer, sources, version) {
      const data = await read(context, courseId), session = findSession(data, courseId, sessionId);
      if (JSON.stringify(session.messages) !== version) throw new Error('UI_STORAGE_CONFLICT');
      const date = new Date().toISOString();
      const message = { role: 'assistant', text: answer, sources, createdAt: date };
      session.messages = [...array(session.messages), { role: 'user', text: question, createdAt: date }, message].slice(-40);
      session.title = session.title === '新会话' ? question.slice(0, 60) : session.title;
      session.updatedAt = date;
      await context.assertCurrent();
      await storage.set({ [key(context, 'chatSessions')]: data.chatSessions });
      return { message, sessionId };
    }
    function segmentsOf(content, courseId) {
      const pages = array(content.pages).filter(page => String(page.courseId) === courseId && safeUrl(page.url) && !page.stale && !page.sourceStale && !page.refreshPending);
      return core.structureAwareSegments(pages, courseId);
    }
    function retrieve(question, content, courseId, scopeQuery = question) {
      const segments = segmentsOf(content, courseId);
      const candidates = core.scopedSearch(question, segments, { limit: 20, scopeQuery });
      const chosen = core.diversifyCandidates(candidates, { limit: 5, lambda: 0.78 });
      return core.contextualizeCandidates(chosen, segments, { maxChars: 1200, sideChars: 220, query: question }).map(sourceView).filter(s => s.url && s.excerpt);
    }
    async function ask(context, args, pageSource) {
      const data = await read(context, args.courseId), session = findSession(data, args.courseId, args.sessionId);
      const version = JSON.stringify(session.messages);
      const history = array(session.messages).filter(m => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string' && m.text.trim())
        .slice(-8).map(m => ({ role: m.role, content: m.text.slice(0, 5000) }));
      while (history.reduce((length, item) => length + item.content.length, 0) > 12000) history.shift();
      const priorQuestion = [...history].reverse().find(m => m.role === 'user')?.content || '';
      const query = core.retrievalQuery(args.question, priorQuestion).query;
      const initialSnapshot = JSON.stringify(data.content);
      let sources = pageSource ? [sourceView(pageSource)] : retrieve(query, data.content, args.courseId);
      const deadlineIntent = globalThis.AskmeDeadlineSources.intent(args.question);
      if (deadlineIntent && !pageSource && !args.captureId) {
        // 先回查日历；已经截止的活动可能不在 upcoming，须回查已发现活动的静态日期区。
        const fresh = await sendToDocument(context, { type: 'SYNC_COURSE_EVENTS', course: data.course });
        await context.assertCurrent();
        if (fresh?.accountId !== context.accountId) throw new Error('UI_ACCOUNT_CHANGED');
        sources = fresh.ok ? globalThis.AskmeDeadlineSources.sources(args.question, args.courseId, array(fresh.data?.events || fresh.data)) : [];
        if (!sources.length) {
          const activities = globalThis.AskmeDeadlineSources.activityCandidates(args.question, args.courseId, data.content);
          if (activities.length) {
            const dates = await sendToDocument(context, { type: 'READ_ACTIVITY_DATES', course: data.course, activities });
            await context.assertCurrent();
            if (dates?.accountId !== context.accountId) throw new Error('UI_ACCOUNT_CHANGED');
            if (!dates.ok) throw new Error('UI_CALENDAR_UNAVAILABLE');
            const allowed = new Set(activities.map(activity => activity.url));
            sources = array(dates.data?.sources).filter(source => allowed.has(source.url) && source.eventType === deadlineIntent);
            if (sources.length > 5) throw new Error('UI_SERVICE_RESPONSE_INVALID');
          } else if (!fresh.ok) throw new Error('UI_CALENDAR_UNAVAILABLE');
        }
        if (!sources.length) return saveTurn(context, args.courseId, args.sessionId, args.question,
          '未能从 Moodle 日历或对应活动的日期区找到可核对的时间。请使用完整活动名称，或打开原活动核对。', [], version);
        sources = sources.map(sourceView);
      } else if (!sources.length && /[\u3400-\u9fff]/u.test(args.question) && !args.captureId) {
        // 只有所有资料都明确属于其他周次时才跳过翻译；周次未知的资料仍可继续检索。
        if (!core.queryWeeks(query).length || core.retrievalScope(query, segmentsOf(data.content, args.courseId)).length) {
          const translated = await request(context, '/translate', { question: query.slice(0, 1500) }, args.courseId);
          if (Array.isArray(translated.terms)) sources = retrieve(`${query} ${translated.terms.filter(t => typeof t === 'string').slice(0, 12).join(' ')}`, data.content, args.courseId, query);
        }
      }
      if (!sources.length && !args.captureId) return saveTurn(context, args.courseId, args.sessionId, args.question,
        '已同步资料中未找到支持这次问题的原文。请补充课程关键词，或先同步对应讲义。', [], version);
      const image = args.captureId ? await captureRead(context, args.captureId) : null;
      // 问答合同最多每条 1200 字；练习 sourceView 的 6000 字预算不共用到此端点。
      sources = sources.map(source => ({ ...sourceView(source), excerpt: String(source.excerpt || '').slice(0, 1200) }));
      const payload = {
        question: args.question, history, sources, ...(image ? { image } : {})
      };
      // 请求总量受 UTF-8 字节限制；优先保留当前依据和问题，再舍弃最早历史。
      while (!p.bounded(payload, image ? 12000000 : 32000) && history.length) history.shift();
      if (!p.bounded(payload, image ? 12000000 : 32000)) throw new Error('UI_REQUEST_TOO_LARGE');
      const result = await request(context, image ? '/vision/answer' : '/answer', payload, args.courseId);
      if (typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 20000) throw new Error('UI_SERVICE_RESPONSE_INVALID');
      const current = await read(context, args.courseId);
      if (JSON.stringify(current.content) !== initialSnapshot) throw new Error('UI_SOURCE_CHANGED');
      const saved = await saveTurn(context, args.courseId, args.sessionId, args.question, result.answer, sources, version);
      if (args.captureId) captureRelease(context, args.captureId);
      return saved;
    }
    return Object.freeze({
      async 'chat.create'(context, args) {
        const data = await read(context, args.courseId), date = new Date().toISOString();
        const session = { id: `chat:${Date.now()}:${random()}`, title: '新会话', createdAt: date, updatedAt: date, messages: [] };
        const sessions = array(data.chatSessions?.[args.courseId]?.sessions);
        const chats = { ...data.chatSessions, [args.courseId]: { activeId: session.id, sessions: [session, ...sessions].slice(0, 20) } };
        await context.assertCurrent(); await storage.set({ [key(context, 'chatSessions')]: chats });
        return { sessionId: session.id };
      },
      'chat.ask': ask,
      async 'page.explain'(context, args) {
        const source = await sendToDocument(context, { type: 'GET_CURRENT_PAGE_SOURCE' });
        if (!source?.ok || source.accountId !== context.accountId || String(source.source?.courseId) !== args.courseId) throw new Error('UI_SOURCE_NOT_FOUND');
        return ask(context, { ...args, question: '请讲清楚当前页面的核心概念、逻辑关系和容易混淆之处。' }, source.source);
      },
      async 'choice.generate'(context, args) {
        await read(context, args.courseId);
        const original = await sourceRead(context, { courseId: args.courseId, sourceId: args.sourceId, offset: 0, length: 6000 });
        if (original.sourceStale || original.stale || original.truncated) throw new Error('UI_SOURCE_CHANGED');
        const source = sourceView(original);
        const result = await request(context, '/choice/generate', { source, count: args.count }, args.courseId);
        if (!/^[A-Za-z0-9_-]{32}$/u.test(result?.sessionId || '') || !Array.isArray(result.questions) || result.questions.length > 3) throw new Error('UI_SERVICE_RESPONSE_INVALID');
        const current = sourceView(await sourceRead(context, { courseId: args.courseId, sourceId: args.sourceId, offset: 0, length: 6000 }));
        const contentDigest = await digest(source.excerpt);
        if (JSON.stringify(source) !== JSON.stringify(current) || contentDigest !== result.contentDigest) throw new Error('UI_SOURCE_CHANGED');
        for (const [id, entry] of practice) if (entry.expiresAt < Date.now()) practice.delete(id);
        if (practice.size >= 50) practice.delete(practice.keys().next().value);
        practice.set(result.sessionId, { accountId: context.accountId, accountEpoch: context.accountEpoch, documentId: context.documentId,
          courseId: args.courseId, sourceId: args.sourceId, source, contentDigest, expiresAt: Date.now() + 30 * 60000 });
        // 明确投影，不能因为上游失误将答案键下发给 renderer。
        return { sessionId: result.sessionId, questions: result.questions.map(q => ({ id: q.id, question: q.question,
          options: array(q.options).map(o => ({ id: o.id, text: o.text })) })), sourceVerification: result.sourceVerification };
      },
      async 'choice.check'(context, args) {
        const entry = practice.get(args.sessionId);
        if (!entry || entry.expiresAt < Date.now() || entry.accountId !== context.accountId || entry.accountEpoch !== context.accountEpoch ||
          entry.documentId !== context.documentId || entry.courseId !== args.courseId) throw new Error('UI_PRACTICE_EXPIRED');
        const source = sourceView(await sourceRead(context, { courseId: args.courseId, sourceId: entry.sourceId, offset: 0, length: 6000 }));
        if (JSON.stringify(source) !== JSON.stringify(entry.source)) throw new Error('UI_SOURCE_CHANGED');
        return request(context, '/choice/check', { sessionId: args.sessionId, questionId: args.questionId,
          optionId: args.selectedOptionId, contentDigest: entry.contentDigest }, args.courseId);
      },
      async 'ai.status'(context) {
        const result = await request(context, '/chatgpt/status');
        return { connected: result.authenticated === true, ready: result.ready === true, model: typeof result.model === 'string' ? result.model : '', state: String(result.state || '').slice(0, 60) };
      },
      async 'ai.models'(context) {
        const result = await request(context, '/chatgpt/models', {});
        return { items: array(result.models).flatMap(x => {
          const id = typeof x === 'string' ? x : x?.slug;
          return typeof id === 'string' && /^[a-zA-Z0-9._-]{1,100}$/u.test(id) ? [{ id, name: String(x?.displayName || id).slice(0, 100) }] : [];
        }), model: typeof result.model === 'string' ? result.model : '' };
      },
      async 'ai.connect'(context) {
        const result = await request(context, '/chatgpt/connect', {});
        const url = new URL(result.authorizationUrl);
        if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password) throw new Error('UI_AUTH_URL_INVALID');
        await context.assertCurrent(); await openAuth(url.href);
        return { opened: true };
      },
      async 'ai.select'(context, args) { await request(context, '/chatgpt/select', { model: args.model }); return { model: args.model }; },
      async 'ai.disconnect'(context) { const result = await request(context, '/chatgpt/disconnect', {}); return { connected: false, revoked: result.revoked === true }; }
    });
  }
  globalThis.AskmeLearningService = Object.freeze({ createLearningService });
})();
