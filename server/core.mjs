import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractDateTimeFacts, verifyAtomicClaim } from './claim-verifier.mjs';
import {
  PRACTICE_ERROR_TAGS, normalizeGeneratedPracticeItem, normalizePracticeContext, practiceContentDigest, practiceQuestionFingerprint,
  ungradablePracticeResult, verifiedPracticeResult
} from './practice-core.mjs';

const maxFileBytes = 20_000_000;
const extractScript = fileURLToPath(new URL('./extract.py', import.meta.url));
const modeInstructions = {
  answer: '先直接回答，再给出理解要点和可执行的复习建议。摘录之外的常识或例子须标明“补充解释（非课程材料）”，不得用课程来源编号为其背书。',
  summary: '按核心概念、通俗讲解、一个短例子、下一步复习顺序组织内容。只总结来源实际覆盖的知识；如自拟例子，标明“自拟例子（非课程材料）”且不为该例子标来源编号；缺失或含糊的部分明确指出。',
  quiz: '编写 3 至 5 道用于自测的原创回忆题，先完整列出题目，再单独列出答案与简短解析。每条答案标注对应来源编号。不要复制或代答课程正式测验、作业题。'
};

export function buildPrompt(question, sources, history = []) {
  const material = sources.map((source, i) => `[${i + 1}] ${source.title}\n摘录: ${source.excerpt}`).join('\n\n');
  const conversation = history.length ? `对话上下文（只用于理解“它”“继续”等指代，不是课程事实来源）：\n${history.map(item => `${item.role === 'user' ? '学生' : 'Askme'}：${item.content}`).join('\n')}\n\n` : '';
  return `${conversation}当前问题：${question}\n\n本轮课程材料：\n${material}`;
}

export function validatePayload(payload) {
  if (payload?.mode !== undefined && (typeof payload.mode !== 'string' || !Object.hasOwn(modeInstructions, payload.mode))) return '学习模式无效。';
  if (!payload || typeof payload.question !== 'string' || !payload.question.trim() || payload.question.length > 1500) return '问题不能为空，且不能超过 1500 字。';
  if (!Array.isArray(payload.sources) || payload.sources.length < 1 || payload.sources.length > 5) return '需要 1 至 5 个来源。';
  if (payload.history !== undefined) {
    if (!Array.isArray(payload.history) || payload.history.length > 8) return '对话上下文格式无效。';
    let historyChars = 0;
    for (const item of payload.history) {
      if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 5000 || Object.keys(item).some(key => !['role', 'content'].includes(key))) return '对话上下文格式无效。';
      historyChars += item.content.length;
    }
    if (historyChars > 12_000) return '对话上下文过长。';
  }
  for (const source of payload.sources) {
    if (!source || typeof source.title !== 'string' || !source.title.trim() || typeof source.excerpt !== 'string' || !source.excerpt.trim() || typeof source.url !== 'string' || source.title.length > 250 || source.excerpt.length > 1200) return '来源格式无效。';
    try {
      const url = new URL(source.url);
      if (!validMoodleEvidenceUrl(url)) return '来源格式无效。';
    } catch { return '来源格式无效。'; }
  }
  return null;
}

function validMoodleEvidenceUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.origin !== 'https://moodle.telt.unsw.edu.au' || url.protocol !== 'https:' || url.username || url.password) return false;
    const keys = [...url.searchParams.keys()];
    const oneNumericId = () => url.searchParams.getAll('id').length === 1 && /^\d{1,12}$/u.test(url.searchParams.get('id') || '');
    if (url.pathname === '/course/view.php') return oneNumericId() && keys.length === 1 && keys[0] === 'id' && (!url.hash || /^#section-\d{1,6}$/u.test(url.hash));
    const activity = url.pathname.match(/^\/mod\/(page|book|folder|resource|assign|quiz)\/view\.php$/u)?.[1];
    if (activity) {
      if (!oneNumericId()) return false;
      const allowed = activity === 'book' ? new Set(['id', 'chapterid']) : new Set(['id']);
      if (keys.some(key => !allowed.has(key)) || keys.length !== new Set(keys).size) return false;
      if (url.searchParams.has('chapterid') && (url.searchParams.getAll('chapterid').length !== 1 || !/^\d{1,12}$/u.test(url.searchParams.get('chapterid') || ''))) return false;
      // 作业和测验只作为日历事实来源，必须是无操作参数、无片段的规范查看地址。
      if ((activity === 'assign' || activity === 'quiz') && url.hash) return false;
      return true;
    }
    if (/^\/pluginfile\.php\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+$/u.test(url.pathname)) {
      if (keys.some(key => key !== 'forcedownload') || url.searchParams.getAll('forcedownload').length > 1) return false;
      if (url.searchParams.has('forcedownload') && url.searchParams.get('forcedownload') !== '1') return false;
      return !url.hash || /^#page=\d{1,6}$/u.test(url.hash);
    }
    return false;
  } catch { return false; }
}

export function validateVisionPayload(payload) {
  if (!payload || typeof payload.question !== 'string' || !payload.question.trim() || payload.question.length > 1500) return '问题不能为空，且不能超过 1500 字。';
  if (typeof payload.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(payload.image)) return '截图格式无效。';
  const base64 = payload.image.slice(payload.image.indexOf(',') + 1);
  if (!base64 || base64.length > 11_000_000) return '截图超过本机视觉问答上限。';
  const sources = payload.sources ?? [];
  if (!Array.isArray(sources) || sources.length > 5) return '截图上下文来源无效。';
  if (sources.length) return validatePayload({ question: payload.question, sources, history: payload.history });
  if (payload.history !== undefined) {
    if (!Array.isArray(payload.history) || payload.history.length > 8) return '对话上下文格式无效。';
    let historyChars = 0;
    for (const item of payload.history) {
      if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 5000 || Object.keys(item).some(key => !['role', 'content'].includes(key))) return '对话上下文格式无效。';
      historyChars += item.content.length;
    }
    if (historyChars > 12_000) return '对话上下文过长。';
  }
  return null;
}

function normaliseEvidence(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

class AnswerStageError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AnswerStageError';
    this.code = code;
  }
}

function stageError(code, message, cause) { return new AnswerStageError(code, message, cause); }
function isTimeout(error) { return error?.name === 'TimeoutError' || error?.name === 'AbortError'; }

function resolveGroundedEvidence(value, excerpt) {
  const source = normaliseEvidence(excerpt);
  const candidate = normaliseEvidence(value);
  if (source.includes(candidate)) return candidate;

  // 本地模型偶尔会把来源编号、标题和“摘录：”一并包进 evidence。
  // 只允许剥离明确的标签，并要求剩余文字仍是课程摘录中的逐字子串。
  const labelled = candidate.match(/(?:摘录|excerpt)\s*[:：]\s*(.{6,500})$/iu)?.[1]?.trim();
  if (labelled && source.includes(labelled)) return labelled;
  return '';
}

function claimWithoutTitleIdentifiers(text, title) {
  const identifiers = new Set((String(title || '').match(/\b(?:[A-Z]{2,}[A-Z0-9_-]*|[A-Za-z]+\d+[A-Za-z0-9_-]*)\b/gu) || []).map(value => value.toLowerCase()));
  return String(text || '').replace(/\b(?:[A-Z]{2,}[A-Z0-9_-]*|[A-Za-z]+\d+[A-Za-z0-9_-]*)\b/gu, value => identifiers.has(value.toLowerCase()) ? '' : value).replace(/\s+/g, ' ').trim();
}

const PRACTICE_STOP_WORDS = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'your', 'their', 'about', 'what', 'when', 'where', 'which', 'does', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'will', 'may', 'might', 'not', 'its', 'our', 'you', 'they', 'them', 'then', 'than', 'also', 'use', 'uses', 'used', 'using', 'source', 'excerpt', 'says', 'states', 'shows', 'identifies']);
function practiceTerms(value) {
  const normalized = String(value || '').normalize('NFKC').toLowerCase();
  const latin = (normalized.match(/[a-z][a-z0-9._+-]*/gu) || []).filter(token => token.length >= 3 && !PRACTICE_STOP_WORDS.has(token));
  const cjk = (normalized.match(/[\u3400-\u9fff]+/gu) || []).flatMap(run => run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)));
  return [...new Set([...latin, ...cjk])];
}

function verifyPracticeText(text, evidence, minimumCoverage = 0.6) {
  const atomic = verifyAtomicClaim(text, evidence);
  if (!atomic.ok) return atomic;
  const textHasCjk = /[\u3400-\u9fff]/u.test(text);
  const evidenceHasCjk = /[\u3400-\u9fff]/u.test(evidence);
  const allTerms = practiceTerms(text);
  // 跨语言回答必须保留来源中的英文技术词；不能拿中文翻译词与英文证据做字面覆盖率比较。
  const terms = textHasCjk !== evidenceHasCjk ? allTerms.filter(term => /^[a-z]/u.test(term)) : allTerms;
  if (!terms.length) return { ok: false, reason: '练习内容没有可核对的知识词', code: 'PRACTICE_TERMS_MISSING' };
  const source = new Set(practiceTerms(evidence));
  const matched = terms.filter(term => source.has(term));
  if (!matched.length || matched.length / terms.length < minimumCoverage) return { ok: false, reason: '练习内容的关键知识词没有得到证据支持', code: 'PRACTICE_TERMS_UNSUPPORTED' };
  return { ok: true, matchedTerms: matched.length, termCount: terms.length };
}

function groundedFallbackPractice(excerpt) {
  const source = normaliseEvidence(excerpt);
  const sentenceMatch = source.match(/^.{8,220}?(?:[.!?](?=\s|$)|$)/u);
  const evidence = normaliseEvidence(sentenceMatch?.[0] || source.slice(0, 220));
  if (evidence.length < 8) throw new Error('课程摘录不足以生成练习');
  const terms = practiceTerms(evidence).filter(term => /^[a-z]/u.test(term)).slice(0, 3);
  const focus = terms.length ? `“${terms.join(' / ')}”` : '这条课程原文';
  return { questions: [{
    id: 'q1',
    question: `请用自己的话解释课程原文中的${focus}。`,
    answer: evidence,
    explanation: evidence,
    evidence
  }] };
}
function parseGroundedItems(content, sources, { semanticAudit = false } = {}) {
  let raw = String(content || '').trim();
  if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw stageError('GENERATION_JSON_INVALID', '回答不是可核对的 JSON', error); }
  if (!Array.isArray(parsed?.items) || !parsed.items.length || parsed.items.length > 12) throw stageError('GENERATION_SCHEMA_INVALID', '回答条目数量无效');
  return parsed.items.map(item => {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const source = Number(item?.source);
    const sourceRecord = sources[source - 1];
    const evidence = resolveGroundedEvidence(item?.evidence, sourceRecord?.excerpt);
    if (!text || text.length > 1000 || /\[\d+\]/.test(text)) throw stageError('GENERATION_SCHEMA_INVALID', '回答条目文本无效');
    if (!Number.isInteger(source) || source < 1 || source > sources.length) throw stageError('GENERATION_SCHEMA_INVALID', '回答来源编号无效');
    if (evidence.length < 6 || evidence.length > 500) throw stageError('EVIDENCE_NOT_SUBSTRING', '回答证据不在课程摘录中');
    // 标题只允许证明课程代码等身份标识，不能把标题中的其他词当作事实证据。
    const verification = verifyAtomicClaim(claimWithoutTitleIdentifiers(text, sourceRecord?.title), evidence, { deferCrossLanguagePolarity: semanticAudit });
    if (!verification.ok) throw stageError(verification.code || 'GROUNDING_FAILED', `回答事实核验失败：${verification.reason}`);
    return { text, source, evidence, sourceTitle: sourceRecord?.title || '' };
  });
}

const DEADLINE_QUESTION = /(?:截止(?:日期|时间)?|due\s+(?:date|time)|when\s+is\b.{0,100}\bdue|what\s+(?:is\s+)?the\s+deadline)/iu;
const TIME_QUESTION = /(?:几点|时间|due\s+time|what\s+time)/iu;
const DUE_PREDICATE = /(?:\b(?:submission\s+)?is\s+due\b|\bdue\s+(?:date|time)\b|\bdue\s*:|截止(?:日期|时间)?)/giu;
const ASSESSMENT_SUBJECT = /(?:\b\d{2}T[1-3]\s+)?(?:Assignment(?:\s+Task)?|Assessment|Quiz|Exam|Project(?:\s+Milestone)?|Task)\s*(?:No\.?\s*)?\d+(?:\.\d+)?\b|(?:作业|任务|测验|考试|项目)\s*第?\s*\d+(?:\.\d+)?\s*(?:项|次|题)?/giu;
const WEEKDAY_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function normalizedSubject(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/gu, '');
}

function assessmentSubjects(value) {
  ASSESSMENT_SUBJECT.lastIndex = 0;
  return [...String(value || '').matchAll(ASSESSMENT_SUBJECT)].map(match => ({ text: match[0].trim(), start: match.index, end: match.index + match[0].length }));
}

function deadlineClauseBounds(text, index) {
  const separators = [...String(text || '').matchAll(/(?:\r?\n+|[。！？!?；;]+|(?<!\d)\.(?!\d))/gu)];
  const previous = separators.filter(match => match.index < index).at(-1);
  const next = separators.find(match => match.index > index);
  return { start: previous ? previous.index + previous[0].length : 0, end: next ? next.index : text.length };
}

function deadlineEventsForSource(source, sourceIndex) {
  const excerpt = String(source?.excerpt || '');
  const excerptSubjects = assessmentSubjects(excerpt);
  const titleSubjects = assessmentSubjects(source?.title || '');
  DUE_PREDICATE.lastIndex = 0;
  const dueMatches = [...excerpt.matchAll(DUE_PREDICATE)];
  const dates = extractDateTimeFacts(excerpt);
  const events = [];
  for (const due of dueMatches) {
    const predicatePrefix = excerpt.slice(Math.max(0, due.index - 24), due.index);
    if (/(?:\bnot\b|\bnever\b|不|未|并非|没有)\s*$/iu.test(predicatePrefix)) continue;
    const dueEnd = due.index + due[0].length;
    const clause = deadlineClauseBounds(excerpt, due.index);
    const clauseDates = dates.filter(item => item.start >= clause.start && item.end <= clause.end);
    if (clauseDates.length !== 1) continue;
    const date = clauseDates[0];
    const clauseSubjects = excerptSubjects.filter(item => item.start >= clause.start && item.end <= clause.end);
    const subjectKeys = new Set(clauseSubjects.map(item => normalizedSubject(item.text)));
    if (subjectKeys.size > 1) continue;
    const subject = clauseSubjects.sort((left, right) => right.text.length - left.text.length)[0] || (titleSubjects.length === 1 ? titleSubjects[0] : null);
    if (!subject) continue;
    const start = Math.min(date.start, due.index, clauseSubjects[0]?.start ?? date.start);
    const end = Math.max(date.end, dueEnd, clauseSubjects[0]?.end ?? dueEnd);
    if (end - start > 500) continue;
    const evidence = excerpt.slice(start, end).trim();
    if (evidence.length < 6 || !excerpt.includes(evidence)) continue;
    events.push({ subject: subject.text, subjectKey: normalizedSubject(subject.text), date, evidence, source: sourceIndex + 1 });
  }
  return { events, dueCount: dueMatches.length, dates, excerptSubjects, titleSubjects };
}

function deadlineEvidenceFallback(sources, subjectKey) {
  return sources.slice(0, 3).map((source, index) => {
    const excerpt = String(source?.excerpt || '');
    const matching = assessmentSubjects(excerpt).find(item => normalizedSubject(item.text) === subjectKey);
    const start = matching ? Math.max(0, matching.start - 120) : 0;
    const evidence = excerpt.slice(start, Math.min(excerpt.length, start + 300)).trim();
    return evidence ? { source: index + 1, evidence } : null;
  }).filter(Boolean);
}

function formatDeadlineEvidence(message, items) {
  const unique = [...new Map(items.map(item => [`${item.source}\u0000${item.evidence}`, item])).values()];
  if (!unique.length) return message;
  return `${message}\n\n${unique.map(item => `[${item.source}] 课程原文：“${item.evidence}”`).join('\n\n')}`;
}

function deadlineFallback(reasonCode, message, evidence) {
  return { handled: true, answer: formatDeadlineEvidence(message, evidence), quality: 'extractive-fallback', reasonCode, verificationMethod: 'deterministic-deadline' };
}

export function resolveDeadlineQuestion(question, sources, mode = 'answer') {
  if (!DEADLINE_QUESTION.test(String(question || ''))) return { handled: false };
  const questionSubjects = assessmentSubjects(question);
  const subjectKeys = [...new Set(questionSubjects.map(item => normalizedSubject(item.text)))];
  if (subjectKeys.length !== 1) {
    return deadlineFallback(subjectKeys.length ? 'DEADLINE_SUBJECT_AMBIGUOUS' : 'DEADLINE_SUBJECT_MISSING', '无法从问题中唯一确定要核对的考核活动，请提供完整活动名称。', deadlineEvidenceFallback(sources, ''));
  }
  const subjectKey = subjectKeys[0];
  const subject = questionSubjects.sort((left, right) => right.text.length - left.text.length)[0].text;
  const parsedSources = sources.map((source, index) => deadlineEventsForSource(source, index));
  const allEvents = parsedSources.flatMap(item => item.events);
  const matchingEvents = allEvents.filter(item => item.subjectKey === subjectKey);
  const sourceEvidence = deadlineEvidenceFallback(sources, subjectKey);
  if (!matchingEvents.length) {
    const sourceMentionsSubject = parsedSources.some(item => [...item.excerptSubjects, ...item.titleSubjects].some(value => normalizedSubject(value.text) === subjectKey));
    const reasonCode = sourceMentionsSubject && parsedSources.every(item => item.dueCount === 0) ? 'DEADLINE_DUE_NOT_FOUND' : allEvents.length ? 'DEADLINE_SUBJECT_MISMATCH' : 'DEADLINE_UNRESOLVED';
    const message = reasonCode === 'DEADLINE_DUE_NOT_FOUND'
      ? `课程资料中没有找到与“${subject}”绑定的截止表述；开放时间不能作为截止时间。`
      : reasonCode === 'DEADLINE_SUBJECT_MISMATCH'
        ? `课程资料中的截止事项与“${subject}”主体不匹配，无法据此回答。`
        : `课程资料不足以唯一确定“${subject}”的截止日期和时间，请在 Moodle 活动页核对。`;
    return deadlineFallback(reasonCode, message, sourceEvidence);
  }
  const weekdayMismatches = matchingEvents.filter(item => item.date.weekday !== null && new Date(Date.UTC(item.date.year, item.date.month - 1, item.date.day)).getUTCDay() !== item.date.weekday);
  if (weekdayMismatches.length) {
    return deadlineFallback('DEADLINE_WEEKDAY_MISMATCH', `课程原文中“${subject}”的星期与日历日期不一致，无法将其作为已核实的截止时间，请在 Moodle 活动页核对。`, weekdayMismatches);
  }
  const dateKeys = new Set(matchingEvents.map(item => `${item.date.year}-${item.date.month}-${item.date.day}`));
  const explicitTimeKeys = new Set(matchingEvents.filter(item => item.date.hour !== null).map(item => `${item.date.hour}-${item.date.minute}`));
  if (dateKeys.size > 1 || explicitTimeKeys.size > 1) {
    return deadlineFallback('DEADLINE_CONFLICT', `课程资料中为“${subject}”找到多个不同的截止时间，无法确定哪一个当前有效，请在 Moodle 活动页核对。`, matchingEvents);
  }
  const needsTime = TIME_QUESTION.test(question);
  const completeEvents = needsTime ? matchingEvents.filter(item => item.date.hour !== null) : matchingEvents;
  if (!completeEvents.length) {
    return deadlineFallback('DEADLINE_TIME_MISSING', `课程原文给出了“${subject}”的截止日期，但没有可核验的具体时间，无法回答截止时间。`, matchingEvents);
  }
  const preferredEvents = completeEvents.filter(item => item.date.hour !== null);
  const [{ date, evidence, source: sourceNumber, subject: sourceSubject }] = preferredEvents.length ? preferredEvents : completeEvents;
  const dateText = `${date.year} 年 ${date.month} 月 ${date.day} 日`;
  const weekdayText = date.weekday === null ? '' : `（${WEEKDAY_ZH[date.weekday]}）`;
  const timeText = date.hour === null ? '' : ` ${String(date.hour).padStart(2, '0')}:${String(date.minute).padStart(2, '0')}`;
  return { handled: true, answer: `${sourceSubject} 的${date.hour === null ? '截止日期' : '截止时间'}是 ${dateText}${weekdayText}${timeText}。[${sourceNumber}]\n依据：“${evidence}”`, quality: 'verified', verificationMethod: 'deterministic-deadline' };
}

export function deterministicDeadlineAnswer(question, sources, mode = 'answer') {
  const resolution = resolveDeadlineQuestion(question, sources, mode);
  return resolution.handled && resolution.quality === 'verified' ? resolution.answer : null;
}

function formatGroundedItems(items) {
  return items.map(({ text, source, evidence }) => `${text} [${source}]\n依据：“${evidence}”`).join('\n\n');
}

function exactSourceFallback(sources) {
  return sources.slice(0, 3).map((source, index) => {
    const evidence = normaliseEvidence(source?.excerpt).slice(0, 500);
    return `模型转述未通过核验，先显示课程原文。 [${index + 1}]\n依据：“${evidence}”`;
  }).join('\n\n');
}

function semanticUnsupportedFallback(sources) {
  return sources.slice(0, 3).map((source, index) => {
    const evidence = normaliseEvidence(source?.excerpt).slice(0, 500);
    return `模型转述未通过语义核验，以下仅显示课程原文。 [${index + 1}]\n依据：“${evidence}”`;
  }).join('\n\n');
}

export function parseGroundedAnswer(content, sources) {
  return formatGroundedItems(parseGroundedItems(content, sources));
}

function validatePracticeSource(source) {
  if (!source || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 250 || typeof source.excerpt !== 'string' || source.excerpt.trim().length < 5 || source.excerpt.length > 1200 || typeof source.url !== 'string' || !validMoodleUrl(source.url)) return '课程来源格式无效。';
  const url = new URL(source.url);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return '课程来源格式无效。'; }
  const isStaticPage = /^\/course\/view\.php$/i.test(path) || /^\/mod\/(?:page|book|folder|resource)\/view\.php$/i.test(path);
  const isStaticFile = /^\/pluginfile\.php(?:\/|$)/i.test(path) || /\.(?:pdf|docx|pptx|xlsx|txt|csv)$/i.test(path);
  if ((!isStaticPage && !isStaticFile) || /(?:^|\/)(?:mod_quiz|mod_assign|mod_forum|quiz|assign|forum|attempt|submission|submit|edit|grade)(?:\/|$)/i.test(path) || [...url.searchParams.keys()].some(key => /^(?:attempt|action|submission|submit|edit|grade|sesskey)$/i.test(key))) return '课程来源不是受支持的静态学习材料。';
  // 静态评分标准、作业指导和考试复习资料可用于原创自测；标题词不是活动类型。
  return null;
}

export function validatePracticePayload(path, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '练习请求格式无效。';
  if (path === '/practice/generate') {
    const keys = Object.keys(payload);
    if (!Object.hasOwn(payload, 'source') || keys.some(key => !['source', 'objective', 'context'].includes(key))) return '生成练习仅接受课程来源、考核目标和最小版本上下文。';
    if (Object.hasOwn(payload, 'objective') && (typeof payload.objective !== 'string' || !payload.objective.trim() || payload.objective.length > 250)) return '考核目标格式无效。';
    if (Object.hasOwn(payload, 'context') && !normalizePracticeContext(payload.context)) return '练习版本上下文无效。';
    return validatePracticeSource(payload.source);
  }
  if (path !== '/practice/check') return '练习模式无效。';
  if (Object.keys(payload).some(key => !['sessionId', 'questionId', 'studentAnswer', 'attemptId'].includes(key)) || !['sessionId', 'questionId', 'studentAnswer', 'attemptId'].every(field => Object.hasOwn(payload, field))) return '判题请求只能包含会话、题目编号、作答编号和学生回答。';
  if (typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(payload.sessionId)) return '练习会话编号无效。';
  if (typeof payload.questionId !== 'string' || !/^q[1-3]$/.test(payload.questionId)) return '练习题编号无效。';
  if (typeof payload.attemptId !== 'string' || !/^attempt:[A-Za-z0-9._:-]{8,112}$/u.test(payload.attemptId)) return '练习作答编号无效。';
  if (typeof payload.studentAnswer !== 'string' || !payload.studentAnswer.trim() || payload.studentAnswer.length > 2000) return 'studentAnswer 不能为空，且不能超过 2000 字。';
  return null;
}

function parsePracticeResponse(path, content, excerpt, context = null) {
  const invalid = (code, message) => { throw stageError(code, message); };
  let parsed;
  try { parsed = JSON.parse(content); } catch { invalid('PRACTICE_JSON_INVALID', '练习输出必须是一个 JSON 对象'); }
  const objectWithKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
  const evidenceIsSource = evidence => typeof evidence === 'string' && evidence.trim().length >= 5 && evidence.length <= 220 && excerpt.includes(evidence.trim());
  if (path === '/practice/generate') {
    const expectedCount = context?.questionCount || 3;
    if (!objectWithKeys(parsed, ['questions']) || !Array.isArray(parsed.questions)) invalid('PRACTICE_SCHEMA_INVALID', '练习输出只接受 questions 数组');
    if (!parsed.questions.length) invalid('PRACTICE_SOURCE_INSUFFICIENT', '摘录不足以支持原创练习');
    if (parsed.questions.length > expectedCount || (context?.questionCount && parsed.questions.length !== expectedCount)) invalid('PRACTICE_COUNT_INVALID', `本次需要 ${expectedCount} 道练习题`);
    const questions = parsed.questions.map((item, index) => {
      if (!objectWithKeys(item, ['question', 'answer', 'explanation', 'evidence', 'type', 'bloomLevel', 'aspect']) ||
          Object.entries({ question: 500, answer: 800, explanation: 1000, evidence: 220 }).some(([key, limit]) => typeof item[key] !== 'string' || !item[key].trim() || item[key].length > limit) ||
          (item.type !== undefined && !['short-answer', 'calculation', 'explanation', 'comparison', 'scenario'].includes(item.type)) ||
          (item.bloomLevel !== undefined && !['remember', 'understand', 'apply', 'analyze'].includes(item.bloomLevel)) ||
          (item.aspect !== undefined && (typeof item.aspect !== 'string' || !item.aspect.trim() || item.aspect.length > 80))) invalid('PRACTICE_SCHEMA_INVALID', '练习字段、类型或长度无效');
      const normalized = normalizeGeneratedPracticeItem(item, index, context?.sourceVersionHashes?.[0] || practiceQuestionFingerprint(excerpt));
      if (!normalized || !evidenceIsSource(normalized.evidence)) invalid('PRACTICE_EVIDENCE_NOT_SUBSTRING', 'evidence 必须逐字复制摘录中连续的 5 至 220 字，保留原换行');
      const answerCheck = verifyPracticeText(normalized.answer, normalized.evidence, 0.6);
      if (!answerCheck.ok) invalid(answerCheck.code || 'PRACTICE_ANSWER_UNSUPPORTED', `练习答案事实核验失败：${answerCheck.reason}`);
      const explanationCheck = verifyPracticeText(normalized.explanation, normalized.evidence, 0.3);
      if (!explanationCheck.ok) invalid(explanationCheck.code || 'PRACTICE_EXPLANATION_UNSUPPORTED', `练习解析事实核验失败：${explanationCheck.reason}`);
      return normalized;
    });
    if (new Set(questions.map(item => item.normalizedStemHash)).size !== questions.length) invalid('PRACTICE_DUPLICATE', '练习题重复');
    if (context?.previousItemIds?.some(id => questions.some(item => item.itemId === id))) invalid('PRACTICE_DUPLICATE', '练习题与历史题目重复');
    if (context?.previousVariantKeys?.some(key => questions.some(item => item.variantKey === key))) invalid('PRACTICE_DUPLICATE', '练习题变体与历史题目重复');
    return { questions };
  }
  if (!objectWithKeys(parsed, ['verdict', 'feedback', 'modelAnswer', 'evidence', 'errorTag']) || !['correct', 'partial', 'incorrect'].includes(parsed?.verdict) || typeof parsed.feedback !== 'string' || !parsed.feedback.trim() || parsed.feedback.length > 1000 || typeof parsed.modelAnswer !== 'string' || !parsed.modelAnswer.trim() || parsed.modelAnswer.length > 800) invalid('PRACTICE_SCHEMA_INVALID', '练习反馈字段或长度无效');
  if (!evidenceIsSource(parsed.evidence)) invalid('PRACTICE_EVIDENCE_NOT_SUBSTRING', '练习反馈缺少连续来源证据');
  const modelAnswerCheck = verifyPracticeText(parsed.modelAnswer.trim(), parsed.evidence.trim(), 0.5);
  if (!modelAnswerCheck.ok) invalid(modelAnswerCheck.code || 'PRACTICE_ANSWER_UNSUPPORTED', `练习参考答案事实核验失败：${modelAnswerCheck.reason}`);
  const errorTag = typeof parsed.errorTag === 'string' ? parsed.errorTag : parsed.verdict === 'correct' ? '' : 'unknown';
  return { verdict: parsed.verdict, feedback: parsed.feedback.trim(), modelAnswer: parsed.modelAnswer.trim(), evidence: parsed.evidence.trim(), errorTag };
}

function practiceErrorTagReasons(result, question, studentAnswer) {
  const reasons = [];
  if (result.verdict !== 'correct') {
    const expected = String(question.answer || '');
    const prompt = String(question.question || '');
    const answer = String(studentAnswer || '');
    const tagSupported = {
      'definition-confusion': /(?:define|definition|what\s+is|什么是|定义|解释)/iu.test(prompt),
      'condition-omission': /(?:if|when|provided|condition|unless|条件|当|仅当)/iu.test(expected) && !/(?:if|when|provided|condition|unless|条件|当|仅当)/iu.test(answer),
      'causal-error': /(?:because|therefore|cause|result|由于|因此|导致)/iu.test(`${prompt} ${expected}`),
      'sequence-error': /(?:first|then|next|before|after|step|首先|然后|步骤|之前|之后)/iu.test(expected),
      'formula-selection': /[=×÷*/^]|\bformula\b|公式/iu.test(`${prompt} ${expected}`),
      'calculation-error': /\d/u.test(expected) && /\d/u.test(answer),
      'unit-error': /(?:\b(?:mm|cm|m|kg|n|pa|mpa|s|hz|rpm)\b|单位)/iu.test(expected),
      'transfer-failure': /(?:scenario|apply|application|case|情境|应用|案例)/iu.test(prompt),
      'hint-dependent': false,
      unknown: false
    }[result.errorTag];
    if (!PRACTICE_ERROR_TAGS.includes(result.errorTag) || !tagSupported) reasons.push('ERROR_TAG_UNVERIFIED');
  }
  return reasons;
}

function normalizedNumbers(value) {
  return (String(value || '').match(/[-+]?\d+(?:\.\d+)?/gu) || []).map(Number).filter(Number.isFinite);
}

export function deterministicPracticeContradictions(expectedAnswer, studentAnswer) {
  const expected = String(expectedAnswer || '').normalize('NFKC').toLowerCase();
  const student = String(studentAnswer || '').normalize('NFKC').toLowerCase();
  const reasons = [];
  const expectedNumbers = normalizedNumbers(expected), studentNumbers = normalizedNumbers(student);
  if (expectedNumbers.length && studentNumbers.length && !studentNumbers.some(value => expectedNumbers.includes(value))) reasons.push('NUMERIC_CONTRADICTION');
  const opposites = [
    ['increase', 'decrease'], ['increases', 'decreases'], ['increasing', 'decreasing'], ['higher', 'lower'], ['before', 'after'],
    ['positive', 'negative'], ['true', 'false'], ['增加', '减少'], ['升高', '降低'], ['之前', '之后'], ['正向', '负向']
  ];
  if (opposites.some(([left, right]) => (expected.includes(left) && student.includes(right)) || (expected.includes(right) && student.includes(left)))) reasons.push('DIRECTION_CONTRADICTION');
  const expectedNegated = /(?:\b(?:no|not|never|without|cannot|can't)\b|不|无|没有|不能)/iu.test(expected);
  const studentNegated = /(?:\b(?:no|not|never|without|cannot|can't)\b|不|无|没有|不能)/iu.test(student);
  const sharedTerms = practiceTerms(expected).filter(term => new Set(practiceTerms(student)).has(term));
  if (sharedTerms.length && expectedNegated !== studentNegated) reasons.push('POLARITY_CONTRADICTION');
  return [...new Set(reasons)];
}

export function parsePracticeJudgementAudit(content) {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => !['supported', 'verdict', 'reason'].includes(key)) ||
      typeof parsed.supported !== 'boolean' || !['correct', 'partial', 'incorrect'].includes(parsed.verdict) ||
      typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.length > 500) throw new Error('独立判题审核格式无效');
  return { supported: parsed.supported, verdict: parsed.verdict, reason: parsed.reason.trim() };
}

function json(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
  if (typeof origin === 'string' && origin.length > 0) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function validMoodleUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://moodle.telt.unsw.edu.au' && !url.username && !url.password;
  } catch { return false; }
}

export function quantizeEmbedding(values) {
  if (!Array.isArray(values) || values.length < 128 || values.length > 4096 || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('向量格式无效');
  const scale = 127 / (Math.max(...values.map(Math.abs)) || 1);
  const bytes = Buffer.allocUnsafe(values.length);
  for (let i = 0; i < values.length; i++) bytes[i] = Math.round(values[i] * scale) & 255;
  return bytes.toString('base64');
}

function runExtractor(bytes, filename, mime) {
  return new Promise((resolve, reject) => {
    // Windows 后台管道默认可能为 GBK，课程原文必须通过 UTF-8 完整传回。
    const child = spawn(process.env.STUDY_PYTHON || 'python', ['-X', 'utf8', extractScript, JSON.stringify({ filename, mime })], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    const output = [];
    let outputBytes = 0;
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('文件解析超时')); }, 30_000);
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 2_000_000) { child.kill(); reject(new Error('提取文字超过输出上限')); }
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 300); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (code !== 0 || result.error) reject(new Error(result.error || stderr || '文件解析失败'));
        else resolve(result);
      } catch { reject(new Error('文件解析器没有返回有效结果')); }
    });
    child.stdin.end(bytes);
  });
}

async function extractRequest(req, res, origin) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { json(res, 415, { error: '仅支持 JSON 请求。' }, origin); return; }
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 28_000_000) { json(res, 413, { error: '文件请求超过 28 MB。' }, origin); return; }
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (String(payload?.courseId) !== req.headers['x-askme-course'] || !payload || !/^\d+$/.test(String(payload.courseId)) || !validMoodleUrl(payload.url) || typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 250 || typeof payload.section !== 'string' || payload.section.length > 150 || typeof payload.mime !== 'string' || payload.mime.length > 150 || typeof payload.base64 !== 'string' || payload.base64.length > 26_666_672 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.base64)) {
      json(res, 400, { error: '文件元数据或内容无效。' }, origin); return;
    }
    const file = Buffer.from(payload.base64, 'base64');
    if (!file.length || file.length > maxFileBytes) { json(res, 413, { error: '文件为空或超过 20 MB。' }, origin); return; }
    const result = await extractFileBytes(file, payload);
    json(res, 200, result, origin);
  } catch (error) {
    const reasonCode = fileErrorCode(error);
    json(res, 422, { error: '文件解析未完成。', reasonCode }, origin);
  }
}

export function fileErrorCode(error) {
  const detail = String(error?.message || '');
  return /没有可提取/u.test(detail) ? 'FILE_NO_TEXT' : /仅支持|不支持/u.test(detail) ? 'FILE_UNSUPPORTED'
    : /超过|过大/u.test(detail) ? 'FILE_TOO_LARGE' : /超时/u.test(detail) ? 'FILE_TIMEOUT' : 'FILE_READ_FAILED';
}

export async function extractFileBytes(file, payload) {
    const result = await runExtractor(file, payload.title, payload.mime);
    const now = new Date().toISOString();
    const pages = result.documents.map(document => {
      const href = new URL(payload.url);
      if (result.kind === 'pdf') href.hash = `page=${document.number}`;
      const label = result.kind === 'pptx' ? '幻灯片' : result.kind === 'xlsx' ? '工作表' : '页';
      const chunkSuffix = document.chunkIndex ? `:chunk=${document.chunkIndex}` : '';
      const chunkLabel = document.chunkIndex ? ` · 分段 ${document.chunkIndex}` : '';
      const ocrLabel = document.extractionMethod === 'ocr' ? ' · OCR' : '';
      return { id: `${payload.url}#part=${document.number}${chunkSuffix}`, courseId: String(payload.courseId), url: href.href, title: `${payload.title} · ${label} ${document.number}${chunkLabel}${ocrLabel}`, section: [payload.section, `${label} ${document.number}${chunkLabel}${ocrLabel}`].filter(Boolean).join(' · '), sectionGroup: payload.section || '课程文件', text: document.text, textTruncated: document.truncated, links: [], sourceType: 'file', fileKind: result.kind, partNumber: document.number, syncedAt: now,
        ...(document.extractionMethod === 'ocr' ? { extractionMethod: 'ocr', ocrConfidence: document.ocrConfidence } : {}) };
    });
    return { pages, kind: result.kind, totalParts: result.totalParts, skippedParts: result.skippedParts, emptyParts: result.emptyParts, truncatedParts: result.truncatedParts,
      blankParts: result.blankParts || 0, blankPages: result.blankPages || [], physicalParts: result.physicalParts,
      emptyPages: result.emptyPages || [], ocrParts: result.ocrParts || 0 };
}


export { modeInstructions, parseGroundedItems, formatGroundedItems, semanticUnsupportedFallback, parsePracticeResponse, practiceErrorTagReasons, extractRequest };
