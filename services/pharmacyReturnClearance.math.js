'use strict';

// Pure financial arithmetic for pharmacy returns. Keeping this independent from
// database models makes the due-first rule directly testable.
const MONEY_EPSILON = 0.009;

const money = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number)
    ? Math.round((number + Number.EPSILON) * 100) / 100
    : 0;
};

const nonNegativeMoney = (value) => Math.max(0, money(value));

function currentSaleNet(sale) {
  const fallback = nonNegativeMoney(Number(sale?.total_amount || 0) - Number(sale?.return_amount || 0));
  const stored = sale?.net_amount_after_returns;
  if (stored !== undefined && stored !== null && Number.isFinite(Number(stored))) {
    const storedValue = nonNegativeMoney(stored);
    // Older Sale documents received the schema default 0 even when this field
    // did not exist in MongoDB. A non-returned positive sale must therefore use
    // its document total, not be treated as already fully returned.
    if (!(storedValue === 0 && fallback > MONEY_EPSILON)) return storedValue;
  }
  return fallback;
}

/**
 * Returns are applied to the original unpaid amount before any refund/wallet credit.
 * returnValue = outstandingReduction + refundableResidual.
 */
function calculateReturnAllocation(sale, returnValue) {
  const netBefore = currentSaleNet(sale);
  const dueBefore = nonNegativeMoney(sale?.balance_due);
  const requested = money(returnValue);

  if (requested <= 0 || requested > netBefore + MONEY_EPSILON) {
    const error = new Error('Return value exceeds the remaining net value of the original sale.');
    error.status = 400;
    throw error;
  }

  const paidRetainedBefore = nonNegativeMoney(netBefore - dueBefore);
  const outstandingReduction = money(Math.min(requested, dueBefore));
  const refundableResidual = money(requested - outstandingReduction);

  if (refundableResidual > paidRetainedBefore + MONEY_EPSILON) {
    const error = new Error('Return exceeds the paid/refundable value on the original sale. Reconcile the sale before returning it.');
    error.status = 409;
    throw error;
  }

  const netAfter = nonNegativeMoney(netBefore - requested);
  const dueAfter = nonNegativeMoney(dueBefore - outstandingReduction);
  const paidRetainedAfter = nonNegativeMoney(paidRetainedBefore - refundableResidual);

  if (Math.abs(money(netAfter - paidRetainedAfter - dueAfter)) > MONEY_EPSILON) {
    const error = new Error('Return allocation failed the sale arithmetic invariant.');
    error.status = 409;
    throw error;
  }

  return {
    netBefore,
    netAfter,
    dueBefore,
    dueAfter,
    paidRetainedBefore,
    paidRetainedAfter,
    outstandingReduction,
    refundableResidual,
  };
}

/**
 * Final-clearance arithmetic. Pharmacy Advance is applied to the current due
 * first; only the remaining due is collected. Any Pharmacy Advance left after
 * that is a real wallet balance that must be refunded or explicitly retained.
 */
function calculateFinalClearanceAmounts({
  outstanding,
  pharmacyAdvanceAvailable,
  ipdAdvanceAvailable,
  pharmacyAdvanceApplied,
  ipdAdvanceApplied,
  paymentTotal,
} = {}) {
  const due = nonNegativeMoney(outstanding);
  const pharmacyAvailable = nonNegativeMoney(pharmacyAdvanceAvailable);
  const ipdAvailable = nonNegativeMoney(ipdAdvanceAvailable);
  const requestedPharmacy = money(pharmacyAdvanceApplied);
  const requestedIpd = money(ipdAdvanceApplied);

  if (requestedPharmacy < -MONEY_EPSILON || requestedPharmacy > pharmacyAvailable + MONEY_EPSILON) {
    const error = new Error(`Pharmacy Advance applied must be between ₹0 and ₹${pharmacyAvailable}.`);
    error.status = 400;
    throw error;
  }
  const pharmacyApplied = money(Math.min(Math.max(0, requestedPharmacy), due));
  const dueAfterPharmacy = money(due - pharmacyApplied);

  if (requestedIpd < -MONEY_EPSILON || requestedIpd > ipdAvailable + MONEY_EPSILON) {
    const error = new Error(`IPD Advance applied must be between ₹0 and ₹${ipdAvailable}.`);
    error.status = 400;
    throw error;
  }
  const ipdApplied = money(Math.min(Math.max(0, requestedIpd), dueAfterPharmacy));
  const cashToCollect = money(dueAfterPharmacy - ipdApplied);
  const paidNow = nonNegativeMoney(paymentTotal);
  if (Math.abs(paidNow - cashToCollect) > MONEY_EPSILON) {
    const error = new Error(`Payment allocations must equal the remaining amount to collect: ₹${cashToCollect}.`);
    error.status = 400;
    throw error;
  }

  return {
    outstanding: due,
    pharmacyAdvanceAvailable: pharmacyAvailable,
    ipdAdvanceAvailable: ipdAvailable,
    pharmacyAdvanceApplied: pharmacyApplied,
    ipdAdvanceApplied: ipdApplied,
    cashToCollect,
    paymentTotal: paidNow,
    unusedPharmacyAdvance: money(pharmacyAvailable - pharmacyApplied),
  };
}

module.exports = { MONEY_EPSILON, money, nonNegativeMoney, currentSaleNet, calculateReturnAllocation, calculateFinalClearanceAmounts };
