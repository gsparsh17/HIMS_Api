const Hospital = require('../models/Hospital');
const abdmConfig = require('../config/abdm.config');

let cachedHospitalId;

function configuredHospitalConditions() {
  const conditions = [];
  const tenant = abdmConfig.tenantCode || process.env.HOSPITAL_ID || process.env.TENANT_CODE;
  if (tenant) {
    conditions.push({ tenantCode: String(tenant).toUpperCase() });
    conditions.push({ hospitalID: String(tenant).toUpperCase() });
  }
  if (abdmConfig.hfrFacilityId) {
    conditions.push({ 'onboarding.hfrFacilityId': abdmConfig.hfrFacilityId });
  }
  return conditions;
}

async function configuredHospital() {
  if (cachedHospitalId) {
    const cached = await Hospital.findById(cachedHospitalId);
    if (cached) return cached;
    cachedHospitalId = undefined;
  }

  const conditions = configuredHospitalConditions();
  if (!conditions.length) {
    const error = new Error(
      'ABDM_TENANT_CODE or ABDM_HFR_FACILITY_ID is required to map this connector to a hospital'
    );
    error.statusCode = 503;
    throw error;
  }

  const matches = await Hospital.find({ $or: conditions }).limit(2);
  if (matches.length !== 1) {
    const error = new Error(
      matches.length === 0
        ? 'ABDM connector is not mapped to a hospital tenant'
        : 'ABDM connector configuration maps to multiple hospital tenants'
    );
    error.statusCode = 503;
    throw error;
  }

  cachedHospitalId = matches[0]._id;
  return matches[0];
}

async function configuredHospitalId() {
  return (await configuredHospital())._id;
}

function clearConfiguredHospitalCache() {
  cachedHospitalId = undefined;
}

module.exports = {
  configuredHospital,
  configuredHospitalId,
  clearConfiguredHospitalCache
};
