const catalog = require('../data/radiologyReportTemplates');

const normalize = (value = '') => String(value)
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\b(rt|right)\b/g, ' right ')
  .replace(/\b(lt|left)\b/g, ' left ')
  .replace(/\b(x rays|xray|x ray)\b/g, ' xray ')
  .replace(/\b(ultrasound|sonography)\b/g, ' usg ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const candidates = (template) => [template.name, template.code, template.slug, ...(template.aliases || [])]
  .map(normalize)
  .filter(Boolean);

const tokenScore = (query, candidate) => {
  const a = new Set(normalize(query).split(' ').filter(Boolean));
  const b = new Set(normalize(candidate).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return (overlap / Math.max(a.size, b.size)) * 100;
};

function listTemplates({ q = '', limit = 100 } = {}) {
  const max = Math.min(Math.max(Number(limit) || 100, 1), catalog.templates.length);
  if (!q) return catalog.templates.slice(0, max);
  const query = normalize(q);
  return catalog.templates
    .map((template) => ({ template, score: Math.max(...candidates(template).map((item) => tokenScore(query, item))) }))
    .filter((item) => item.score >= 35)
    .sort((a, b) => b.score - a.score || a.template.number - b.template.number)
    .slice(0, max)
    .map((item) => item.template);
}

function getTemplate(identifier) {
  const raw = String(identifier || '');
  const normalized = normalize(raw);
  return catalog.templates.find((template) => (
    template.id === raw || template.slug === raw || template.code === raw
    || String(template.number) === raw || candidates(template).includes(normalized)
  )) || null;
}

function matchTemplateDetailed(testName = '', testCode = '', preferredTemplateId = '') {
  if (preferredTemplateId) {
    const preferred = getTemplate(preferredTemplateId);
    if (preferred) return { template: preferred, score: 1000, confidence: 'exact', matchedOn: 'stored-template-id' };
  }
  const queries = [testName, testCode].map(normalize).filter(Boolean);
  let best = null;
  for (const template of catalog.templates) {
    const templateCandidates = candidates(template);
    for (const query of queries) {
      if (templateCandidates.includes(query)) {
        return { template, score: 1000, confidence: 'exact', matchedOn: query };
      }
      for (const candidate of templateCandidates) {
        const score = tokenScore(query, candidate);
        if (!best || score > best.score) best = { template, score, matchedOn: `${query} ~ ${candidate}` };
      }
    }
  }
  if (!best || best.score < 58) return null;
  return { ...best, confidence: best.score >= 80 ? 'high' : 'medium' };
}

module.exports = {
  catalogVersion: catalog.version,
  listTemplates,
  getTemplate,
  matchTemplateDetailed,
  matchTemplate: (...args) => matchTemplateDetailed(...args)?.template || null
};
