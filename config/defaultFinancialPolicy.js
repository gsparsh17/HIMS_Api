'use strict';

/**
 * Recommended hospital financial-policy baseline.
 *
 * This is deliberately a policy/configuration template, not a tariff table.
 * Service prices still come from the central pricing/rate-card/pharmacy masters.
 * The template only defines permitted payment/clearance behaviour and conservative
 * discount/tax defaults. Hospitals can edit every value from Admin Settings.
 */

const DEFAULT_FINANCIAL_POLICY_TEMPLATE_VERSION = 1;
const DEFAULT_FINANCIAL_POLICY_TEMPLATE_NAME = 'MediQliq recommended hybrid baseline';

const FULL_PREPAY = 'FULL_PREPAY';
const PARTIAL_PREPAY = 'PARTIAL_PREPAY';
const POSTPAID = 'POSTPAID';
const TPA_SPONSOR = 'TPA_SPONSOR';
const AUTHORIZED_EXCEPTION = 'AUTHORIZED_EXCEPTION';

const OPD_MODES = [FULL_PREPAY, POSTPAID, TPA_SPONSOR];
const OPD_PARTIAL_MODES = [FULL_PREPAY, PARTIAL_PREPAY, POSTPAID, TPA_SPONSOR];
const IPD_MODES = [FULL_PREPAY, PARTIAL_PREPAY, POSTPAID, TPA_SPONSOR];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function mergeDefined(base, override) {
  const out = isPlainObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(override || {})) {
    if (value === undefined || value === null) continue;
    if (isPlainObject(value)) out[key] = mergeDefined(out[key], value);
    else out[key] = clone(value);
  }
  return out;
}

function partial30() {
  return {
    type: 'PERCENTAGE',
    percentage: 30,
    fixedAmount: 0,
    minimumAmount: 0,
    allowUserAmount: false,
    minUserAmount: 0,
    maxUserAmount: 0
  };
}

function rule(templateKey, encounterType, serviceType, allowedModes, defaultMode, extra = {}) {
  return {
    templateKey,
    enabled: true,
    encounterType,
    urgency: 'ANY',
    serviceType,
    allowedModes: [...allowedModes],
    defaultMode,
    ...(allowedModes.includes(PARTIAL_PREPAY) ? { partial: partial30() } : {}),
    ...extra
  };
}

function buildDefaultFinancialPolicyRules() {
  return [
    // OPD service families. These preserve the normal OPD default while making
    // the policy explicit and editable per service family.
    rule('OPD_LABORATORY', 'OPD', 'LABORATORY', OPD_MODES, FULL_PREPAY),
    rule('OPD_RADIOLOGY', 'OPD', 'RADIOLOGY', OPD_MODES, FULL_PREPAY),
    rule('OPD_PROCEDURE', 'OPD', 'PROCEDURE', OPD_PARTIAL_MODES, FULL_PREPAY),
    rule('OPD_PHARMACY', 'OPD', 'PHARMACY', OPD_MODES, FULL_PREPAY),
    rule('OPD_CONSULTATION', 'OPD', 'CONSULTATION', OPD_MODES, FULL_PREPAY),
    rule('OPD_REGISTRATION', 'OPD', 'REGISTRATION', [FULL_PREPAY, POSTPAID], FULL_PREPAY),

    // IPD service families. Running-account/postpaid remains the recommended
    // default; Full/Partial/TPA remain available when policy/context permits.
    rule('IPD_LABORATORY', 'IPD', 'LABORATORY', IPD_MODES, POSTPAID),
    rule('IPD_RADIOLOGY', 'IPD', 'RADIOLOGY', IPD_MODES, POSTPAID),
    rule('IPD_PROCEDURE', 'IPD', 'PROCEDURE', IPD_MODES, POSTPAID),
    rule('IPD_OPERATION_THEATRE', 'IPD', 'OPERATION_THEATRE', IPD_MODES, POSTPAID),
    rule('IPD_PHARMACY', 'IPD', 'PHARMACY', IPD_MODES, POSTPAID),
    rule('IPD_CONSULTATION', 'IPD', 'CONSULTATION', IPD_MODES, POSTPAID),
    rule('IPD_REGISTRATION', 'IPD', 'REGISTRATION', IPD_MODES, POSTPAID),
    rule('IPD_ADMISSION', 'IPD', 'ADMISSION', IPD_MODES, POSTPAID),
    rule('IPD_BED', 'IPD', 'BED', IPD_MODES, POSTPAID),
    rule('IPD_OTHER_RECURRING', 'IPD', 'OTHER', IPD_MODES, POSTPAID)
  ];
}

function buildDefaultFinancialPolicy() {
  return {
    templateVersion: DEFAULT_FINANCIAL_POLICY_TEMPLATE_VERSION,
    templateName: DEFAULT_FINANCIAL_POLICY_TEMPLATE_NAME,
    enabled: true,
    payment: {
      OPD: {
        allowedModes: [...OPD_MODES],
        defaultMode: FULL_PREPAY,
        partial: partial30()
      },
      IPD: {
        allowedModes: [...IPD_MODES],
        defaultMode: POSTPAID,
        partial: partial30()
      },
      EMERGENCY: {
        allowedModes: [POSTPAID, TPA_SPONSOR, AUTHORIZED_EXCEPTION],
        defaultMode: POSTPAID,
        partial: {
          type: 'PERCENTAGE', percentage: 0, fixedAmount: 0, minimumAmount: 0,
          allowUserAmount: false, minUserAmount: 0, maxUserAmount: 0
        }
      }
    },
    discount: {
      enabled: true,
      defaultType: 'percentage',
      defaultValue: 0,
      maxPercentage: 10,
      maxFixedAmount: 0,
      registrarMaxPercentage: 5,
      financeMaxPercentage: 10,
      requireReasonAbove: 5,
      allowFixed: false,
      allowPercentage: true
    },
    tax: {
      enabled: true,
      mode: 'exempt',
      name: 'Healthcare exempt',
      code: '',
      defaultRate: 0,
      minRate: 0,
      maxRate: 0,
      exemptionReason: 'Configured hospital healthcare tax policy'
    },
    rules: buildDefaultFinancialPolicyRules()
  };
}

/**
 * Merge a hospital's existing configuration onto the recommended baseline.
 * Existing service rules are never overwritten. An empty rules array is only
 * interpreted as "not initialized yet" when the template marker is absent.
 * Once an admin saves templateVersion >= current, an intentionally empty rules
 * list remains empty.
 */
function mergeFinancialPolicyWithDefaults(current = {}, { populateUninitializedRules = true } = {}) {
  const baseline = buildDefaultFinancialPolicy();
  const incoming = clone(current || {});
  const merged = mergeDefined(baseline, incoming);
  const currentTemplateVersion = Number(incoming.templateVersion || 0);

  if (Array.isArray(incoming.rules) && incoming.rules.length) {
    merged.rules = clone(incoming.rules);
  } else if (currentTemplateVersion >= DEFAULT_FINANCIAL_POLICY_TEMPLATE_VERSION) {
    merged.rules = Array.isArray(incoming.rules) ? clone(incoming.rules) : [];
  } else {
    merged.rules = populateUninitializedRules ? buildDefaultFinancialPolicyRules() : [];
  }

  // A response merged with the recommended baseline carries the marker so the
  // next explicit Save persists that the hospital has reviewed this template.
  merged.templateVersion = Math.max(currentTemplateVersion, DEFAULT_FINANCIAL_POLICY_TEMPLATE_VERSION);
  merged.templateName = incoming.templateName || DEFAULT_FINANCIAL_POLICY_TEMPLATE_NAME;
  return merged;
}

function financialPolicyDefaultsPending(current = {}) {
  return Number(current?.templateVersion || 0) < DEFAULT_FINANCIAL_POLICY_TEMPLATE_VERSION;
}

module.exports = {
  DEFAULT_FINANCIAL_POLICY_TEMPLATE_VERSION,
  DEFAULT_FINANCIAL_POLICY_TEMPLATE_NAME,
  buildDefaultFinancialPolicy,
  buildDefaultFinancialPolicyRules,
  mergeFinancialPolicyWithDefaults,
  financialPolicyDefaultsPending
};
