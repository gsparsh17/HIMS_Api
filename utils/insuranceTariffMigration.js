'use strict';

const BROAD_SPECIMEN_TYPES = new Set([
  'Blood', 'Urine', 'Stool', 'CSF', 'Sputum', 'Tissue', 'Swab',
  'Body Fluid', 'Semen', 'Other', 'Not Applicable'
]);

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeCode(value) {
  return compact(value).toUpperCase();
}

function normalizeSpecimen(value) {
  const detail = compact(value);
  if (!detail) return { specimen_type: 'Other', specimen_detail: '' };
  if (BROAD_SPECIMEN_TYPES.has(detail)) return { specimen_type: detail, specimen_detail: detail };
  const lower = detail.toLowerCase();
  let broad = 'Other';
  if (/not applicable|\bn\/a\b|none/.test(lower)) broad = 'Not Applicable';
  else if (/cerebrospinal|\bcsf\b/.test(lower)) broad = 'CSF';
  else if (/urine/.test(lower)) broad = 'Urine';
  else if (/stool|faec|fecal/.test(lower)) broad = 'Stool';
  else if (/sputum/.test(lower)) broad = 'Sputum';
  else if (/semen|seminal/.test(lower)) broad = 'Semen';
  else if (/swab/.test(lower)) broad = 'Swab';
  else if (/tissue|biopsy|bone marrow|aspirat|smear|cytology/.test(lower)) broad = 'Tissue';
  else if (/pleural|ascitic|synovial|peritoneal|pericardial|body fluid|fluid/.test(lower)) broad = 'Body Fluid';
  else if (/blood|serum|plasma|edta|citrate|capillary|dbs/.test(lower)) broad = 'Blood';
  return { specimen_type: broad, specimen_detail: detail };
}

const SMALL_CATEGORY_WORDS = new Set(['and', 'or', 'of', 'for', 'with', 'in', 'to', 'the', 'per']);
const CATEGORY_ACRONYMS = new Set([
  'ENT', 'OT', 'ICU', 'CT', 'MRI', 'PET', 'ECG', 'EEG', 'EMG', 'NCV',
  'TMT', 'OPD', 'IPD', 'IVF', 'NICU', 'PICU', 'NABL', 'NABH', 'CGHS'
]);

function normalizeCategory(value) {
  const text = compact(value);
  if (!text) return '';
  return text.split(' ').map((word, index) => {
    const punctuation = word.match(/^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/);
    const prefix = punctuation?.[1] || '';
    const core = punctuation?.[2] || word;
    const suffix = punctuation?.[3] || '';
    const upper = core.toUpperCase();
    const lower = core.toLowerCase();
    if (CATEGORY_ACRONYMS.has(upper)) return `${prefix}${upper}${suffix}`;
    if (index > 0 && SMALL_CATEGORY_WORDS.has(lower)) return `${prefix}${lower}${suffix}`;
    return `${prefix}${lower.charAt(0).toUpperCase()}${lower.slice(1)}${suffix}`;
  }).join(' ');
}

function serviceSignature(value) {
  const replacements = [
    [/\busg\b/gi, 'ultrasound'],
    [/\bx[ -]?ray(s)?\b/gi, 'xray'],
    [/\bcomputed tomography\b/gi, 'ct'],
    [/\bmagnetic resonance imaging\b/gi, 'mri'],
    [/\belectrocardiogram\b/gi, 'ecg'],
    [/\bechocardiography\b/gi, 'echo']
  ];
  let text = compact(value).toLowerCase();
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  const tokens = text
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .filter((token) => !['scan', 'study', 'test', 'imaging', 'digital', 'whole'].includes(token));
  return [...new Set(tokens)].sort().join(' ');
}

function imagingCategory(name, fallback = 'Other') {
  const text = compact(`${name} ${fallback}`).toLowerCase();
  if (/mammograph/.test(text)) return 'Mammography';
  if (/\bpet\b/.test(text)) return 'PET Scan';
  if (/dexa|bone density/.test(text)) return 'DEXA Scan';
  if (/angiograph|angiogram/.test(text)) return 'Angiography';
  if (/fluoro|c-arm/.test(text)) return 'Fluoroscopy';
  if (/\bmri\b|magnetic resonance/.test(text)) return 'MRI';
  if (/\bct\b|computed tomography/.test(text)) return 'CT Scan';
  if (/ultrasound|\busg\b|doppler/.test(text)) return 'Ultrasound';
  if (/x[ -]?ray|radiograph|\biopa\b|\bopg\b/.test(text)) return 'X-Ray';
  if (/echocardi|\becho\b/.test(text)) return 'Echocardiography';
  if (/\becg\b|electrocardi/.test(text)) return 'ECG';
  if (/\beeg\b|electroenceph/.test(text)) return 'EEG';
  if (/\bemg\b/.test(text)) return 'EMG';
  if (/\bncv\b|nerve conduction/.test(text)) return 'NCV';
  if (/\btmt\b|treadmill/.test(text)) return 'TMT';
  return 'Other';
}

function payerTypeFromLegacy(provider = {}) {
  const type = compact(provider.type).toLowerCase();
  const category = compact(provider.category).toLowerCase();
  if (type === 'tpa') return 'tpa';
  if (category === 'corporate') return 'corporate';
  if (type === 'government' || type === 'public' || category === 'government_scheme') return 'government_other';
  if (type === 'private') return 'private_insurer';
  return 'other';
}

function placeholderName(item = {}) {
  const category = compact(item.category || item.specialty || item.serviceType || 'Tariff Service');
  const code = normalizeCode(item.externalCode || 'UNKNOWN');
  return `[SOURCE NAME MISSING] ${category} (${code})`;
}

function parsePageMap(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Source page map must be a JSON object keyed by external code');
  const result = new Map();
  for (const [key, value] of Object.entries(payload)) {
    const page = typeof value === 'object' && value !== null ? value.page : value;
    const numeric = Number(page);
    if (!Number.isInteger(numeric) || numeric <= 0) throw new Error(`Invalid page for ${key}`);
    result.set(normalizeCode(key), numeric);
  }
  return result;
}

module.exports = {
  BROAD_SPECIMEN_TYPES,
  compact,
  normalizeCode,
  normalizeSpecimen,
  normalizeCategory,
  serviceSignature,
  imagingCategory,
  payerTypeFromLegacy,
  placeholderName,
  parsePageMap
};
