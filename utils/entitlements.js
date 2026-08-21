const ENTITLEMENT_KEYS = Object.freeze([
  'dashboard',
  'registration_opd',
  'ipd',
  'pharmacy',
  'billing_finance',
  'laboratory',
  'radiology',
  'operation_theatre',
  'store_inventory',
  'hr_staff',
  'abdm',
  'reports',
  'masters_settings',
  'insurance_tpa',
  'nabh',
  'clinical_ai',
  'voice_dictation',
  'advanced_mis',
  'patient_media'
]);

const ENTITLEMENT_SET = new Set(ENTITLEMENT_KEYS);

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  return false;
}

function normalizeEntitlements(value = {}, options = {}) {
  const result = {};
  const defaultValue = Boolean(options.defaultValue);
  ENTITLEMENT_KEYS.forEach((key) => {
    result[key] = Object.prototype.hasOwnProperty.call(value || {}, key)
      ? booleanValue(value[key])
      : defaultValue;
  });
  return result;
}

function mergeEntitlements(base = {}, overrides = {}) {
  const result = normalizeEntitlements(base || {});
  Object.entries(overrides || {}).forEach(([key, value]) => {
    if (ENTITLEMENT_SET.has(key) && value !== undefined && value !== null) result[key] = booleanValue(value);
  });
  return result;
}

const FULL_ACCESS_ENTITLEMENTS = Object.freeze(normalizeEntitlements(
  Object.fromEntries(ENTITLEMENT_KEYS.map((key) => [key, true]))
));

function isEntitled(entitlements, key) {
  if (!ENTITLEMENT_SET.has(key)) return true;
  return Boolean(entitlements?.[key]);
}

module.exports = { ENTITLEMENT_KEYS, ENTITLEMENT_SET, normalizeEntitlements, mergeEntitlements, FULL_ACCESS_ENTITLEMENTS, isEntitled };
