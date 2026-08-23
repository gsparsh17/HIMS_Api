function exchangeEligibility(patient) {
  const status = String(patient?.abha?.status || '').toUpperCase();
  const reconciliation = String(
    patient?.abha?.identityReconciliation?.status || 'NOT_CHECKED'
  ).toUpperCase();
  const hasIdentity = Boolean(patient?.abha?.number || patient?.abha?.address);
  const blockedLifecycle = new Set(['LOCAL_ASSOCIATION_RETIRED', 'DEACTIVATED', 'DELETED', 'ABHA_DEACTIVATED', 'ABHA_DELETED']);
  if (blockedLifecycle.has(status)) {
    return {
      eligible: false,
      code: 'ABHA_IDENTITY_INACTIVE',
      reason: 'The local ABHA association is retired, deactivated, or deleted and cannot be used for new exchange'
    };
  }

  if (!['VERIFIED', 'VERIFIED_ACTIVE', 'ACTIVE'].includes(status) || !patient?.abha?.kycVerified || !hasIdentity) {
    return {
      eligible: false,
      code: 'ABHA_NOT_VERIFIED',
      reason: 'Patient does not have a verified ABDM identity'
    };
  }
  if (reconciliation !== 'MATCHED') {
    return {
      eligible: false,
      code:
        reconciliation === 'MISMATCH'
          ? 'ABHA_IDENTITY_MISMATCH'
          : 'ABHA_IDENTITY_RECONCILIATION_REQUIRED',
      reason:
        reconciliation === 'MISMATCH'
          ? 'The ABDM profile does not match the selected local patient'
          : 'The verified ABDM profile has not been reconciled with the local patient'
    };
  }
  return { eligible: true, code: null, reason: null };
}

function assertAbdmExchangeEligible(patient) {
  const result = exchangeEligibility(patient);
  if (!result.eligible) {
    const error = new Error(result.reason);
    error.statusCode = 409;
    error.code = result.code;
    error.details = {
      abhaStatus: patient?.abha?.status || null,
      reconciliationStatus:
        patient?.abha?.identityReconciliation?.status || 'NOT_CHECKED'
    };
    throw error;
  }
  return result;
}

module.exports = { exchangeEligibility, assertAbdmExchangeEligible };
