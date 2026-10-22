import fs from 'node:fs';

const asArray = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value))];
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function evidenceGroups(item) {
  return asArray(item.evidenceGroups).map((group, index) => ({
    id: String(group.id || `evidence-${index + 1}`),
    ids: unique(asArray(group.ids)),
    gain: Math.max(0, finite(group.gain || 1)),
    required: group.required !== false,
    versionHash: typeof group.versionHash === 'string' ? group.versionHash : null
  })).filter(group => group.ids.length);
}

function relevantIds(item) {
  return new Set(evidenceGroups(item).flatMap(group => group.ids));
}

function requiredGroups(item) {
  return evidenceGroups(item).filter(group => group.required);
}

function factMap(item) {
  return new Map(asArray(item.requiredFacts).map(fact => [String(fact.id), {
    ...fact,
    evidenceIds: unique(asArray(fact.evidenceIds))
  }]));
}

function safeDivide(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function groupHit(group, ids) {
  return group.ids.some(id => ids.has(id));
}

export function validateDataset(dataset) {
  const errors = [];
  if (!dataset || dataset.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (!Array.isArray(dataset?.items) || !dataset.items.length) errors.push('items 必须是非空数组');
  const seen = new Set();
  for (const [index, item] of asArray(dataset?.items).entries()) {
    const at = `items[${index}]`;
    if (!item?.id) errors.push(`${at}.id 缺失`);
    else if (seen.has(String(item.id))) errors.push(`${at}.id 重复: ${item.id}`);
    else seen.add(String(item.id));
    if (!['qa', 'summary'].includes(item?.type)) errors.push(`${at}.type 必须是 qa 或 summary`);
    if (!['answerable', 'unanswerable'].includes(item?.answerability)) errors.push(`${at}.answerability 无效`);
    if (item?.answerability === 'answerable' && !evidenceGroups(item).length) errors.push(`${at} 缺少 evidenceGroups`);
    for (const group of evidenceGroups(item)) {
      if (!group.ids.length) errors.push(`${at}.${group.id} 没有 span id`);
    }
    const factIds = new Set();
    for (const fact of asArray(item?.requiredFacts)) {
      if (!fact?.id) errors.push(`${at}.requiredFacts 存在缺失 id 的事实`);
      else if (factIds.has(String(fact.id))) errors.push(`${at}.requiredFacts 重复 id: ${fact.id}`);
      else factIds.add(String(fact.id));
      if (!asArray(fact?.evidenceIds).length) errors.push(`${at}.requiredFacts.${fact?.id || '?'} 缺少 evidenceIds`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRun(dataset, run) {
  const datasetIds = new Set(asArray(dataset?.items).map(item => String(item.id)));
  const errors = [];
  const seen = new Set();
  for (const [index, result] of asArray(run?.items).entries()) {
    const id = String(result?.id || '');
    if (!id) errors.push(`run.items[${index}].id 缺失`);
    else if (!datasetIds.has(id)) errors.push(`run 包含未知项目: ${id}`);
    else if (seen.has(id)) errors.push(`run 项目重复: ${id}`);
    seen.add(id);
  }
  for (const id of datasetIds) if (!seen.has(id)) errors.push(`run 缺少项目: ${id}`);
  return { valid: errors.length === 0, errors };
}

export function scoreRetrieval(item, result, cutoffs = [5, 20]) {
  const retrieved = unique(asArray(result?.retrievedEvidenceIds));
  const groups = requiredGroups(item);
  const relevant = relevantIds(item);
  const recalls = {};
  for (const cutoff of cutoffs) {
    const ids = new Set(retrieved.slice(0, cutoff));
    recalls[`recallAt${cutoff}`] = safeDivide(groups.filter(group => groupHit(group, ids)).length, groups.length);
  }
  const firstRelevant = retrieved.findIndex(id => relevant.has(id));
  const mrr = firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0;

  const groupById = new Map();
  for (const group of evidenceGroups(item)) {
    for (const id of group.ids) {
      const previous = groupById.get(id);
      if (!previous || group.gain > previous.gain) groupById.set(id, group);
    }
  }
  const creditedGroups = new Set();
  const gains = [];
  for (const id of retrieved) {
    const group = groupById.get(id);
    if (group && creditedGroups.has(group.id)) continue;
    if (group) creditedGroups.add(group.id);
    gains.push(group?.gain || 0);
    if (gains.length >= 10) break;
  }
  const dcg = gains.reduce((sum, gain, index) => sum + ((2 ** gain) - 1) / Math.log2(index + 2), 0);
  const ideal = evidenceGroups(item).map(group => group.gain).sort((a, b) => b - a).slice(0, 10);
  const idcg = ideal.reduce((sum, gain, index) => sum + ((2 ** gain) - 1) / Math.log2(index + 2), 0);
  return { ...recalls, mrr: round(mrr), ndcgAt10: round(safeDivide(dcg, idcg)) };
}

function claimVerdict(claim, facts) {
  if (['supported', 'unsupported', 'contradicted'].includes(claim?.adjudication)) return claim.adjudication;
  const fact = facts.get(String(claim?.factId || ''));
  if (!fact) return 'unsupported';
  const citations = new Set(unique(asArray(claim?.citationIds)));
  return fact.evidenceIds.some(id => citations.has(id)) ? 'supported' : 'unsupported';
}

export function scoreAnswer(item, result) {
  const expected = relevantIds(item);
  const citations = unique(asArray(result?.citationIds).concat(asArray(result?.claims).flatMap(claim => asArray(claim?.citationIds))));
  const citationPrecision = safeDivide(citations.filter(id => expected.has(id)).length, citations.length);
  const cited = new Set(citations);
  const groups = requiredGroups(item);
  const necessaryCitationRecall = safeDivide(groups.filter(group => groupHit(group, cited)).length, groups.length);
  const facts = factMap(item);
  const claims = asArray(result?.claims);
  const verdicts = claims.map(claim => claimVerdict(claim, facts));
  const claimFaithfulness = safeDivide(verdicts.filter(value => value === 'supported').length, verdicts.length);
  const unanswerable = item.answerability === 'unanswerable';
  const correctRefusal = unanswerable ? result?.refused === true : null;
  return {
    citationPrecision: round(citationPrecision),
    necessaryCitationRecall: round(necessaryCitationRecall),
    claimFaithfulness: round(claimFaithfulness),
    supportedClaims: verdicts.filter(value => value === 'supported').length,
    unsupportedClaims: verdicts.filter(value => value === 'unsupported').length,
    contradictedClaims: verdicts.filter(value => value === 'contradicted').length,
    correctRefusal
  };
}

export function scoreSummary(item, result) {
  if (item.type !== 'summary') return null;
  const facts = factMap(item);
  const claims = asArray(result?.claims);
  const claimedFactIds = new Set(claims.map(claim => String(claim?.factId || '')).filter(Boolean));
  const keyFactRecall = safeDivide([...facts.keys()].filter(id => claimedFactIds.has(id)).length, facts.size);
  const verdicts = claims.map(claim => claimVerdict(claim, facts));
  const factConsistency = safeDivide(verdicts.filter(value => value === 'supported').length, verdicts.length);
  return {
    keyFactRecall: round(keyFactRecall),
    factConsistency: round(factConsistency),
    hallucinatedOrUnsupported: verdicts.filter(value => value === 'unsupported').length,
    contradicted: verdicts.filter(value => value === 'contradicted').length
  };
}

export function checkEvidenceVersions(dataset, catalog) {
  const catalogHashes = new Map(asArray(catalog?.entries).map(entry => [String(entry.id), entry.versionHash || null]));
  const stale = [];
  const missing = [];
  for (const item of asArray(dataset?.items)) {
    for (const group of evidenceGroups(item)) {
      for (const id of group.ids) {
        if (!catalogHashes.has(id)) missing.push({ itemId: item.id, evidenceId: id });
        else if (group.versionHash && catalogHashes.get(id) !== group.versionHash) {
          stale.push({ itemId: item.id, evidenceId: id, expected: group.versionHash, actual: catalogHashes.get(id) });
        }
      }
    }
  }
  return { valid: !stale.length && !missing.length, stale, missing };
}

export function evaluate(dataset, run, options = {}) {
  const datasetValidation = validateDataset(dataset);
  const runValidation = validateRun(dataset, run);
  if (!datasetValidation.valid || !runValidation.valid) {
    throw new Error([...datasetValidation.errors, ...runValidation.errors].join('\n'));
  }
  const byId = new Map(run.items.map(item => [String(item.id), item]));
  const rows = dataset.items.map(item => {
    const result = byId.get(String(item.id));
    return {
      id: item.id,
      type: item.type,
      risk: item.risk || 'standard',
      language: item.language || 'unspecified',
      retrieval: item.answerability === 'answerable' ? scoreRetrieval(item, result, options.cutoffs) : null,
      answer: scoreAnswer(item, result),
      summary: scoreSummary(item, result)
    };
  });
  const answerableRows = rows.filter(row => row.retrieval);
  const answerRows = rows.filter(row => row.answer.claimFaithfulness !== null || row.answer.citationPrecision !== null);
  const summaryRows = rows.filter(row => row.summary);
  const refusalRows = rows.filter(row => row.answer.correctRefusal !== null);
  const aggregate = {
    items: rows.length,
    retrieval: {
      recallAt5: round(mean(answerableRows.map(row => row.retrieval.recallAt5))),
      recallAt20: round(mean(answerableRows.map(row => row.retrieval.recallAt20))),
      mrr: round(mean(answerableRows.map(row => row.retrieval.mrr))),
      ndcgAt10: round(mean(answerableRows.map(row => row.retrieval.ndcgAt10)))
    },
    answer: {
      claimFaithfulness: round(mean(answerRows.map(row => row.answer.claimFaithfulness))),
      citationPrecision: round(mean(answerRows.map(row => row.answer.citationPrecision))),
      necessaryCitationRecall: round(mean(answerRows.map(row => row.answer.necessaryCitationRecall))),
      correctRefusalRate: round(mean(refusalRows.map(row => row.answer.correctRefusal ? 1 : 0)))
    },
    summary: {
      keyFactRecall: round(mean(summaryRows.map(row => row.summary.keyFactRecall))),
      factConsistency: round(mean(summaryRows.map(row => row.summary.factConsistency))),
      hallucinatedOrUnsupported: summaryRows.reduce((sum, row) => sum + row.summary.hallucinatedOrUnsupported, 0),
      contradicted: summaryRows.reduce((sum, row) => sum + row.summary.contradicted, 0)
    }
  };
  const versionCheck = options.catalog ? checkEvidenceVersions(dataset, options.catalog) : null;
  return { schemaVersion: 1, datasetId: dataset.datasetId || null, generatedAt: new Date().toISOString(), aggregate, versionCheck, items: rows };
}

function locateCorpusEntries(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['segments', 'chunks', 'entries', 'pages']) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

export function createLocalCatalog(indexExport, { includeText = false } = {}) {
  const entries = locateCorpusEntries(indexExport).map((entry, index) => {
    const id = String(entry.id || entry.segmentId || entry.chunkId || entry.pageId || `entry-${index + 1}`);
    const text = typeof entry.text === 'string' ? entry.text : '';
    const value = {
      id,
      artifactId: entry.artifactId || entry.pageId || null,
      title: entry.title || null,
      headingPath: asArray(entry.headingPath),
      page: entry.page ?? null,
      slide: entry.slide ?? null,
      versionHash: entry.versionHash || entry.hash || null,
      characterCount: text.length
    };
    if (includeText) value.text = text;
    return value;
  });
  return { schemaVersion: 1, localOnly: true, includesSourceText: includeText, entries };
}

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}
