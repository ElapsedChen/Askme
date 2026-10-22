// 中文可直接贴着数字和单位；词界仅阻止拉丁标识内部的数字，避免把 100%法则误读成裸数字 100。
const NUMBER_WITH_UNIT = /(?<![\p{Script=Latin}\p{N}_])[-+]?\d+(?:[.,]\d+)?(?:\s*(?:%|°[CF]?|mm|cm|m|km|ms|s|min|h|Hz|kHz|MHz|Pa|kPa|MPa|GPa|N|kN|J|kJ|W|kW|V|A|kg|g|mol|rpm)(?![\p{Script=Latin}\p{N}_]))?/giu;
const IDENTIFIER = /\b(?:[A-Z]{2,}[A-Z0-9_-]*|[A-Za-z]+\d+[A-Za-z0-9_-]*)\b/gu;

const MONTHS = new Map([
  ['january', 1], ['jan', 1], ['february', 2], ['feb', 2], ['march', 3], ['mar', 3],
  ['april', 4], ['apr', 4], ['may', 5], ['june', 6], ['jun', 6], ['july', 7], ['jul', 7],
  ['august', 8], ['aug', 8], ['september', 9], ['sep', 9], ['sept', 9], ['october', 10], ['oct', 10],
  ['november', 11], ['nov', 11], ['december', 12], ['dec', 12]
]);
const WEEKDAYS = new Map([
  ['sunday', 0], ['sun', 0], ['星期日', 0], ['星期天', 0], ['周日', 0], ['周天', 0],
  ['monday', 1], ['mon', 1], ['星期一', 1], ['周一', 1],
  ['tuesday', 2], ['tue', 2], ['tues', 2], ['星期二', 2], ['周二', 2],
  ['wednesday', 3], ['wed', 3], ['星期三', 3], ['周三', 3],
  ['thursday', 4], ['thu', 4], ['thur', 4], ['thurs', 4], ['星期四', 4], ['周四', 4],
  ['friday', 5], ['fri', 5], ['星期五', 5], ['周五', 5],
  ['saturday', 6], ['sat', 6], ['星期六', 6], ['周六', 6]
]);

function validDateParts(year, month, day, hour, minute) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour !== null && (hour < 0 || hour > 23 || minute < 0 || minute > 59)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function timeParts(hourText, minuteText, meridiemText = '') {
  if (hourText === undefined) return { hour: null, minute: null };
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  const meridiem = String(meridiemText || '').toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return { hour: NaN, minute };
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
    if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12;
  }
  return { hour, minute };
}

function dateFact(match, fields) {
  const year = Number(fields.year);
  const month = Number(fields.month);
  const day = Number(fields.day);
  const { hour, minute } = timeParts(fields.hour, fields.minute, fields.meridiem);
  if (!validDateParts(year, month, day, hour, minute)) return null;
  const weekday = fields.weekday ? WEEKDAYS.get(String(fields.weekday).toLowerCase()) : null;
  return { year, month, day, hour, minute, weekday: weekday ?? null, start: match.index, end: match.index + match[0].length, raw: match[0] };
}

export function extractDateTimeFacts(value) {
  const text = String(value || '').normalize('NFKC');
  const results = [];
  const patterns = [
    {
      pattern: /(?:(?<weekday>Monday|Mon|Tuesday|Tue(?:s)?|Wednesday|Wed|Thursday|Thu(?:r|rs)?|Friday|Fri|Saturday|Sat|Sunday|Sun)\s*,?\s*)?(?<day>\d{1,2})\s+(?<month>January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep(?:t)?|October|Oct|November|Nov|December|Dec)\s+(?<year>20\d{2})(?:(?:\s*,\s*|\s+)(?<hour>\d{1,2})(?::(?<minute>\d{2}))\s*(?<meridiem>AM|PM|am|pm)?)?/giu,
      fields: groups => ({ ...groups, month: MONTHS.get(String(groups.month).toLowerCase()) })
    },
    {
      pattern: /(?<year>20\d{2})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})\s*日?(?:\s*[（(]?(?<weekday>星期[一二三四五六日天]|周[一二三四五六日天])[）)]?)?(?:\s*(?<hour>\d{1,2})\s*(?:[:：]|时)\s*(?<minute>\d{2})?\s*分?)?/gu,
      fields: groups => groups
    },
    {
      pattern: /(?<year>20\d{2})[-/](?<month>\d{1,2})[-/](?<day>\d{1,2})(?:[T\s]+(?<hour>\d{1,2}):(?<minute>\d{2}))?/gu,
      fields: groups => groups
    }
  ];
  for (const { pattern, fields } of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (results.some(item => match.index < item.end && match.index + match[0].length > item.start)) continue;
      const fact = dateFact(match, fields(match.groups || {}));
      if (fact) results.push(fact);
    }
  }
  return results.sort((left, right) => left.start - right.start);
}

export function normaliseForEvidence(value) {
  return String(value || '').normalize('NFKC').replace(/[−–—]/gu, '-').replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function atomicClaimParts(value) {
  // 句点只有在不属于小数时才作为事实分隔符；0.5、3.14 等必须保留为同一事实。
  return String(value || '')
    .split(/(?:\r?\n+|[。！？?；;]+|(?<!\d)\.(?!\d))\s*/gu)
    .map(part => part.trim())
    .filter(Boolean);
}

function factMatches(pattern, value) {
  pattern.lastIndex = 0;
  return [...String(value || '').matchAll(pattern)].map(match => ({ value: normaliseForEvidence(match[0]), start: match.index, end: match.index + match[0].length }));
}

function facts(pattern, value, ignoredRanges = []) {
  return factMatches(pattern, value).filter(match => !ignoredRanges.some(range => match.start >= range.start && match.end <= range.end)).map(match => match.value);
}

function isLimitation(value) {
  return /(?:(?:材料|证据|摘录|来源).{0,20}(?:无法|不能|未提供|不足|未说明|需要.*核对)|(?:source|evidence|excerpt|material).{0,30}(?:not enough|cannot|not provided|unclear|insufficient)|(?:not enough information|insufficient evidence))/iu.test(value);
}

const DIRECTION_PATTERNS = [
  { direction: 'up', pattern: /(?:提高|增加|增大|上升|升高|变高|更多|加强|改善|提升|\b(?:increase|increases|increased|increasing|raise|raises|raised|raising|rise|rises|rose|rising|higher|more|improve|improves|improved|improving|enhance|enhances|enhanced|enhancing)\b)/giu },
  { direction: 'down', pattern: /(?:降低|减少|减小|下降|变低|更少|减弱|恶化|\b(?:decrease|decreases|decreased|decreasing|reduce|reduces|reduced|reducing|lower|lowers|lowered|lowering|drop|drops|dropped|dropping|fall|falls|fell|falling|less|worsen|worsens|worsened|worsening)\b)/giu }
];

function directionSequence(value) {
  const matches = [];
  for (const { direction, pattern } of DIRECTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of String(value || '').matchAll(pattern)) matches.push({ index: match.index, direction });
  }
  return matches.sort((left, right) => left.index - right.index).map(item => item.direction);
}

function sameDirectionSequence(claim, evidence) {
  const claimDirections = directionSequence(claim);
  if (!claimDirections.length) return true;
  const evidenceDirections = directionSequence(evidence);
  if (evidenceDirections.length < claimDirections.length) return false;
  // 引文应当是支持单条原子事实的短证据。方向词按出现顺序一致，才能支持
  // “A 增加导致 B 降低”这类高风险比较或因果结论。
  return claimDirections.every((direction, index) => evidenceDirections[index] === direction);
}

const RELATION_DIRECTION = new Map([
  ['increasing', 'up'], ['raising', 'up'], ['higher', 'up'],
  ['decreasing', 'down'], ['lowering', 'down'], ['lower', 'down'],
  ['increases', 'up'], ['increase', 'up'], ['increased', 'up'], ['raises', 'up'], ['raise', 'up'], ['raised', 'up'],
  ['decreases', 'down'], ['decrease', 'down'], ['decreased', 'down'], ['reduces', 'down'], ['reduce', 'down'], ['reduced', 'down'], ['lowers', 'down'], ['lowered', 'down']
]);

function normaliseRelationArgument(value) {
  return normaliseForEvidence(value).replace(/[^a-z0-9\s_-]/gu, ' ').replace(/\b(?:the|a|an)\b/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function parseEnglishDirectionalRelation(value) {
  const text = String(value || '').normalize('NFKC').trim();
  const match = text.match(/^(?<subjectDirection>Increasing|Decreasing|Raising|Lowering|Higher|Lower)\s+(?<subject>.+?)\s+(?<predicate>increases?|increased|decreases?|decreased|raises?|raised|reduces?|reduced|lowers?|lowered)\s+(?<object>.+?)[.!]?$/iu);
  if (!match?.groups) return null;
  const subject = normaliseRelationArgument(match.groups.subject);
  const object = normaliseRelationArgument(match.groups.object);
  if (!subject || !object) return null;
  return {
    subject,
    object,
    subjectDirection: RELATION_DIRECTION.get(match.groups.subjectDirection.toLowerCase()),
    predicateDirection: RELATION_DIRECTION.get(match.groups.predicate.toLowerCase())
  };
}

function verifyRelationArguments(claim, evidence) {
  const claimRelation = parseEnglishDirectionalRelation(claim);
  const evidenceRelation = parseEnglishDirectionalRelation(evidence);
  if (!claimRelation || !evidenceRelation) return { ok: true };
  if (claimRelation.subject !== evidenceRelation.subject || claimRelation.object !== evidenceRelation.object) {
    return { ok: false, reason: '回答中的关系主语或宾语与证据不一致', code: 'RELATION_ARGUMENT_MISMATCH' };
  }
  if (claimRelation.subjectDirection !== evidenceRelation.subjectDirection || claimRelation.predicateDirection !== evidenceRelation.predicateDirection) {
    return { ok: false, reason: '回答中的比较或变化方向与证据不一致', code: 'DIRECTION_MISMATCH' };
  }
  return { ok: true };
}

function sameDateTimeFacts(claim, evidence) {
  const claimFacts = extractDateTimeFacts(claim);
  if (!claimFacts.length) return { ok: true, claimFacts, evidenceFacts: extractDateTimeFacts(evidence) };
  const evidenceFacts = extractDateTimeFacts(evidence);
  for (const fact of claimFacts) {
    const matching = evidenceFacts.find(candidate => candidate.year === fact.year && candidate.month === fact.month && candidate.day === fact.day &&
      (fact.hour === null || (candidate.hour === fact.hour && candidate.minute === fact.minute)) &&
      (fact.weekday === null || candidate.weekday === fact.weekday));
    if (!matching) return { ok: false, reason: '回答中的日期、时间或星期与证据不一致', code: 'DATE_TIME_MISMATCH' };
  }
  return { ok: true, claimFacts, evidenceFacts };
}

// 英文按整词识别；课程常用的 “No duplication” 也是明确否定，不能漏检。
const NEGATION = /(?:不|无|未|不能|不得|并非|没有|\b(?:no|not|never|without|cannot|can['’]t|doesn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|won['’]t|mustn['’]t)\b)/iu;
const POLARITY_STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'on', 'at', 'in', 'to', 'of', 'for', 'and', 'or', 'not', 'never', 'without', 'does', 'do', 'did']);

function polarityTerms(value) {
  return (normaliseForEvidence(value).match(/[a-z][a-z0-9_-]*|[\u3400-\u9fff]{2,}/gu) || []).filter(term => term.length > 1 && !POLARITY_STOP_WORDS.has(term));
}

function matchingEvidenceClause(claim, evidence) {
  const clauses = String(evidence || '').split(/(?:\r?\n+|[。！？?；;]+|(?<!\d)\.(?!\d))\s*/gu).map(item => item.trim()).filter(Boolean);
  if (!clauses.length) return String(evidence || '');
  const terms = polarityTerms(claim);
  let best = clauses[0];
  let score = -1;
  for (const clause of clauses) {
    const normalized = normaliseForEvidence(clause);
    const current = terms.filter(term => normalized.includes(term)).length;
    if (current > score) { best = clause; score = current; }
  }
  return best;
}

export function verifyAtomicClaim(text, evidence, { deferCrossLanguagePolarity = false } = {}) {
  const claim = String(text || '').trim();
  const quote = String(evidence || '').trim();
  const parts = atomicClaimParts(claim);
  if (parts.length !== 1) return { ok: false, reason: '回答条目必须只包含一个可核验事实', code: 'ATOMICITY_FAILED' };
  if (claim.length > 1000 || quote.length < 6) return { ok: false, reason: '回答条目或证据长度无效', code: 'GENERATION_SCHEMA_INVALID' };
  const dates = sameDateTimeFacts(claim, quote);
  if (!dates.ok) return dates;
  const consumedDateRanges = dates.claimFacts.map(({ start, end }) => ({ start, end }));
  const evidenceNumbers = new Set(facts(NUMBER_WITH_UNIT, quote));
  for (const fact of facts(NUMBER_WITH_UNIT, claim, consumedDateRanges)) {
    if (!evidenceNumbers.has(fact)) return { ok: false, reason: `回答中的数值或单位没有出现在证据中：${fact}`, code: 'NUMERIC_FACT_UNSUPPORTED' };
  }
  const evidenceIdentifiers = new Set(facts(IDENTIFIER, quote));
  for (const identifier of facts(IDENTIFIER, claim)) {
    if (!evidenceIdentifiers.has(identifier)) return { ok: false, reason: `回答中的技术标识没有出现在证据中：${identifier}`, code: 'IDENTIFIER_UNSUPPORTED' };
  }
  const claimNegated = NEGATION.test(claim);
  const evidenceNegated = NEGATION.test(matchingEvidenceClause(claim, quote));
  // “避免重复”与“No duplication”等跨语言同义关系交由调用方强制执行的语义审核。
  // 默认调用仍严格检查，只有具备后续独立审核的回答管线可以显式延后这一项。
  const crossLanguage = /[\u3400-\u9fff]/u.test(claim) !== /[\u3400-\u9fff]/u.test(quote);
  const semanticPolarity = deferCrossLanguagePolarity && crossLanguage && claimNegated !== evidenceNegated;
  if (claimNegated !== evidenceNegated && !isLimitation(claim) && !semanticPolarity) return { ok: false, reason: claimNegated ? '回答增加了证据中没有的否定关系' : '回答删除了证据中的否定关系', code: 'NEGATION_MISMATCH' };
  const relation = verifyRelationArguments(claim, quote);
  if (!relation.ok) return relation;
  if (!sameDirectionSequence(claim, quote)) return { ok: false, reason: '回答中的比较或变化方向与证据不一致', code: 'DIRECTION_MISMATCH' };
  return { ok: true, claimCount: 1, checkedNumbers: facts(NUMBER_WITH_UNIT, claim), checkedIdentifiers: facts(IDENTIFIER, claim), ...(semanticPolarity ? { requiresSemanticAudit: true } : {}) };
}

export function verifyGroundedItems(items, sources) {
  if (!Array.isArray(items)) return { ok: false, reason: '回答条目无效' };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const source = Number(item?.source);
    if (!Number.isInteger(source) || source < 1 || source > sources.length) return { ok: false, reason: `第 ${index + 1} 条来源编号无效` };
    const quote = normaliseForEvidence(item?.evidence);
    if (!normaliseForEvidence(sources[source - 1]?.excerpt).includes(quote)) return { ok: false, reason: `第 ${index + 1} 条证据不在课程摘录中` };
    const verified = verifyAtomicClaim(item?.text, item?.evidence);
    if (!verified.ok) return { ok: false, reason: `第 ${index + 1} 条：${verified.reason}` };
  }
  return { ok: true, itemCount: items.length };
}
