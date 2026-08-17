const INTERNAL_TO_ABDM = {
  PRESCRIPTION: 'Prescription',
  DIAGNOSTIC_REPORT: 'DiagnosticReport',
  OP_CONSULTATION: 'OPConsultation',
  DISCHARGE_SUMMARY: 'DischargeSummary',
  IMMUNIZATION_RECORD: 'ImmunizationRecord',
  HEALTH_DOCUMENT_RECORD: 'HealthDocumentRecord',
  WELLNESS_RECORD: 'WellnessRecord',
  INVOICE: 'Invoice'
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
  return INTERNAL_TO_ABDM[internal] || String(value || '');
}

function normalizeInternalHiTypes(values) {
  return Array.from(
    new Set((Array.isArray(values) ? values : []).map(toInternalHiType).filter(Boolean))
  );
}

module.exports = { INTERNAL_TO_ABDM, toInternalHiType, toAbdmHiType, normalizeInternalHiTypes };
