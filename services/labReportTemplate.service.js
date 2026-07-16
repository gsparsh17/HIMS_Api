const catalog = require('../data/labReportTemplates.json');
const aliasCatalog = require('../data/labReportTemplateAliases.json');

const GENERIC_WORDS = new Set([
  'test', 'tests', 'report', 'reports', 'assay', 'assays', 'estimation',
  'examination', 'screen', 'screening', 'laboratory', 'lab'
]);

const TOKEN_REPLACEMENTS = new Map([
  ['haemoglobin', 'hemoglobin'],
  ['haematocrit', 'hematocrit'],
  ['leucocyte', 'leukocyte'],
  ['leucocytes', 'leukocytes'],
  ['glycosylated', 'glycated'],
  ['faecal', 'fecal'],
  ['foetal', 'fetal'],
  ['tumour', 'tumor'],
  ['cpk', 'ck'],
  ['rheumatoid', 'rheumatoid']
]);

const normalizeText = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[–—]/g, '-')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

function normalizeLabTestName(value = '', { removeGenericWords = true } = {}) {
  const tokens = normalizeText(value)
    .split(' ')
    .filter(Boolean)
    .map((token) => TOKEN_REPLACEMENTS.get(token) || token)
    .filter((token) => !removeGenericWords || !GENERIC_WORDS.has(token));
  return tokens.join(' ');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildNameVariants(value = '', { allowStandaloneAcronym = true } = {}) {
  const text = String(value || '').trim();
  if (!text) return [];

  const variants = [
    normalizeLabTestName(text),
    normalizeLabTestName(text, { removeGenericWords: false })
  ];

  const withoutParentheses = text.replace(/\([^)]*\)/g, ' ');
  variants.push(normalizeLabTestName(withoutParentheses));

  const parentheses = [...text.matchAll(/\(([^)]+)\)/g)].map((match) => match[1].trim());
  const lastClose = text.lastIndexOf(')');
  const hasTrailingQualifier = lastClose >= 0 && text.slice(lastClose + 1).trim().length > 0;
  if (allowStandaloneAcronym && !hasTrailingQualifier) {
    for (const item of parentheses) {
      const letters = item.replace(/[^A-Za-z]/g, '');
      if (letters && letters.length <= 10 && letters === letters.toUpperCase()) {
        variants.push(normalizeLabTestName(item));
      }
    }
  }

  return unique(variants);
}

function templateAliases(template) {
  return unique([
    ...(template.aliases || []),
    ...(aliasCatalog.aliases?.[template.id] || [])
  ]);
}

function templateCandidates(template) {
  const names = [
    template.name,
    template.slug,
    ...templateAliases(template),
  ];

  return unique(names.flatMap((name) => buildNameVariants(name, {
    allowStandaloneAcronym: name === template.name
      ? !/\)\s+(with|and|plus|including)\b/i.test(name)
      : true
  })));
}

function queryCandidates(testName = '', testCode = '') {
  return unique([
    ...buildNameVariants(testName),
    ...buildNameVariants(testCode),
    ...buildNameVariants(`${testName} ${testCode}`)
  ]);
}

function tokenSet(value) {
  return new Set(normalizeLabTestName(value).split(' ').filter(Boolean));
}

function hasConflictingContext(queryTokens, candidateTokens) {
  const contexts = ['urine', 'stool', 'fecal', 'blood', 'serum', 'plasma', 'csf', 'sputum', 'tissue'];
  const queryContext = contexts.filter((token) => queryTokens.has(token));
  const candidateContext = contexts.filter((token) => candidateTokens.has(token));
  return queryContext.length > 0
    && candidateContext.length > 0
    && !queryContext.some((token) => candidateTokens.has(token));
}

function fuzzyScore(query, candidate) {
  const queryTokens = tokenSet(query);
  const candidateTokens = tokenSet(candidate);
  if (!queryTokens.size || !candidateTokens.size || hasConflictingContext(queryTokens, candidateTokens)) return 0;

  const overlap = [...queryTokens].filter((token) => candidateTokens.has(token)).length;
  if (overlap < 2) return 0;

  const union = new Set([...queryTokens, ...candidateTokens]).size;
  const queryCoverage = overlap / queryTokens.size;
  const candidateCoverage = overlap / candidateTokens.size;
  if (queryCoverage < 0.67 || candidateCoverage < 0.5) return 0;

  const jaccard = overlap / union;
  return Math.round(500 * ((0.45 * jaccard) + (0.3 * queryCoverage) + (0.25 * candidateCoverage)));
}

function scoreTemplate(template, testName = '', testCode = '', preferredTemplateId = '') {
  if (preferredTemplateId && template.id === preferredTemplateId) {
    return { score: 2000, confidence: 'exact', matchedOn: 'stored-template-id' };
  }

  const queries = queryCandidates(testName, testCode);
  if (!queries.length) return { score: 0, confidence: 'none', matchedOn: '' };

  const candidates = templateCandidates(template);
  for (const query of queries) {
    if (candidates.includes(query)) {
      return { score: 1000, confidence: 'exact', matchedOn: query };
    }
  }

  let best = 0;
  let matchedOn = '';
  for (const query of queries) {
    for (const candidate of candidates) {
      const score = fuzzyScore(query, candidate);
      if (score > best) {
        best = score;
        matchedOn = `${query} ~ ${candidate}`;
      }
    }
  }

  return {
    score: best,
    confidence: best >= 430 ? 'high' : best >= 400 ? 'medium' : 'low',
    matchedOn
  };
}

function listTemplates({ q = '', limit = 105 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 105, 1), 105);
  const templates = catalog.templates.map((template) => ({
    ...template,
    aliases: templateAliases(template)
  }));

  if (!q) return templates.slice(0, max);
  return templates
    .map((template) => ({ template, match: scoreTemplate(template, q, '') }))
    .filter(({ match }) => match.score >= 300)
    .sort((a, b) => b.match.score - a.match.score || a.template.number - b.template.number)
    .slice(0, max)
    .map(({ template }) => template);
}

function getTemplate(identifier) {
  if (!identifier) return null;
  const rawIdentifier = String(identifier);
  const normalized = normalizeLabTestName(rawIdentifier);

  const template = catalog.templates.find((item) => (
    item.id === rawIdentifier
    || item.slug === rawIdentifier
    || String(item.number) === rawIdentifier
    || templateCandidates(item).includes(normalized)
  ));

  return template ? { ...template, aliases: templateAliases(template) } : null;
}

function matchTemplateDetailed(testName, testCode, preferredTemplateId = '') {
  const matches = catalog.templates
    .map((template) => ({
      template,
      ...scoreTemplate(template, testName, testCode, preferredTemplateId)
    }))
    .sort((a, b) => b.score - a.score || a.template.number - b.template.number);

  const best = matches[0];
  const second = matches[1];
  if (!best || best.score < 430) return null;
  if (best.score < 1000 && second && (best.score - second.score) < 35) return null;

  return {
    template: { ...best.template, aliases: templateAliases(best.template) },
    score: best.score,
    confidence: best.confidence,
    matchedOn: best.matchedOn
  };
}

function matchTemplate(testName, testCode, preferredTemplateId = '') {
  return matchTemplateDetailed(testName, testCode, preferredTemplateId)?.template || null;
}

module.exports = {
  catalogVersion: catalog.version,
  normalizeLabTestName,
  listTemplates,
  getTemplate,
  matchTemplate,
  matchTemplateDetailed,
  scoreTemplate
};
