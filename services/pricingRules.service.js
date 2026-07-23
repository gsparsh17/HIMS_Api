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
  if (item?.rates?.flatAmount !== undefined && item?.rates?.flatAmount !== null) return Number(item.rates.flatAmount);
  const tierKey = tier === 'II' ? 'tierII' : tier === 'III' ? 'tierIII' : 'tierI';
  const accreditationKey = accreditation === 'non_nabh_non_nabl' ? 'nonNabh' : accreditation === 'super_speciality' ? 'superSpeciality' : 'nabh';
  return Number(item?.rates?.[tierKey]?.[accreditationKey] ?? item?.rates?.[tierKey]?.nabh ?? 0);
}
function applyConfiguredRateRules({ item, rules = {}, cityTier = 'I', accreditation = 'nabh_nabl', wardEntitlement = 'semi_private', sameOtSessionIndex = 1, bilateralSecond = false, withinPackagePeriod = false }) {
  const explanation = [];
  const ruleTrace = [];
  let contractedUnit = tierRate(item, cityTier, accreditation);
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
  return { contractedUnit, explanation, ruleTrace, wardUniform: uniform };
}
module.exports = { roundMoney, mapValue, tierRate, applyConfiguredRateRules };
