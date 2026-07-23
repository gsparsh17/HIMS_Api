const test = require('node:test');
const assert = require('node:assert/strict');
const { roundMoney, tierRate, applyConfiguredRateRules } = require('../services/pricingRules.service');

const rules = {
  rounding: 'two_decimals',
  wardFactors: { general: 0.95, semi_private: 1, private: 1.05 },
  sameOtSession: [1, 0.5, 0.25],
  bilateralSecondFactor: 0.5,
  withinPackagePeriodFactor: 0.75,
  wardUniformCategories: ['investigation', 'radiotherapy', 'day_care', 'minor_no_admission'],
};
const procedure = {
  category: 'Major Surgery',
  rates: {
    tierI: { nonNabh: 850, nabh: 1000, superSpeciality: 1150 },
    tierII: { nonNabh: 765, nabh: 900, superSpeciality: 1035 },
    tierIII: { nonNabh: 680, nabh: 800, superSpeciality: 920 },
  },
};

test('CGHS table lookup selects tier and accreditation without deriving a second factor', () => {
  assert.equal(tierRate(procedure, 'I', 'nabh_nabl'), 1000);
  assert.equal(tierRate(procedure, 'II', 'nabh_nabl'), 900);
  assert.equal(tierRate(procedure, 'III', 'non_nabh_non_nabl'), 680);
  assert.equal(tierRate(procedure, 'I', 'super_speciality'), 1150);
});

test('private/general/semi-private entitlement factors are applied to non-uniform packages', () => {
  const privateRate = applyConfiguredRateRules({ item: procedure, rules, cityTier: 'II', accreditation: 'nabh_nabl', wardEntitlement: 'private' });
  const generalRate = applyConfiguredRateRules({ item: procedure, rules, cityTier: 'II', accreditation: 'nabh_nabl', wardEntitlement: 'general' });
  const semiPrivateRate = applyConfiguredRateRules({ item: procedure, rules, cityTier: 'II', accreditation: 'nabh_nabl', wardEntitlement: 'semi_private' });
  assert.equal(roundMoney(privateRate.contractedUnit), 945);
  assert.equal(roundMoney(generalRate.contractedUnit), 855);
  assert.equal(roundMoney(semiPrivateRate.contractedUnit), 900);
});

test('same OT session factors are 100/50/25 for first, second, third and subsequent', () => {
  const input = { item: procedure, rules, cityTier: 'II', accreditation: 'nabh_nabl', wardEntitlement: 'semi_private' };
  assert.equal(roundMoney(applyConfiguredRateRules({ ...input, sameOtSessionIndex: 1 }).contractedUnit), 900);
  assert.equal(roundMoney(applyConfiguredRateRules({ ...input, sameOtSessionIndex: 2 }).contractedUnit), 450);
  assert.equal(roundMoney(applyConfiguredRateRules({ ...input, sameOtSessionIndex: 3 }).contractedUnit), 225);
  assert.equal(roundMoney(applyConfiguredRateRules({ ...input, sameOtSessionIndex: 4 }).contractedUnit), 225);
});

test('bilateral and within-package-period rules are reproducible', () => {
  const value = applyConfiguredRateRules({ item: procedure, rules, cityTier: 'II', accreditation: 'nabh_nabl', wardEntitlement: 'semi_private', bilateralSecond: true, withinPackagePeriod: true });
  assert.equal(roundMoney(value.contractedUnit), 337.5);
  assert.deepEqual(value.ruleTrace.map((row) => row.rule), ['ward_entitlement', 'bilateral_second', 'within_package_period']);
});

test('investigations remain ward-uniform', () => {
  const item = { ...procedure, category: 'Laboratory Investigation', wardUniform: true };
  const value = applyConfiguredRateRules({ item, rules, cityTier: 'II', accreditation: 'nabh_nabl', wardEntitlement: 'private' });
  assert.equal(roundMoney(value.contractedUnit), 900);
  assert.equal(value.wardUniform, true);
});
