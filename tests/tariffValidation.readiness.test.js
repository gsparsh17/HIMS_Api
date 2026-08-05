const test = require('node:test');
const assert = require('node:assert/strict');
const { itemIssues, applyPreviewMutations } = require('../services/tariffValidation.service');
const { canonicalExactWardRates } = require('../services/rateCardReadiness.service');

function baseItem(overrides = {}) {
  return {
    externalCode: 'LB001',
    externalName: 'Urine Routine',
    serviceType: 'laboratory',
    pricingMode: 'matrix',
    rates: { tierI: { nabh: 100 } },
    active: true,
    mappingOptions: { requiredForBilling: true },
    internalService: { mappingStatus: 'unmapped' },
    sourceRow: { annexure: 'Annexure I' },
    packageDefinition: { isPackage: false },
    ...overrides
  };
}

test('card-level annexure inherited to an item satisfies source traceability', () => {
  const issues = itemIssues(baseItem());
  assert.equal(issues.some((row) => row.code === 'SOURCE_TRACEABILITY_MISSING'), false);
});

test('unapproved mappings are workflow information rather than data-quality warnings', () => {
  const issue = itemIssues(baseItem()).find((row) => row.code === 'MAPPING_NOT_APPROVED');
  assert.equal(issue?.severity, 'info');
});

test('empty package scope remains an actionable warning', () => {
  const issue = itemIssues(baseItem({
    pricingMode: 'package',
    packagePeriodDays: 7,
    packageDefinition: {
      isPackage: true,
      inclusions: [],
      exclusions: [],
      includesMedicines: false,
      includesConsumables: false,
      includesInvestigations: false,
      includesRoom: false,
      includesProfessionalFees: false
    }
  })).find((row) => row.code === 'PACKAGE_SCOPE_EMPTY');
  assert.equal(issue?.severity, 'warning');
});


test('legacy snake-case ward rates convert to the canonical exact-ward shape', () => {
  assert.deepEqual(canonicalExactWardRates({
    general: 21000,
    semi_private: 23800,
    private: 28000,
    day_care: 5000
  }), {
    general: 21000,
    semiPrivate: 23800,
    private: 28000,
    dayCare: 5000
  });
});

test('preview mutations validate the projected source and legacy-rate repairs', () => {
  const item = baseItem({
    _id: 'legacy-item-1',
    pricingMode: 'matrix',
    rates: {},
    sourceRow: { raw: {} }
  });
  applyPreviewMutations([item], {
    inheritedAnnexure: 'Annexure I',
    legacyRatesById: new Map([['legacy-item-1', {
      pricingMode: 'exact_ward',
      rates: { exactWard: { general: 21000, semiPrivate: 23800, private: 28000 } }
    }]])
  });
  const issues = itemIssues(item);
  assert.equal(issues.some((row) => row.code === 'SOURCE_TRACEABILITY_MISSING'), false);
  assert.equal(issues.some((row) => row.code === 'RATE_REQUIRED'), false);
});
