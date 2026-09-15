const FINANCIAL_PROCEED_STATES = Object.freeze(['CLEARED', 'POSTPAID_ALLOWED', 'EXCEPTION_APPROVED']);

function normalizedServiceDomain(procedure = {}) {
  return String(procedure?.serviceDomain || procedure?.procedureId?.serviceDomain || '').trim().toLowerCase() || 'procedure';
}

function requiresOtWorkflow(procedure = {}) {
  return normalizedServiceDomain(procedure) === 'surgery';
}

function financialCanProceed(state) {
  return FINANCIAL_PROCEED_STATES.includes(String(state || '').trim().toUpperCase());
}

function executionLane(procedure = {}) {
  return requiresOtWorkflow(procedure) ? 'OT' : 'CLINICAL_SERVICES';
}

module.exports = {
  FINANCIAL_PROCEED_STATES,
  normalizedServiceDomain,
  requiresOtWorkflow,
  financialCanProceed,
  executionLane,
};
