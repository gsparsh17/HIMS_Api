const { requestHospitalId } = require('../utils/hospitalScope');
const featureFlags = require('../services/financeFeatureFlag.service');

function hasIpdContext(req) {
  const body = req.body || {};
  return Boolean(body.admissionId || body.admission_id || body.ipdAdmissionId || body.ipd_admission_id || body.encounterType === 'IPD');
}

async function blockLegacyIpdDirectBilling(req, res, next) {
  try {
    if (!hasIpdContext(req)) return next();
    const hospitalId = requestHospitalId(req);
    if (!await featureFlags.isEnabled(hospitalId, 'disableLegacyIpdDirectBilling')) return next();
    return res.status(409).json({
      success: false,
      code: 'LEGACY_IPD_BILLING_DISABLED',
      error: 'Direct IPD Bill/Invoice creation is disabled. Post an operational charge and use the centralized IPD invoice workflow.',
      canonicalEndpoint: '/api/source-finance/:sourceModule/:sourceId/charge'
    });
  } catch (error) { return next(error); }
}

module.exports = { blockLegacyIpdDirectBilling };
