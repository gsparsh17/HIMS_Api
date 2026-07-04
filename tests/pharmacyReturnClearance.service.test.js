'use strict';

const assert = require('assert');
const { calculateReturnAllocation } = require('../services/pharmacyReturnClearance.math');

function sale({ total = 100, due = 0, returned = 0 } = {}) {
  return {
    total_amount: total,
    return_amount: returned,
    net_amount_after_returns: total - returned,
    balance_due: due,
  };
}

// Fully deferred/unpaid: a return reduces due only. It cannot become a wallet credit.
{
  const allocation = calculateReturnAllocation(sale({ total: 100, due: 100 }), 40);
  assert.deepStrictEqual(
    {
      dueBefore: allocation.dueBefore,
      outstandingReduction: allocation.outstandingReduction,
      refundableResidual: allocation.refundableResidual,
      dueAfter: allocation.dueAfter,
    },
    { dueBefore: 100, outstandingReduction: 40, refundableResidual: 0, dueAfter: 60 }
  );
}

// Part-paid: return reduces outstanding first, then only the paid excess is refundable.
{
  const allocation = calculateReturnAllocation(sale({ total: 100, due: 30 }), 40);
  assert.deepStrictEqual(
    {
      dueBefore: allocation.dueBefore,
      outstandingReduction: allocation.outstandingReduction,
      refundableResidual: allocation.refundableResidual,
      dueAfter: allocation.dueAfter,
      paidRetainedAfter: allocation.paidRetainedAfter,
    },
    { dueBefore: 30, outstandingReduction: 30, refundableResidual: 10, dueAfter: 0, paidRetainedAfter: 60 }
  );
}

// Fully paid: a returned amount is refundable because it is entirely paid value.
{
  const allocation = calculateReturnAllocation(sale({ total: 100, due: 0 }), 40);
  assert.strictEqual(allocation.outstandingReduction, 0);
  assert.strictEqual(allocation.refundableResidual, 40);
  assert.strictEqual(allocation.dueAfter, 0);
}

// Never allow a return that exceeds the remaining sale value.
assert.throws(
  () => calculateReturnAllocation(sale({ total: 100, due: 50 }), 101),
  /Return value exceeds/
);

console.log('pharmacyReturnClearance.service.test.js: passed');
