
'use strict';

const { activeCoverage, activeAppointmentCoverage } = require('./coverage.service');
const {
  getPatientCoveragePreference,
  resolveDeclaredCoveragePreference,
  rememberDeclaredPreference
} = require('./patientCoveragePreference.service');

function toContext(source, origin = 'LAST_USED') {
  if (!source) return null;
  const payer = source.payerId?.toObject?.() || source.payerId;
  const beneficiary = source.beneficiary?.toObject?.() || source.beneficiary || {};
  const category = payer?.type || source.payerCategory || 'self';
  return {
    coverageId: source._id || source.coverageId || undefined,
    payerId: payer?._id || source.payerId || undefined,
    payerCategory: category,
    payerName: payer?.name || source.payerName || (category === 'self' ? 'Self / Cash' : undefined),
    policyNumber: beneficiary.policyNumber || undefined,
    memberId: beneficiary.memberId || undefined,
    beneficiaryId: beneficiary.beneficiaryId || undefined,
    schemeCardNumber: beneficiary.schemeCardNumber || undefined,
    validTo: beneficiary.validTo || undefined,
    preAuthStatus: source.preAuthorisation?.status || source.preAuthStatus || undefined,
    source: origin
  };
}

async function resolveRequestPayerContext({
  hospitalId,
  patientId,
  sourceType,
  admissionId,
  appointmentId,
  declaredCoverage,
  userId,
  rememberSource = 'OTHER'
}) {
  // Explicit staff selection always wins for this service request. This allows
  // a patient to use a different payer for a particular service without
  // rewriting registration identity or a previous encounter's coverage.
  if (declaredCoverage && (declaredCoverage.payerId || declaredCoverage.payerCategory)) {
    const resolved = await resolveDeclaredCoveragePreference({ hospitalId, coverage: declaredCoverage });
    return toContext({ ...resolved, payerId: resolved.payer || resolved.payerId }, 'EXPLICIT');
  }

  const normalized = String(sourceType || '').toUpperCase();
  if (normalized === 'IPD' && admissionId) {
    const coverage = await activeCoverage(hospitalId, admissionId);
    if (coverage) return toContext(coverage, 'ENCOUNTER_COVERAGE');
  }
  if (normalized === 'OPD' && appointmentId) {
    const coverage = await activeAppointmentCoverage(hospitalId, appointmentId);
    if (coverage) return toContext(coverage, 'ENCOUNTER_COVERAGE');
  }

  // Walk-in and other standalone services use the patient's last confirmed
  // payer as a suggestion/snapshot. It remains editable by the caller.
  const preference = await getPatientCoveragePreference({ hospitalId, patientId });
  if (preference?.payerCategory && preference.payerCategory !== 'self') {
    const empanelmentInvalid = preference.empanelmentStatus && preference.empanelmentStatus !== 'active';
    if (preference.payerActive === false || preference.expired || empanelmentInvalid) {
      // A historical payer may still be shown by the UI as a suggestion, but
      // a background/direct service request must not silently treat stale
      // coverage as current encounter coverage.
      return null;
    }
  }
  return toContext(preference, 'LAST_USED');
}

async function rememberRequestPayerContextUsage({
  hospitalId,
  patientId,
  payerContext,
  source = 'OTHER',
  encounterId,
  userId,
  usedAt = new Date()
}) {
  if (!payerContext) return null;
  return rememberDeclaredPreference({
    hospitalId,
    patientId,
    payerId: payerContext.payerId,
    payerCategory: payerContext.payerCategory || 'self',
    payerName: payerContext.payerName,
    beneficiary: {
      policyNumber: payerContext.policyNumber,
      memberId: payerContext.memberId,
      beneficiaryId: payerContext.beneficiaryId,
      schemeCardNumber: payerContext.schemeCardNumber,
      validTo: payerContext.validTo
    },
    source,
    encounterId,
    coverageId: payerContext.coverageId,
    userId,
    usedAt,
    updateLegacyPatientFields: false
  });
}

module.exports = {
  resolveRequestPayerContext,
  rememberRequestPayerContextUsage,
  toContext
};
