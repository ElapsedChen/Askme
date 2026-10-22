// UI 只提交业务参数，账号、标签和文档身份由后台从 sender 获取。
(() => {
  'use strict';
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const id = value => typeof value === 'string' && /^\d{1,12}$/u.test(value);
  const token = value => typeof value === 'string' && /^[a-f0-9]{48}$/u.test(value);
  const captureRegion = value => exact(value, ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight']) &&
    Object.values(value).every(Number.isFinite) && value.x >= 0 && value.y >= 0 && value.width >= 16 && value.height >= 16 &&
    value.viewportWidth > 0 && value.viewportHeight > 0 && value.viewportWidth <= 16000 && value.viewportHeight <= 16000 &&
    value.x + value.width <= value.viewportWidth && value.y + value.height <= value.viewportHeight;
  const requestId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/u.test(value);
  const bounded = (value, max = 65536) => {
    try { const json = JSON.stringify(value); return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= max; } catch { return false; }
  };
  const page = args => exact(args, ['offset', 'limit']) && Number.isInteger(args.offset) && args.offset >= 0 && args.offset <= 100000 && Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 50;
  const session = value => typeof value === 'string' && /^chat:[A-Za-z0-9:._-]{8,100}$/u.test(value);
  const artifact = value => typeof value === 'string' && /^quiz:[a-f0-9]{32}$/u.test(value);
  const quizArgs = args => id(args.courseId) && session(args.sessionId) && artifact(args.artifactId);
  const operations = Object.freeze({
    'ui.bootstrap': args => exact(args, []),
    'course.discover': args => exact(args, []),
    'course.select': args => exact(args, ['courseId', 'selected']) && id(args.courseId) && typeof args.selected === 'boolean',
    'course.sync': args => exact(args, ['courseId']) && id(args.courseId),
    'course.files.continue': args => exact(args, ['courseId', 'retry']) && id(args.courseId) && typeof args.retry === 'boolean',
    'course.sync.report': args => exact(args, ['courseId', 'offset', 'limit']) && id(args.courseId) && page({ offset: args.offset, limit: args.limit }),
    'course.list': page,
    'course.view': args => exact(args, ['courseId']) && id(args.courseId),
    'source.list': args => exact(args, ['courseId', 'offset', 'limit']) && id(args.courseId) && page({ offset: args.offset, limit: args.limit }),
    'source.read': args => exact(args, ['courseId', 'sourceId', 'offset', 'length']) && id(args.courseId) && requestId(args.sourceId) && Number.isInteger(args.offset) && args.offset >= 0 && args.offset <= 10000000 && Number.isInteger(args.length) && args.length > 0 && args.length <= 8000,
    'chat.list': args => exact(args, ['courseId', 'offset', 'limit']) && id(args.courseId) && page({ offset: args.offset, limit: args.limit }),
    'chat.read': args => exact(args, ['courseId', 'sessionId', 'offset', 'limit']) && id(args.courseId) && typeof args.sessionId === 'string' && /^chat:[A-Za-z0-9:._-]{8,100}$/u.test(args.sessionId) && page({ offset: args.offset, limit: args.limit }),
    'chat.create': args => exact(args, ['courseId']) && id(args.courseId),
    'chat.quiz.read': args => object(args) && exact(args, Object.hasOwn(args, 'questionIndex') ? ['courseId', 'sessionId', 'artifactId', 'questionIndex'] : ['courseId', 'sessionId', 'artifactId']) && quizArgs(args) &&
      (!Object.hasOwn(args, 'questionIndex') || Number.isInteger(args.questionIndex) && args.questionIndex >= 0 && args.questionIndex < 12),
    'chat.quiz.advance': args => exact(args, ['courseId', 'sessionId', 'artifactId']) && quizArgs(args),
    'chat.quiz.check': args => exact(args, ['courseId', 'sessionId', 'artifactId', 'questionId', 'selectedOptionId']) && quizArgs(args) && /^q(?:[1-9]|1[0-2])$/u.test(args.questionId) && ['A', 'B', 'C', 'D'].includes(args.selectedOptionId),
    'chat.ask': args => object(args) && exact(args, Object.hasOwn(args, 'captureId') ? ['courseId', 'sessionId', 'question', 'captureId'] : ['courseId', 'sessionId', 'question']) &&
      id(args.courseId) && session(args.sessionId) && typeof args.question === 'string' && args.question.trim().length > 0 && args.question.length <= 1500 &&
      (!Object.hasOwn(args, 'captureId') || token(args.captureId)),
    'page.explain': args => exact(args, ['courseId', 'sessionId']) && id(args.courseId) && session(args.sessionId),
    'capture.take': args => exact(args, []) || exact(args, ['region']) && captureRegion(args.region),
    'choice.generate': args => exact(args, ['courseId', 'sourceId', 'count']) && id(args.courseId) && requestId(args.sourceId) && Number.isInteger(args.count) && args.count >= 1 && args.count <= 3,
    'choice.check': args => exact(args, ['courseId', 'sessionId', 'questionId', 'selectedOptionId']) && id(args.courseId) &&
      typeof args.sessionId === 'string' && /^[A-Za-z0-9_-]{32}$/u.test(args.sessionId) && /^q[1-3]$/u.test(args.questionId) && ['A', 'B', 'C', 'D'].includes(args.selectedOptionId),
    'study.units': args => exact(args, ['courseId', 'offset', 'limit']) && id(args.courseId) && page({ offset: args.offset, limit: args.limit }) && args.limit <= 30,
    'study.plan': args => object(args) && exact(args, Object.hasOwn(args, 'limit') ? ['courseId', 'limit'] : ['courseId']) && id(args.courseId) &&
      (!Object.hasOwn(args, 'limit') || Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= 20),
    'practice.start': args => exact(args, ['courseId', 'unitId']) && id(args.courseId) && typeof args.unitId === 'string' && /^ku:[a-f0-9]{1,8}:\d{1,12}$/u.test(args.unitId),
    'practice.submit': args => exact(args, ['courseId', 'sessionId', 'questionId', 'answer']) && id(args.courseId) &&
      typeof args.sessionId === 'string' && /^[A-Za-z0-9_-]{32}$/u.test(args.sessionId) && typeof args.questionId === 'string' && /^q[1-3]$/u.test(args.questionId) &&
      typeof args.answer === 'string' && args.answer.trim().length > 0 && args.answer.length <= 2000,
    'ai.status': args => exact(args, []),
    'ai.connect': args => exact(args, []),
    'ai.models': args => exact(args, []),
    'ai.disconnect': args => exact(args, []),
    'ai.select': args => exact(args, ['model']) && typeof args.model === 'string' && /^[a-zA-Z0-9._-]{1,100}$/u.test(args.model),
    'ui.layout.save': args => exact(args, ['width', 'open', 'view']) && Number.isInteger(args.width) && args.width >= 240 && args.width <= 720 && typeof args.open === 'boolean' && ['courses', 'ask', 'review'].includes(args.view)
  });
  function validSender(sender, extensionId) {
    try {
      const url = new URL(sender?.url || '');
      return sender?.id === extensionId && url.origin === 'https://moodle.telt.unsw.edu.au' && !url.username && !url.password &&
        sender.frameId === 0 && Number.isInteger(sender.tab?.id) && sender.tab.id >= 0 && Number.isInteger(sender.tab?.windowId) && sender.tab.windowId >= 0 &&
        typeof sender.documentId === 'string' && sender.documentId.length >= 1 && sender.documentId.length <= 128 &&
        (!sender.documentLifecycle || sender.documentLifecycle === 'active');
    } catch { return false; }
  }
  function hello(value, buildVersion) {
    return exact(value, ['protocolVersion', 'buildVersion', 'hostInstanceId']) && value.protocolVersion === 1 && value.buildVersion === buildVersion && requestId(value.hostInstanceId);
  }
  function request(value) {
    const required = ['v', 'requestId', 'bindingId', 'generation', 'op', 'args'];
    return object(value) && required.every(key => Object.hasOwn(value, key)) &&
      Object.keys(value).every(key => [...required, 'expectedRevision', 'operationId'].includes(key)) &&
      (!Object.hasOwn(value, 'expectedRevision') || (Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0)) &&
      (!Object.hasOwn(value, 'operationId') || (typeof value.operationId === 'string' && /^[A-Za-z0-9:._-]{8,128}$/u.test(value.operationId))) &&
      value.v === 1 && requestId(value.requestId) && token(value.bindingId) &&
      Number.isSafeInteger(value.generation) && value.generation > 0 && Object.hasOwn(operations, value.op) && operations[value.op](value.args) && bounded(value);
  }
  globalThis.AskmeUiProtocol = Object.freeze({ exact, id, token, requestId, bounded, validSender, hello, request, operations });
})();
