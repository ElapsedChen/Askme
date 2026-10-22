(function initAskmeLearningCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module?.exports) module.exports = api;
  if (root) root.AskmeLearningCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const DEFAULTS = Object.freeze({ minTokens: 220, targetTokens: 440, maxTokens: 700, overlapTokens: 60 });
  const EN_STOP = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'with', 'from', 'that', 'this', 'what', 'how', 'why', 'who', 'when', 'where', 'can', 'does', 'of', 'in', 'on', 'to', 'is', 'it', 'a', 'an', 'or', 'as', 'by', 'be']);

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${(hash >>> 0).toString(16)}:${text.length}`;
  }

  function estimateTokens(value) {
    const text = String(value || '');
    const cjk = (text.match(/[\u3400-\u9fff]/gu) || []).length;
    const latin = text.replace(/[\u3400-\u9fff]/gu, '').trim();
    return Math.max(1, cjk + Math.ceil(latin.length / 4));
  }

  function tokenize(value) {
    const text = String(value || '').toLowerCase();
    const latin = (text.match(/[a-z][a-z0-9._+-]*|\d+(?:\.\d+)?/gu) || []).filter(token => !EN_STOP.has(token));
    const cjkRuns = text.match(/[\u3400-\u9fff]+/gu) || [];
    const cjk = cjkRuns.flatMap(run => run.length <= 2 ? [run] : [run, ...Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2))]);
    return [...latin, ...cjk];
  }

  function headingLine(line) {
    const text = line.trim();
    if (!text || text.length > 140) return false;
    if (/^#{1,6}\s+\S/u.test(text) || /^(?:\d+(?:\.\d+){0,4}|[A-Z]|[IVX]+)[.)]?\s+\S/u.test(text)) return true;
    if (/^(?:week|module|lecture|topic|chapter|section|unit)\s+\d+/iu.test(text)) return true;
    if (/^(?:第[一二三四五六七八九十百\d]+[章节讲周]|定义|定理|公式|例题|总结|重点|学习目标)\b/u.test(text)) return true;
    const letters = text.match(/[A-Za-z]/g) || [];
    return letters.length >= 4 && text === text.toUpperCase() && !/[.!?。！？]$/u.test(text);
  }

  function sourceBlocks(text) {
    const source = String(text || '').replace(/\r\n?/gu, '\n');
    const blocks = [];
    let heading = '';
    const pattern = /[^\n]*(?:\n|$)/gu;
    let match;
    let paragraph = [];
    let paragraphKind = 'text';
    let paragraphStart = 0;
    const flush = end => {
      if (!paragraph.length) return;
      const rawValue = source.slice(paragraphStart, end);
      const left = rawValue.search(/\S/u);
      const trailing = rawValue.match(/\s*$/u)?.[0].length || 0;
      const right = rawValue.length - trailing;
      if (left >= 0 && right > left) blocks.push({ text: rawValue.slice(left, right), start: paragraphStart + left, end: paragraphStart + right, heading, structure: paragraphKind === 'text' ? undefined : paragraphKind });
      paragraph = [];
      paragraphKind = 'text';
    };
    while ((match = pattern.exec(source)) && match[0]) {
      const raw = match[0].replace(/\n$/u, '');
      const trimmed = raw.trim();
      const lineStart = match.index;
      if (!trimmed) { flush(lineStart); continue; }
      if (headingLine(trimmed)) {
        flush(lineStart);
        heading = trimmed.replace(/^#{1,6}\s+/u, '');
        const left = raw.search(/\S/u);
        const right = raw.length - (raw.match(/\s*$/u)?.[0].length || 0);
        blocks.push({ text: raw.slice(left, right), start: lineStart + left, end: lineStart + right, heading, isHeading: true });
        continue;
      }
      const lineKind = /^\s*(?:[-*+]|\d+[.)])\s+\S/u.test(trimmed) ? 'list' : /^\s*\|(?:[^|]*\|)+\s*$/u.test(trimmed) ? 'table' : 'text';
      if (paragraph.length && lineKind !== paragraphKind) flush(lineStart);
      if (!paragraph.length) paragraphStart = lineStart;
      paragraphKind = lineKind;
      paragraph.push(trimmed);
      if (lineKind === 'text' && (/[.!?。！？；;:]$/u.test(trimmed) || estimateTokens(paragraph.join('\n')) >= 180)) flush(lineStart + raw.length);
    }
    flush(source.length);
    return blocks;
  }

  function splitOversizeBlock(block, maxTokens) {
    if (estimateTokens(block.text) <= maxTokens) return [block];
    const source = String(block.text || '');
    const spans = [];
    let sentenceStart = 0;
    const pushSentence = end => {
      let left = sentenceStart, right = end;
      while (left < right && /\s/u.test(source[left])) left++;
      while (right > left && /\s/u.test(source[right - 1])) right--;
      if (right > left) spans.push({ start: left, end: right });
      sentenceStart = end;
    };
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      // 小数点不是句界，0.5、1.2、3.14 必须保持为同一原子文本。
      if (char === '.' && /\d/u.test(source[index - 1] || '') && /\d/u.test(source[index + 1] || '')) continue;
      if (!/[.!?。！？；;\n]/u.test(char)) continue;
      let end = index + 1;
      while (end < source.length && /[.!?。！？；;\]\)}”’]/u.test(source[end])) end++;
      pushSentence(end);
      index = end - 1;
    }
    if (sentenceStart < source.length) pushSentence(source.length);
    if (!spans.length) spans.push({ start: 0, end: source.length });
    const result = [];
    let currentStart = null;
    let currentEnd = null;
    const emit = () => {
      if (currentStart == null || currentEnd == null) return;
      result.push({ ...block, text: source.slice(currentStart, currentEnd), start: block.start + currentStart, end: block.start + currentEnd });
      currentStart = null;
      currentEnd = null;
    };
    for (const span of spans) {
      const combinedStart = currentStart == null ? span.start : currentStart;
      if (currentStart != null && estimateTokens(source.slice(combinedStart, span.end)) > maxTokens) emit();
      currentStart = currentStart == null ? span.start : currentStart;
      currentEnd = span.end;
    }
    emit();
    return result;
  }

  function structureAwareSegments(pages, courseId, options = {}) {
    const limits = { ...DEFAULTS, ...options };
    const segments = [];
    for (const page of Array.isArray(pages) ? pages : []) {
      if (String(page?.courseId) !== String(courseId) || typeof page?.text !== 'string' || !page.text.trim()) continue;
      const pageId = String(page.id || `${page.url || ''}|${page.title || ''}`);
      const artifactId = String(page.artifactId || page.fileId || pageId.replace(/#(?:page|part)=\d+.*$/u, ''));
      const blocks = sourceBlocks(page.text).flatMap(block => splitOversizeBlock(block, limits.maxTokens));
      let current = [];
      let currentTokens = 0;
      const emit = () => {
        if (!current.length) return;
        const first = current[0], last = current.at(-1);
        const text = page.text.slice(first.start, last.end);
        if (!text) { current = []; currentTokens = 0; return; }
        const headingPath = [...new Set([page.sectionGroup, page.section, ...current.map(block => block.heading)].filter(Boolean).map(String))];
        const base = `${courseId}|${pageId}|${first.start}|${last.end}|${hashText(text)}`;
        segments.push({
          id: `seg:${hashText(base)}`, key: `seg:${hashText(base)}`, courseId: String(courseId), artifactId, pageId,
          url: page.url || '', title: page.title || page.section || '课程材料', section: page.section || '', headingPath,
          charStart: first.start, charEnd: last.end, text, input: `${page.title || ''} ${headingPath.join(' > ')}\n${text}`.trim(),
          tokenCount: estimateTokens(text), sourceType: page.sourceType || 'html', partNumber: page.partNumber ?? null,
          hash: hashText(text), prevId: null, nextId: null
        });
        const overlap = [];
        let tokens = 0;
        for (let i = current.length - 1; i >= 0 && tokens < limits.overlapTokens; i--) { overlap.unshift(current[i]); tokens += estimateTokens(current[i].text); }
        current = overlap;
        currentTokens = tokens;
      };
      for (const block of blocks) {
        const blockTokens = estimateTokens(block.text);
        const wouldOverflow = current.length && currentTokens + blockTokens > limits.maxTokens;
        const naturalBreak = current.length && currentTokens >= limits.targetTokens && (block.isHeading || currentTokens >= limits.minTokens);
        if (wouldOverflow || naturalBreak) emit();
        current.push(block);
        currentTokens += blockTokens;
      }
      emit();
    }
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const previous = segments[index - 1], next = segments[index + 1];
      if (previous?.artifactId === segment.artifactId) segment.prevId = previous.id;
      if (next?.artifactId === segment.artifactId) segment.nextId = next.id;
    }
    return segments;
  }

  function bm25Search(query, segments, options = {}) {
    const docs = (Array.isArray(segments) ? segments : []).map(segment => ({ segment, tokens: tokenize(`${segment.title || ''} ${segment.headingPath?.join(' ') || ''} ${segment.text || ''}`) }));
    const queryTokens = [...new Set(tokenize(query))];
    if (!docs.length || !queryTokens.length) return [];
    const k1 = options.k1 ?? 1.2, b = options.b ?? 0.75;
    const averageLength = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length || 1;
    const documentFrequency = new Map();
    for (const doc of docs) for (const token of new Set(doc.tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    const phrase = String(query || '').trim().toLowerCase();
    return docs.map(({ segment, tokens }) => {
      const frequencies = new Map();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const tf = frequencies.get(token) || 0;
        if (!tf) continue;
        const df = documentFrequency.get(token) || 0;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * tokens.length / averageLength));
      }
      const title = `${segment.title || ''} ${segment.headingPath?.join(' ') || ''}`.toLowerCase();
      if (queryTokens.some(token => title.includes(token))) score *= 1.18;
      if (phrase.length >= 4 && segment.text?.toLowerCase().includes(phrase)) score += 2.5;
      return { ...segment, bm25Score: score, score };
    }).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, options.limit ?? 20);
  }

  // 周次属于用户明确选择的课程范围；不把孤立数字（页码、年份等）当作周次。
  function queryWeeks(value) {
    const text = String(value || '').normalize('NFKC');
    // 仅把完整、肯定的周次表达用作排除依据；不支持的列表或相对表达保留全库召回。
    if (/\b(?:not|except|excluding|without|before|after|earlier|later|previous|next|until|since|onwards?|other than)\b|不是|不含|不包括|除了|除外|以外|之外|之前|之后|以前|以后|上周|下周/iu.test(text) ||
        /\d\s*[,/、]\s*(?:and\s*)?\d|第[零一二三四五六七八九十\d]+周\s*(?:到|至|[-–—])/iu.test(text)) return [];
    const chineseNumber = value => {
      if (/^\d+$/u.test(value)) return Number(value);
      const digits = '零一二三四五六七八九';
      if (value === '十') return 10;
      if (value.includes('十')) { const [a, b] = value.split('十'); return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0); }
      return digits.indexOf(value);
    };
    const weeks = [];
    let valid = true;
    let remainder = text.replace(/\bweeks?\s*(\d{1,2})(?!\d)(?:\s*(and|&|to|[-–—])\s*(?:weeks?\s*)?(\d{1,2})(?!\d))?/giu, (match, firstValue, connector, lastValue) => {
      const first = Number(firstValue), last = lastValue === undefined ? first : Number(lastValue);
      if (first < 1 || first > 53 || last < 1 || last > 53) valid = false;
      weeks.push(first, last);
      if (/^(?:to|[-–—])$/iu.test(connector || '')) {
        if (last < first || last - first > 20) valid = false;
        else for (let week = first; week <= last; week++) weeks.push(week);
      }
      return ' ';
    });
    remainder = remainder.replace(/第\s*([零一二三四五六七八九十\d]{1,3})\s*周/gu, (match, value) => {
      const week = chineseNumber(value);
      if (!Number.isInteger(week) || week < 1 || week > 53) valid = false;
      weeks.push(week); return ' ';
    });
    // 剩余周次词、列表续项和未识别周次说明解析不完整，不采用已识别的局部范围。
    if (/\bweeks?(?=\b|\d)|第[^。！？\n]{0,30}周|[零一二三四五六七八九十\d]+\s*周|(?:\b(?:and|or|to|as well as)\b|[,&/、~–—-]|到|至|和|及|与)\s*\d/iu.test(remainder)) valid = false;
    return valid ? [...new Set(weeks)] : [];
  }

  function retrievalQuery(question, priorQuestion = '') {
    const current = String(question || '').trim();
    // 独立问题不继承上一问；只有简短、明确指代前文的追问才补充先前主题。
    const followup = current.length <= 180 && !/\bweeks?(?=\b|\d)|第[^。！？\n]{0,30}周/iu.test(current) &&
      /^(?:请\s*)?(?:那么[，,\s]*)?(?:这个|那个|上述|刚才|它们|它|这些|那些|前面提到|继续解释|再举个例子)|\b(?:it|its|they|them|those|these|that concept|the above|another example)\b/iu.test(current);
    return { query: followup && priorQuestion ? `${current}\n${String(priorQuestion).slice(0, 1500)}` : current, usesHistory: !!(followup && priorQuestion) };
  }

  function retrievalScope(query, segments) {
    const weeks = queryWeeks(query);
    return (segments || []).filter(segment => {
      if (!weeks.length) return true;
      // 只在正文的周次标题行补充缺少的元数据，正文偶然提到别的周次不改变归属。
      const headings = String(segment.text || '').split('\n').filter(line => /^\s*(?:#{1,6}\s*)?(?:weeks?\s*\d|第\s*[零一二三四五六七八九十\d]+\s*周)/iu.test(line)).join('\n');
      const metadata = [segment.section, ...(segment.headingPath || []), segment.title].filter(Boolean);
      const parsed = metadata.map(value => ({ value: String(value), weeks: queryWeeks(value) }));
      // 文件所在周与标题回顾周都可能相关；元数据不完整时不据此排除。
      const actual = [...new Set(parsed.flatMap(item => item.weeks))];
      // 标题末尾的分页编号可能无法解析；已有明确周次时不能因此绕过范围判断。
      if (!actual.length && parsed.some(item => !item.weeks.length && /\bweeks?(?=\b|\d)|第[^。！？\n]{0,30}周/iu.test(item.value))) return true;
      const known = actual.length ? actual : queryWeeks(headings);
      return !known.length || known.some(week => weeks.includes(week));
    });
  }

  function scopedSearch(query, segments, options = {}) {
    // 范围内继续使用已有 BM25，不增加模型调用或特定题目的答案提示。
    return bm25Search(query, retrievalScope(options.scopeQuery ?? query, segments), options);
  }

  function focusedExcerpt(value, query, maxChars) {
    const text = String(value || '');
    if (text.length <= maxChars || !query) return text.slice(0, maxChars);
    const lower = text.toLowerCase();
    const terms = [...new Set(tokenize(query))].filter(term => term.length >= 2 && !/^\d+$/u.test(term) && !/^weeks?$/u.test(term)).slice(0, 64);
    const starts = new Set([0]);
    for (const term of terms) {
      let offset = 0, count = 0;
      while (count++ < 100) {
        const at = lower.indexOf(term, offset);
        if (at < 0) break;
        starts.add(Math.max(0, Math.min(text.length - maxChars, at - 180)));
        offset = at + term.length;
      }
    }
    let bestStart = 0, bestScore = -1;
    for (const start of starts) {
      const window = lower.slice(start, start + maxChars);
      const score = terms.reduce((sum, term) => sum + (window.includes(term) ? Math.min(4, term.length) : 0), 0);
      if (score > bestScore) { bestStart = start; bestScore = score; }
    }
    // 保留原文连续切片，避免生成模型编写的检索摘要充当证据。
    return text.slice(bestStart, bestStart + maxChars);
  }

  function reciprocalRankFusion(rankings, options = {}) {
    const k = options.k ?? 60;
    const weights = options.weights || [];
    const byId = new Map();
    rankings.forEach((ranking, rankingIndex) => {
      const weight = Number.isFinite(weights[rankingIndex]) ? weights[rankingIndex] : 1;
      (ranking || []).forEach((item, rank) => {
        const id = item?.id || item?.key;
        if (!id) return;
        const current = byId.get(id) || { ...item, rrfScore: 0, matchedRankings: [] };
        current.rrfScore += weight / (k + rank + 1);
        current.matchedRankings.push({ ranking: rankingIndex, rank: rank + 1 });
        byId.set(id, current);
      });
    });
    return [...byId.values()].sort((left, right) => right.rrfScore - left.rrfScore || String(left.id).localeCompare(String(right.id))).slice(0, options.limit ?? 30);
  }

  function tokenSimilarity(left, right) {
    const a = new Set(tokenize(left)), b = new Set(tokenize(right));
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection++;
    return intersection / (a.size + b.size - intersection);
  }

  function diversifyCandidates(candidates, options = {}) {
    const limit = options.limit ?? 8, lambda = options.lambda ?? 0.78;
    const remaining = [...(candidates || [])], selected = [];
    const relevance = item => Number(item.rerankScore ?? item.rrfScore ?? item.semanticScore ?? item.bm25Score ?? item.score ?? 0);
    const max = Math.max(...remaining.map(relevance), 1e-9);
    while (remaining.length && selected.length < limit) {
      let bestIndex = 0, bestScore = -Infinity;
      for (let index = 0; index < remaining.length; index++) {
        const candidate = remaining[index];
        const duplicate = selected.some(item => item.id === candidate.id);
        if (duplicate) continue;
        const similarity = selected.length ? Math.max(...selected.map(item => tokenSimilarity(candidate.text, item.text))) : 0;
        const sameArtifactPenalty = selected.filter(item => item.artifactId === candidate.artifactId).length * 0.08;
        const mmr = lambda * (relevance(candidate) / max) - (1 - lambda) * similarity - sameArtifactPenalty;
        if (mmr > bestScore) { bestScore = mmr; bestIndex = index; }
      }
      selected.push(remaining.splice(bestIndex, 1)[0]);
    }
    return selected;
  }

  function expandNeighbors(selected, allSegments, options = {}) {
    const byId = new Map((allSegments || []).map(item => [item.id, item]));
    const output = [], seen = new Set();
    const add = (item, relation) => {
      if (!item || seen.has(item.id)) return;
      seen.add(item.id); output.push({ ...item, relation });
    };
    for (const item of selected || []) {
      if (options.before !== false) add(byId.get(item.prevId), 'previous');
      add(item, 'match');
      if (options.after !== false) add(byId.get(item.nextId), 'next');
    }
    return output.slice(0, options.limit ?? 12);
  }

  function contextualizeCandidates(selected, allSegments, options = {}) {
    const byId = new Map((allSegments || []).map(item => [item.id, item]));
    const maxChars = Math.max(300, Math.min(1400, options.maxChars ?? 1200));
    const sideChars = Math.max(0, Math.min(350, options.sideChars ?? 220));
    return (selected || []).map(item => {
      const previous = byId.get(item.prevId), next = byId.get(item.nextId);
      const samePage = candidate => candidate && candidate.artifactId === item.artifactId && candidate.pageId === item.pageId;
      const before = samePage(previous) ? String(previous.text || '').slice(-sideChars) : '';
      const after = samePage(next) ? String(next.text || '').slice(0, sideChars) : '';
      const current = String(item.excerpt || item.text || '');
      const decorated = [before && `上文：${before}`, `命中内容：${current}`, after && `下文：${after}`].filter(Boolean).join('\n\n');
      return {
        ...item,
        excerpt: decorated.length <= maxChars ? decorated : `命中内容：${focusedExcerpt(current, options.query, maxChars - 5)}`,
        contextSegmentIds: [samePage(previous) && previous.id, item.id, samePage(next) && next.id].filter(Boolean)
      };
    });
  }

  function classifyQuery(query) {
    const text = String(query || '').toLowerCase();
    if (/(compare|difference|versus|vs\.?|比较|区别|异同)/u.test(text)) return 'compare';
    if (/(calculate|derive|equation|formula|单位|公式|推导|计算)/u.test(text)) return 'formula';
    if (/(steps?|procedure|workflow|how to|步骤|流程|怎么做)/u.test(text)) return 'procedure';
    if (/(exam|quiz|assessment|test|考试|测验|考核|复习)/u.test(text)) return 'assessment-prep';
    if (/(why|explain|mechanism|为什么|解释|原理|机制)/u.test(text)) return 'explain';
    if (/(summar|overview|relationship|总结|概括|联系|综合)/u.test(text)) return 'synthesis';
    return 'fact';
  }

  function promptSuggestions(context = {}) {
    const title = String(context.title || context.concept || '').trim();
    const hasFormula = !!context.hasFormula;
    const hasComparison = Array.isArray(context.relatedConcepts) && context.relatedConcepts.length >= 2;
    const mode = context.mode || 'ask';
    const suggestions = [];
    if (mode === 'summary') suggestions.push('核对这份提炼是否遗漏了适用条件或例外');
    else if (mode === 'practice') suggestions.push('针对刚才的错误，再出一道不同情境的迁移题');
    else suggestions.push(title ? `用一句话解释“${title}”，再给出课程原文依据` : '提炼当前材料的核心概念、条件与相互关系');
    if (hasFormula) suggestions.push('逐项解释公式变量、单位、适用条件和常见误用');
    if (hasComparison) suggestions.push(`比较 ${context.relatedConcepts.slice(0, 2).join(' 与 ')}，说明各自适用场景`);
    suggestions.push(context.assessmentObjective ? `围绕“${context.assessmentObjective}”生成一道需要迁移应用的练习` : '根据当前证据生成一道能检查真正理解的应用题');
    suggestions.push('指出现有材料无法确认、需要回到 Moodle 核对的部分');
    return [...new Set(suggestions)].slice(0, 3);
  }

  return { DEFAULTS, hashText, estimateTokens, tokenize, splitOversizeBlock, structureAwareSegments, bm25Search, queryWeeks, retrievalQuery, retrievalScope, scopedSearch, focusedExcerpt, reciprocalRankFusion, diversifyCandidates, expandNeighbors, contextualizeCandidates, classifyQuery, promptSuggestions };
});
