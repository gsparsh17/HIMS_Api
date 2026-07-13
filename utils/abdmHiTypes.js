const INTERNAL_TO_ABDM = {
  PRESCRIPTION: 'PRESCRIPTION',
  DIAGNOSTIC_REPORT: 'DIAGNOSTICREPORT',
  OP_CONSULTATION: 'OPCONSULTATION',
  DISCHARGE_SUMMARY: 'DISCHARGESUMMARY',
  IMMUNIZATION_RECORD: 'IMMUNIZATIONRECORD',
  HEALTH_DOCUMENT_RECORD: 'HEALTHDOCUMENTRECORD',
  WELLNESS_RECORD: 'WELLNESSRECORD',
  INVOICE: 'INVOICE'
};

const ALIASES = new Map();
for (const [internal, external] of Object.entries(INTERNAL_TO_ABDM)) {
  for (const value of [internal, external, external.replace(/_/g, ''), internal.replace(/_/g, '')]) {
    ALIASES.set(String(value).toUpperCase().replace(/[\s-]/g, ''), internal);
  }
}

function toInternalHiType(value) {
  const key = String(value || '').toUpperCase().replace(/[\s-]/g, '');
  return ALIASES.get(key);
}

function toAbdmHiType(value) {
  const internal = toInternalHiType(value) || value;
  return INTERNAL_TO_ABDM[internal] || String(value || '').toUpperCase();
}

function normalizeInternalHiTypes(values) {
  return Array.from(
    new Set((Array.isArray(values) ? values : []).map(toInternalHiType).filter(Boolean))
  );
}

module.exports = { INTERNAL_TO_ABDM, toInternalHiType, toAbdmHiType, normalizeInternalHiTypes };
