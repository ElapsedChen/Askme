// 后台资料投影：沿用已有账号存储键，界面无法指定存储键或读取另一个账号。
(() => {
  'use strict';
  const p = globalThis.AskmeUiProtocol;
  const list = value => Array.isArray(value) ? value : [];
  const short = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const key = (accountId, field) => `askme:v1:user:${accountId}:${field}`;
  const link = value => {
    try { const url = new URL(value); return url.origin === 'https://moodle.telt.unsw.edu.au' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  };
  function createAccountStore({ storage }) {
    async function read(context, fields) {
      if (!p.id(context.accountId)) throw new Error('UI_ACCOUNT_CHANGED');
      const names = fields.map(field => key(context.accountId, field));
      const stored = await storage.get(names);
      await context.assertCurrent();
      return Object.fromEntries(fields.map((field, index) => [field, stored[names[index]]]));
    }
    function coursesOf(data) {
      const courses = list(data.courses).filter(item => p.id(String(item?.id || '')));
      if (new Set(courses.map(item => String(item.id))).size !== courses.length) throw new Error('UI_STORAGE_CONFLICT');
      return courses;
    }
    function courseOf(data, id) {
      const course = coursesOf(data).find(item => String(item.id) === id);
      if (!course) throw new Error('UI_COURSE_NOT_FOUND');
      return course;
    }
    function projectCourse(course, data) {
      const id = String(course.id), content = data.library?.[id];
      return { id, title: short(course.title, 250), url: link(course.url), selected: course.selected === true,
        pageCount: list(content?.pages).length, fileCount: list(content?.files).length,
        ...(globalThis.AskmeSyncHealth?.report(content).summary || { issueCount: Math.max(list(content?.errors).length, list(content?.failedActivities).length) + list(content?.fileErrors).length }),
        syncedAt: short(content?.syncedAt, 40) };
    }
    function sessionsOf(data, courseId) {
      courseOf(data, courseId);
      const sessions = list(data.chatSessions?.[courseId]?.sessions).filter(item => typeof item?.id === 'string' && /^chat:[A-Za-z0-9:._-]{8,100}$/u.test(item.id));
      if (new Set(sessions.map(item => item.id)).size !== sessions.length) throw new Error('UI_STORAGE_CONFLICT');
      return sessions;
    }
    function projectMessage(message) {
      if (!['user', 'assistant'].includes(message?.role) || typeof message.text !== 'string' || message.text.length > 20000) return null;
      const quiz = message.artifact;
      const artifact = quiz?.type === 'quiz' && /^quiz:[a-f0-9]{32}$/u.test(quiz.id || '') && Number.isInteger(quiz.questionCount) && quiz.questionCount >= 1 && quiz.questionCount <= 12
        ? { type: 'quiz', id: quiz.id, title: short(quiz.title, 120), questionCount: quiz.questionCount, expiresAt: Number(quiz.expiresAt) || 0, status: ['generating', 'active', 'expired', 'failed'].includes(quiz.status) ? quiz.status : 'expired' } : null;
      return { role: message.role, text: message.text, createdAt: short(message.createdAt, 40), ...(artifact ? { artifact } : {}),
        sources: list(message.sources).slice(0, 5).flatMap(source => {
          const url = link(source?.url);
          return url ? [{ url, title: short(source.title, 250), excerpt: short(source.excerpt, 500) }] : [];
        }) };
    }
    return Object.freeze({
      async 'ui.bootstrap'(context) {
        const data = await read(context, ['courses']);
        const layout = (await storage.get('askme:v1:ui:overlay'))['askme:v1:ui:overlay'];
        await context.assertCurrent();
        return { accountId: context.accountId, courseCount: coursesOf(data).length,
          layout: { width: Number.isInteger(layout?.width) ? Math.max(240, Math.min(720, layout.width)) : 400, open: false,
            view: ['courses', 'ask', 'review'].includes(layout?.view) ? layout.view : 'courses' } };
      },
      async 'course.list'(context, args) {
        const data = await read(context, ['courses', 'library']), courses = coursesOf(data);
        const items = courses.slice(args.offset, args.offset + args.limit).map(course => projectCourse(course, data));
        return { items, total: courses.length, nextOffset: args.offset + items.length < courses.length ? args.offset + items.length : null };
      },
      async 'course.view'(context, args) {
        const data = await read(context, ['courses', 'library']);
        return projectCourse(courseOf(data, args.courseId), data);
      },
      async 'chat.list'(context, args) {
        const data = await read(context, ['courses', 'chatSessions']);
        const sessions = sessionsOf(data, args.courseId).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        const items = sessions.slice(args.offset, args.offset + args.limit).map(item => ({ id: item.id, title: short(item.title, 60),
          createdAt: short(item.createdAt, 40), updatedAt: short(item.updatedAt, 40), messageCount: list(item.messages).length }));
        return { items, total: sessions.length, nextOffset: args.offset + items.length < sessions.length ? args.offset + items.length : null };
      },
      async 'chat.read'(context, args) {
        const data = await read(context, ['courses', 'chatSessions']);
        const session = sessionsOf(data, args.courseId).find(item => item.id === args.sessionId);
        if (!session) throw new Error('UI_SESSION_NOT_FOUND');
        const messages = list(session.messages).map(projectMessage).filter(Boolean), items = [];
        let bytes = 0;
        for (const item of messages.slice(args.offset, args.offset + args.limit)) {
          const size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
          if (bytes + size > 60000) break;
          items.push(item); bytes += size;
        }
        return { sessionId: session.id, items, total: messages.length, nextOffset: args.offset + items.length < messages.length ? args.offset + items.length : null };
      },
      async 'ui.layout.save'(context, args) {
        await context.assertCurrent();
        const value = { width: args.width, open: args.open, view: args.view };
        await storage.set({ 'askme:v1:ui:overlay': value });
        return value;
      }
    });
  }
  globalThis.AskmeAccountStore = Object.freeze({ createAccountStore });
})();
