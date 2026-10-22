// 对话成果持久化；题目、答卷和引用归属当前账号、课程与会话。
(() => {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];
  const ids = ['A', 'B', 'C', 'D'];
  const fail = code => { throw new Error(code); };
  const clean = value => String(value || '').replace(/^(?:Course is (?:not )?starred\s*)+/iu, '').trim();
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
  const random = () => { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return [...bytes].map(n => n.toString(16).padStart(2, '0')).join(''); };
  const normalize = value => String(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
  // 显式周次属于检索边界，不能因关键词命中其他讲义而被放宽。
  function weeksIn(value) {
    const weeks = new Set();
    for (const pattern of [/\bweeks?[\s_-]*(\d{1,2})(?!\d)(?:\s*(?:[-–—]|to)\s*(\d{1,2})(?!\d))?/giu, /第?\s*(\d{1,2})\s*周(?:\s*(?:[-–—至到])\s*第?\s*(\d{1,2})\s*周)?/gu]) {
      for (const match of String(value || '').matchAll(pattern)) {
        const first = Number(match[1]), last = Number(match[2] || match[1]);
        if (first > 0 && last >= first && last <= 53) for (let week = first; week <= last; week++) weeks.add(week);
      }
    }
    return weeks;
  }
  function quizIntent(value) {
    const text = String(value || '');
    if (/(?:不要|不用|别|do not|don't|without).{0,20}(?:出题|生成|quiz|测验|选择题)/iu.test(text)) return false;
    return /(?:出|生成|制作|准备|给我|来|create|make|generate|give|build).{0,55}(?:quiz|选择题|测验|单选|自测)/iu.test(text) || /(?:quiz|test)\s+me\b/iu.test(text);
  }
  function requestedCount(value) {
    const text = String(value || ''), match = text.match(/(?:出|生成|制作|准备|给我)?\s*(\d{1,3})\s*(?:道|题|个问题|questions?|题测验)/iu);
    if (match) return Number(match[1]);
    const chinese = text.match(/([一二三四五六七八九十两]{1,3})\s*(?:道|题)/u)?.[1];
    if (!chinese) return 3;
    const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (chinese.includes('十')) { const [a, b] = chinese.split('十'); return (a ? digits[a] || 0 : 1) * 10 + (b ? digits[b] || 0 : 0); }
    return digits[chinese] || 3;
  }
  function staticSource(page, courseId) {
    if (String(page?.courseId) !== courseId || page.stale || page.sourceStale || page.refreshPending || page.truncated || page.textTruncated || typeof page.text !== 'string') return false;
    try {
      const u = new URL(page.url), path = decodeURIComponent(u.pathname);
      return u.origin === 'https://moodle.telt.unsw.edu.au' && !u.username && !u.password &&
        (/^\/mod\/(page|book|folder|resource)\/view\.php$/iu.test(path) || path === '/course/view.php' && u.searchParams.get('id') === courseId || /^\/pluginfile\.php\//iu.test(path)) &&
        !/(?:^|\/)(?:mod_quiz|mod_assign|mod_forum|quiz|assign|forum|attempt|submission|submit|edit|grade)(?:\/|$)/iu.test(path) &&
        ![...u.searchParams.keys()].some(k => /^(attempt|action|submission|submit|edit|grade|sesskey)$/iu.test(k));
    } catch { return false; }
  }
  function createConversationSkills({ storage, request, now = Date.now }) {
    const core = globalThis.AskmeLearningCore, protocol = globalThis.AskmeUiProtocol;
    const key = (context, field) => `askme:v1:user:${context.accountId}:${field}`;
    async function read(context, args) {
      await context.assertCurrent();
      const fields = ['courses', 'library', 'chatSessions', 'quizArtifacts'], names = fields.map(field => key(context, field));
      const stored = await storage.get(names); await context.assertCurrent();
      const data = Object.fromEntries(fields.map((field, i) => [field, stored[names[i]]]));
      const course = list(data.courses).find(item => String(item.id) === args.courseId);
      if (!course) fail('UI_COURSE_NOT_FOUND');
      const session = list(data.chatSessions?.[args.courseId]?.sessions).find(item => item.id === args.sessionId);
      if (!session) fail('UI_SESSION_NOT_FOUND');
      const artifact = args.artifactId ? data.quizArtifacts?.[args.courseId]?.[args.artifactId] : null;
      if (args.artifactId && (!artifact || artifact.sessionId !== args.sessionId || artifact.courseId !== args.courseId)) fail('UI_SESSION_NOT_FOUND');
      return { ...data, course, session, artifact, pages: list(data.library?.[args.courseId]?.pages) };
    }
    function fresh(data, artifact) {
      for (const item of artifact.sources) {
        if (!data.pages.some(page => staticSource(page, artifact.courseId) && String(page.id || page.url) === item.pageId && page.url === item.source.url && page.text.includes(item.source.excerpt))) fail('UI_SOURCE_CHANGED');
      }
    }
    function sourcePlan(data, args, count) {
      const pages = data.pages.filter(page => staticSource(page, args.courseId));
      let segments = core.structureAwareSegments(pages, args.courseId);
      const requestedWeeks = weeksIn(args.question);
      if (requestedWeeks.size) {
        const foundWeeks = new Set();
        segments = segments.filter(segment => {
          const sourceWeeks = weeksIn([segment.title, segment.section, ...list(segment.headingPath)].join(' '));
          const matching = [...requestedWeeks].filter(week => sourceWeeks.has(week));
          matching.forEach(week => foundWeeks.add(week));
          return matching.length > 0;
        });
        if ([...requestedWeeks].some(week => !foundWeeks.has(week))) return [];
      }
      // 只去除题量，保留 Week 4 / Task 1 等检索范围中的数字。
      const topic = args.question.replace(/(?:\d+|[一二三四五六七八九十两]+)\s*(?:道|题|questions?)/giu, ' ')
        .replace(/(?:根据|当前|课程|资料|请|给我|帮我|出|生成|制作|准备|选择题|测验|单选|自测|quiz|questions?|create|make|generate|give|build|道题)/giu, ' ').trim();
      const ranked = topic ? core.bm25Search(topic, segments, { limit: 30 }) : [];
      const chosen = ranked.length ? core.diversifyCandidates(ranked, { limit: Math.ceil(count / 3), lambda: .8 }) : segments.slice().sort((a, b) => Number(/pluginfile/iu.test(b.url)) - Number(/pluginfile/iu.test(a.url)));
      const result = [], seen = new Set();
      for (const segment of chosen) {
        const excerpt = String(segment.text || segment.excerpt || '').slice(0, 5000);
        const page = pages.find(p => p.url === segment.url && p.text.includes(excerpt));
        if (!page || excerpt.trim().length < 40 || seen.has(excerpt)) continue;
        seen.add(excerpt); result.push({ pageId: String(page.id || page.url), source: { title: clean(segment.title || page.title || data.course.title).slice(0, 250), url: page.url, excerpt } });
        if (result.length >= Math.ceil(count / 3)) break;
      }
      return result;
    }
    function status(artifact) { return artifact.expiresAt <= now() || artifact.status === 'expired' ? 'expired' : artifact.status; }
    function project(artifact, index = 0) {
      if (!Number.isInteger(index) || index < 0 || index >= artifact.questionCount) fail('UI_SOURCE_NOT_FOUND');
      const item = artifact.questions[index], feedback = item && artifact.feedback[item.id];
      const value = { id: artifact.id, title: artifact.title, questionCount: artifact.questionCount, generatedCount: artifact.questions.length,
        questionIndex: index, answeredCount: Object.keys(artifact.feedback).length, correctCount: Object.values(artifact.feedback).filter(f => f.verdict === 'correct').length,
        questions: item ? [{ id: item.id, question: item.question, options: item.options.map(o => ({ id: o.id, text: o.text })) }] : [],
        feedback: feedback ? { [item.id]: feedback } : {}, expiresAt: artifact.expiresAt, status: status(artifact), error: artifact.error || '' };
      if (!protocol.bounded(value, 60000)) fail('UI_RESPONSE_TOO_LARGE');
      return value;
    }
    async function save(context, args, artifact, expectedRevision) {
      const latest = await read(context, args);
      if (latest.artifact.revision !== expectedRevision) fail('UI_STORAGE_CONFLICT');
      fresh(latest, artifact); artifact.revision = expectedRevision + 1;
      await context.assertCurrent();
      await storage.set({ [key(context, 'quizArtifacts')]: { ...latest.quizArtifacts, [args.courseId]: { ...latest.quizArtifacts[args.courseId], [artifact.id]: artifact } } });
      await context.assertCurrent();
    }
    async function begin(context, args) {
      const data = await read(context, args), count = requestedCount(args.question);
      const date = new Date(now()).toISOString();
      const recordMessage = async (text, artifact, sources = []) => {
        const message = { role: 'assistant', text, sources, createdAt: date, ...(artifact ? { artifact: { type: 'quiz', id: artifact.id, title: artifact.title, questionCount: count, expiresAt: artifact.expiresAt, status: artifact.status } } : {}) };
        data.session.messages = [...list(data.session.messages), { role: 'user', text: args.question, createdAt: date }, message].slice(-40);
        if (data.session.title === '新会话') data.session.title = args.question.slice(0, 60);
        data.session.updatedAt = date;
        const values = { [key(context, 'chatSessions')]: data.chatSessions };
        if (artifact) {
          const previous = Object.entries(data.quizArtifacts?.[args.courseId] || {}).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0)).slice(0, 29);
          values[key(context, 'quizArtifacts')] = { ...data.quizArtifacts, [args.courseId]: { ...Object.fromEntries(previous), [artifact.id]: artifact } };
        }
        await context.assertCurrent(); await storage.set(values); await context.assertCurrent(); return { message, sessionId: args.sessionId };
      };
      if (count < 1 || count > 12) return recordMessage('目前一份测验支持 1–12 道题，请指定这个范围内的题数。');
      const sources = sourcePlan(data, args, count);
      if (!sources.length) return recordMessage(weeksIn(args.question).size ? '已同步的完整资料尚未覆盖你指定的周次，请先同步对应周次的讲义，再生成测验。' : '当前课程还没有可用于出题的完整原文，请先同步相应讲义。');
      const artifact = { id: `quiz:${random()}`, courseId: args.courseId, sessionId: args.sessionId,
        title: `${clean(data.course.title).split(/\s[-·]\s/u)[0].slice(0, 35) || '课程'} · 知识自测`, questionCount: count, sources, topic: args.question.slice(0, 1500),
        questions: [], feedback: {}, status: 'generating', revision: 0, createdAt: now(), expiresAt: now() + 30 * 60000 };
      return recordMessage(`正在根据课程原文准备 ${count} 道选择题，核验通过后会显示在下面的测验卡片中。`, artifact,
        sources.map(item => ({ ...item.source, excerpt: item.source.excerpt.slice(0, 500) })));
    }
    async function advance(context, args) {
      const data = await read(context, args), artifact = structuredClone(data.artifact), revision = artifact.revision;
      if (status(artifact) === 'expired' || artifact.status === 'active') return project(artifact);
      fresh(data, artifact);
      const sourceIndex = Math.min(Math.floor(artifact.questions.length / 3), artifact.sources.length - 1), source = artifact.sources[sourceIndex].source;
      const count = Math.min(3, artifact.questionCount - artifact.questions.length);
      try {
        const result = await request(context, '/choice/generate', { source, count, context: { topic: artifact.topic || '', avoidQuestions: artifact.questions.map(q => q.question.slice(0, 180)) } }, args.courseId); await context.assertCurrent();
        const contentDigest = await hash(source.excerpt); await context.assertCurrent();
        if (!/^[A-Za-z0-9_-]{32}$/u.test(result?.sessionId || '') || result.contentDigest !== contentDigest || result.sourceVerification !== 'verified' ||
          !Array.isArray(result.questions) || !result.questions.length || result.questions.length > count || result.questions.some(q => !/^q[1-3]$/u.test(q?.id || '') ||
            typeof q.question !== 'string' || q.question.length > 600 || !Array.isArray(q.options) || q.options.length !== 4 || new Set(q.options.map(o => o?.id)).size !== 4 ||
            q.options.some(o => !ids.includes(o?.id) || typeof o.text !== 'string' || !o.text.trim() || o.text.length > 350))) fail('UI_SERVICE_RESPONSE_INVALID');
        const stems = new Set(artifact.questions.map(q => normalize(q.question)));
        for (const q of result.questions) { const stem = normalize(q.question); if (stems.has(stem)) fail('UI_SERVICE_RESPONSE_INVALID'); stems.add(stem); }
        for (const q of result.questions) artifact.questions.push({ id: `q${artifact.questions.length + 1}`, question: q.question,
          options: q.options.map(o => ({ id: o.id, text: o.text })), sourceIndex, upstreamSessionId: result.sessionId, upstreamQuestionId: q.id, contentDigest });
        artifact.status = artifact.questions.length >= artifact.questionCount ? 'active' : 'generating'; artifact.error = '';
      } catch (error) {
        await context.assertCurrent();
        if (['UI_ACCOUNT_CHANGED', 'UI_BINDING_EXPIRED', 'UI_SOURCE_CHANGED'].includes(error.message)) throw error;
        artifact.status = 'failed'; artifact.error = '部分题目尚未通过生成或原文核验，可以重试剩余题目。';
      }
      await save(context, args, artifact, revision); return project(artifact);
    }
    async function check(context, args) {
      const data = await read(context, args), artifact = structuredClone(data.artifact), revision = artifact.revision;
      const q = artifact.questions.find(item => item.id === args.questionId);
      if (!q) fail('UI_SOURCE_NOT_FOUND');
      // 已提交的解析可永久回看；改变答案不触发第二次判分。
      const old = artifact.feedback[q.id];
      if (old) { if (old.selectedOptionId !== args.selectedOptionId) fail('UI_STORAGE_CONFLICT'); return old; }
      if (status(artifact) === 'expired') fail('UI_PRACTICE_EXPIRED');
      fresh(data, artifact);
      const result = await request(context, '/choice/check', { sessionId: q.upstreamSessionId, questionId: q.upstreamQuestionId, optionId: args.selectedOptionId, contentDigest: q.contentDigest }, args.courseId);
      await context.assertCurrent(); const source = artifact.sources[q.sourceIndex].source;
      if (result?.questionId !== q.upstreamQuestionId || result.contentDigest !== q.contentDigest || result.selectedOptionId !== args.selectedOptionId ||
          result.sourceVerification !== 'verified' || !ids.includes(result.correctOptionId) || !['correct', 'incorrect'].includes(result.verdict) ||
          result.verdict !== (result.correctOptionId === args.selectedOptionId ? 'correct' : 'incorrect') || typeof result.evidence?.quote !== 'string' ||
          !result.evidence.quote.trim() || !source.excerpt.includes(result.evidence.quote) || !Array.isArray(result.options) || result.options.length !== 4 ||
          new Set(result.options.map(o => o?.id)).size !== 4 || result.options.some(o => !ids.includes(o?.id) || typeof o.explanation !== 'string' || !o.explanation.trim() || o.explanation.length > 400)) fail('UI_SERVICE_RESPONSE_INVALID');
      const feedback = { questionId: q.id, selectedOptionId: result.selectedOptionId, correctOptionId: result.correctOptionId, verdict: result.verdict,
        sourceVerification: 'verified', options: result.options.map(o => ({ id: o.id, explanation: o.explanation })),
        evidence: { title: source.title, url: source.url, quote: result.evidence.quote } };
      artifact.feedback[q.id] = feedback;
      feedback.score = { correct: Object.values(artifact.feedback).filter(f => f.verdict === 'correct').length, answered: Object.keys(artifact.feedback).length, total: artifact.questionCount };
      await save(context, args, artifact, revision); return feedback;
    }
    return Object.freeze({ matches: quizIntent, begin,
      'chat.quiz.read': async (context, args) => { const data = await read(context, args); return project(data.artifact, args.questionIndex || 0); },
      'chat.quiz.advance': advance, 'chat.quiz.check': check });
  }
  globalThis.AskmeConversationSkills = Object.freeze({ createConversationSkills, quizIntent, requestedCount });
})();
