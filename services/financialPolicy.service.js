'use strict';

const crypto = require('crypto');
const NabhSetting = require('../models/NabhSetting');
const { money } = require('../utils/financeNumbers');
const { _hasActionPermission, hasFeatureAccess } = require('../middlewares/auth');

const MODES = Object.freeze([
  'FULL_PREPAY',
  'PARTIAL_PREPAY',
  'POSTPAID',
  'TPA_SPONSOR',
  'AUTHORIZED_EXCEPTION'
]);

const BILLING_INTENT_BY_MODE = Object.freeze({
  FULL_PREPAY: { OPD: 'ADD_TO_OPD_CART', IPD: 'BILL_NOW' },
  PARTIAL_PREPAY: { OPD: 'ADD_TO_OPD_CART', IPD: 'BILL_NOW' },
  POSTPAID: { OPD: 'ADD_TO_OPD_CART', IPD: 'DEFER_TO_ENCOUNTER' },
  TPA_SPONSOR: { OPD: 'ADD_TO_OPD_CART', IPD: 'DEFER_TO_ENCOUNTER' },
  AUTHORIZED_EXCEPTION: { OPD: 'ADD_TO_OPD_CART', IPD: 'DEFER_TO_ENCOUNTER' }
});

const CLEARANCE_BY_MODE = Object.freeze({
  FULL_PREPAY: 'PAYMENT_REQUIRED',
  PARTIAL_PREPAY: 'PAYMENT_REQUIRED',
  POSTPAID: 'POSTPAID_ALLOWED',
  TPA_SPONSOR: 'TPA_PENDING',
  AUTHORIZED_EXCEPTION: 'EXCEPTION_APPROVED'
});

function clean(value) { return String(value || '').trim(); }
function upper(value) { return clean(value).toUpperCase(); }
function round(value) { return money(Number(value || 0)); }
function error(message, statusCode = 400, code = 'FINANCIAL_POLICY_INVALID', details = {}) {
  return Object.assign(new Error(message), { statusCode, code, details });
}
function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function plain(value) {
  if (!value) return {};
  return value.toObject ? value.toObject({ depopulate: true }) : JSON.parse(JSON.stringify(value));
}
function uniqueModes(values = []) {
  return [...new Set((values || []).map(upper).filter(value => MODES.includes(value)))];
}
function normalizeEncounterType(value) {
  const normalized = upper(value || 'OPD');
  return ['OPD', 'IPD', 'EMERGENCY'].includes(normalized) ? normalized : 'OPD';
}
function normalizeUrgency(value) {
  const raw = upper(value || 'ROUTINE');
  if (raw === 'ELECTIVE') return 'ROUTINE';
  if (['ROUTINE', 'URGENT', 'STAT', 'EMERGENCY'].includes(raw)) return raw;
  return 'ROUTINE';
}
function isPayerMatch(ruleValue, actual) {
  if (!clean(ruleValue)) return true;
  return upper(ruleValue) === upper(actual || 'SELF');
}
function scoreRule(rule, context) {
  if (rule?.enabled === false) return -1;
  const at = new Date(context.effectiveAt || new Date());
  if (rule?.effectiveFrom && new Date(rule.effectiveFrom) > at) return -1;
  if (rule?.effectiveTo && new Date(rule.effectiveTo) < at) return -1;
  const encounter = upper(rule?.encounterType || 'ANY');
  if (encounter !== 'ANY' && encounter !== context.encounterType) return -1;
  const urgency = upper(rule?.urgency || 'ANY');
  if (urgency !== 'ANY' && urgency !== context.urgency) return -1;
  if (clean(rule?.serviceType) && upper(rule.serviceType) !== upper(context.serviceType)) return -1;
  if (clean(rule?.serviceCategory) && upper(rule.serviceCategory) !== upper(context.serviceCategory)) return -1;
  if (clean(rule?.serviceCode) && upper(rule.serviceCode) !== upper(context.serviceCode)) return -1;
  if (!isPayerMatch(rule?.payerCategory, context.payerCategory)) return -1;
  if (rule?.departmentId && String(rule.departmentId) !== String(context.departmentId || '')) return -1;
  return Number(encounter !== 'ANY') + Number(urgency !== 'ANY') * 2 + Number(Boolean(clean(rule?.serviceType))) * 2
    + Number(Boolean(clean(rule?.serviceCategory))) * 3
    + Number(Boolean(clean(rule?.serviceCode))) * 4 + Number(Boolean(clean(rule?.payerCategory))) * 2
    + Number(Boolean(rule?.departmentId));
}
function mergeDefined(base, override) {
  const out = { ...(base || {}) };
  Object.entries(override || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = mergeDefined(out[key], value);
    else out[key] = value;
  });
  return out;
}

async function loadFinancialPolicy(hospitalId) {
  const setting = await NabhSetting.findOne({ hospitalId }).lean();
  const policy = setting?.financialPolicy || {};
  // Preserve safe hybrid defaults even before an admin opens the new settings UI.
  return {
    settingsVersion: Number(setting?.version || 0),
    enabled: policy.enabled !== false,
    payment: {
      OPD: mergeDefined({ allowedModes: ['FULL_PREPAY', 'POSTPAID'], defaultMode: 'FULL_PREPAY', partial: { type: 'PERCENTAGE', percentage: 30 } }, policy.payment?.OPD),
      IPD: mergeDefined({ allowedModes: ['FULL_PREPAY', 'PARTIAL_PREPAY', 'POSTPAID'], defaultMode: 'POSTPAID', partial: { type: 'PERCENTAGE', percentage: 30 } }, policy.payment?.IPD),
      EMERGENCY: mergeDefined({ allowedModes: ['POSTPAID', 'AUTHORIZED_EXCEPTION'], defaultMode: 'POSTPAID', partial: { type: 'PERCENTAGE', percentage: 0 } }, policy.payment?.EMERGENCY)
    },
    discount: mergeDefined({ enabled: true, defaultType: 'percentage', defaultValue: 0, maxPercentage: 0, maxFixedAmount: 0, registrarMaxPercentage: 0, financeMaxPercentage: 0, requireReasonAbove: 0, allowFixed: true, allowPercentage: true }, policy.discount),
    tax: mergeDefined({ enabled: true, mode: 'exempt', name: 'Healthcare exempt', code: '', defaultRate: 0, minRate: 0, maxRate: 0, exemptionReason: 'Configured hospital healthcare tax policy' }, policy.tax),
    rules: Array.isArray(policy.rules) ? policy.rules : []
  };
}

function roleDiscountCeiling(policy, user) {
  const role = upper(user?.role).toLowerCase();
  if (_hasActionPermission(user, 'discount_override')) return 100;
  const hospitalMax = Math.max(0, Math.min(100, Number(policy.maxPercentage ?? 0)));
  if (['accountant', 'finance', 'finance_staff', 'insurance_desk'].includes(role)) {
    return Math.min(hospitalMax, Math.max(0, Number(policy.financeMaxPercentage ?? hospitalMax)));
  }
  return Math.min(hospitalMax, Math.max(0, Number(policy.registrarMaxPercentage ?? hospitalMax)));
}

function normalizePartial(partial = {}) {
  return {
    type: ['PERCENTAGE', 'FIXED', 'MINIMUM'].includes(upper(partial.type)) ? upper(partial.type) : 'PERCENTAGE',
    percentage: Math.max(0, Math.min(100, Number(partial.percentage ?? 30))),
    fixedAmount: Math.max(0, round(partial.fixedAmount)),
    minimumAmount: Math.max(0, round(partial.minimumAmount)),
    allowUserAmount: Boolean(partial.allowUserAmount),
    minUserAmount: Math.max(0, round(partial.minUserAmount)),
    maxUserAmount: Math.max(0, round(partial.maxUserAmount))
  };
}

function calculateRequiredNow(mode, patientLiability, partial, requestedDeposit) {
  const liability = Math.max(0, round(patientLiability));
  if (mode === 'FULL_PREPAY') return liability;
  if (mode === 'POSTPAID' || mode === 'AUTHORIZED_EXCEPTION') return 0;
  if (mode === 'TPA_SPONSOR') return 0;
  const p = normalizePartial(partial);
  let required = 0;
  if (p.type === 'FIXED') required = p.fixedAmount;
  else if (p.type === 'MINIMUM') required = p.minimumAmount;
  else required = liability * p.percentage / 100;
  if (p.allowUserAmount && requestedDeposit !== undefined && requestedDeposit !== null && requestedDeposit !== '') {
    const candidate = Math.max(0, round(requestedDeposit));
    if (p.minUserAmount && candidate < p.minUserAmount) throw error(`Deposit cannot be lower than ₹${p.minUserAmount.toFixed(2)}`, 400, 'DEPOSIT_BELOW_POLICY_MINIMUM');
    if (p.maxUserAmount && candidate > p.maxUserAmount) throw error(`Deposit cannot exceed ₹${p.maxUserAmount.toFixed(2)}`, 400, 'DEPOSIT_ABOVE_POLICY_MAXIMUM');
    required = candidate;
  }
  return round(Math.min(liability, Math.max(0, required)));
}

function resolveDiscountConfig(globalPolicy, rule) {
  return mergeDefined(globalPolicy || {}, rule?.discount || {});
}
function resolveTaxConfig(globalPolicy, rule) {
  return mergeDefined(globalPolicy || {}, rule?.tax || {});
}

function applyDiscountAndTax({ baseAmount, patientLiability, sponsorLiability, discountPolicy, taxPolicy, requested = {}, user }) {
  const contractedBase = Math.max(0, round(baseAmount));
  const sponsor = Math.max(0, round(sponsorLiability));
  const patientBefore = Math.max(0, round(patientLiability));
  const canDiscount = Boolean(discountPolicy?.enabled) && _hasActionPermission(user, 'billing_apply_discount');
  const requestedType = requested.discountType || discountPolicy.defaultType || 'percentage';
  const discountType = requestedType === 'fixed' ? 'fixed' : 'percentage';
  const requestedRaw = requested.discountValue ?? (discountType === 'percentage' ? requested.discountRate : requested.discountAmount);
  const hasExplicitDiscountSelection = requestedRaw !== undefined && requestedRaw !== null && requestedRaw !== '';
  const defaultRaw = Number(discountPolicy.defaultValue || 0);
  const desired = hasExplicitDiscountSelection ? Number(requestedRaw || 0) : defaultRaw;
  const canDiscountOverride = _hasActionPermission(user, 'discount_override');
  let discountAmount = 0;
  let discountRate = 0;
  const discountReason = clean(requested.discountReason);

  if (desired > 0) {
    // Hospital defaults are automatic policy and do not require clerk discount permission.
    // A user-entered departure from the default does require the explicit discount action.
    if (hasExplicitDiscountSelection && !canDiscount && !canDiscountOverride) {
      throw error('You do not have permission to change the configured discount', 403, 'DISCOUNT_PERMISSION_REQUIRED');
    }
    if (discountType === 'fixed') {
      if (discountPolicy.allowFixed === false) throw error('Fixed discounts are not enabled by hospital policy', 409, 'DISCOUNT_MODE_NOT_ALLOWED');
      const configuredMax = Math.max(0, Number(discountPolicy.maxFixedAmount || 0));
      const roleCeiling = roleDiscountCeiling(discountPolicy, user);
      const roleFixedMax = patientBefore > 0 ? round(patientBefore * roleCeiling / 100) : 0;
      const effectiveFixedMax = Math.min(configuredMax, roleFixedMax);
      if (hasExplicitDiscountSelection && desired > effectiveFixedMax + 0.01 && !canDiscountOverride) {
        throw error(`Discount exceeds your configured maximum of ₹${round(effectiveFixedMax).toFixed(2)}`, 409, 'DISCOUNT_ABOVE_ALLOWED_RANGE', { maximumFixedAmount: round(effectiveFixedMax) });
      }
      discountAmount = Math.min(patientBefore, Math.max(0, round(desired)));
      discountRate = patientBefore ? round(discountAmount / patientBefore * 100) : 0;
    } else {
      if (discountPolicy.allowPercentage === false) throw error('Percentage discounts are not enabled by hospital policy', 409, 'DISCOUNT_MODE_NOT_ALLOWED');
      const hospitalCeiling = Math.max(0, Math.min(100, Number(discountPolicy.maxPercentage ?? 0)));
      const userCeiling = roleDiscountCeiling(discountPolicy, user);
      const ceiling = hasExplicitDiscountSelection ? Math.min(hospitalCeiling, userCeiling) : hospitalCeiling;
      if (hasExplicitDiscountSelection && desired > ceiling + 0.0001 && !canDiscountOverride) {
        throw error(`Discount exceeds your allowed maximum of ${ceiling}%`, 409, 'DISCOUNT_ABOVE_ALLOWED_RANGE', { maximumPercentage: ceiling });
      }
      discountRate = Math.max(0, Math.min(100, desired));
      discountAmount = round(patientBefore * discountRate / 100);
    }
    if (hasExplicitDiscountSelection && desired > Number(discountPolicy.requireReasonAbove || 0) && !discountReason) {
      throw error('Discount reason is required by hospital policy', 400, 'DISCOUNT_REASON_REQUIRED');
    }
  } else if (hasExplicitDiscountSelection && defaultRaw > 0 && !canDiscount && !canDiscountOverride) {
    throw error('You do not have permission to remove the configured default discount', 403, 'DISCOUNT_PERMISSION_REQUIRED');
  }

  const patientAfterDiscount = round(Math.max(0, patientBefore - discountAmount));
  // Discretionary discount/tax applies to patient liability. Contractual payer
  // adjustment and sponsor liability remain distinct amounts from the pricing engine.
  const taxableBeforeTax = patientAfterDiscount;
  // Some regulated verticals (notably Pharmacy) carry statutory tax from an
  // authoritative batch/medicine snapshot. In that case this resolver still
  // governs discount/payment policy, while tax remains server-authoritative in
  // the upstream master instead of being applied a second time here.
  const preserveUpstreamTax = requested.preserveUpstreamTax === true;
  const configuredTaxMode = ['exclusive', 'inclusive', 'exempt'].includes(taxPolicy?.mode) ? taxPolicy.mode : 'exempt';
  const requestedTaxRate = requested.taxRate;
  const requestedTaxMode = requested.taxMode;
  let taxMode = preserveUpstreamTax ? 'upstream_master' : configuredTaxMode;
  let taxRate = preserveUpstreamTax ? 0 : Number(taxPolicy?.defaultRate || 0);
  const taxOverride = !preserveUpstreamTax && ((requestedTaxRate !== undefined && Number(requestedTaxRate) !== taxRate)
    || (requestedTaxMode && requestedTaxMode !== configuredTaxMode));
  if (taxOverride) {
    if (!_hasActionPermission(user, 'tax_override')) {
      throw error('Tax treatment is controlled by hospital policy', 403, 'TAX_OVERRIDE_PERMISSION_REQUIRED');
    }
    if (!clean(requested.taxReason || requested.overrideReason)) {
      throw error('Tax override reason is required', 400, 'TAX_OVERRIDE_REASON_REQUIRED');
    }
    taxMode = ['exclusive', 'inclusive', 'exempt'].includes(requestedTaxMode) ? requestedTaxMode : taxMode;
    taxRate = Math.max(0, Math.min(100, Number(requestedTaxRate ?? taxRate)));
  }
  if (!preserveUpstreamTax && (taxPolicy?.enabled === false || taxMode === 'exempt')) taxRate = 0;
  const minRate = Number(taxPolicy?.minRate ?? 0);
  const maxRate = Number(taxPolicy?.maxRate ?? taxRate);
  if (!preserveUpstreamTax && (taxRate < minRate - 0.0001 || (maxRate >= 0 && taxRate > maxRate + 0.0001))) {
    if (!_hasActionPermission(user, 'tax_override')) {
      throw error('Tax rate is outside the hospital-configured range', 409, 'TAX_OUTSIDE_ALLOWED_RANGE');
    }
  }

  let taxAmount = 0;
  let taxableAmount = taxableBeforeTax;
  let netAmount = taxableBeforeTax;
  if (taxMode === 'inclusive' && taxRate > 0) {
    taxAmount = round(taxableBeforeTax * taxRate / (100 + taxRate));
    taxableAmount = round(taxableBeforeTax - taxAmount);
    netAmount = taxableBeforeTax;
  } else if (taxMode === 'exclusive' && taxRate > 0) {
    taxAmount = round(taxableBeforeTax * taxRate / 100);
    netAmount = round(taxableBeforeTax + taxAmount);
  }

  // Contractual payer pricing is not a discretionary discount. The discretionary
  // discount and tax treatment apply to patient liability; sponsor liability is
  // kept as returned by the payer allocation engine unless a dedicated payer
  // rule changes it upstream.
  const patientAfterTax = round(patientAfterDiscount + (taxMode === 'exclusive' ? taxAmount : 0));
  const totalLiability = round(patientAfterTax + sponsor);

  return {
    grossAmount: contractedBase,
    discountType,
    discountRate: round(discountRate),
    discountAmount,
    discountReason,
    taxableAmount,
    taxMode,
    taxName: clean(taxPolicy?.name),
    taxCode: clean(taxPolicy?.code),
    taxRate: round(taxRate),
    taxAmount,
    taxExemptionReason: taxMode === 'exempt' ? clean(taxPolicy?.exemptionReason) : '',
    netAmount: totalLiability,
    patientNetAmount: netAmount,
    patientLiability: patientAfterTax,
    sponsorLiability: sponsor,
    totalLiability,
    discountOverride: hasExplicitDiscountSelection && desired > 0 && canDiscountOverride,
    taxOverride
  };
}

async function resolveFinancialPolicy({
  hospitalId,
  user,
  encounterType = 'OPD',
  serviceType,
  serviceCategory,
  serviceCode,
  payerCategory = 'SELF',
  departmentId,
  urgency,
  effectiveAt,
  selectedMode,
  inheritedMode,
  requestedDeposit,
  patientLiability = 0,
  sponsorLiability = 0,
  contractedAmount = 0,
  adjustments = {},
  taxAuthority = 'POLICY',
  overrideReason
}) {
  if (!hospitalId) throw error('Hospital context is required', 400, 'HOSPITAL_CONTEXT_REQUIRED');
  const policy = await loadFinancialPolicy(hospitalId);
  const context = {
    encounterType: normalizeEncounterType(encounterType),
    serviceType: upper(serviceType),
    serviceCategory: upper(serviceCategory),
    serviceCode: upper(serviceCode),
    payerCategory: upper(payerCategory || 'SELF'),
    departmentId: departmentId || null,
    urgency: normalizeUrgency(urgency),
    effectiveAt: new Date(effectiveAt || new Date()).toISOString()
  };
  const candidates = policy.rules.map(rule => ({ rule: plain(rule), score: scoreRule(rule, context) })).filter(row => row.score >= 0).sort((a, b) => b.score - a.score);
  const rule = candidates[0]?.rule || null;
  const basePayment = plain(policy.payment[context.encounterType] || policy.payment.OPD);
  const mergedPayment = mergeDefined(basePayment, rule ? { allowedModes: rule.allowedModes?.length ? rule.allowedModes : undefined, defaultMode: rule.defaultMode, partial: rule.partial } : {});
  let allowedModes = uniqueModes(mergedPayment.allowedModes);
  if (!allowedModes.length) allowedModes = context.encounterType === 'IPD' ? ['POSTPAID'] : ['FULL_PREPAY'];
  let defaultMode = upper(mergedPayment.defaultMode);
  if (!allowedModes.includes(defaultMode)) defaultMode = allowedModes[0];
  const explicitSelection = clean(selectedMode) ? upper(selectedMode) : '';
  const inheritedSelection = clean(inheritedMode) ? upper(inheritedMode) : '';
  const desiredMode = explicitSelection || (allowedModes.includes(inheritedSelection) ? inheritedSelection : defaultMode);
  let modeOverride = false;
  if (explicitSelection && !allowedModes.includes(desiredMode)) {
    if (!_hasActionPermission(user, 'billing_mode_override')) {
      throw error('Selected financial mode is not enabled for this encounter/service', 409, 'BILLING_MODE_NOT_ALLOWED', { allowedModes, defaultMode });
    }
    if (!clean(overrideReason)) throw error('Override reason is required for a disallowed financial mode', 400, 'BILLING_MODE_OVERRIDE_REASON_REQUIRED');
    modeOverride = true;
  }
  // An authorised exception is never a casual clerk selection even when the
  // hospital exposes it for emergencies. It always needs an explicit override
  // capability and a recorded reason/approver trail.
  if (desiredMode === 'AUTHORIZED_EXCEPTION') {
    if (!_hasActionPermission(user, 'billing_mode_override') && !_hasActionPermission(user, 'final_clearance')) {
      throw error('Authorised exception requires privileged override permission', 403, 'AUTHORIZED_EXCEPTION_PERMISSION_REQUIRED');
    }
    if (!clean(overrideReason)) {
      throw error('Authorised exception reason is required', 400, 'AUTHORIZED_EXCEPTION_REASON_REQUIRED');
    }
    modeOverride = true;
  }
  const effectiveMode = desiredMode;
  const amountPolicy = applyDiscountAndTax({
    baseAmount: contractedAmount,
    patientLiability,
    sponsorLiability,
    discountPolicy: resolveDiscountConfig(policy.discount, rule),
    taxPolicy: resolveTaxConfig(policy.tax, rule),
    requested: { ...adjustments, preserveUpstreamTax: taxAuthority === 'UPSTREAM_MASTER' },
    user
  });
  const partial = normalizePartial(mergedPayment.partial);
  const requiredNow = calculateRequiredNow(effectiveMode, amountPolicy.patientLiability, partial, requestedDeposit);
  let clearanceState = CLEARANCE_BY_MODE[effectiveMode] || 'PAYMENT_REQUIRED';
  if (effectiveMode === 'TPA_SPONSOR' && amountPolicy.sponsorLiability <= 0 && amountPolicy.patientLiability > 0) clearanceState = 'PAYMENT_REQUIRED';
  if (requiredNow <= 0 && clearanceState === 'PAYMENT_REQUIRED') clearanceState = 'CLEARED';
  const overrideAt = new Date();
  const policySnapshot = {
    settingsVersion: policy.settingsVersion,
    context,
    matchedRuleId: rule?._id || null,
    allowedModes,
    defaultMode,
    selectedMode: effectiveMode,
    partial,
    amountPolicy: {
      discount: resolveDiscountConfig(policy.discount, rule),
      tax: resolveTaxConfig(policy.tax, rule),
      taxAuthority
    },
    appliedAmounts: {
      grossAmount: amountPolicy.grossAmount,
      discountType: amountPolicy.discountType,
      discountRate: amountPolicy.discountRate,
      discountAmount: amountPolicy.discountAmount,
      taxableAmount: amountPolicy.taxableAmount,
      taxMode: amountPolicy.taxMode,
      taxRate: amountPolicy.taxRate,
      taxAmount: amountPolicy.taxAmount,
      patientLiability: amountPolicy.patientLiability,
      sponsorLiability: amountPolicy.sponsorLiability,
      totalLiability: amountPolicy.totalLiability
    },
    requiredNow,
    clearanceState,
    resolvedAt: new Date(),
    modeOverride,
    overrideReason: modeOverride ? clean(overrideReason) : undefined,
    overrideAudit: (modeOverride || amountPolicy.discountOverride || amountPolicy.taxOverride) ? {
      actorId: user?._id || null,
      at: overrideAt,
      modeOverride,
      discountOverride: Boolean(amountPolicy.discountOverride),
      taxOverride: Boolean(amountPolicy.taxOverride),
      reason: clean(overrideReason || adjustments.discountReason || adjustments.taxReason)
    } : undefined
  };
  policySnapshot.hash = hash(policySnapshot);

  return {
    allowedModes,
    defaultMode,
    selectedMode: effectiveMode,
    billingIntent: BILLING_INTENT_BY_MODE[effectiveMode]?.[context.encounterType === 'IPD' ? 'IPD' : 'OPD'] || 'ADD_TO_OPD_CART',
    partial,
    requiredNow,
    clearanceState,
    amounts: amountPolicy,
    policySnapshot,
    permissions: {
      canSelectMode: hasFeatureAccess(user, 'billing_finance', 'manage') || hasFeatureAccess(user, 'registration_opd', 'manage') || hasFeatureAccess(user, 'ipd', 'manage'),
      canApplyDiscount: _hasActionPermission(user, 'billing_apply_discount'),
      canOverridePrice: _hasActionPermission(user, 'pricing_override'),
      canOverrideMode: _hasActionPermission(user, 'billing_mode_override'),
      canOverrideTax: _hasActionPermission(user, 'tax_override')
    }
  };
}

module.exports = {
  MODES,
  BILLING_INTENT_BY_MODE,
  loadFinancialPolicy,
  resolveFinancialPolicy,
  calculateRequiredNow,
  applyDiscountAndTax
};
