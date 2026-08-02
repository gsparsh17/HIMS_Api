const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'mongoose') return { startSession: async () => ({ withTransaction: async (work) => work(), endSession: async () => {} }) };
  if (request.startsWith('../models/')) return {};
  if (request === './billingPatient.service') return {};
  if (request === '../utils/financeNumbers') {
    return {
      money: (value) => Math.round((Number(value) || 0) * 100) / 100,
      nextFinancialNumber: async () => 'TEST-000001'
    };
  }
  if (request === '../utils/hospitalScope') return { assertUserHospital: () => 'hospital-1' };
  return originalLoad(request, parent, isMain);
};

const { calculateLineAmounts } = require('../services/patientFinancial.service');
Module._load = originalLoad;

const exclusive = calculateLineAmounts({
  quantity: 2,
  rate: 500,
  discountType: 'percentage',
  discountRate: 10,
  taxMode: 'exclusive',
  taxRate: 18
});
assert.deepStrictEqual(
  { gross: exclusive.grossAmount, discount: exclusive.discountAmount, taxable: exclusive.taxableAmount, tax: exclusive.taxAmount, net: exclusive.netAmount },
  { gross: 1000, discount: 100, taxable: 900, tax: 162, net: 1062 }
);

const inclusive = calculateLineAmounts({
  quantity: 1,
  rate: 1180,
  discountType: 'fixed',
  discountAmount: 0,
  taxMode: 'inclusive',
  taxRate: 18
});
assert.deepStrictEqual(
  { taxable: inclusive.taxableAmount, tax: inclusive.taxAmount, net: inclusive.netAmount },
  { taxable: 1000, tax: 180, net: 1180 }
);

assert.throws(
  () => calculateLineAmounts({ quantity: 1, rate: 100, discountAmount: 101 }),
  /Discount cannot exceed gross amount/
);


const fs = require('fs');
const serviceSource = fs.readFileSync(require.resolve('../services/patientFinancial.service'), 'utf8');
const routeSource = fs.readFileSync(require.resolve('../routes/finance.routes'), 'utf8');
assert(serviceSource.includes("documentType: 'ADVANCE_REFUND'"), 'OPD advance refund must use a supported financial sequence type');
assert(!serviceSource.includes("documentType: 'REFUND'"), 'unsupported REFUND sequence type must not be used');
[
  '/patients/:patientId/workspace',
  '/patients/:patientId/charges',
  '/patients/:patientId/invoices',
  '/patients/:patientId/payments',
  '/patients/:patientId/advances',
  '/patients/:patientId/advance-refunds'
].forEach((route) => assert(routeSource.includes(route), `missing OPD finance route ${route}`));

console.log('patient-financial-followup: PASS');
