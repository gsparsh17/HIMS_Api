'use strict';

const assert = require('assert');
const { calculateFinalClearanceAmounts } = require('../services/pharmacyReturnClearance.math');

// ₹1,000 due and ₹1,400 Pharmacy Advance: advance settles the full due;
// ₹400 is genuinely unused and therefore refundable/retainable by policy.
{
  const result = calculateFinalClearanceAmounts({
    outstanding: 1000,
    pharmacyAdvanceAvailable: 1400,
    ipdAdvanceAvailable: 0,
    pharmacyAdvanceApplied: 1000,
    ipdAdvanceApplied: 0,
    paymentTotal: 0,
  });
  assert.deepStrictEqual(result, {
    outstanding: 1000,
    pharmacyAdvanceAvailable: 1400,
    ipdAdvanceAvailable: 0,
    pharmacyAdvanceApplied: 1000,
    ipdAdvanceApplied: 0,
    cashToCollect: 0,
    paymentTotal: 0,
    unusedPharmacyAdvance: 400,
  });
}

// Partially paid/deferred balance: use ₹250 advance and collect only ₹450.
{
  const result = calculateFinalClearanceAmounts({
    outstanding: 700,
    pharmacyAdvanceAvailable: 250,
    ipdAdvanceAvailable: 0,
    pharmacyAdvanceApplied: 250,
    ipdAdvanceApplied: 0,
    paymentTotal: 450,
  });
  assert.strictEqual(result.cashToCollect, 450);
  assert.strictEqual(result.unusedPharmacyAdvance, 0);
}

// A clearance cannot accept a mismatched tender total.
assert.throws(
  () => calculateFinalClearanceAmounts({
    outstanding: 700,
    pharmacyAdvanceAvailable: 250,
    ipdAdvanceAvailable: 0,
    pharmacyAdvanceApplied: 250,
    ipdAdvanceApplied: 0,
    paymentTotal: 500,
  }),
  /Payment allocations must equal/
);

console.log('pharmacyFinalClearance.math.test.js: passed');
