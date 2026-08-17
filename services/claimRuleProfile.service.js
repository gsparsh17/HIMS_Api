const SchemeRuleProfile = require('../models/SchemeRuleProfile');

const PMJAY_BASE_PROFILE = Object.freeze({
  schemeType: 'pmjay',
  jurisdiction: 'national',
  profileName: 'PMJAY national base readiness',
  version: 'NHA-CAM-2.0-2020+HIMS-2026.1',
  sourceReference: 'NHA Claims Adjudication Manual 2.0 (October 2020); SHA/package/STG overrides apply',
  rules: {
    requireEligibilityVerified: true,
    requireBeneficiaryId: true,
    requirePackageCode: true,
    requireDiagnosis: true,
    requireIcd10: false,
    warnUnsignedClinicalDocuments: true,
    blockCashCollection: true,
    requireDayWiseClinicalCoverage: true,
    requireDischargeSummary: true,
    requirePreauthWhenCoverageSaysRequired: true,
    requireClaimAtOrBelowPreauth: true,
    stateSubmissionDeadlineDays: null,
    submissionDeadlineSeverity: 'warning',
    requiredEvidenceTypes: [],
    requiredDocumentTypes: [],
    custom: {}
  },
  packageRules: []
});

const GENERIC_BASE_PROFILE = Object.freeze({
  schemeType: 'generic',
  jurisdiction: 'hospital',
  profileName: 'Generic sponsored-claim readiness',
  version: 'HIMS-2026.1',
  sourceReference: 'HIMS generic sponsored claim controls',
  rules: {
    requireEligibilityVerified: false,
    requireBeneficiaryId: false,
    requirePackageCode: false,
    requireDiagnosis: false,
    requireIcd10: false,
    warnUnsignedClinicalDocuments: false,
    blockCashCollection: false,
    requireDayWiseClinicalCoverage: false,
    requireDischargeSummary: false,
    requirePreauthWhenCoverageSaysRequired: true,
    requireClaimAtOrBelowPreauth: true,
    stateSubmissionDeadlineDays: null,
    submissionDeadlineSeverity: 'warning',
    requiredEvidenceTypes: [],
    requiredDocumentTypes: [],
    custom: {}
  },
  packageRules: []
});

function mergePackageRules(baseRules = [], overrideRules = []) {
  const map = new Map();
  for (const rule of baseRules || []) map.set(String(rule.packageCode || '').toUpperCase(), { ...rule });
  for (const rule of overrideRules || []) {
    const key = String(rule.packageCode || '').toUpperCase();
    const current = map.get(key) || {};
    map.set(key, { ...current, ...rule, metadata: { ...(current.metadata || {}), ...(rule.metadata || {}) } });
  }
  return [...map.values()].filter((rule) => rule.packageCode);
}

function mergeProfile(base, override) {
  if (!override) return JSON.parse(JSON.stringify(base));
  return {
    ...base,
    ...override,
    rules: {
      ...(base.rules || {}),
      ...(override.rules || {}),
      custom: { ...(base.rules?.custom || {}), ...(override.rules?.custom || {}) }
    },
    packageRules: mergePackageRules(base.packageRules || [], override.packageRules || [])
  };
}

async function resolveSchemeRuleProfile({ hospitalId, schemeType, at = new Date() }) {
  const normalized = String(schemeType || 'generic').toLowerCase();
  let resolved = normalized === 'pmjay' ? JSON.parse(JSON.stringify(PMJAY_BASE_PROFILE)) : { ...JSON.parse(JSON.stringify(GENERIC_BASE_PROFILE)), schemeType: normalized };
  const profiles = await SchemeRuleProfile.find({
    hospitalId,
    schemeType: normalized,
    active: true,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: at } }]
  }).sort({ effectiveFrom: 1, updatedAt: 1 }).lean();
  const priority = { state: 10, package: 20, hospital: 30 };
  profiles.sort((a, b) => (priority[a.scopeLevel] || 30) - (priority[b.scopeLevel] || 30) || new Date(a.effectiveFrom || 0) - new Date(b.effectiveFrom || 0));
  for (const profile of profiles) resolved = mergeProfile(resolved, profile);
  resolved.appliedProfiles = profiles.map((row) => ({ id: String(row._id), scopeLevel: row.scopeLevel, jurisdiction: row.jurisdiction, profileName: row.profileName, version: row.version, sourceReference: row.sourceReference }));
  return resolved;
}

function packageRuleFor(profile, packageCode) {
  const code = String(packageCode || '').trim().toUpperCase();
  if (!code) return null;
  return (profile?.packageRules || []).find((row) => String(row.packageCode || '').trim().toUpperCase() === code) || null;
}

module.exports = {
  PMJAY_BASE_PROFILE,
  GENERIC_BASE_PROFILE,
  mergeProfile,
  mergePackageRules,
  resolveSchemeRuleProfile,
  packageRuleFor
};
