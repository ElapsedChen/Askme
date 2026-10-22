// 知识点与原文练习由后台负责；阅读、点击及选择题成绩不写入掌握记录。
(() => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fail = code => { throw new Error(code); };
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const id = value => typeof value === 'string' && /^\d{1,12}$/u.test(value);
  const bounded = value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 60000;
  const random = () => { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return [...bytes].map(n => n.toString(16).padStart(2, '0')).join(''); };
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
  function staticUrl(value, courseId) {
    try {
      const u = new URL(value), path = decodeURIComponent(u.pathname);
      if (u.origin !== 'https://moodle.telt.unsw.edu.au' || u.username || u.password || u.href.length > 2300) return '';
      if ([...u.searchParams.keys()].some(k => /^(attempt|action|submission|submit|edit|grade|sesskey)$/iu.test(k))) return '';
      if (/(?:^|\/)(mod_quiz|mod_assign|mod_forum|quiz|assign|forum|attempt|submission|submit|edit|grade)(?:\/|$)/iu.test(path)) return '';
      if (path === '/course/view.php') return u.searchParams.getAll('id').length === 1 && u.searchParams.get('id') === courseId ? u.href : '';
      return /^\/mod\/(page|book|folder|resource)\/view\.php$/iu.test(path) || /^\/pluginfile\.php(?:\/|$)/iu.test(path) || /\.(pdf|docx|pptx|xlsx|txt|csv)$/iu.test(path) ? u.href : '';
    } catch { return ''; }
  }
  const dayKey = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  function createStudyService({ storage, request, sourceRead, now = Date.now }) {
    const core = globalThis.AskmeLearningCore, knowledge = globalThis.AskmeKnowledgeUnits, progressCore = globalThis.AskmeUnitProgress;
    if (!core || !knowledge || !progressCore || !storage?.get || !storage?.set || typeof request !== 'function') fail('UI_SERVICE_CONFIGURATION');
    // sourceRead 保留适配器接口；证据使用本次重建的连续 sourceSegments，不拼接不同位置的句子。
    void sourceRead;
    const sessions = new Map();
    const key = (context, field) => `askme:v1:user:${context.accountId}:${field}`;
    async function guarded(context, operation) {
      await context.assertCurrent();
      try { return await operation(); }
      finally { await context.assertCurrent(); }
    }
    async function read(context, courseId) {
      if (!id(context.accountId) || !id(courseId)) fail('UI_COURSE_NOT_FOUND');
      const fields = ['courses', 'library', 'studyProgress'], names = fields.map(f => key(context, f));
      const raw = await guarded(context, () => storage.get(names));
      const data = Object.fromEntries(fields.map((f, i) => [f, raw[names[i]]]));
      const courses = list(data.courses);
      if (new Set(courses.map(c => String(c?.id))).size !== courses.length) fail('UI_STORAGE_CONFLICT');
      const course = courses.find(c => String(c?.id) === courseId);
      if (!course) fail('UI_COURSE_NOT_FOUND');
      return { ...data, course, content: object(data.library?.[courseId]) };
    }
    function rebuild(data, courseId) {
      const pages = list(data.content.pages).filter(page => String(page?.courseId) === courseId &&
        !page.stale && !page.sourceStale && !page.refreshPending && !page.truncated && !page.textTruncated && typeof page.text === 'string' && staticUrl(page.url, courseId));
      const segments = core.structureAwareSegments(pages, courseId), byId = new Map(segments.map(s => [s.id, s]));
      const units = knowledge.buildKnowledgeUnits(segments, { courseId, maxEvidence: 6, minConfidence: 0.7 });
      return units.flatMap(unit => {
        if (knowledge.knowledgeUnitState(unit) !== 'current') return [];
        // 先选出能容纳证据的一个连续片段；原文不插入自动生成的摘要。
        for (const evidence of unit.evidence) {
          const segment = byId.get(evidence.segmentId);
          if (!segment || segment.text.slice(evidence.charStart - segment.charStart, evidence.charEnd - segment.charStart).slice(0, 600) !== evidence.quote) continue;
          const local = evidence.charStart - segment.charStart;
          const start = Math.max(0, Math.min(local, segment.text.length - 1200));
          const source = { title: String(segment.title || unit.label).slice(0, 250), url: staticUrl(segment.url, courseId), excerpt: segment.text.slice(start, start + 1200) };
          if (!source.url || !source.excerpt.includes(evidence.quote)) continue;
          const identity = JSON.stringify({ unitId: unit.id, contentHash: unit.contentHash, evidence: unit.evidence, source, segmentId: segment.id, pageId: segment.pageId });
          // Assignment/Exam 等标题也可能是评分标准与讲解；按静态来源和正文判断可用性。
          return [{ unit, source, identity, practiceAvailable: source.excerpt.trim().length >= 40,
            section: String(segment.headingPath?.[0] || '').slice(0, 160) }];
        }
        return [];
      });
    }
    async function load(context, courseId) {
      const data = await read(context, courseId), units = rebuild(data, courseId);
      const hashes = await guarded(context, () => Promise.all(units.map(unit => digest(unit.identity))));
      units.forEach((entry, index) => { entry.version = hashes[index]; });
      return { data, units };
    }
    function currentProgress(data, courseId, entry) {
      // 旧 review/focus 不导入；只读此服务产生的最小作答记录。
      const record = data.studyProgress?.[courseId]?.[entry.unit.id];
      if (record?.schemaVersion !== 1 || record.origin !== 'practice-v2' || record.unitProgress?.knowledgeUnitId !== entry.unit.id || !Array.isArray(record.unitProgress.attempts)) return null;
      return progressCore.revalidateProgress(record.unitProgress, [entry.version]);
    }
    function project(data, courseId, entry) {
      const progress = currentProgress(data, courseId, entry);
      return { id: entry.unit.id, title: entry.unit.label, description: entry.unit.description, section: entry.section,
        source: { title: entry.source.title, url: entry.source.url, excerpt: entry.source.excerpt },
        status: progress?.status || 'unseen', dueAt: progress?.dueAt || '', errorTags: list(progress?.errorTags).slice(0, 10),
        attempts: list(progress?.attempts).length, evidenceCount: entry.unit.evidence.length, practiceAvailable: entry.practiceAvailable };
    }
    function page(items, offset, limit) {
      const output = [];
      for (const item of items.slice(offset, offset + limit)) { if (!bounded({ items: [...output, item] })) break; output.push(item); }
      return { items: output, total: items.length, nextOffset: offset + output.length < items.length ? offset + output.length : null };
    }
    function binding(courseId, entry) {
      return { courseId, knowledgeUnitId: entry.unit.id, sourceId: entry.unit.id, sourceVersionHashes: [entry.version], preparationSnapshotId: '' };
    }
    function ticket(context, args) {
      const entry = sessions.get(args.sessionId);
      if (!entry || entry.expiresAt <= now() || entry.accountId !== context.accountId || entry.accountEpoch !== context.accountEpoch ||
        entry.documentId !== context.documentId || entry.tabId !== context.tabId || entry.generation !== context.generation || entry.courseId !== args.courseId) fail('UI_PRACTICE_EXPIRED');
      return entry;
    }
    async function fresh(context, session) {
      const state = await load(context, session.courseId), current = state.units.find(unit => unit.unit.id === session.unitId);
      if (!current || current.identity !== session.identity || current.version !== session.version) fail('UI_SOURCE_CHANGED');
      return { ...state, current };
    }
    function feedback(result, session, question, recorded, progress) {
      return { sessionId: session.id, questionId: question.id, verdict: recorded ? result.verdict : 'ungradable',
        feedback: recorded && typeof result.feedback === 'string' ? result.feedback.slice(0, 1000) : '本次判题未通过课程原文核验，请回查来源；不会计入掌握或复习记录。',
        modelAnswer: recorded && typeof result.modelAnswer === 'string' ? result.modelAnswer.slice(0, 800) : '',
        explanation: recorded && typeof result.explanation === 'string' ? result.explanation.slice(0, 1000) : '',
        evidence: recorded ? result.evidence : '',
        verification: recorded ? 'verified' : 'needsReview', recorded, status: progress?.status || 'needsReview', dueAt: progress?.dueAt || '',
        errorTags: recorded ? list(progress?.errorTags) : [], source: session.source };
    }
    return Object.freeze({
      async 'study.units'(context, args) {
        if (!exact(args, ['courseId', 'offset', 'limit']) || !Number.isInteger(args.offset) || args.offset < 0 || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 30) fail('INVALID_UI_REQUEST');
        const { data, units } = await load(context, args.courseId);
        return page(units.map(entry => project(data, args.courseId, entry)), args.offset, args.limit);
      },
      async 'study.plan'(context, args) {
        if (!exact(args, ['courseId']) && !exact(args, ['courseId', 'limit'])) fail('INVALID_UI_REQUEST');
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) fail('INVALID_UI_REQUEST');
        const { data, units } = await load(context, args.courseId), time = now(), groups = { due: [], weak: [], fresh: [] };
        for (const entry of units) {
          if (!entry.practiceAvailable) continue;
          const item = project(data, args.courseId, entry), due = Date.parse(item.dueAt);
          if (Number.isFinite(due) && due <= time && item.status !== 'needsRevalidation') groups.due.push({ ...item, reason: 'due' });
          else if (['weak', 'needsRevalidation'].includes(item.status)) groups.weak.push({ ...item, reason: item.status === 'weak' ? 'weak' : 'source-changed' });
          else if (item.status === 'unseen') groups.fresh.push({ ...item, reason: 'new' });
        }
        groups.due.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
        const items = [...groups.due, ...groups.weak, ...groups.fresh];
        return { ...page(items, 0, args.limit || 10), counts: { due: groups.due.length, weak: groups.weak.length, fresh: groups.fresh.length },
          policy: 'one-day-different-question', scope: 'course-material', assessmentScopeConfirmed: false };
      },
      async 'practice.start'(context, args) {
        if (!exact(args, ['courseId', 'unitId']) || typeof args.unitId !== 'string' || args.unitId.length > 180) fail('INVALID_UI_REQUEST');
        const { data, units } = await load(context, args.courseId), entry = units.find(unit => unit.unit.id === args.unitId);
        if (!entry || !entry.practiceAvailable) fail('UI_SOURCE_NOT_FOUND');
        const previous = currentProgress(data, args.courseId, entry), history = progressCore.nextVariantContext(previous);
        const versionContext = { schemaVersion: 2, ...binding(args.courseId, entry), dayKey: dayKey(now()), questionCount: 1,
          ...history, variantSeed: `${dayKey(now())}:${random()}` };
        const contentDigest = await guarded(context, () => digest(entry.source.excerpt));
        const result = await guarded(context, () => request(context, '/practice/generate', { source: entry.source, context: versionContext }, args.courseId));
        if (result?.schemaVersion !== 2 || !/^[A-Za-z0-9_-]{32}$/u.test(result.sessionId || '') || result.contentDigest !== contentDigest ||
          !progressCore.currentBinding(result.binding, versionContext) || !Array.isArray(result.questions) || result.questions.length !== 1) fail('UI_SERVICE_RESPONSE_INVALID');
        const q = result.questions[0];
        if (!/^q[1-3]$/u.test(q?.id || '') || typeof q.question !== 'string' || !q.question.trim() || q.question.length > 500 ||
          !/^practice:[a-f0-9]{24}$/u.test(q.itemId || '') || !/^[a-f0-9]{24}$/u.test(q.normalizedStemHash || '') ||
          typeof q.variantKey !== 'string' || !q.variantKey || q.variantKey.length > 180 || history.previousItemIds.includes(q.itemId) || history.previousVariantKeys.includes(q.variantKey) ||
          list(previous?.attempts).some(a => a.normalizedStemHash === q.normalizedStemHash)) fail('UI_SERVICE_RESPONSE_INVALID');
        const session = { id: result.sessionId, accountId: context.accountId, accountEpoch: context.accountEpoch, documentId: context.documentId,
          tabId: context.tabId, generation: context.generation, courseId: args.courseId, unitId: args.unitId, identity: entry.identity, version: entry.version,
          source: entry.source, contentDigest, expectedBinding: binding(args.courseId, entry), question: { id: q.id, itemId: q.itemId, normalizedStemHash: q.normalizedStemHash, variantKey: q.variantKey },
          attemptId: `attempt:${random()}`, expiresAt: now() + 30 * 60000 };
        await fresh(context, session);
        for (const [sessionId, value] of sessions) if (value.expiresAt <= now()) sessions.delete(sessionId);
        if (sessions.size >= 50) sessions.delete(sessions.keys().next().value);
        sessions.set(session.id, session);
        return { sessionId: session.id, unitId: args.unitId, question: { id: q.id, question: q.question }, expiresAt: session.expiresAt };
      },
      async 'practice.submit'(context, args) {
        if (!exact(args, ['courseId', 'sessionId', 'questionId', 'answer']) || typeof args.answer !== 'string' || !args.answer.trim() || args.answer.length > 2000) fail('INVALID_UI_REQUEST');
        const session = ticket(context, args), q = session.question;
        if (q.id !== args.questionId) fail('UI_PRACTICE_EXPIRED');
        await fresh(context, session);
        if (session.result) {
          if (session.answer !== args.answer) fail('UI_STORAGE_CONFLICT');
          return structuredClone(session.result);
        }
        if (session.pending) fail('UI_BUSY');
        session.pending = true;
        try {
          const result = session.checked || await guarded(context, () => request(context, '/practice/check', {
            sessionId: session.id, questionId: q.id, attemptId: session.attemptId, studentAnswer: args.answer
          }, args.courseId));
          if (session.checked && session.answer !== args.answer) fail('UI_STORAGE_CONFLICT');
          const { data, current } = await fresh(context, session);
          ticket(context, args);
          if (result?.schemaVersion !== 2 || result.contentDigest !== session.contentDigest || !progressCore.currentBinding(result.binding, session.expectedBinding) ||
            result.binding.practiceItemId !== q.itemId || result.binding.normalizedStemHash !== q.normalizedStemHash || result.binding.variantKey !== q.variantKey ||
            result.binding.attemptId !== session.attemptId || !['correct', 'partial', 'incorrect', 'ungradable'].includes(result.verdict)) fail('UI_SERVICE_RESPONSE_INVALID');
          session.checked = result; session.answer = args.answer;
          const quoteValid = typeof result.evidence === 'string' && result.evidence.trim().length >= 5 && result.evidence.length <= 220 && session.source.excerpt.includes(result.evidence);
          const normalizedQuote = quoteValid ? result.evidence.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim() : '';
          const quoteId = normalizedQuote ? `evidence:${(await guarded(context, () => digest(normalizedQuote))).slice(0, 24)}` : '';
          const verifiedRefs = quoteValid && !!quoteId && result.verification?.method === 'independent-semantic-audit' &&
            list(result.evidenceRefs).length > 0 && list(result.evidenceRefs).every(ref => ref?.id === quoteId && ref.sourceVersionHash === session.version) &&
            list(result.criterionResults).every(item => list(result.evidenceRefs).some(ref => ref.id === item?.evidenceRef?.id && item.evidenceRef.sourceVersionHash === session.version));
          const attempt = verifiedRefs ? progressCore.minimalAttempt(result, { expectedBinding: session.expectedBinding, now: now(), hintLevel: 0, answerViewed: false }) : null;
          let progress = currentProgress(data, args.courseId, current);
          if (attempt) {
            // 引用摘要计算也是异步边界；写入前再次核对当前来源及最新进度。
            const latest = await fresh(context, session);
            ticket(context, args);
            progress = currentProgress(latest.data, args.courseId, latest.current);
            // 来源变化后的旧正确作答不可与新版本拼成延迟掌握。
            if (progress?.status === 'needsRevalidation') progress = null;
            progress = progressCore.applyAttempt(progress, attempt, now());
            const all = object(latest.data.studyProgress), course = object(all[args.courseId]);
            const next = { ...all, [args.courseId]: { ...course, [session.unitId]: { schemaVersion: 1, origin: 'practice-v2',
              contentHash: latest.current.unit.contentHash, unitProgress: progress } } };
            await guarded(context, () => storage.set({ [key(context, 'studyProgress')]: next }));
          }
          const view = feedback(result, session, q, !!attempt, progress);
          if (!bounded(view)) fail('UI_RESPONSE_TOO_LARGE');
          session.result = view;
          return structuredClone(view);
        } finally { session.pending = false; }
      }
    });
  }
  globalThis.AskmeStudyService = Object.freeze({ createStudyService });
})();
