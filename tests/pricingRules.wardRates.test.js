const test = require('node:test');
const assert = require('node:assert/strict');
const { applyConfiguredRateRules } = require('../services/pricingRules.service');

test('explicit ward rates are selected without applying a global ward factor', () => {
  const item = {
    category: 'General Surgery',
    rates: {
      tierI: { nabh: 99999 }
    },
    wardRates: {
      general: 33200,
      semi_private: 38300,
      private: 45000
    }
  };

  const result = applyConfiguredRateRules({
    item,
    wardEntitlement: 'private',
    rules: {
      wardFactors: { private: 1.5 },
      sameOtSession: [1, 0.5, 0.25]
    }
  });

  assert.equal(result.contractedUnit, 45000);
  assert.equal(result.usedExplicitWardRate, true);
  assert.equal(result.ruleTrace[0].rule, 'explicit_ward_rate');
});

test('same-session factors are still applied after selecting an explicit ward rate', () => {
  const result = applyConfiguredRateRules({
    item: {
      wardRates: { semi_private: 23800 }
    },
    wardEntitlement: 'semi_private',
    sameOtSessionIndex: 2,
    rules: { sameOtSession: [1, 0.5, 0.25] }
  });

  assert.equal(result.contractedUnit, 11900);
  assert.equal(result.ruleTrace.at(-1).rule, 'same_ot_session');
});
