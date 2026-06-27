'use strict';

/**
 * Pure calculation helpers for pharmacy final-ledger settlement.
 * No database access belongs in this file. Amounts are in INR and rounded to 2 decimals.
 */

// ========== CORE MATH HELPERS ==========

function money(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  const rounded = Math.round((number + Number.EPSILON) * 100) / 100;
  return Math.abs(rounded) < 0.005 ? 0 : rounded;
}

function sum(items, selector) {
  return money((items || []).reduce((total, item) => total + Number(selector(item) || 0), 0));
}

function idOf(row) {
  return String(row.saleId || row.sale_id || row._id || '');
}

function assertMoneyEquals(actual, expected, label) {
  if (Math.abs(money(actual) - money(expected)) > 0.01) {
    throw new Error(`${label} must equal ₹${money(expected)}; received ₹${money(actual)}.`);
  }
}

// ========== SORTING ==========

function sortRows(rows, policy) {
  const copy = [...rows];
  switch (policy) {
    case 'FIFO':
      return copy.sort((a, b) => new Date(a.saleDate || a.sale_date || 0) - new Date(b.saleDate || b.sale_date || 0));
    case 'LIFO':
      return copy.sort((a, b) => new Date(b.saleDate || b.sale_date || 0) - new Date(a.saleDate || a.sale_date || 0));
    case 'LARGEST_DUE_FIRST':
      return copy.sort((a, b) => money(b.openingDue) - money(a.openingDue));
    case 'SMALLEST_DUE_FIRST':
      return copy.sort((a, b) => money(a.openingDue) - money(b.openingDue));
    default:
      return copy;
  }
}

// ========== ALLOCATE POOL ==========

function allocatePool(rows, pool, policy = 'PROPORTIONAL', capacityKey = 'openingDue') {
  const amount = money(pool);
  const totalCapacity = sum(rows, (row) => row[capacityKey]);

  if (amount < -0.01) throw new Error('Allocation amount cannot be negative.');
  if (amount > totalCapacity + 0.01) {
    throw new Error(`Allocation amount ₹${amount} exceeds available capacity ₹${totalCapacity}.`);
  }

  const byId = new Map(rows.map((row) => [idOf(row), 0]));
  if (amount <= 0 || rows.length === 0) return byId;

  if (policy === 'PROPORTIONAL') {
    let allocated = 0;
    const totalCapacitySafe = totalCapacity > 0 ? totalCapacity : 1;

    rows.forEach((row, index) => {
      const rowId = idOf(row);
      const capacity = money(row[capacityKey]);

      let value;
      if (index === rows.length - 1) {
        value = money(amount - allocated);
      } else {
        value = money((amount * capacity) / totalCapacitySafe);
      }

      const safe = Math.min(capacity, Math.max(0, value));
      byId.set(rowId, safe);
      allocated = money(allocated + safe);
    });

    // Handle paise residuals
    let residual = money(amount - sum(rows, (row) => byId.get(idOf(row))));
    for (const row of rows) {
      if (residual <= 0) break;
      const rowId = idOf(row);
      const remaining = money(row[capacityKey] - byId.get(rowId));
      const use = Math.min(remaining, residual);
      byId.set(rowId, money(byId.get(rowId) + use));
      residual = money(residual - use);
    }
    return byId;
  }

  // Policy-based allocation (FIFO, LIFO, etc.)
  let remaining = amount;
  for (const row of sortRows(rows, policy)) {
    if (remaining <= 0) break;
    const rowId = idOf(row);
    const use = Math.min(money(row[capacityKey]), remaining);
    byId.set(rowId, money(use));
    remaining = money(remaining - use);
  }
  return byId;
}

// ========== BUILD FINAL CONCESSION ALLOCATIONS ==========

function buildFinalConcessionAllocations(openRows, options = {}) {
  const rows = (openRows || [])
    .map((row) => ({
      ...row,
      saleId: idOf(row),
      openingDue: money(row.openingDue),
    }))
    .filter((row) => row.openingDue > 0);

  const totalDue = sum(rows, (row) => row.openingDue);
  const discountToApply = Math.min(money(options.discountToApply), totalDue);
  const policy = options.allocationPolicy || 'PROPORTIONAL';

  // Manual allocation mode
  if (policy === 'MANUAL') {
    const manualById = new Map(
      (options.manualAllocations || []).map((allocation) => [String(allocation.saleId), allocation])
    );

    const allocations = rows.map((row) => {
      const manual = manualById.get(row.saleId) || {};
      const paymentAllocated = money(manual.paymentAllocated);
      const settlementDiscountAllocated = money(manual.settlementDiscountAllocated);

      if (paymentAllocated < 0 || settlementDiscountAllocated < 0) {
        throw new Error(`Negative allocation is not allowed for sale ${row.saleId}.`);
      }

      assertMoneyEquals(
        paymentAllocated + settlementDiscountAllocated,
        row.openingDue,
        `Allocation for sale ${row.saleId}`
      );

      const closingDue = Math.max(0, row.openingDue - paymentAllocated - settlementDiscountAllocated);

      return {
        ...row,
        paymentAllocated,
        settlementDiscountAllocated,
        creditNoteAllocated: 0,
        unapplied: 0,
        closingDue: money(closingDue),
      };
    });

    assertMoneyEquals(
      sum(allocations, (row) => row.settlementDiscountAllocated),
      discountToApply,
      'Manual discount allocation total'
    );

    assertMoneyEquals(
      sum(allocations, (row) => row.paymentAllocated),
      money(totalDue - discountToApply),
      'Manual payment allocation total'
    );

    return allocations;
  }

  // Automatic allocation
  const discounts = allocatePool(rows, discountToApply, policy, 'openingDue');

  return rows.map((row) => {
    const settlementDiscountAllocated = money(discounts.get(row.saleId));
    const paymentAllocated = money(row.openingDue - settlementDiscountAllocated);
    const closingDue = Math.max(0, row.openingDue - paymentAllocated - settlementDiscountAllocated);

    return {
      ...row,
      paymentAllocated,
      settlementDiscountAllocated,
      creditNoteAllocated: 0,
      unapplied: 0,
      closingDue: money(closingDue),
    };
  });
}

// ========== BUILD RETROACTIVE ALLOCATIONS ==========

function buildRetroactiveAllocations(allRows, options = {}) {
  const rows = (allRows || []).map((row) => ({
    ...row,
    saleId: idOf(row),
    openingDue: money(row.openingDue),
    amountPaid: money(row.amountPaid),
    grossAmount: money(row.grossAmount),
    existingDiscounts: money(row.existingDiscounts),
  }));

  const discountType = options.discountType || 'PERCENTAGE';
  const treatment = options.percentageTreatment || 'ADDITIONAL';
  const policy = options.allocationPolicy || 'PROPORTIONAL';

  let requestedById = new Map();

  // Percentage discount
  if (discountType === 'PERCENTAGE') {
    const rate = Number(options.discountValue || 0);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      throw new Error('Percentage discount must be between 0 and 100.');
    }

    for (const row of rows) {
      const calculated = money((row.grossAmount * rate) / 100);
      const requested = treatment === 'TARGET_TOTAL_DISCOUNT'
        ? Math.max(0, money(calculated - row.existingDiscounts))
        : calculated;
      requestedById.set(row.saleId, requested);
    }
  } else {
    // Fixed amount discount
    const pool = money(options.discountValue);

    const capacities = rows.map((row) => ({
      ...row,
      discountCapacity: money(row.amountPaid + row.openingDue),
    }));

    if (policy === 'MANUAL') {
      const manualById = new Map(
        (options.manualAllocations || []).map((allocation) => [String(allocation.saleId), allocation])
      );

      for (const row of capacities) {
        const manual = manualById.get(row.saleId) || {};
        requestedById.set(
          row.saleId,
          money(manual.settlementDiscountAllocated) + money(manual.creditNoteAllocated)
        );
      }

      assertMoneyEquals(
        sum(capacities, (row) => requestedById.get(row.saleId)),
        pool,
        'Manual retroactive discount allocation total'
      );
    } else {
      requestedById = allocatePool(capacities, pool, policy, 'discountCapacity');
    }
  }

  // Build allocations
  const allocations = rows.map((row) => {
    const requested = money(requestedById.get(row.saleId) || 0);

    // First apply discount to opening due
    const settlementDiscountAllocated = Math.min(row.openingDue, requested);
    const remainingCredit = money(requested - settlementDiscountAllocated);

    // Then apply remaining credit to amount paid (credit note)
    const creditNoteAllocated = Math.min(row.amountPaid, remainingCredit);
    const unapplied = money(remainingCredit - creditNoteAllocated);

    // Payment is the remaining opening due after discount
    const paymentAllocated = money(row.openingDue - settlementDiscountAllocated);
    const closingDue = Math.max(0, row.openingDue - paymentAllocated - settlementDiscountAllocated);

    return {
      ...row,
      paymentAllocated,
      settlementDiscountAllocated,
      creditNoteAllocated,
      unapplied,
      closingDue: money(closingDue),
    };
  });

  return allocations;
}

// ========== ALLOCATE PAYMENT METHODS TO SALES ==========

function allocatePaymentMethodsToSales(paymentSources, allocations) {
  const sources = (paymentSources || []).map((source) => ({
    ...source,
    remaining: money(source.amount),
  }));

  const result = new Map();

  for (const allocation of allocations || []) {
    let remaining = money(allocation.paymentAllocated);
    const entries = [];

    for (const source of sources) {
      if (remaining <= 0) break;
      const use = Math.min(source.remaining, remaining);
      if (use <= 0) continue;

      entries.push({
        method: source.method,
        amount: money(use),
        reference: source.reference || '',
        walletType: source.walletType || null,
      });

      source.remaining = money(source.remaining - use);
      remaining = money(remaining - use);
    }

    if (remaining > 0.01) {
      throw new Error(`Payment sources are insufficient for sale ${allocation.saleId}.`);
    }

    result.set(String(allocation.saleId), entries);
  }

  // Verify no unused payment sources
  const unused = sum(sources, (source) => source.remaining);
  if (unused > 0.01) {
    throw new Error(`Receipt has ₹${unused} that was not allocated to any sale.`);
  }

  return result;
}

// ========== EXPORTS ==========

module.exports = {
  money,
  sum,
  buildFinalConcessionAllocations,
  buildRetroactiveAllocations,
  allocatePaymentMethodsToSales,
};