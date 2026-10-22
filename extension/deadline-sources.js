// 从已验收的课程截止事项检索提取，保持匹配和证据约束。
(() => {
'use strict';
const moodleOrigin = 'https://moodle.telt.unsw.edu.au';
function tokens(value) {
  const text = value.toLowerCase();
  const stop = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'with', 'from', 'that', 'this', 'what', 'how', 'why', 'who', 'when', 'where', 'can', 'does', 'of', 'in', 'on', 'to', 'is', 'it', 'a', 'an']);
  return [...new Set([...(text.match(/[a-z]{2,}|\d+/g) || []).filter(word => !stop.has(word)), ...(text.match(/[\u3400-\u9fff]{2,}/g) || []).flatMap(s => s.length > 4 ? [s, ...Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2))] : [s])])];
}

function deadlineEventIntent(question) {
  const text = String(question || '').normalize('NFKC').toLocaleLowerCase('en-AU');
  if (!text) return '';
  if (/(?:\bopens?\b|\bavailable\b|什么时候开放|何时开放|开放时间|开始时间)/iu.test(text)) return 'open';
  if (/(?:\bcloses?\b|\bclosing\b|什么时候关闭|何时关闭|关闭时间|最终关闭)/iu.test(text)) return 'close';
  if (/(?:\bdue\b|\bdeadline\b|截止|提交(?:日期|时间)|到期)/iu.test(text)) return 'due';
  if (/(?:日期|时间|when)/iu.test(text) && /(?:assignment|task|assessment|quiz|exam|作业|任务|考核|测验|考试)/iu.test(text)) return 'due';
  return '';
}

function assessmentIdentity(value) {
  const text = String(value || '').normalize('NFKC').toLocaleLowerCase('en-AU')
    .replace(/[\u2010-\u2015]/gu, '-').replace(/\s+/gu, ' ').trim();
  const identities = [];
  const patterns = [
    /\bassignment\s*(?:task\s*)?(\d+[a-z]?)\b/giu,
    /\btask\s*(\d+[a-z]?)\b/giu,
    /\bquiz\s*(\d+[a-z]?)\b/giu,
    /\bexam\s*(\d+[a-z]?)?\b/giu,
    /(?:作业|任务|测验|考试)\s*([0-9]+[a-z]?)/giu
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) identities.push(`${match[0].replace(/\s+/gu, ' ').trim()}:${match[1] || ''}`);
  }
  const number = identities.map(item => item.split(':').at(-1)).find(Boolean) || '';
  const kind = /assignment|作业/iu.test(text) ? 'assignment' : /quiz|测验/iu.test(text) ? 'quiz' : /exam|考试/iu.test(text) ? 'exam' : /task|任务/iu.test(text) ? 'task' : '';
  return { text, number, kind };
}

function safeEventSourceUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/mod\/(assign|quiz|page|book|folder)\/view\.php$/u);
    if (url.origin !== moodleOrigin || url.protocol !== 'https:' || !match || url.hash ||
        url.searchParams.getAll('id').length !== 1 || !/^\d{1,12}$/u.test(url.searchParams.get('id') || '') ||
        [...url.searchParams.keys()].some(key => key !== 'id')) return '';
    return `${moodleOrigin}${url.pathname}?id=${encodeURIComponent(url.searchParams.get('id'))}`;
  } catch { return ''; }
}

function deadlineEventSources(question, courseId, sourceEvents = []) {
  const intent = deadlineEventIntent(question);
  if (!intent || !/^\d{1,12}$/u.test(String(courseId || ''))) return [];
  const query = assessmentIdentity(question);
  const queryTokens = new Set(tokens(query.text).filter(token => !['due', 'deadline', 'date', 'time', 'open', 'opens', 'close', 'closes', 'submission'].includes(token)));
  const candidates = [];
  for (const event of sourceEvents) {
    if (!event || String(event.courseId) !== String(courseId) || String(event.eventType || '').toLocaleLowerCase('en-AU') !== intent) continue;
    const url = safeEventSourceUrl(event.activityUrl);
    const evidence = event.evidence;
    if (!url || !event.sourceVersion || !/^[0-9a-f]+:\d+$/u.test(String(event.sourceVersion)) ||
        evidence?.schemaVersion !== 1 || evidence.verbatim !== true || typeof evidence.normalizedText !== 'string' || !evidence.normalizedText.trim()) continue;
    const target = assessmentIdentity(event.title);
    if (query.number && target.number !== query.number) continue;
    if (query.kind && target.kind && query.kind !== target.kind && !(query.kind === 'assignment' && target.kind === 'task')) continue;
    const targetTokens = new Set(tokens(target.text));
    const overlap = [...queryTokens].filter(token => targetTokens.has(token)).length;
    if (!query.number && queryTokens.size && overlap === 0) continue;
    candidates.push({
      title: String(event.title || 'Moodle 日历事项').slice(0, 180), url,
      excerpt: evidence.normalizedText.trim().slice(0, 1200), eventType: intent,
      timestampMs: Number(event.timestampMs) || 0, sourceVersion: event.sourceVersion,
      score: (query.number ? 100 : 0) + overlap
    });
  }
  if (!candidates.length) return [];
  const best = Math.max(...candidates.map(item => item.score));
  return candidates.filter(item => item.score === best)
    .sort((left, right) => left.timestampMs - right.timestampMs || left.title.localeCompare(right.title))
    .slice(0, 4);
}

function activityCandidates(question, courseId, snapshot) {
  if (!deadlineEventIntent(question) || !/^\d{1,12}$/u.test(String(courseId))) return [];
  const query = assessmentIdentity(question);
  const queryTokens = new Set(tokens(query.text).filter(token => !['due', 'deadline', 'date', 'time', 'open', 'opens', 'close', 'closes', 'submission'].includes(token)));
  const list = value => Array.isArray(value) ? value : [];
  // 活动地址必须已由所选课程同步发现；不能从问题中提取任意 URL。
  const links = [
    ...list(snapshot?.pages).filter(page => String(page.courseId) === String(courseId)).flatMap(page => list(page.links)),
    ...list(snapshot?.assignmentBriefs).filter(brief => String(brief.courseId) === String(courseId)).map(brief => ({ url: brief.sourceUrl, title: brief.title })),
    ...list(snapshot?.events).filter(event => String(event.courseId) === String(courseId)).map(event => ({ url: event.activityUrl, title: event.title }))
  ];
  const found = new Map();
  for (const link of links) {
    const url = safeEventSourceUrl(link?.url);
    if (!url || !/\/mod\/(assign|quiz)\/view\.php\?/u.test(url)) continue;
    const title = String(link.title || '').trim().slice(0, 180), target = assessmentIdentity(title);
    if (!title || query.number && target.number !== query.number) continue;
    const sameKind = query.kind === target.kind || ['assignment', 'task'].includes(query.kind) && ['assignment', 'task'].includes(target.kind);
    if (query.kind && target.kind && !sameKind) continue;
    const targetTokens = new Set(tokens(target.text));
    const overlap = [...queryTokens].filter(token => targetTokens.has(token)).length;
    if (!query.number && (!queryTokens.size || !overlap)) continue;
    const score = (query.number ? 100 : 0) + overlap;
    if (!found.has(url) || found.get(url).score < score) found.set(url, { url, title, score });
  }
  if (!found.size) return [];
  const best = Math.max(...[...found.values()].map(item => item.score));
  const selected = [...found.values()].filter(item => item.score === best);
  // 多于三项时要求澄清，不能截掉候选后伪装成唯一活动。
  return selected.length <= 3 ? selected.map(({ url, title }) => ({ url, title })) : [];
}

globalThis.AskmeDeadlineSources = Object.freeze({ intent: deadlineEventIntent, sources: deadlineEventSources, activityCandidates });
})();

