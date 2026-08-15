function roundMoney(value, mode = 'two_decimals') {
  const number = Number(value || 0);
  if (mode === 'nearest_rupee') return Math.round(number);
  if (mode === 'floor') return Math.floor(number);
  if (mode === 'ceil') return Math.ceil(number);
  return Number(number.toFixed(2));
}

function mapValue(map, key, fallback = 1) {
  if (!map) return fallback;
  if (typeof map.get === 'function') return Number(map.get(key) ?? fallback);
  return Number(map[key] ?? fallback);
}

function tierRate(item, tier, accreditation) {
  if (item?.pricingMode === 'flat' || item?.rates?.flatAmount !== undefined && item?.rates?.flatAmount !== null) {
    return Number(item?.rates?.flatAmount || 0);
  }
  const tierKey = tier === 'II' ? 'tierII' : tier === 'III' ? 'tierIII' : 'tierI';
  const accreditationKey = accreditation === 'non_nabh_non_nabl' ? 'nonNabh' : accreditation === 'super_speciality' ? 'superSpeciality' : 'nabh';
  return Number(item?.rates?.[tierKey]?.[accreditationKey] ?? item?.rates?.[tierKey]?.nabh ?? 0);
}

function exactWardRate(item, wardEntitlement) {
  const key = ({
    general: 'general',
    semi_private: 'semiPrivate',
    private: 'private',
    deluxe: 'deluxe',
    icu: 'icu',
    day_care: 'dayCare',
    not_applicable: 'notApplicable'
  })[wardEntitlement] || 'semiPrivate';
  const value = item?.rates?.exactWard?.[key];
  return value === null || value === undefined ? null : Number(value);
}

function applyConfiguredRateRules({
  item,
  rules = {},
  cityTier = 'I',
  accreditation = 'nabh_nabl',
  wardEntitlement = 'semi_private',
  sameOtSessionIndex = 1,
  bilateralSecond = false,
  withinPackagePeriod = false
}) {
  const explanation = [];
  const ruleTrace = [];
  let contractedUnit;

  if (item?.pricingMode === 'non_admissible') {
    return { contractedUnit: 0, explanation: ['Rate-card item is explicitly non-admissible'], ruleTrace: [{ rule: 'non_admissible' }], wardUniform: true };
  }

  const wardRate = item?.pricingMode === 'exact_ward' || item?.rates?.exactWard
    ? exactWardRate(item, wardEntitlement)
    : null;
  if (wardRate !== null) {
    contractedUnit = wardRate;
    explanation.push(`Exact ${String(wardEntitlement).replaceAll('_', ' ')} rate selected`);
    ruleTrace.push({ rule: 'exact_ward_rate', wardEntitlement, amount: wardRate });
  } else {
    contractedUnit = tierRate(item, cityTier, accreditation);
    explanation.push(`${cityTier === 'I' ? 'Tier-I' : cityTier === 'II' ? 'Tier-II' : 'Tier-III'} rate selected`);
    explanation.push(`${String(accreditation).replaceAll('_', ' ')} column selected`);
    const category = String(item?.category || item?.specialty || '').toLowerCase().replaceAll(' ', '_');
    const uniform = Boolean(item?.wardUniform) || (rules.wardUniformCategories || []).some((row) => category.includes(String(row).toLowerCase()));
    if (!uniform) {
      const factor = mapValue(rules.wardFactors, wardEntitlement, 1);
      contractedUnit *= factor;
      ruleTrace.push({ rule: 'ward_entitlement', factor });
      explanation.push(`${String(wardEntitlement).replaceAll('_', ' ')} ward factor applied`);
    } else explanation.push('Ward-uniform category: no ward factor applied');
  }

  if (Number(sameOtSessionIndex || 1) > 1) {
    const index = Number(sameOtSessionIndex) - 1;
    const factors = Array.isArray(rules.sameOtSession) ? rules.sameOtSession : [1, 0.5, 0.25];
    const factor = Number(factors[Math.min(index, factors.length - 1)] ?? 0.25);
    contractedUnit *= factor;
    ruleTrace.push({ rule: 'same_ot_session', factor, sequence: Number(sameOtSessionIndex) });
    explanation.push(`Same OT session factor ${factor} applied`);
  }
  if (bilateralSecond) {
    const factor = Number(rules.bilateralSecondFactor ?? 0.5);
    contractedUnit *= factor;
    ruleTrace.push({ rule: 'bilateral_second', factor });
    explanation.push(`Bilateral/identical-site second procedure factor ${factor} applied`);
  }
  if (withinPackagePeriod) {
    const factor = Number(rules.withinPackagePeriodFactor ?? 0.75);
    contractedUnit *= factor;
    ruleTrace.push({ rule: 'within_package_period', factor });
    explanation.push(`Within-package-period factor ${factor} applied`);
  }
  return { contractedUnit, explanation, ruleTrace, wardUniform: Boolean(item?.wardUniform) };
}

module.exports = { roundMoney, mapValue, tierRate, exactWardRate, applyConfiguredRateRules };
