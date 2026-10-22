// 闭合 Shadow DOM 内的学习界面；所有资料和 AI 操作均经账号绑定 broker。
(() => {
  'use strict';
  function createPanelController({ host, client, document: doc, brandLogoUrl = '', folderIconUrl = '', courseIconUrl = '', buildVersion = '' }) {
    if (!host?.root || typeof client?.call !== 'function') throw new Error('INVALID_PANEL_DEPENDENCIES');
    let disposed = false, epoch = 0, layoutTimer = null, composing = false, renderedContext = '', renderedMessageCount = 0;
    const syncingCourses = new Set();
    const state = { view: 'courses', courses: [], courseId: '', courseNext: null, sessionId: '', sessions: [], sessionNext: null,
      messages: [], messageNext: null, history: false, picker: false, skill: '', quizViews: new Map(), syncReports: new Map(), draft: '', ai: null, models: [], settings: false,
      sources: [], sourceNext: null, sourceId: '', choice: null, questionIndex: 0, selections: {}, feedback: {}, finished: false,
      reviewMode: 'choice', plan: null, practice: null, practiceDraft: '', practiceSubmitted: null, practiceFeedback: null,
      error: null, notice: '', captureId: '', captureExpiresAt: null, busy: new Map(), initialized: false };
    const node = (tag, text, className) => { const el = doc.createElement(tag); if (text != null) el.textContent = String(text); if (className) el.className = className; return el; };
    const button = (label, action, className = '') => { const el = node('button', label, className); el.type = 'button'; el.addEventListener('click', action); return el; };
    const list = value => Array.isArray(value) ? value : [];
    // Moodle 的收藏状态属于无障碍提示，不是课程名称。
    const courseTitle = course => String(course.title || `课程 ${course.id}`).replace(/^(?:Course is (?:not )?starred\s*)+/iu, '').trim() || `课程 ${course.id}`;
    const rows = result => {
      if (!Array.isArray(result?.items) || result.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('INVALID_UI_RESPONSE');
      return result.items;
    };
    const safeLink = value => { try { const u = new URL(value); return u.origin === 'https://moodle.telt.unsw.edu.au' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
    const currentCourse = () => state.courses.find(item => String(item.id) === state.courseId);
    const stamp = () => ({ epoch, courseId: state.courseId, view: state.view });
    const current = value => !disposed && value.epoch === epoch && value.courseId === state.courseId && value.view === state.view;
    const invalidate = () => { epoch++; state.busy.clear(); for (const message of state.messages) if (message.localStatus === 'pending') message.localStatus = 'failed'; };
    const call = (op, args) => client.call(op, args || {});
    const messages = {
      UI_BINDING_EXPIRED: '页面连接已过期，请重试。', UI_BINDING_MISMATCH: '页面连接已变化，请重试。', UI_ACCOUNT_CHANGED: 'Moodle 账号已变化，请重新打开学习面板。',
      UI_OPERATION_UNAVAILABLE: '当前版本尚未提供这个功能。', UI_UNAVAILABLE: '服务暂时无法连接，请重试。',
      AUTH_REQUIRED: '请先连接 ChatGPT。', CHATGPT_AUTH_REQUIRED: '请先连接 ChatGPT。', SESSION_EXPIRED: '这组练习已过期，请重新出题。',
      SOURCE_CHANGED: '课程资料已变化，请重新出题。', UNVERIFIED_QUESTIONS: '这次题目没有通过原文核验，请换一份资料再试。',
      CHOICE_TIMEOUT: '出题超时，请重试。', BUSY: '服务正在处理其他请求，请稍后重试。', INVALID_UI_RESPONSE: '服务返回格式异常，请重试。',
      UI_COURSE_REQUIRED: '请先选择一门课程。', UI_COURSE_NOT_FOUND: '没有找到这门课程，请重新查找课程。', CAPTURE_EXPIRED: '截图已过期，请重新截图。',
      LOGIN_REQUIRED: '请先连接 ChatGPT，完成登录后刷新连接状态。', MODEL_SELECTION_REQUIRED: '请在 ChatGPT 设置中选择一个可用模型。',
      UI_SOURCE_CHANGED: '课程原文已变化，请重新生成练习。', UI_SERVICE_TIMEOUT: '这次操作已超时结束，可以重试。',
      UI_BUSY: '当前有多项操作正在进行，请稍后重试。课程、历史和设置仍可查看。',
      UI_QUEUE_TIMEOUT: '这次操作等待过久，已退出队列，可以重新操作。',
      UI_STALE_RESPONSE: '页面连接已更新，请在会话或历史中查看最新结果。',
      UI_CAPTURE_EXPIRED: '截图已过期，请重新截图。', UI_CAPTURE_INACTIVE: '请切换到当前 Moodle 标签页后重新截图。',
      UI_CAPTURE_RESIZED: '页面大小已变化，请重新选择截图范围。', UI_CAPTURE_TOO_LARGE: '截图过大，请缩小页面显示范围后重试。',
      UI_CALENDAR_UNAVAILABLE: '暂时无法读取课程日历，请在 Moodle 核对日期后重试。',
      UI_PRACTICE_EXPIRED: '这道练习已过期，请返回复习计划重新开始。',
      UI_SOURCE_NOT_FOUND: '这份资料暂时不能用于出题，请同步课程或选择其他知识点。'
    };
    function showError(error, retry) {
      if (disposed) return;
      const code = String(error?.code || error?.message || 'UI_UNAVAILABLE');
      const evidenceFailure = ['NEGATION_MISMATCH', 'ATOMICITY_FAILED', 'NUMERIC_FACT_UNSUPPORTED', 'IDENTIFIER_UNSUPPORTED', 'DIRECTION_MISMATCH'];
      if (code === 'UI_ACCOUNT_CHANGED') {
        invalidate(); state.courses = []; state.courseId = ''; state.sessionId = ''; state.sessions = []; state.messages = [];
        state.sources = []; state.sourceId = ''; state.choice = null; state.feedback = {}; state.selections = {}; state.quizViews.clear(); state.syncReports.clear(); state.skill = ''; state.picker = false;
        state.captureId = ''; state.captureExpiresAt = null; state.draft = ''; state.plan = null; state.practice = null; state.practiceDraft = ''; state.practiceSubmitted = null; state.practiceFeedback = null; state.initialized = true; retry = initialize;
      }
      state.error = { text: evidenceFailure.includes(code) ? '这次生成的解释未通过课程原文核对，请重试或缩小提问范围。' : messages[code] || (/^[A-Z_]{1,70}$/u.test(code) ? `操作失败（${code}）` : '操作未完成，请重试。'), retry };
      if (code === 'UI_ACCOUNT_CHANGED') render(); else renderError();
    }
    // 页面、课程或会话改变后，迟到结果不会写入另一个上下文。
    async function task(key, work, apply, retry) {
      if (disposed || state.busy.has(key)) return;
      const started = stamp(); state.busy.set(key, started); state.error = null; render();
      try { const result = await work(started); if (current(started)) await apply?.(result, started); }
      catch (error) { if (current(started)) showError(error, retry); }
      finally { if (state.busy.get(key) === started) state.busy.delete(key); if (current(started)) render(); }
    }
    const style = node('style');
    style.textContent = `
      .am-ui{height:100%;display:flex;flex-direction:column;min-width:0;min-height:0;background-color:#fff;background-image:linear-gradient(180deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.18) 28%,#fff 100%),linear-gradient(115deg,#efd8e6 0%,#dfd0fa 52%,#d8e1fb 100%);background-size:100% 62%;background-repeat:no-repeat;color:#292438;font:16px/1.6 Inter,"Segoe UI",sans-serif;container-type:inline-size}
      .am-ui *{box-sizing:border-box}.am-ui button,.am-ui input,.am-ui select,.am-ui textarea{font:inherit;color:inherit;min-width:0}
      .am-ui button{border:1px solid #e6e0f2;background:#fff;border-radius:12px;padding:8px 12px;cursor:pointer;line-height:1.4;white-space:normal}
      .am-ui button:hover{background:#f4f0ff}.am-ui button:disabled{opacity:.5;cursor:default}.am-ui button:focus-visible,.am-ui input:focus-visible,.am-ui select:focus-visible,.am-ui textarea:focus-visible{outline:3px solid #c7baff;outline-offset:2px}
      .am-ui .am-primary{background:#7058ed;border-color:#7058ed;color:#fff}.am-ui .am-primary:hover{background:#6048dc}.am-ui .am-quiet{border-color:transparent;color:#685e79;background:transparent}
      .am-head{padding:20px 56px 14px 20px;flex:none;min-width:0}.am-brand{display:flex;align-items:center;gap:10px;min-width:0;height:44px}.am-brand-logo{display:block;width:42px;height:42px;flex:0 0 42px;object-fit:contain}.am-wordmark{font-family:"Segoe UI Variable Display","Segoe UI",sans-serif;font-size:28px;font-weight:750;line-height:1.1;letter-spacing:-1px;color:#3a2a64;white-space:nowrap}.am-wordmark-accent{color:#7058ed}
      .am-ui .am-status{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;margin-top:9px;text-align:left;padding:8px 11px;border:1px solid #dfd6fb;background:#f7f4ff;border-radius:11px;font-size:14px;color:#574488;overflow-wrap:anywhere}
      .am-ui .am-status::after{content:'设置 ›';flex:0 0 auto;white-space:nowrap;font-size:13px;font-weight:650;color:#644bd8}
      .am-ui .am-status:hover,.am-ui .am-status[aria-expanded=true]{background:#eee8ff;border-color:#b8a7ef}
      .am-settings .am-title{font-size:22px;margin:0 0 18px}.am-settings-card{padding:16px;border:1px solid #e7e1ef;border-radius:16px;background:#fff;margin:0 0 16px;min-width:0}
      .am-settings-card p{margin:0}.am-settings-card .am-subtle{margin-top:9px;line-height:1.6}.am-settings-card .am-settings-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}
      .am-settings-actions button{min-height:44px;padding:9px 8px}.am-settings-label{display:block;margin:0 0 10px;font-weight:650}.am-model-actions{margin-top:12px;display:flex;justify-content:flex-end}.am-model-actions button{min-height:40px;font-size:14px}
      @container(max-width:300px){.am-settings-card .am-settings-actions{grid-template-columns:1fr}}
      .am-nav{display:flex;gap:6px;padding:0 16px 12px;flex:none}.am-nav button{flex:1;padding:8px 3px;font-weight:600;border:0;background:transparent}.am-nav button[aria-pressed=true]{color:#644bd8;background:rgba(255,255,255,.82);box-shadow:inset 0 0 0 1px #ded3f8}
      .am-course-context{padding:0 18px 12px;flex:none}.am-course-context select,.am-settings select,.am-source-select{display:block;width:100%;border:1px solid #ded7e9;background:#fff;padding:10px;border-radius:12px;min-height:44px}
      .am-error{margin:0 16px 10px;padding:10px 12px;border:1px solid #efb9b1;background:#fff6f3;border-radius:12px;font-size:14px;overflow-wrap:anywhere;max-height:150px;overflow:auto;flex:none}.am-error-actions{display:flex;gap:8px;margin-top:6px}.am-error[hidden]{display:none}
      .am-main{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden}.am-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 18px 20px;overflow-wrap:anywhere;scrollbar-gutter:stable}
      .am-title{font-size:24px;line-height:1.35;margin:8px 0 18px;font-weight:700}.am-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.am-spread{justify-content:space-between}.am-subtle{color:#70657e;font-size:14px}.am-empty{padding:28px 2px;color:#746a81;line-height:1.8}.am-card{padding:16px;border:1px solid #e7e1ef;border-radius:16px;margin:12px 0;background:#fff}.am-card.am-selected{border-color:#a896f5;background:#fbf9ff}.am-card h3{font-size:17px;line-height:1.5;margin:0 0 8px;overflow-wrap:anywhere}.am-course-label{display:flex;gap:10px;align-items:flex-start;cursor:pointer;font-weight:650}.am-course-label input{accent-color:#7058ed;width:20px;height:20px;flex:0 0 20px;margin-top:4px}.am-card-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.am-pill{font-size:13px;color:#644bd8;background:#eee8ff;border-radius:8px;padding:2px 7px}.am-toolbar{display:flex;gap:8px;align-items:center;padding:0 18px 10px;flex:none;flex-wrap:wrap}.am-toolbar button{font-size:14px}.am-notice{font-size:14px;color:#665b74;padding:0 18px 10px;overflow-wrap:anywhere;flex:none}
      .am-sync-item{padding:12px 0;border-top:1px solid #eee9f3;overflow-wrap:anywhere}.am-sync-item p{margin:4px 0}.am-sync-item a{color:#644bd8;font-size:14px}
      .am-message{padding:14px 0;border-bottom:1px solid #eee9f3}.am-message.am-user{background:#f6f3fd;border:0;border-radius:14px;padding:12px 14px;margin:12px 0}.am-message-role{font-size:13px;font-weight:650;color:#75658f;margin-bottom:6px}.am-message-text{white-space:pre-wrap;line-height:1.8;overflow-wrap:anywhere}.am-sources{margin-top:10px;font-size:14px}.am-sources summary{cursor:pointer;color:#7058ed;padding:4px 0}.am-sources blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid #d2c6fb;background:#faf8ff;white-space:pre-wrap}.am-sources a{color:#644bd8;text-decoration:underline;overflow-wrap:anywhere}
      .am-composer{padding:12px 16px 16px;border-top:1px solid #ece6f4;background:#fff;flex:none}.am-composer textarea{display:block;width:100%;height:94px;max-height:160px;resize:vertical;padding:12px;border:1px solid #ded7e9;border-radius:13px;background:#fff;line-height:1.5}.am-composer .am-row{margin-top:8px}.am-composer .am-primary{margin-left:auto;min-width:76px}.am-settings{flex:1;overflow:auto;padding:12px 18px 24px;min-height:0}.am-settings .am-settings-label{display:block;margin:0 0 10px;font-weight:650}
      .am-history-item{display:block;width:100%;text-align:left;margin:8px 0!important;padding:12px!important}.am-history-item[aria-current=true]{border-color:#a896f5;background:#f6f2ff}.am-question{font-size:20px;line-height:1.65;margin:14px 0 22px}.am-options{border:0;margin:0;padding:0;min-width:0}.am-options legend{padding:0;margin-bottom:8px;font-size:14px;color:#70657e}.am-option{display:flex;gap:10px;align-items:flex-start;padding:14px 12px;margin:10px 0;border:1px solid #e2daee;border-radius:13px;cursor:pointer}.am-option input{accent-color:#7058ed;width:18px;height:18px;flex:0 0 18px;margin-top:5px}.am-option.am-picked{border-color:#957deb;background:#f8f5ff}.am-option.am-correct{border-color:#6aa68a;background:#f1faf5}.am-option.am-wrong{border-color:#d59188;background:#fff6f4}.am-option-content{min-width:0}.am-option-note{font-size:14px;margin-top:8px;line-height:1.7;color:#63586e}.am-result{font-weight:650;padding:12px 0}.am-footer{padding:12px 18px 16px;border-top:1px solid #ece6f4;flex:none}.am-footer button{width:100%}.am-loading{color:#75678d;padding:18px 2px}.am-score{font-size:38px;font-weight:750;color:#7058ed;margin:20px 0}
      @media(max-height:600px){.am-head{padding-top:12px;padding-bottom:8px}.am-nav{padding-bottom:8px}.am-composer textarea{height:70px}}
      .am-review-tabs{display:flex;gap:8px;padding:0 18px 12px;flex:none}.am-review-tabs button{flex:1;font-size:14px}.am-review-tabs button[aria-pressed=true]{background:#eee8ff;border-color:#d2c6fb;color:#644bd8}
      .am-plan-meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}.am-plan-card .am-card-actions button{min-height:44px}.am-plan-card .am-subtle{margin:8px 0}.am-plan-card p{margin:8px 0}.am-study-answer{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}.am-study-feedback{border-left:3px solid #a896f5;padding:10px 14px;margin:18px 0;background:#faf8ff;border-radius:0 10px 10px 0}.am-study-feedback h2{font-size:18px;margin:0 0 8px}.am-study-feedback p{margin:8px 0}.am-study-composer label{display:block;font-size:14px;margin-bottom:8px;color:#70657e}
      .am-session-bar{display:flex;align-items:center;gap:6px;padding:18px 54px 14px 16px;flex:none;min-width:0}.am-session-bar .am-back{margin-right:auto;font-size:23px;padding:3px 10px}.am-session-bar button{font-size:14px;color:#7157df;background:transparent;border-color:transparent;padding:7px 8px;min-height:40px}.am-session-bar button:hover{background:#ffffffb0}
      .am-chat-scroll{padding:4px 20px 20px}.am-chat-empty{display:flex;flex-direction:column;justify-content:flex-end;min-height:0;max-height:46%;padding-top:24px;padding-bottom:12px;flex:1 1 auto;overflow:visible}.am-welcome{display:flex;gap:14px;align-items:center;padding:12px 8px 20px}.am-welcome img{width:54px;height:54px;object-fit:contain}.am-welcome h1{font-size:23px;line-height:1.4;margin:0;font-weight:650}.am-welcome p{font-size:14px;color:#7c7189;margin:7px 0 0}
      .am-session-composer{margin:0 18px 18px;padding:14px;border:1px solid #e6e0ef;border-radius:20px;background:rgba(255,255,255,.96);box-shadow:0 5px 24px #49386f05}.am-session-composer textarea{border:0;border-radius:0;padding:8px 2px;height:86px;min-height:60px;max-height:150px;resize:vertical;background:transparent}.am-session-composer textarea:focus-visible{outline:0}.am-session-composer:focus-within{border-color:#b6a2f3;box-shadow:0 0 0 3px #eee8ff}.am-compose-row{display:flex;align-items:center;gap:8px;min-width:0;margin-top:8px}.am-course-chip{display:flex;gap:4px;align-items:center;min-width:0;max-width:calc(100% - 52px);border-radius:12px;background:#f5f3f8;padding:0 2px}.am-course-chip button{border:0;background:transparent;font-size:14px;padding:7px;white-space:nowrap}.am-course-chip .am-course-name{overflow:hidden;text-overflow:ellipsis;min-width:0;text-align:left}.am-course-chip .am-course-clear{flex:none;padding:7px 8px}.am-session-composer .am-send{margin-left:auto;min-width:40px;width:40px;height:40px;border-radius:50%;font-size:22px;padding:4px;flex:none}.am-skills{display:flex;gap:7px;flex-wrap:wrap;padding:8px 0 0}.am-skills button{border:0;background:#f7f5fb;color:#796397;padding:6px 9px;font-size:13px}.am-picker{padding:8px 0;margin-top:8px;border-top:1px solid #ece7f2;max-height:190px;overflow:auto}.am-picker button{display:block;width:100%;text-align:left;border:0;margin:3px 0;font-size:14px}.am-picker button[aria-pressed=true]{background:#efe9ff;color:#6246cd}.am-conversation-status{padding:10px 20px;font-size:13px;color:#7b6d91;flex:none}.am-conversation-status button{font-size:13px;padding:3px 8px;background:#ffffffb0;color:#7157df}
      .am-message{border:0;padding:12px 0;margin:8px 0}.am-message.am-user{margin:12px 0 12px auto;width:fit-content;max-width:92%;background:#fff;box-shadow:0 1px 4px #49386f05}.am-message-role{font-size:12px}.am-artifact{margin:14px 0;border:1px solid #e5def1;border-radius:18px;background:#fff;overflow:hidden}.am-artifact-toggle{display:flex;align-items:center;gap:12px;width:100%;text-align:left!important;border:0!important;border-radius:0!important;padding:17px!important}.am-artifact-icon{width:40px;height:40px;background:#f0ebff;color:#7058ed;border-radius:12px;display:grid;place-items:center;font-size:22px;flex:none}.am-artifact-copy{min-width:0;flex:1}.am-artifact-title{font-weight:650;font-size:16px}.am-artifact-body{padding:0 16px 16px}.am-artifact-body .am-question{font-size:18px;margin:12px 0}.am-artifact-body .am-option{font-size:15px;padding:11px;margin:8px 0}.am-artifact-controls{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:14px}.am-artifact-controls button{font-size:14px}.am-inline-study{background:#ffffffd9;border:1px solid #e5def1;border-radius:18px;margin:12px 0;padding:12px;min-width:0}.am-inline-study>.am-scroll{overflow:visible;padding:0}.am-inline-study .am-title{font-size:20px}.am-inline-study .am-composer{padding:12px 0 0}.am-inline-study .am-footer{padding:12px 0 0}.am-chat-empty+.am-session-composer{margin-bottom:auto}.am-chat-empty .am-loading{padding:0}.am-inline-study-close{margin-bottom:8px!important;font-size:14px!important}
      @container(max-width:350px){.am-session-bar{gap:0;padding-left:10px}.am-session-bar button{font-size:13px;padding:7px 5px}.am-session-composer{margin-left:12px;margin-right:12px;padding:11px}.am-chat-scroll{padding-left:14px;padding-right:14px}.am-welcome h1{font-size:20px}.am-welcome img{width:42px;height:42px}.am-skills{gap:4px}}
      @media(max-height:650px){.am-chat-empty{padding-top:16px}.am-session-bar{padding-top:8px;padding-bottom:8px}.am-session-composer textarea{height:64px}.am-welcome{padding-bottom:10px}}
      .am-session-composer{position:relative}.am-course-chip{border-radius:20px}.am-course-chip .am-course-name{display:flex;align-items:center;gap:7px;padding:7px 10px;color:#555967}.am-folder-icon,.am-course-icon{width:18px;height:18px;display:block;flex:0 0 18px;opacity:.75}.am-course-label-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .am-picker{position:absolute;z-index:30;left:12px;right:12px;top:100%;margin:6px 0;padding:7px;border:1px solid #eeebf2;border-radius:14px;background:#fff;box-shadow:0 10px 28px #30214d16;max-height:240px;overflow:auto}.am-picker .am-folder-course{display:flex;align-items:center;gap:10px;min-height:42px;padding:9px 10px;margin:0;font-size:15px;border-radius:9px}.am-folder-course .am-course-label-text{flex:1}.am-picker .am-quiet{margin-top:5px;border-top:1px solid #f0edf5;border-radius:0;font-size:13px;color:#80738c}.am-folder-course:focus-visible{outline-offset:-2px}
    `;
    const shell = node('div', null, 'am-ui');
    shell.addEventListener('pointerdown', event => {
      if (!state.picker || event.target?.closest?.('.am-picker, .am-course-chip')) return;
      state.picker = false;
      shell.querySelector('.am-picker')?.remove();
      shell.querySelector('.am-course-name')?.setAttribute('aria-expanded', 'false');
    });
    const header = node('header', null, 'am-head'), brand = node('div', null, 'am-brand');
    if (brandLogoUrl) { const logo = node('img', null, 'am-brand-logo'); logo.src = brandLogoUrl; logo.alt = ''; logo.width = 42; logo.height = 42; brand.append(logo); }
    const wordmark = node('span', null, 'am-wordmark'); wordmark.append(node('span', 'Ask'), node('span', 'me', 'am-wordmark-accent')); brand.append(wordmark);
    const statusButton = button('连接 ChatGPT', () => { state.settings = !state.settings; invalidate(); render(); if (state.settings) void refreshAi(); }, 'am-status');
    header.append(brand, statusButton);
    const errorBox = node('div', null, 'am-error'), main = node('main', null, 'am-main');
    errorBox.setAttribute('role', 'alert'); errorBox.hidden = true;
    shell.append(header, errorBox, main); host.root.append(style, shell);
    function renderError() {
      errorBox.replaceChildren(); errorBox.hidden = !state.error;
      if (!state.error) return;
      errorBox.append(node('div', state.error.text));
      const actions = node('div', null, 'am-error-actions'), retry = state.error.retry;
      if (retry) actions.append(button('重试', () => { state.error = null; renderError(); void Promise.resolve().then(retry).catch(error => showError(error, retry)); }));
      actions.append(button('关闭', () => { state.error = null; renderError(); }, 'am-quiet')); errorBox.append(actions);
    }
    function empty(parent, text) { parent.append(node('p', text, 'am-empty')); }
    function scroller(parent = main) { const area = node('div', null, 'am-scroll'); parent.append(area); return area; }
    function sources(parent, value) {
      list(value).filter(source => source && typeof source === 'object').forEach((source, index) => {
        const details = node('details', null, 'am-sources'); details.append(node('summary', `${index + 1}. ${source.title || '课程来源'}`));
        if (source.excerpt || source.quote) details.append(node('blockquote', source.excerpt || source.quote));
        const url = safeLink(source.url); if (url) { const a = node('a', '查看 Moodle 原文'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; details.append(a); }
        parent.append(details);
      });
    }
    function render() {
      if (disposed) return;
      const active = host.root.getRootNode?.().activeElement;
      const editing = active?.tagName === 'TEXTAREA' && shell.contains(active) ? { start: active.selectionStart, end: active.selectionEnd, id: active.id } : null;
      const context = `${state.view}:${state.courseId}:${state.sessionId}:${state.settings}:${state.history}:${state.reviewMode}:${state.practice?.sessionId || ''}`;
      const oldScroll = main.querySelector('.am-scroll')?.scrollTop;
      const sameContext = context === renderedContext, oldMessageCount = renderedMessageCount;
      statusButton.textContent = state.ai?.connected ? `ChatGPT 已连接 · ${state.ai.model || '选择模型'}` : '连接 ChatGPT';
      statusButton.setAttribute('aria-expanded', String(state.settings));
      statusButton.setAttribute('aria-label', `${statusButton.textContent}，打开连接与模型设置`);
      header.hidden = state.view === 'ask' && !state.settings;
      renderError(); main.replaceChildren();
      if (!state.initialized) { empty(scroller(), '正在载入课程…'); return; }
      if (state.settings) renderSettings();
      else if (state.view === 'courses') renderCourses();
      else if (state.view === 'ask') renderChat();
      else renderChat();
      const scroll = main.querySelector('.am-scroll');
      if (scroll && sameContext && oldScroll != null && state.messages.length === oldMessageCount) scroll.scrollTop = oldScroll;
      else if (scroll && state.view === 'ask' && !state.history && state.messages.length) scroll.scrollTop = scroll.scrollHeight;
      if (editing && sameContext) { const input = editing.id === 'askme-study-answer' ? main.querySelector('#askme-study-answer') : main.querySelector('.am-session-composer textarea'); input?.focus({ preventScroll: true }); input?.setSelectionRange(editing.start, editing.end); }
      renderedContext = context; renderedMessageCount = state.messages.length;
    }
    async function initialize() {
      const started = stamp();
      try {
        const bootstrap = await call('ui.bootstrap');
        if (!current(started)) return;
        if (bootstrap.layout) { host.setWidth?.(bootstrap.layout.width); state.view = bootstrap.layout.view === 'ask' ? 'ask' : 'courses'; }
        const result = await call('course.list', { offset: 0, limit: 50 });
        if (disposed || epoch !== started.epoch) return;
        state.courses = rows(result); state.courseNext = result.nextOffset; state.courseId = String(state.courses.find(item => item.selected && item.syncedAt)?.id || '');
        state.initialized = true; render(); void refreshAi();
        if (state.courseId && state.view === 'ask') void loadSessions();
        if (state.courseId && state.view === 'review') void loadSources();
      } catch (error) { if (!disposed && epoch === started.epoch) { state.initialized = true; showError(error, initialize); render(); } }
    }
    function openView(view) {
      if (disposed || !['courses', 'ask', 'review'].includes(view)) return;
      invalidate(); state.view = view === 'review' ? 'ask' : view; state.skill = view === 'review' ? 'plan' : ''; state.picker = false; state.settings = false; state.history = false; state.error = null; state.notice = ''; host.setOpen?.(true); render();
      if (!state.initialized) { void initialize(); return; }
      if (state.courseId && view === 'ask' && !state.sessionId) void loadSessions();
      if (state.courseId && view === 'review') void loadStudyPlan();
      layoutChanged(host.getState?.() || {});
    }
    async function selectCourse(id) {
      invalidate(); state.courseId = String(id); state.sessionId = ''; state.sessions = []; state.messages = []; state.history = false; state.skill = ''; state.picker = false; state.quizViews.clear(); state.captureId = ''; state.captureExpiresAt = null;
      state.sources = []; state.sourceId = ''; state.choice = null; state.feedback = {}; state.selections = {}; state.finished = false; state.plan = null; state.practice = null; state.practiceDraft = ''; state.practiceSubmitted = null; state.practiceFeedback = null; state.error = null; state.notice = ''; render();
      if (!state.courseId) return;
      if (state.view === 'ask') await loadSessions(); else if (state.view === 'review') { if (state.reviewMode === 'plan') await loadStudyPlan(); else await loadSources(); }
    }
    async function loadCourses(offset = 0) {
      return task('courses', () => call('course.list', { offset, limit: 50 }), result => {
        state.courses = offset ? [...state.courses, ...rows(result)] : rows(result); state.courseNext = result.nextOffset;
      }, () => loadCourses(offset));
    }
    function renderCourses() {
      const area = scroller(); area.append(node('h1', '你的课程', 'am-title'));
      if (state.notice) area.append(node('p', state.notice, 'am-subtle'));
      const discover = button(state.busy.has('discover') ? '查找中…' : '查找 Moodle 课程', discoverCourses); discover.disabled = state.busy.has('discover'); area.append(discover);
      if (!state.courses.length) empty(area, '查找课程后，勾选并同步需要学习的课程。');
      for (const course of state.courses) {
        const id = String(course.id), card = node('article', null, `am-card${course.selected ? ' am-selected' : ''}`), label = node('label', null, 'am-course-label');
        const input = node('input'); input.type = 'checkbox'; input.checked = !!course.selected; input.disabled = state.busy.has(`select:${id}`);
        input.addEventListener('change', () => { void toggleCourse(id, input.checked); });
        label.append(input, node('span', courseTitle(course))); card.append(label);
        const details = node('div', null, 'am-row'); if (course.selected) details.append(node('span', '已选择', 'am-pill'));
        const synced = !!course.syncedAt;
        details.append(node('span', synced ? `已保存 ${course.pageCount || 0} 段正文 · ${course.indexedFiles ?? 0}/${course.fileCount || 0} 个文件完整读取` : '尚未同步', 'am-subtle'));
        if (course.issueCount || course.unsupportedFiles) details.append(button(`${course.issueCount || 0} 项待处理${course.unsupportedFiles ? ` · ${course.unsupportedFiles} 个格式暂不支持` : ''} ›`, () => loadSyncReport(id), 'am-quiet'));
        card.append(details);
        const actions = node('div', null, 'am-card-actions'), sync = button(syncingCourses.has(id) ? '同步中…' : synced ? '更新资料' : '同步课程', () => syncCourse(id), 'am-primary');
        sync.disabled = !course.selected || syncingCourses.has(id); actions.append(sync);
        if (synced) actions.append(button('开始学习', () => { openView('ask'); void selectCourse(id); }));
        if (course.pendingFiles) { const resume = button(`继续读取 ${course.pendingFiles} 个文件`, () => resumeFiles(id)); resume.disabled = syncingCourses.has(id); actions.append(resume); }
        card.append(actions); area.append(card);
        const report = state.syncReports.get(id);
        if (report) {
          const issues = node('section', null, 'am-card'); issues.setAttribute('aria-label', '同步详情');
          const heading = node('div', null, 'am-row'); heading.append(node('strong', '同步详情'), button('收起', () => { state.syncReports.delete(id); render(); }, 'am-quiet')); issues.append(heading);
          if (report.failedFiles || report.partialFiles) { const retry = button('重试未完整读取的文件', () => resumeFiles(id, true)); retry.disabled = syncingCourses.has(id); issues.append(retry); }
          for (const item of report.items) {
            const row = node('div', null, 'am-sync-item'); row.append(node('strong', item.title), node('p', item.reason, 'am-subtle'));
            const url = safeLink(item.url); if (url) { const link = node('a', '在 Moodle 查看'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
            issues.append(row);
          }
          if (!report.items.length) issues.append(node('p', '当前快照没有待处理项。', 'am-subtle'));
          if (report.nextOffset != null) issues.append(button('更多详情', () => loadSyncReport(id, report.nextOffset)));
          area.append(issues);
        }
      }
      if (state.courseNext != null) area.append(button('更多课程', () => loadCourses(state.courseNext)));
    }
    const toggleCourse = (courseId, selected) => task(`select:${courseId}`, () => call('course.select', { courseId, selected }), () => { const c = state.courses.find(item => String(item.id) === courseId); if (c) c.selected = selected; }, () => toggleCourse(courseId, selected));
    const discoverCourses = () => task('discover', async () => { await call('course.discover'); return call('course.list', { offset: 0, limit: 50 }); }, result => { state.courses = rows(result); state.courseNext = result.nextOffset; }, discoverCourses);
    function loadSyncReport(id, offset = 0) {
      return task(`report:${id}`, () => call('course.sync.report', { courseId: id, offset, limit: 30 }), result => {
        const items = offset ? [...(state.syncReports.get(id)?.items || []), ...rows(result)] : rows(result);
        state.syncReports.set(id, { ...result, items });
      }, () => loadSyncReport(id, offset));
    }
    async function continuePending(id, started, course) {
      let value = course;
      // 每批已落盘；换页/关闭或断开连接后由“继续读取”接着完成，避免重读前 30 个文件。
      for (let batch = 0; current(started) && host.getState?.().open !== false && value.pendingFiles > 0 && batch < 400; batch++) {
        state.courses = state.courses.map(item => String(item.id) === id ? value : item);
        state.notice = `正在读取课程文件，还剩 ${value.pendingFiles} 个…`; render();
        const progress = await call('course.files.continue', { courseId: id, retry: false });
        value = await call('course.view', { courseId: id });
        if (!progress.attempted) break;
      }
      return value;
    }
    function applySync(id, result) {
      state.courses = state.courses.map(course => String(course.id) === id ? result : course); state.syncReports.delete(id);
      if (id === state.courseId) state.sources = [];
      state.notice = result.pendingFiles ? `本批已保存，还剩 ${result.pendingFiles} 个文件可继续读取。`
        : result.issueCount || result.unsupportedFiles ? '本次读取已结束，可展开待处理项查看原因。' : '课程同步完成，可以开始学习。';
    }
    async function resumeFiles(id, retry = false) {
      if (disposed || syncingCourses.has(id)) return;
      syncingCourses.add(id);
      try { await task(`sync:${id}`, async started => {
        await call('course.files.continue', { courseId: id, retry });
        return continuePending(id, started, await call('course.view', { courseId: id }));
      }, result => applySync(id, result), () => resumeFiles(id, retry)); }
      finally { syncingCourses.delete(id); if (!disposed) render(); }
    }
    async function syncCourse(id) {
      if (disposed || syncingCourses.has(id)) return;
      syncingCourses.add(id);
      try { await task(`sync:${id}`, async started => { await call('course.sync', { courseId: id }); return continuePending(id, started, await call('course.view', { courseId: id })); }, result => applySync(id, result), () => syncCourse(id)); }
      finally { syncingCourses.delete(id); if (!disposed) render(); }
    }
    async function selectDiscoveredCourse(courseId) {
      const id = String(courseId);
      if (disposed || syncingCourses.has(id)) return;
      if (!/^\d{1,12}$/u.test(id)) { showError({ code: 'UI_COURSE_NOT_FOUND' }); return; }
      syncingCourses.add(id); openView('courses'); await selectCourse(id);
      state.notice = '正在查找并同步这门课程…';
      try {
        await task(`sync:${id}`, async started => {
          await call('course.discover');
          const result = await call('course.list', { offset: 0, limit: 50 });
          if (!current(started)) return null;
          state.courses = rows(result); state.courseNext = result.nextOffset; state.initialized = true;
          await call('course.select', { courseId: id, selected: true });
          if (!current(started)) return null;
          const course = state.courses.find(item => String(item.id) === id);
          if (course) course.selected = true;
          render();
          await call('course.sync', { courseId: id });
          return continuePending(id, started, await call('course.view', { courseId: id }));
        }, result => {
          const existing = state.courses.some(item => String(item.id) === id);
          state.courses = existing ? state.courses.map(item => String(item.id) === id ? result : item) : [...state.courses, result];
          state.sources = []; applySync(id, result);
        }, () => selectDiscoveredCourse(id));
      } finally { syncingCourses.delete(id); if (!disposed) render(); }
    }
    async function refreshAi() {
      return task('ai-status', () => call('ai.status'), result => { state.ai = result; }, refreshAi);
    }
    function renderSettings() {
      const area = node('div', null, 'am-settings'); main.append(area); area.append(button('‹ 返回', () => { state.settings = false; render(); }, 'am-quiet'), node('h1', '连接与模型', 'am-title'));
      const connection = node('section', null, 'am-settings-card'); connection.setAttribute('aria-label', 'ChatGPT 连接');
      connection.append(node('p', state.ai?.connected ? 'ChatGPT 已连接' : '连接你的 ChatGPT 账号', 'am-settings-label'));
      connection.append(node('p', '问题、相关课程片段及附加截图会发送至 ChatGPT。', 'am-subtle'));
      const row = node('div', null, 'am-settings-actions');
      if (!state.ai?.connected) row.append(button(state.busy.has('ai-connect') ? '正在打开…' : '连接 ChatGPT', connectAi, 'am-primary'));
      else row.append(button('断开连接', disconnectAi));
      row.append(button('刷新连接状态', refreshAi)); connection.append(row); area.append(connection);
      if (state.ai?.connected) {
        const modelCard = node('section', null, 'am-settings-card'); modelCard.setAttribute('aria-label', '回答模型');
        const label = node('label', '回答模型', 'am-settings-label'), select = node('select'); select.id = 'askme-chatgpt-model'; label.setAttribute('for', select.id); select.setAttribute('aria-label', 'ChatGPT 回答模型');
        const options = state.models.length ? state.models : state.ai.model ? [{ id: state.ai.model, name: state.ai.model }] : [];
        if (!state.ai.model) { const option = node('option', '选择一个模型'); option.value = ''; select.append(option); }
        for (const model of options) { const option = node('option', model.name || model.id); option.value = model.id; select.append(option); }
        select.value = state.ai.model || ''; select.disabled = state.busy.has('ai-select');
        select.addEventListener('change', () => { const model = select.value; if (model) void selectAiModel(model); });
        const actions = node('div', null, 'am-model-actions'); actions.append(button('刷新模型列表', loadModels));
        modelCard.append(label, select, actions); area.append(modelCard);
      }
      if (state.notice) area.append(node('p', state.notice, 'am-subtle'));
    }
    const loadModels = () => task('ai-models', () => call('ai.models'), result => { state.models = rows(result); state.ai = { ...state.ai, model: typeof result.model === 'string' ? result.model : '', ready: !!result.model }; }, loadModels);
    const selectAiModel = model => task('ai-select', () => call('ai.select', { model }), () => { state.ai.model = model; state.ai.ready = true; }, () => selectAiModel(model));
    const connectAi = () => task('ai-connect', () => call('ai.connect'), () => { state.notice = '完成 ChatGPT 登录后，点击“刷新连接状态”。'; }, connectAi);
    const disconnectAi = () => task('ai-disconnect', () => call('ai.disconnect'), () => { state.ai = { connected: false }; state.models = []; }, disconnectAi);
    async function loadSessions(offset = 0) {
      if (!state.courseId) return;
      return task('chat-list', () => call('chat.list', { courseId: state.courseId, offset, limit: 30 }), result => {
        state.sessions = offset ? [...state.sessions, ...rows(result)] : rows(result); state.sessionNext = result.nextOffset;
      }, () => loadSessions(offset));
    }
    function newChat() { invalidate(); state.sessionId = ''; state.messages = []; state.messageNext = null; state.draft = ''; state.history = false; state.skill = ''; state.quizViews.clear(); state.error = null; state.notice = ''; state.captureId = ''; state.captureExpiresAt = null; render(); }
    async function readSession(id, offset = 0) {
      if (!offset) { invalidate(); state.sessionId = id; state.messages = []; state.draft = ''; state.history = false; state.skill = ''; state.picker = false; state.quizViews.clear(); state.captureId = ''; state.captureExpiresAt = null; }
      return task('chat-read', () => call('chat.read', { courseId: state.courseId, sessionId: id, offset, limit: 30 }), result => {
        state.messages = offset ? [...state.messages, ...rows(result)] : rows(result); state.messageNext = result.nextOffset;
      }, () => readSession(id, offset));
    }
    function renderChat() {
      const toolbar = node('div', null, 'am-session-bar');
      const back = button('‹', () => openView('courses'), 'am-back'); back.setAttribute('aria-label', '返回课程');
      toolbar.append(back, button('＋ 新对话', newChat), button(state.history ? '返回对话' : '◷ 历史记录', () => { state.history = !state.history; render(); if (state.history) void loadSessions(); })); main.append(toolbar);
      if (state.history) {
        const area = scroller(); area.append(node('h1', '历史对话', 'am-title'));
        if (!state.sessions.length) empty(area, state.busy.has('chat-list') ? '读取中…' : state.courseId ? '还没有历史对话。' : '选择课程后查看对应的历史对话。');
        for (const session of state.sessions) { const b = button(session.title || '课程对话', () => readSession(session.id), 'am-history-item'); b.setAttribute('aria-current', String(state.sessionId === session.id)); area.append(b); }
        if (state.sessionNext != null) area.append(button('更多对话', () => loadSessions(state.sessionNext)));
        renderComposer(); return;
      }
      const area = scroller(); area.classList.add('am-chat-scroll'); area.setAttribute('role', 'log'); area.setAttribute('aria-label', '课程对话');
      const isEmpty = !state.messages.length && !state.skill && !state.busy.has('chat-read');
      if (isEmpty) {
        area.classList.add('am-chat-empty'); const welcome = node('div', null, 'am-welcome');
        if (brandLogoUrl) { const logo = node('img'); logo.src = brandLogoUrl; logo.alt = ''; welcome.append(logo); }
        const greeting = node('div'); greeting.append(node('h1', '今天，想弄懂什么？'), node('p', '从课程知识到考前自测，一起学清楚。')); welcome.append(greeting); area.append(welcome);
      }
      for (const message of state.messages) {
        const item = node('article', null, `am-message${message.role === 'user' ? ' am-user' : ''}`);
        item.append(node('div', message.role === 'user' ? '你' : 'Askme', 'am-message-role'));
        if (message.text) item.append(node('div', message.text, 'am-message-text'));
        if (message.localStatus === 'failed') item.append(node('div', '未收到回答，可重试这条问题。', 'am-subtle'));
        sources(item, message.sources);
        if (message.artifact?.type === 'quiz') renderQuizArtifact(item, message.artifact);
        area.append(item);
      }
      if (state.messageNext != null) area.append(button('继续读取对话', () => readSession(state.sessionId, state.messageNext)));
      if (state.busy.has('chat-read')) area.append(node('p', '正在读取对话…', 'am-loading'));
      if (state.busy.has('chat-ask') || state.busy.has('page-explain')) { const waiting = node('p', '正在根据课程资料生成并核对回答…', 'am-loading'); waiting.setAttribute('role', 'status'); area.append(waiting); }
      if (state.skill === 'plan') {
        const panel = node('section', null, 'am-inline-study'); panel.append(button('收起复习计划', () => { state.skill = ''; render(); }, 'am-quiet am-inline-study-close')); area.append(panel); renderStudy(panel);
      }
      if (state.notice) main.append(node('div', state.notice, 'am-notice'));
      renderComposer();
      const status = node('div', null, 'am-conversation-status');
      status.append(button(state.ai?.connected ? 'ChatGPT 已连接 · 设置 ›' : '连接 ChatGPT ›', () => { state.settings = true; invalidate(); render(); void refreshAi(); })); main.append(status);
    }
    function renderComposer() {
      const composer = node('form', null, 'am-composer am-session-composer'), input = node('textarea');
      input.value = state.draft; input.maxLength = 1500; input.placeholder = state.courseId ? '问课程知识、继续追问，或让 Askme 出一份 quiz…' : '先选择下方课程，再开始提问…'; input.setAttribute('aria-label', '课程问题');
      const busy = () => state.busy.has('chat-ask') || state.busy.has('page-explain') || state.busy.has('chat-read');
      if (state.captureId) { const attachment = node('div', null, 'am-row'); attachment.append(node('span', '截图已附加', 'am-pill'), button('清除截图', () => { state.captureId = ''; state.captureExpiresAt = null; render(); }, 'am-quiet')); composer.append(attachment); }
      input.addEventListener('input', () => { state.draft = input.value; send.disabled = !state.courseId || !input.value.trim() || busy(); });
      input.addEventListener('compositionstart', () => { composing = true; }); input.addEventListener('compositionend', () => { composing = false; });
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing) { event.preventDefault(); if (!send.disabled) void ask(); } });
      const row = node('div', null, 'am-compose-row'), chip = node('div', null, 'am-course-chip');
      const choose = button('', () => {
        state.picker = !state.picker; render();
        main.querySelector(state.picker ? '.am-picker button' : '.am-course-name')?.focus();
      }, 'am-course-name');
      const iconUrl = state.courseId ? courseIconUrl : folderIconUrl;
      if (iconUrl) { const icon = node('img', null, 'am-folder-icon'); icon.src = iconUrl; icon.alt = ''; choose.append(icon); }
      choose.append(node('span', state.courseId ? courseTitle(currentCourse() || { id: state.courseId }) : 'Folder', 'am-course-label-text'));
      choose.setAttribute('aria-label', state.courseId ? `切换课程：${courseTitle(currentCourse() || { id: state.courseId })}` : 'Folder：选择已同步课程');
      choose.setAttribute('aria-expanded', String(state.picker)); choose.setAttribute('aria-controls', 'askme-course-folder'); choose.title = state.courseId ? courseTitle(currentCourse() || { id: state.courseId }) : '选择已同步课程'; chip.append(choose);
      if (state.courseId) { const clear = button('×', () => selectCourse(''), 'am-course-clear'); clear.setAttribute('aria-label', '清除当前课程'); chip.append(clear); }
      const send = button('↑', ask, 'am-primary am-send'); send.setAttribute('aria-label', busy() ? '正在回答' : '发送问题'); send.disabled = !state.courseId || !state.draft.trim() || busy();
      row.append(chip, send); composer.append(input, row);
      let picker;
      if (state.picker) {
        picker = node('div', null, 'am-picker'); picker.id = 'askme-course-folder'; picker.setAttribute('aria-label', '已同步课程'); const courses = state.courses.filter(c => !!c.syncedAt);
        for (const course of courses) { const b = button('', async () => {
          const id = String(course.id); await selectCourse(id);
          if (!disposed && state.view === 'ask' && state.courseId === id) main.querySelector('.am-course-name')?.focus();
        }, 'am-folder-course');
          if (courseIconUrl) { const icon = node('img', null, 'am-course-icon'); icon.src = courseIconUrl; icon.alt = ''; b.append(icon); }
          b.append(node('span', courseTitle(course), 'am-course-label-text')); b.title = courseTitle(course);
          b.setAttribute('aria-pressed', String(String(course.id) === state.courseId)); picker.append(b);
        }
        if (!courses.length) picker.append(node('p', '还没有同步课程。', 'am-subtle'));
        picker.append(button('管理课程与同步 ›', () => openView('courses'), 'am-quiet')); if (state.courseNext != null) picker.append(button('载入更多课程', () => loadCourses(state.courseNext))); composer.append(picker);
      }
      const skills = node('div', null, 'am-skills');
      for (const [label, question] of [['提炼重点', '帮我提炼这门课的核心知识点'], ['选择题自测', '根据当前课程资料，出3道选择题。']]) {
        const b = button(label, () => { state.draft = question; if (state.courseId) void ask(); else { state.picker = true; render(); } }); b.disabled = busy(); skills.append(b);
      }
      const plan = button('复习计划', () => { state.history = false; if (!state.courseId) { state.picker = true; render(); return; } state.skill = 'plan'; render(); if (!state.plan) void loadStudyPlan(); }); plan.disabled = busy(); skills.append(plan); composer.append(skills);
      composer.addEventListener('submit', event => { event.preventDefault(); if (!send.disabled) void ask(); }); main.append(composer);
      // 输入框在底部时向上展开；欢迎状态下有足够空间才向下展开。
      if (picker && row.getBoundingClientRect && main.getBoundingClientRect) {
        const anchor = row.getBoundingClientRect(), bounds = main.getBoundingClientRect(), box = composer.getBoundingClientRect();
        const below = bounds.bottom - anchor.bottom - 12, above = anchor.top - bounds.top - 12;
        const opensBelow = below >= 170 || below >= above;
        picker.style.top = opensBelow ? `${anchor.bottom - box.top + 6}px` : 'auto';
        picker.style.bottom = opensBelow ? 'auto' : `${box.bottom - anchor.top + 6}px`;
        picker.style.maxHeight = `${Math.max(60, Math.min(240, opensBelow ? below : above))}px`;
      }
      composer.addEventListener('keydown', event => { if (event.key === 'Escape' && state.picker) { event.preventDefault(); state.picker = false; render(); main.querySelector('.am-course-name')?.focus(); } });
    }
    function renderQuizArtifact(parent, artifact) {
      if (!/^quiz:[a-f0-9]{32}$/u.test(String(artifact.id))) return;
      const entry = state.quizViews.get(artifact.id), card = node('section', null, 'am-artifact');
      const toggle = button('', () => { if (entry?.open) { entry.open = false; render(); } else void loadQuiz(artifact); }, 'am-artifact-toggle');
      const copy = node('div', null, 'am-artifact-copy'); copy.append(node('div', artifact.title || '课程选择题', 'am-artifact-title'), node('div', `${artifact.questionCount || entry?.data?.questionCount || ''} 道题 · 选择题自测`, 'am-subtle'));
      toggle.append(node('span', '◇', 'am-artifact-icon'), copy, node('span', entry?.open ? '⌃' : '›')); toggle.setAttribute('aria-expanded', String(!!entry?.open)); card.append(toggle); parent.append(card);
      if (state.busy.has(`quiz-read:${artifact.id}`)) { card.append(node('p', '正在打开测验…', 'am-loading')); return; }
      if (!entry?.open || !entry.data) return;
      const data = entry.data, body = node('div', null, 'am-artifact-body'), questions = list(data.questions); card.append(body);
      const expired = data.status === 'expired' || (Number.isFinite(data.expiresAt) && Date.now() >= data.expiresAt);
      if (data.status === 'generating' || data.status === 'failed') {
        body.append(node('p', `已生成 ${Number.isInteger(data.generatedCount) ? data.generatedCount : questions.length} / ${data.questionCount || artifact.questionCount || 3} 题${data.status === 'generating' ? '，正在继续核对课程原文…' : '，剩余题目生成未完成。'}`, 'am-subtle'));
        if (data.status === 'failed') { const retry = button(state.busy.has(`quiz-advance:${artifact.id}`) ? '正在重试…' : '继续生成剩余题目', () => advanceQuiz(artifact.id)); retry.disabled = state.busy.has(`quiz-advance:${artifact.id}`); body.append(retry); }
      }
      if (expired) { body.append(node('p', '测验已过期，已答解析仍可回看。', 'am-subtle'), button('重新出题', () => { state.draft = '根据当前课程资料，出3道选择题。'; void ask(); })); }
      const question = questions[0]; if (!question) { if (!expired) body.append(node('p', '暂无可显示的题目。', 'am-subtle')); return; }
      const feedback = data.feedback?.[question.id], selectedId = feedback?.selectedOptionId || entry.selections[question.id];
      body.append(node('div', `第 ${data.questionIndex + 1} / ${data.questionCount} 题`, 'am-subtle'), node('h2', question.question, 'am-question'));
      const fieldset = node('fieldset', null, 'am-options'); fieldset.append(node('legend', '选择一个答案'));
      const checkKey = `quiz-check:${artifact.id}`;
      const submit = button(state.busy.has(checkKey) ? '核对中…' : '提交答案', () => checkQuiz(artifact.id, question.id), 'am-primary'); submit.disabled = !selectedId || !!feedback || data.status !== 'active' || expired || state.busy.has(checkKey);
      for (const option of list(question.options)) {
        const selected = selectedId === option.id, label = node('label', null, `am-option${selected ? ' am-picked' : ''}${feedback?.correctOptionId === option.id ? ' am-correct' : feedback && selected ? ' am-wrong' : ''}`);
        const input = node('input'); input.type = 'radio'; input.name = `askme-${artifact.id}-${question.id}`; input.value = option.id; input.checked = selected; input.disabled = !!feedback || data.status !== 'active' || expired || state.busy.has(checkKey);
        input.addEventListener('change', () => { entry.selections[question.id] = option.id; for (const item of fieldset.querySelectorAll('.am-option')) item.classList.toggle('am-picked', item.querySelector('input')?.value === option.id); submit.disabled = false; });
        const text = node('div', null, 'am-option-content'); text.append(node('div', `${option.id}. ${option.text}`));
        if (feedback) { const explanation = list(feedback.options).find(o => o.id === option.id)?.explanation; if (explanation) text.append(node('div', explanation, 'am-option-note')); }
        label.append(input, text); fieldset.append(label);
      }
      body.append(fieldset);
      if (feedback) { body.append(node('p', feedback.verdict === 'correct' ? '答对了' : `正确答案：${feedback.correctOptionId}`, 'am-result')); sources(body, feedback.evidence ? [feedback.evidence] : []); }
      else if (!expired) body.append(submit);
      const pagingDisabled = !['active', 'expired'].includes(data.status) || state.busy.has(checkKey);
      const availableCount = Math.min(data.questionCount, data.generatedCount);
      const controls = node('div', null, 'am-artifact-controls'), previous = button('上一题', () => loadQuiz(artifact, data.questionIndex - 1)), next = button('下一题', () => loadQuiz(artifact, data.questionIndex + 1)); previous.disabled = pagingDisabled || data.questionIndex === 0; next.disabled = pagingDisabled || data.questionIndex + 1 >= availableCount;
      controls.append(previous, button('收起测验', () => { entry.open = false; render(); }, 'am-quiet'), next); body.append(controls);
      body.append(node('p', `已答 ${data.answeredCount} / ${data.questionCount} 题 · 答对 ${data.correctCount} 题`, 'am-subtle'));
    }
    function validQuiz(result, artifactId) {
      return result?.id === artifactId && ['generating', 'active', 'expired', 'failed'].includes(result.status) &&
        ['questionIndex', 'questionCount', 'generatedCount', 'answeredCount', 'correctCount'].every(key => Number.isInteger(result[key]) && result[key] >= 0) &&
        result.questionCount >= 1 && result.questionCount <= 12 && result.questionIndex < result.questionCount && result.generatedCount <= result.questionCount && result.answeredCount <= result.generatedCount && result.correctCount <= result.answeredCount &&
        Array.isArray(result.questions) && result.questions.length <= 1 && result.questions.every(q => typeof q?.id === 'string' && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length === 4 && new Set(q.options.map(o => o?.id)).size === 4 && q.options.every(o => ['A','B','C','D'].includes(o?.id) && typeof o.text === 'string'));
    }
    async function loadQuiz(artifact, questionIndex) {
      const existing = state.quizViews.get(artifact.id);
      if (existing?.data && questionIndex == null) { existing.open = true; render(); if (existing.data.status === 'generating') void advanceQuiz(artifact.id); return; }
      const started = stamp();
      await task(`quiz-read:${artifact.id}`, () => call('chat.quiz.read', { courseId: state.courseId, sessionId: state.sessionId, artifactId: artifact.id, questionIndex: questionIndex ?? 0 }), result => {
        if (!validQuiz(result, artifact.id) || result.questionIndex !== (questionIndex ?? 0)) throw new Error('INVALID_UI_RESPONSE');
        state.quizViews.set(artifact.id, { open: true, selections: existing?.selections || {}, data: result });
      }, () => loadQuiz(artifact, questionIndex));
      if (current(started) && state.quizViews.get(artifact.id)?.data.status === 'generating') void advanceQuiz(artifact.id);
    }
    async function advanceQuiz(artifactId) {
      const entry = state.quizViews.get(artifactId), key = `quiz-advance:${artifactId}`;
      if (!entry || state.busy.has(key)) return;
      const started = stamp(); let shouldContinue = false;
      await task(key, () => call('chat.quiz.advance', { courseId: state.courseId, sessionId: state.sessionId, artifactId }), result => {
        if (!validQuiz(result, artifactId)) throw new Error('INVALID_UI_RESPONSE');
        entry.data = result; shouldContinue = result.status === 'generating';
      }, () => advanceQuiz(artifactId));
      if (current(started) && shouldContinue) void advanceQuiz(artifactId);
    }
    function checkQuiz(artifactId, questionId) {
      const entry = state.quizViews.get(artifactId), selectedOptionId = entry?.selections[questionId]; if (!selectedOptionId || entry.data.feedback?.[questionId]) return;
      return task(`quiz-check:${artifactId}`, () => call('chat.quiz.check', { courseId: state.courseId, sessionId: state.sessionId, artifactId, questionId, selectedOptionId }), result => {
        if (result?.questionId !== questionId || result.selectedOptionId !== selectedOptionId || result.sourceVerification !== 'verified' || !['A','B','C','D'].includes(result.correctOptionId) || !['correct','incorrect'].includes(result.verdict) || typeof result.evidence?.quote !== 'string') throw new Error('INVALID_UI_RESPONSE');
        if (!['correct', 'answered', 'total'].every(key => Number.isInteger(result.score?.[key]) && result.score[key] >= 0) || result.score.total !== entry.data.questionCount || result.score.correct > result.score.answered || result.score.answered > result.score.total) throw new Error('INVALID_UI_RESPONSE');
        entry.data.feedback = { ...entry.data.feedback, [questionId]: result }; entry.data.answeredCount = result.score.answered; entry.data.correctCount = result.score.correct;
      }, () => checkQuiz(artifactId, questionId));
    }
    function assistantMessage(result) {
      const message = result?.message;
      if (!message || message.role !== 'assistant' || typeof message.text !== 'string') throw new Error('INVALID_UI_RESPONSE');
      return message;
    }
    async function ensureSession(started) {
      if (state.sessionId) return state.sessionId;
      const result = await call('chat.create', { courseId: started.courseId });
      if (!current(started)) return null;
      if (typeof result.sessionId !== 'string' || !result.sessionId.startsWith('chat:')) throw new Error('INVALID_UI_RESPONSE');
      state.sessionId = result.sessionId; return result.sessionId;
    }
    async function ask() {
      const question = state.draft.trim(); if (!question || !state.courseId || state.busy.has('chat-ask') || state.busy.has('page-explain') || state.busy.has('chat-read')) return;
      const captureId = state.captureId, captureExpiresAt = state.captureExpiresAt;
      if (captureId && state.captureExpiresAt && Date.now() >= state.captureExpiresAt) { state.captureId = ''; state.captureExpiresAt = null; showError({ code: 'CAPTURE_EXPIRED' }, capture); render(); return; }
      const userMessage = { role: 'user', text: question, localStatus: 'pending' }, startedContext = stamp();
      state.messages.push(userMessage); state.draft = ''; state.history = false; state.skill = ''; state.captureId = ''; state.captureExpiresAt = null;
      await task('chat-ask', async started => {
        const sessionId = await ensureSession(started); if (!sessionId) return null;
        return call('chat.ask', { courseId: started.courseId, sessionId, question, ...(captureId ? { captureId } : {}) });
      }, result => { const answer = assistantMessage(result); delete userMessage.localStatus; state.messages.push(answer); state.notice = ''; if (answer.artifact?.type === 'quiz') void loadQuiz(answer.artifact); }, () => {
        state.messages = state.messages.filter(item => item !== userMessage); state.draft = question;
        if (captureId) { state.captureId = captureId; state.captureExpiresAt = captureExpiresAt; }
        return ask();
      });
      if (current(startedContext) && userMessage.localStatus === 'pending') { userMessage.localStatus = 'failed'; render(); }
    }
    async function loadSources(offset = 0) {
      if (!state.courseId) return;
      return task('source-list', () => call('source.list', { courseId: state.courseId, offset, limit: 50 }), result => {
        state.sources = offset ? [...state.sources, ...rows(result)] : rows(result); state.sourceNext = result.nextOffset;
        if (!state.sourceId) state.sourceId = String(state.sources[0]?.id || '');
      }, () => loadSources(offset));
    }
    function renderPractice() {
      if (!state.courseId) { empty(scroller(), '选择课程后，用课程资料练习与复习。'); return; }
      const modes = node('div', null, 'am-review-tabs');
      for (const [mode, label] of [['choice', '选择题'], ['plan', '复习计划']]) {
        const b = button(label, () => { if (state.reviewMode === mode) return; invalidate(); state.reviewMode = mode; state.error = null; render(); if (mode === 'plan') void loadStudyPlan(); else if (!state.sources.length) void loadSources(); });
        b.setAttribute('aria-pressed', String(state.reviewMode === mode)); modes.append(b);
      }
      main.append(modes);
      if (state.reviewMode === 'plan') { renderStudy(); return; }
      const area = scroller();
      if (!state.choice) {
        area.append(node('h1', '选择题自测', 'am-title'));
        const label = node('label', '选择练习资料'), select = node('select', null, 'am-source-select'); select.setAttribute('aria-label', '练习资料');
        if (!state.sources.length) { const o = node('option', state.busy.has('source-list') ? '正在读取资料…' : '暂无可练习资料'); o.value = ''; select.append(o); }
        for (const source of state.sources) { const o = node('option', source.title || '课程资料'); o.value = source.id; select.append(o); }
        select.value = state.sourceId; select.disabled = state.busy.has('choice-generate'); select.addEventListener('change', () => { state.sourceId = select.value; }); area.append(label, select);
        if (state.sourceNext != null) area.append(button('更多资料', () => loadSources(state.sourceNext)));
        if (!state.sources.length && !state.busy.has('source-list')) empty(area, '先同步课程，再用可读取的课程原文出题。');
        const row = node('div', null, 'am-row'); row.style.marginTop = '20px';
        for (const count of [1, 3]) { const b = button(`${count} 题${count === 1 ? '热身' : '练习'}`, () => generateChoice(count), count === 3 ? 'am-primary' : ''); b.disabled = !state.sourceId || state.busy.has('choice-generate'); row.append(b); } area.append(row);
        if (state.busy.has('choice-generate')) area.append(node('p', '正在出题并核对课程原文…', 'am-loading')); return;
      }
      if (state.finished) {
        area.append(node('h1', '练习完成', 'am-title')); const feedback = state.feedback[state.choice.questions.at(-1).id];
        const score = feedback?.score; area.append(node('div', `${score?.correct ?? 0} / ${score?.total ?? state.choice.questions.length}`, 'am-score'));
        area.append(node('p', '正确题数')); const row = node('div', null, 'am-row'); row.append(button('回看解析', () => { state.finished = false; state.questionIndex = 0; render(); }), button('再练一组', resetChoice, 'am-primary')); area.append(row); return;
      }
      const question = state.choice.questions[state.questionIndex], feedback = state.feedback[question.id];
      area.append(node('div', `第 ${state.questionIndex + 1} / ${state.choice.questions.length} 题`, 'am-subtle'), node('h1', question.question, 'am-question'));
      const fieldset = node('fieldset', null, 'am-options'); fieldset.append(node('legend', '选择一个答案'));
      for (const option of question.options) {
        const selected = (feedback?.selectedOptionId || state.selections[question.id]) === option.id;
        const label = node('label', null, `am-option${selected ? ' am-picked' : ''}${feedback?.correctOptionId === option.id ? ' am-correct' : feedback && selected ? ' am-wrong' : ''}`);
        const input = node('input'); input.type = 'radio'; input.name = `askme-choice-${question.id}`; input.value = option.id; input.checked = selected; input.disabled = !!feedback || state.busy.has('choice-check');
        input.addEventListener('change', () => {
          state.selections[question.id] = option.id;
          for (const item of fieldset.querySelectorAll('.am-option')) item.classList.toggle('am-picked', item.querySelector('input')?.value === option.id);
          submit.disabled = false;
        });
        const content = node('div', null, 'am-option-content'); content.append(node('div', `${option.id}. ${option.text}`));
        if (feedback) { const explanation = list(feedback.options).find(item => item.id === option.id)?.explanation; if (explanation) content.append(node('div', explanation, 'am-option-note')); }
        label.append(input, content); fieldset.append(label);
      }
      area.append(fieldset);
      if (feedback) { area.append(node('div', feedback.verdict === 'correct' ? '答对了' : `正确答案：${feedback.correctOptionId}`, 'am-result')); sources(area, [feedback.evidence]); }
      const footer = node('div', null, 'am-footer');
      const submit = feedback ? button(state.questionIndex + 1 === state.choice.questions.length ? '查看结果' : '下一题', () => { if (state.questionIndex + 1 === state.choice.questions.length) state.finished = true; else state.questionIndex++; render(); }, 'am-primary') : button(state.busy.has('choice-check') ? '核对中…' : '提交答案', checkChoice, 'am-primary');
      submit.disabled = !feedback && (!state.selections[question.id] || state.busy.has('choice-check')); footer.append(submit); main.append(footer);
    }
    function studyStatus(value) {
      return ({ unseen: '未练习', weak: '需要巩固', pendingDelayed: '等待隔日复测', delayedConfirmed: '已通过隔日复测', needsRevalidation: '资料已更新', needsReview: '待核验' })[value] || '待复习';
    }
    function studyDate(value) {
      const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
      return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Australia/Sydney', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
    }
    function loadStudyPlan() {
      if (!state.courseId) return;
      return task('study-plan', () => call('study.plan', { courseId: state.courseId, limit: 10 }), result => {
        const items = rows(result);
        if (result.scope !== 'course-material' || result.assessmentScopeConfirmed !== false || items.some(item => typeof item.id !== 'string' || typeof item.title !== 'string' || item.practiceAvailable !== true)) throw new Error('INVALID_UI_RESPONSE');
        state.plan = { ...result, items };
      }, loadStudyPlan);
    }
    function returnToPlan() {
      invalidate(); state.practice = null; state.practiceDraft = ''; state.practiceSubmitted = null; state.practiceFeedback = null; state.error = null; render(); void loadStudyPlan();
    }
    function startStudy(unitId) {
      if (!state.courseId || state.busy.has('practice-start')) return;
      return task('practice-start', () => call('practice.start', { courseId: state.courseId, unitId }), result => {
        if (typeof result?.sessionId !== 'string' || result.unitId !== unitId || typeof result.question?.id !== 'string' || typeof result.question.question !== 'string' || !result.question.question.trim()) throw new Error('INVALID_UI_RESPONSE');
        state.practice = result; state.practiceDraft = ''; state.practiceSubmitted = null; state.practiceFeedback = null;
      }, () => startStudy(unitId));
    }
    function submitStudy() {
      const practice = state.practice, answer = state.practiceSubmitted ?? state.practiceDraft.trim();
      if (!practice || !answer || state.practiceFeedback || state.busy.has('practice-submit')) return;
      // 首次提交固定答卷；网络失败后的重试不能改成第二次作答。
      state.practiceSubmitted = answer;
      return task('practice-submit', () => call('practice.submit', { courseId: state.courseId, sessionId: practice.sessionId, questionId: practice.question.id, answer }), result => {
        if (result?.sessionId !== practice.sessionId || result.questionId !== practice.question.id || !['correct', 'partial', 'incorrect', 'ungradable'].includes(result.verdict) ||
          !['verified', 'needsReview'].includes(result.verification) || typeof result.recorded !== 'boolean' || (result.recorded && (result.verification !== 'verified' || result.verdict === 'ungradable'))) throw new Error('INVALID_UI_RESPONSE');
        state.practiceFeedback = result; state.plan = null;
      }, submitStudy);
    }
    function renderStudy(container = main) {
      const area = scroller(container), practice = state.practice, feedback = state.practiceFeedback;
      if (!practice) {
        area.append(node('h1', '今天复习什么', 'am-title'), node('p', '依据已同步课程资料，优先复习到期内容与薄弱知识点。', 'am-subtle'));
        const refresh = button(state.busy.has('study-plan') ? '正在整理…' : '刷新计划', loadStudyPlan); refresh.disabled = state.busy.has('study-plan') || state.busy.has('practice-start'); area.append(refresh);
        if (!state.plan) { empty(area, state.busy.has('study-plan') ? '正在整理课程知识点…' : '点击刷新计划，查看可练习的知识点。'); return; }
        const counts = state.plan.counts || {}, meta = node('p', null, 'am-plan-meta');
        for (const [key, label] of [['due', '到期'], ['weak', '待巩固'], ['fresh', '新知识']]) if (Number.isInteger(counts[key])) meta.append(node('span', `${label} ${counts[key]}`, 'am-pill'));
        area.append(meta);
        if (!state.plan.items.length) { empty(area, '目前没有待安排的练习。已完成的知识点会在复测时间到达后出现；新课程需先完成同步。'); return; }
        for (const item of state.plan.items) {
          const card = node('section', null, 'am-card am-plan-card');
          card.append(node('h3', item.title), node('span', ({ due: '到期复习', weak: '巩固薄弱点', 'source-changed': '核对新资料', new: '开始学习' })[item.reason] || studyStatus(item.status), 'am-pill'));
          if (item.section) card.append(node('p', item.section, 'am-subtle'));
          if (item.dueAt) card.append(node('p', `复测时间：${studyDate(item.dueAt)}（悉尼）`, 'am-subtle'));
          sources(card, item.source ? [item.source] : []);
          const actions = node('div', null, 'am-card-actions'), start = button(state.busy.has('practice-start') ? '正在准备题目…' : '练一道', () => startStudy(item.id), 'am-primary');
          start.disabled = state.busy.has('practice-start'); actions.append(start); card.append(actions); area.append(card);
        }
        return;
      }
      area.append(button('返回复习计划', returnToPlan, 'am-quiet'), node('h1', practice.question.question, 'am-question'));
      if (!feedback) {
        if (state.practiceSubmitted !== null) area.append(node('p', '答卷已固定。若提交失败，可重试同一份答案。', 'am-subtle'));
        const form = node('form', null, 'am-composer am-study-composer'), label = node('label', '用自己的话回答'), input = node('textarea');
        input.id = 'askme-study-answer'; label.setAttribute('for', input.id); input.maxLength = 2000; input.placeholder = '写下你的理解…'; input.value = state.practiceSubmitted ?? state.practiceDraft;
        input.disabled = state.practiceSubmitted !== null || state.busy.has('practice-submit');
        const row = node('div', null, 'am-row'), submit = button(state.busy.has('practice-submit') ? '正在核对原文…' : state.practiceSubmitted !== null ? '重试提交' : '提交回答', submitStudy, 'am-primary');
        submit.disabled = !(state.practiceSubmitted ?? state.practiceDraft).trim() || state.busy.has('practice-submit');
        input.addEventListener('input', () => { state.practiceDraft = input.value; submit.disabled = !input.value.trim(); });
        row.append(submit); form.append(label, input, row); form.addEventListener('submit', event => { event.preventDefault(); if (!submit.disabled) void submitStudy(); }); container.append(form); return;
      }
      area.append(node('p', '你的回答', 'am-subtle'), node('div', state.practiceSubmitted, 'am-study-answer'));
      const result = node('section', null, 'am-study-feedback');
      if (feedback.verification === 'verified' && feedback.recorded) {
        result.append(node('h2', ({ correct: '回答正确', partial: '还差一点', incorrect: '再巩固一下' })[feedback.verdict]));
        if (feedback.feedback) result.append(node('p', feedback.feedback, 'am-study-answer'));
        if (feedback.modelAnswer) result.append(node('p', '参考答案', 'am-subtle'), node('p', feedback.modelAnswer, 'am-study-answer'));
        if (feedback.explanation) result.append(node('p', feedback.explanation, 'am-study-answer'));
        result.append(node('p', studyStatus(feedback.status), 'am-pill'));
        if (feedback.dueAt) result.append(node('p', `下次复测：${studyDate(feedback.dueAt)}（悉尼）`, 'am-subtle'));
        sources(result, feedback.source ? [{ ...feedback.source, excerpt: feedback.evidence || feedback.source.excerpt }] : []);
      } else result.append(node('h2', '本次反馈待核验'), node('p', '没有更新掌握记录。请回查课程原文，或返回计划换一道练习。'));
      area.append(result); const footer = node('div', null, 'am-footer'); footer.append(button('继续复习', returnToPlan, 'am-primary')); container.append(footer);
    }
    function resetChoice() { invalidate(); state.choice = null; state.feedback = {}; state.selections = {}; state.questionIndex = 0; state.finished = false; state.error = null; render(); }
    const generateChoice = count => task('choice-generate', () => call('choice.generate', { courseId: state.courseId, sourceId: state.sourceId, count }), result => {
      if (typeof result?.sessionId !== 'string' || !result.sessionId || result.sourceVerification !== 'verified' || !list(result.questions).length || result.questions.length > count ||
          result.questions.some(q => !q || typeof q.id !== 'string' || typeof q.question !== 'string' || list(q.options).length !== 4 ||
            new Set(q.options.map(option => option?.id)).size !== 4 || q.options.some(option => !option || !['A', 'B', 'C', 'D'].includes(option.id) || typeof option.text !== 'string'))) throw new Error('INVALID_UI_RESPONSE');
      state.choice = result; state.questionIndex = 0; state.selections = {}; state.feedback = {}; state.finished = false;
    }, () => generateChoice(count));
    const checkChoice = () => {
      const q = state.choice?.questions[state.questionIndex], selectedOptionId = q && state.selections[q.id]; if (!q || !selectedOptionId) return;
      return task('choice-check', () => call('choice.check', { courseId: state.courseId, sessionId: state.choice.sessionId, questionId: q.id, selectedOptionId }), result => {
        if (result?.questionId !== q.id || result.selectedOptionId !== selectedOptionId || result.sourceVerification !== 'verified' ||
            !['A', 'B', 'C', 'D'].includes(result.correctOptionId) || !['correct', 'incorrect'].includes(result.verdict) || !result.evidence ||
            typeof result.evidence.quote !== 'string' || !result.score || !['correct', 'answered', 'total'].every(key => Number.isInteger(result.score[key])) ||
            list(result.options).length !== 4 || result.options.some(option => !option || typeof option.explanation !== 'string')) throw new Error('INVALID_UI_RESPONSE');
        state.feedback[q.id] = result;
      }, checkChoice);
    };
    async function capture() {
      if (disposed) return; openView('ask');
      if (!state.courseId) { state.picker = true; state.notice = '先选择课程，再截取需要解释的内容。'; render(); return; }
      const started = stamp();
      const region = host.selectCaptureRegion ? await host.selectCaptureRegion() : {};
      if (region === null || !current(started)) return;
      return task('capture', () => call('capture.take', region?.width ? { region } : {}), result => {
        // 只保留短期票据；图片仍在后台，发送问题时由后台核对当前账号和课程。
        if (typeof result?.captureId !== 'string' || !result.captureId || !Number.isFinite(result.expiresAt)) throw new Error('INVALID_UI_RESPONSE');
        state.captureId = result.captureId; state.captureExpiresAt = result.expiresAt; state.notice = '';
        if (!state.draft.trim()) state.draft = '请解释截图中的内容，并结合当前课程资料说明。';
      }, capture);
    }
    async function explainPage() {
      if (disposed) return; openView('ask');
      if (!state.courseId) { showError({ code: 'UI_COURSE_REQUIRED' }); return; }
      return task('page-explain', async started => {
        const sessionId = await ensureSession(started); if (!sessionId) return null;
        return call('page.explain', { courseId: started.courseId, sessionId });
      }, result => { state.messages.push(assistantMessage(result)); }, explainPage);
    }
    function layoutChanged(layout) {
      if (disposed) return;
      clearTimeout(layoutTimer); const value = { width: Math.max(240, Math.min(720, Math.round(layout.width || 400))), open: layout.open !== false, view: state.view };
      const started = stamp();
      layoutTimer = setTimeout(() => { if (!disposed) void call('ui.layout.save', value).catch(error => { if (current(started)) showError(error, () => call('ui.layout.save', value)); }); }, 200);
    }
    function dispose() { if (disposed) return; disposed = true; invalidate(); clearTimeout(layoutTimer); state.messages = []; state.courses = []; state.sources = []; state.choice = null; state.captureId = ''; shell.remove(); style.remove(); void client.dispose?.(); }
    render(); void initialize();
    return Object.freeze({ openView, selectDiscoveredCourse, layoutChanged, capture, explainPage, dispose });
  }
  globalThis.AskmePanelController = Object.freeze({ createPanelController });
})();
