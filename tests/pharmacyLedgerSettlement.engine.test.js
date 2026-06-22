'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFinalConcessionAllocations,
  buildRetroactiveAllocations,
  allocatePaymentMethodsToSales,
} = require('../utils/pharmacyLedgerSettlement.engine');

test('manual final concession can allocate cash to the ₹100 bill and discount to the ₹9,900 bills', () => {
  const allocations = buildFinalConcessionAllocations([
    { saleId: 'small', openingDue: 100 },
    { saleId: 'others', openingDue: 9900 },
  ], {
    discountToApply: 5000,
    allocationPolicy: 'MANUAL',
    manualAllocations: [
      { saleId: 'small', paymentAllocated: 100, settlementDiscountAllocated: 0 },
      { saleId: 'others', paymentAllocated: 4900, settlementDiscountAllocated: 5000 },
    ],
  });

  assert.deepEqual(allocations.map(({ saleId, paymentAllocated, settlementDiscountAllocated }) => ({ saleId, paymentAllocated, settlementDiscountAllocated })), [
    { saleId: 'small', paymentAllocated: 100, settlementDiscountAllocated: 0 },
    { saleId: 'others', paymentAllocated: 4900, settlementDiscountAllocated: 5000 },
  ]);
});

test('proportional final concession allocates ₹50 payment and ₹50 discount to a ₹100 bill', () => {
  const allocations = buildFinalConcessionAllocations([
    { saleId: 'small', openingDue: 100 },
    { saleId: 'others', openingDue: 9900 },
  ], { discountToApply: 5000, allocationPolicy: 'PROPORTIONAL' });

  assert.equal(allocations[0].settlementDiscountAllocated, 50);
  assert.equal(allocations[0].paymentAllocated, 50);
  assert.equal(allocations[1].settlementDiscountAllocated, 4950);
  assert.equal(allocations[1].paymentAllocated, 4950);
});

test('payment tender sources are statefully consumed only once', () => {
  const allocations = [
    { saleId: 'a', paymentAllocated: 100 },
    { saleId: 'b', paymentAllocated: 4900 },
  ];
  const perSale = allocatePaymentMethodsToSales([
    { method: 'Cash', amount: 1000, reference: 'cash' },
    { method: 'UPI', amount: 4000, reference: 'upi' },
  ], allocations);

  assert.deepEqual(perSale.get('a').map((p) => [p.method, p.amount]), [['Cash', 100]]);
  assert.deepEqual(perSale.get('b').map((p) => [p.method, p.amount]), [['Cash', 900], ['UPI', 4000]]);
});

test('retroactive 25% target discount creates a ₹2,500 credit on paid ledger and ₹2,500 discount on unpaid ledger', () => {
  const allocations = buildRetroactiveAllocations([
    { saleId: 'paid', grossAmount: 10000, openingDue: 0, amountPaid: 10000, existingDiscounts: 0 },
    { saleId: 'due', grossAmount: 10000, openingDue: 10000, amountPaid: 0, existingDiscounts: 0 },
  ], {
    discountType: 'PERCENTAGE',
    discountValue: 25,
    percentageTreatment: 'TARGET_TOTAL_DISCOUNT',
  });

  assert.equal(allocations[0].creditNoteAllocated, 2500);
  assert.equal(allocations[0].settlementDiscountAllocated, 0);
  assert.equal(allocations[1].settlementDiscountAllocated, 2500);
  assert.equal(allocations[1].paymentAllocated, 7500);
});

test('FIFO policy may intentionally use the entire discount on the earliest ₹100 bill', () => {
  const allocations = buildFinalConcessionAllocations([
    { saleId: 'old-small', openingDue: 100, saleDate: '2026-01-01' },
    { saleId: 'new-large', openingDue: 9900, saleDate: '2026-01-02' },
  ], { discountToApply: 5000, allocationPolicy: 'FIFO' });

  assert.equal(allocations[0].settlementDiscountAllocated, 100);
  assert.equal(allocations[0].paymentAllocated, 0);
  assert.equal(allocations[1].settlementDiscountAllocated, 4900);
  assert.equal(allocations[1].paymentAllocated, 5000);
});

test('target-total percentage does not double-discount an invoice that already has a discount', () => {
  const allocations = buildRetroactiveAllocations([
    { saleId: 'paid', grossAmount: 10000, openingDue: 0, amountPaid: 9000, existingDiscounts: 1000 },
  ], {
    discountType: 'PERCENTAGE',
    discountValue: 25,
    percentageTreatment: 'TARGET_TOTAL_DISCOUNT',
  });

  // Target is ₹2,500; ₹1,000 already exists, so only ₹1,500 additional credit is created.
  assert.equal(allocations[0].creditNoteAllocated, 1500);
});

test('fixed retroactive discount can create a credit for paid bills and a due discount for open bills', () => {
  const allocations = buildRetroactiveAllocations([
    { saleId: 'paid', grossAmount: 5000, openingDue: 0, amountPaid: 5000, existingDiscounts: 0 },
    { saleId: 'open', grossAmount: 5000, openingDue: 5000, amountPaid: 0, existingDiscounts: 0 },
  ], {
    discountType: 'FIXED',
    discountValue: 2000,
    allocationPolicy: 'PROPORTIONAL',
  });

  assert.equal(allocations[0].creditNoteAllocated, 1000);
  assert.equal(allocations[1].settlementDiscountAllocated, 1000);
  assert.equal(allocations[1].paymentAllocated, 4000);
});
