'use strict';

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = numberOrNull(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstNonZeroNumber(...values) {
  for (const value of values) {
    const parsed = numberOrNull(value);
    if (parsed !== null && Math.abs(parsed) > 1e-9) return parsed;
  }
  return null;
}

/**
 * Normalize legacy/current charge or invoice line shapes without allowing a
 * schema-default zero to hide a later real amount.  This is the backend source
 * used by /billing patient details; frontend normalizers are only defensive
 * compatibility for older API payloads.
 */
function normalizeFinancialLine(line = {}) {
  const quantity = Math.max(1, firstNumber(line.quantity, line.qty, 1) ?? 1);
  const unitRateCandidate = firstNonZeroNumber(line.unit_price, line.unitPrice, line.rate, line.price);
  const grossCandidate = firstNonZeroNumber(line.gross_amount, line.grossAmount);
  const amountCandidate = firstNonZeroNumber(line.amount, line.total_price, line.totalAmount, line.total);
  const explicitNetRaw = firstNumber(line.net_amount, line.netAmount);
  const explicitNetNonZero = firstNonZeroNumber(line.net_amount, line.netAmount);
  const discount = firstNumber(line.discount_amount, line.discountAmount, line.discount) ?? 0;
  const tax = firstNumber(line.tax_amount, line.taxAmount, line.tax) ?? 0;
  const taxable = firstNumber(line.taxable_amount, line.taxableAmount);

  const computedFromRate = unitRateCandidate !== null ? unitRateCandidate * quantity : null;
  const grossAmount = grossCandidate ?? computedFromRate ?? amountCandidate ?? explicitNetNonZero ?? 0;

  let netAmount;
  if (explicitNetNonZero !== null) netAmount = explicitNetNonZero;
  else if (amountCandidate !== null) netAmount = amountCandidate;
  else if (explicitNetRaw === 0 && discount > 0 && grossAmount > 0 && discount >= grossAmount - 0.009) netAmount = 0;
  else if (taxable !== null && (Math.abs(taxable) > 1e-9 || Math.abs(tax) > 1e-9)) netAmount = taxable + tax;
  else if (computedFromRate !== null) netAmount = computedFromRate - discount + tax;
  else netAmount = grossAmount - discount + tax;

  const unitRate = unitRateCandidate !== null ? unitRateCandidate : quantity > 0 ? grossAmount / quantity : grossAmount;
  return {
    quantity,
    unitRate: Number(unitRate || 0),
    grossAmount: Number(grossAmount || 0),
    discountAmount: Number(discount || 0),
    taxAmount: Number(tax || 0),
    netAmount: Number(netAmount || 0)
  };
}

module.exports = { normalizeFinancialLine };
