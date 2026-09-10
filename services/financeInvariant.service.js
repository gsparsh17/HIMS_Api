const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const idOf = (value) => String(value?._id || value?.id || value || '');
const hasValue = (value) => value !== undefined && value !== null && value !== '';


function calculateChargeAmounts(payload = {}) {
  const quantity = Number(payload.quantity || 1);
  const rate = money(payload.rate);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Quantity must be greater than zero');
  if (rate < 0) throw new Error('Rate cannot be negative');
  const grossAmount = money(quantity * rate);
  const discountType = payload.discountType === 'percentage' ? 'percentage' : 'fixed';
  const discountRate = money(payload.discountRate);
  let discountAmount = money(payload.discountAmount);
  if (discountType === 'percentage') discountAmount = money(grossAmount * Math.max(0, Math.min(100, discountRate)) / 100);
  else discountAmount = Math.max(0, Math.min(grossAmount, discountAmount));
  const afterDiscount = money(grossAmount - discountAmount);
  const taxMode = ['inclusive', 'exempt'].includes(payload.taxMode) ? payload.taxMode : 'exclusive';
  const taxRate = taxMode === 'exempt' ? 0 : Math.max(0, Number(payload.taxRate || 0));
  if (taxRate > 100) throw new Error('Tax rate cannot exceed 100%');
  let taxableAmount = afterDiscount;
  let taxAmount = 0;
  let netAmount = afterDiscount;
  if (taxMode === 'inclusive' && taxRate > 0) {
    taxableAmount = money(afterDiscount / (1 + taxRate / 100));
    taxAmount = money(afterDiscount - taxableAmount);
  } else if (taxMode === 'exclusive' && taxRate > 0) {
    taxAmount = money(taxableAmount * taxRate / 100);
    netAmount = money(taxableAmount + taxAmount);
  }
  return { quantity, rate, grossAmount, discountType, discountRate, discountAmount, taxableAmount, taxMode, taxRate, taxAmount, netAmount };
}

function strongLineIdentity(line = {}) {
  return idOf(
    line._id || line.id || line.charge_id || line.chargeId ||
    line.bill_item_id || line.billItemId ||
    line.request_id || line.requestId ||
    line.lab_test_request_id || line.labTestRequestId ||
    line.radiology_request_id || line.radiologyRequestId ||
    line.procedure_request_id || line.procedureRequestId
  ) || String(line.source_snapshot?.sourceLineKey || line.sourceSnapshot?.sourceLineKey || line.sourceLineKey || '').trim();
}

function canonicalInvoiceLines(invoice = {}) {
  const groups = [
    ...(invoice.service_items || []),
    ...(invoice.procedure_items || []),
    ...(invoice.lab_test_items || []),
    ...(invoice.radiology_items || []),
    ...(invoice.medicine_items || [])
  ];
  const seen = new Set();
  const result = [];
  for (const line of groups) {
    const key = strongLineIdentity(line);
    // Only strong persisted/source identities may deduplicate a financial line.
    // Visually identical services are legitimate and must remain separate rows.
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(line);
  }
  return result;
}

function lineGross(line = {}) {
  const direct = line.gross_amount ?? line.grossAmount;
  if (hasValue(direct)) return money(direct);
  const quantity = Number(line.quantity || 1);
  const unit = line.unit_price ?? line.unitPrice ?? line.rate;
  if (hasValue(unit)) return money(Number(unit) * (Number.isFinite(quantity) && quantity > 0 ? quantity : 1));
  return money(line.amount ?? line.total_price ?? line.totalPrice ?? line.net_amount ?? line.netAmount ?? 0);
}

function lineDiscount(line = {}) {
  return money(line.discount_amount ?? line.discountAmount ?? 0);
}

function lineTax(line = {}) {
  return money(line.tax_amount ?? line.taxAmount ?? 0);
}

function lineNet(line = {}) {
  const explicit = line.net_amount ?? line.netAmount ?? line.total_price ?? line.totalPrice ?? line.amount;
  if (explicit !== undefined && explicit !== null && explicit !== '') return money(explicit);
  return money(Math.max(0, lineGross(line) - lineDiscount(line)) + lineTax(line));
}

function linePatientLiability(line = {}) {
  const explicit = line.patient_liability ?? line.patientLiability;
  return explicit === undefined || explicit === null || explicit === '' ? lineNet(line) : money(explicit);
}

function lineServiceSource(line = {}) {
  const raw = String(
    line.service_type || line.serviceType || line.charge_type || line.chargeType || line.charge_head || line.chargeHead || line.item_type || line.itemType || ''
  ).trim().toLowerCase();
  if (/lab|patholog/.test(raw)) return 'Lab';
  if (/radiolog|imaging|x-?ray|ct|mri|ultrasound/.test(raw)) return 'Radiology';
  if (/procedure|surgery|\bot\b|operation/.test(raw)) return 'Procedure';
  if (/pharmacy|medicine|drug/.test(raw)) return 'Pharmacy';
  if (/consult|appointment|doctor/.test(raw)) return 'Appointment';
  if (/bed|room|ward/.test(raw)) return 'Bed';
  if (/nurs/.test(raw)) return 'Nursing';
  if (/admission|registration/.test(raw)) return 'Admission';
  return raw ? raw.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Other';
}

function invoiceLineTotals(invoice = {}) {
  const lines = canonicalInvoiceLines(invoice);
  return {
    count: lines.length,
    gross: money(lines.reduce((sum, line) => sum + lineGross(line), 0)),
    discount: money(lines.reduce((sum, line) => sum + lineDiscount(line), 0)),
    tax: money(lines.reduce((sum, line) => sum + lineTax(line), 0)),
    net: money(lines.reduce((sum, line) => sum + lineNet(line), 0)),
    patientLiability: money(lines.reduce((sum, line) => sum + linePatientLiability(line), 0))
  };
}

function linkedBillIds(invoice = {}) {
  return Array.from(new Set([invoice.bill_id, ...(invoice.bill_ids || [])].map(idOf).filter(Boolean)));
}


function payerAllocationOf(document = {}) {
  return document.payer_allocation || document.payerAllocation || {};
}

function allocationValue(allocation = {}, snake, camel) {
  if (hasValue(allocation[snake])) return allocation[snake];
  if (camel && hasValue(allocation[camel])) return allocation[camel];
  return undefined;
}

function hasMeaningfulPayerAllocation(document = {}) {
  const allocation = payerAllocationOf(document);
  if (!allocation || typeof allocation !== 'object') return false;

  const identityFields = [
    allocation.coverage_id, allocation.coverageId,
    allocation.payer_id, allocation.payerId,
    allocation.claim_id, allocation.claimId,
    allocation.rate_card_id, allocation.rateCardId,
    allocation.rate_card_version, allocation.rateCardVersion
  ];
  if (identityFields.some((value) => hasValue(value) && String(value) !== '')) return true;

  const numericPairs = [
    ['standard_amount', 'standardAmount'],
    ['contracted_amount', 'contractedAmount'],
    ['eligible_amount', 'eligibleAmount'],
    ['patient_liability', 'patientLiability'],
    ['sponsor_liability', 'sponsorLiability'],
    ['non_admissible_amount', 'nonAdmissibleAmount'],
    ['contractual_adjustment', 'contractualAdjustment'],
    ['hospital_concession', 'hospitalConcession'],
    ['package_absorbed', 'packageAbsorbed'],
    ['sponsor_paid_amount', 'sponsorPaidAmount']
  ];

  return numericPairs.some(([snake, camel]) => {
    const value = allocationValue(allocation, snake, camel);
    return hasValue(value) && Math.abs(Number(value || 0)) > 0.005;
  });
}

function isPatientSettlementInvoice(invoice = {}) {
  const invoiceType = String(invoice.invoice_type || invoice.invoiceType || '').trim().toLowerCase();
  const customerType = String(invoice.customer_type || invoice.customerType || '').trim().toLowerCase();
  const number = String(invoice.invoice_number || invoice.invoiceNumber || '').trim().toUpperCase();

  if (customerType === 'supplier') return false;
  if (invoiceType === 'purchase' || invoiceType === 'purchase order') return false;
  if (invoice.purchase_order_id || invoice.purchaseOrderId) return false;
  if (number.startsWith('PO-')) return false;
  return true;
}

function hospitalDateKeyFromValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function canonicalChargeIdentity(charge = {}) {
  const admissionId = idOf(charge.admissionId || charge.admission_id);
  const sourceModule = String(charge.sourceModule || charge.source_module || '').trim().toUpperCase();
  const sourceId = idOf(charge.sourceId || charge.source_id);
  if (!admissionId || !sourceModule || !sourceId) return '';

  const lineKey = String(
    charge.sourceReference?.lineKey ||
    charge.source_reference?.lineKey ||
    charge.sourceLineKey ||
    charge.source_line_key ||
    ''
  ).trim();
  if (lineKey) return `${admissionId}|${sourceModule}|${sourceId}|LINE:${lineKey}`;

  const serviceCode = String(
    charge.pricingSnapshot?.serviceCode ||
    charge.pricing_snapshot?.serviceCode ||
    charge.externalCode ||
    charge.serviceCode ||
    charge.service_code ||
    ''
  ).trim().toUpperCase();

  const internalServiceId = idOf(
    charge.pricingSnapshot?.internalServiceId ||
    charge.pricing_snapshot?.internalServiceId ||
    charge.internalServiceId ||
    charge.internal_service_id
  );

  const chargeType = String(charge.chargeType || charge.charge_type || '').trim().toUpperCase();
  const description = String(charge.description || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const serviceDiscriminator = serviceCode || internalServiceId || chargeType || description || 'UNSPECIFIED';

  if (sourceModule === 'RECURRINGDAILY') {
    const day = String(charge.chargeDateKey || charge.charge_date_key || '').trim()
      || hospitalDateKeyFromValue(charge.chargeDate || charge.charge_date || charge.createdAt || charge.created_at);
    if (!day) return '';
    return `${admissionId}|${sourceModule}|${sourceId}|DAY:${day}|SERVICE:${serviceDiscriminator}`;
  }

  // Admission commonly creates more than one legitimate source line (for example
  // registration and admission charges) with the same admission/source ids.
  if (sourceModule === 'ADMISSION') {
    return `${admissionId}|${sourceModule}|${sourceId}|SERVICE:${serviceDiscriminator}`;
  }

  return `${admissionId}|${sourceModule}|${sourceId}|SERVICE:${serviceDiscriminator}`;
}

function transactionTargetsInvoice(transaction = {}, invoice = {}, invoiceBillIds = []) {
  const invoiceId = idOf(invoice?._id || invoice);
  if (!invoiceId) return false;
  if (idOf(transaction.invoiceId || transaction.invoice_id) === invoiceId) return true;

  const linkedBills = new Set((invoiceBillIds || []).map(idOf).filter(Boolean));
  if (transaction.billId && linkedBills.has(idOf(transaction.billId))) return true;
  if (transaction.bill_id && linkedBills.has(idOf(transaction.bill_id))) return true;

  return (transaction.documentAllocations || transaction.document_allocations || []).some((allocation) => {
    const type = String(allocation.documentType || allocation.document_type || '').toLowerCase();
    const documentId = idOf(allocation.documentId || allocation.document_id);
    return (type === 'invoice' && documentId === invoiceId)
      || (type === 'bill' && linkedBills.has(documentId));
  });
}

function nearMoney(left, right, tolerance = 0.02) {
  return Math.abs(money(left) - money(right)) <= tolerance;
}

function deriveLegacyTransactionAllocations(transaction = {}, invoice = null, linkedBills = []) {
  const existing = transaction.documentAllocations || transaction.document_allocations || [];
  if (existing.length) return { allocations: existing, deterministic: true, reason: 'already_allocated' };

  const txAmount = money(transaction.amount || transaction.amountApplied || transaction.amount_applied || 0);
  if (txAmount <= 0) return { allocations: [], deterministic: false, reason: 'zero_amount' };

  const receiptKeys = new Set([
    transaction.transactionNumber,
    transaction.transaction_number,
    transaction.paymentReference,
    transaction.payment_reference
  ].filter(Boolean).map((value) => String(value).trim()));

  const linkedById = new Map((linkedBills || []).map((bill) => [idOf(bill._id), bill]));
  const explicitBillId = idOf(transaction.billId || transaction.bill_id);

  // Prefer exact historical Bill payment rows carrying this receipt/reference.
  const byBill = [];
  if (receiptKeys.size) {
    for (const bill of linkedBills || []) {
      const matchedAmount = money((bill.payments || [])
        .filter((payment) => {
          const key = String(payment.reference || payment.transaction_id || payment.receipt_number || '').trim();
          return key && receiptKeys.has(key);
        })
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
      if (matchedAmount > 0) {
        const billCap = money(bill.total_amount ?? bill.total ?? matchedAmount);
        if (matchedAmount > billCap + 0.02) {
          return { allocations: [], deterministic: false, reason: 'bill_history_exceeds_bill_total' };
        }
        byBill.push({ documentType: 'Bill', documentId: bill._id, amount: matchedAmount });
      }
    }
  }

  if (byBill.length && nearMoney(byBill.reduce((sum, row) => sum + row.amount, 0), txAmount)) {
    return { allocations: byBill, deterministic: true, reason: 'matched_bill_payment_history' };
  }

  // A single linked Bill is unambiguous even when old rows have no receipt marker.
  if (invoice && linkedBills.length === 1) {
    return {
      allocations: [{ documentType: 'Bill', documentId: linkedBills[0]._id, amount: txAmount }],
      deterministic: true,
      reason: 'single_linked_bill'
    };
  }

  // A transaction targeting a standalone Bill is also unambiguous.
  if (!invoice && explicitBillId) {
    return {
      allocations: [{ documentType: 'Bill', documentId: transaction.billId || transaction.bill_id, amount: txAmount }],
      deterministic: true,
      reason: 'standalone_bill'
    };
  }

  // If an Invoice has no linked Bills at all, an Invoice allocation is the only
  // document target available. Do not use this fallback for multi-Bill invoices.
  if (invoice && !(linkedBills || []).length) {
    return {
      allocations: [{ documentType: 'Invoice', documentId: invoice._id, amount: txAmount }],
      deterministic: true,
      reason: 'invoice_without_linked_bills'
    };
  }

  // A primary bill id on a consolidated invoice is not enough evidence to place
  // the whole transaction on that bill.
  if (invoice && explicitBillId && linkedById.has(explicitBillId)) {
    return { allocations: [], deterministic: false, reason: 'consolidated_invoice_primary_bill_only' };
  }

  return { allocations: [], deterministic: false, reason: 'ambiguous' };
}


function transactionMatchesAdvanceLedger(entry = {}, transaction = {}) {
  if (String(transaction.status || '').toUpperCase() !== 'POSTED') return false;

  const expectedType = entry.transactionType === 'ADVANCE_DEPOSIT'
    ? 'ADVANCE_DEPOSIT'
    : entry.transactionType === 'REFUND_PAID'
      ? 'ADVANCE_REFUND'
      : ['IPD_INVOICE_DEBIT', 'OUTSTANDING_SETTLEMENT_DEBIT'].includes(entry.transactionType)
        ? 'ADVANCE_UTILISATION'
        : '';
  if (!expectedType || String(transaction.transactionType || '').toUpperCase() !== expectedType) return false;
  if (idOf(transaction.patientId || transaction.patient_id) !== idOf(entry.patientId || entry.patient_id)) return false;
  if (idOf(transaction.admissionId || transaction.admission_id) !== idOf(entry.admissionId || entry.admission_id)) return false;

  const reference = String(entry.referenceNumber || entry.reference_number || '').trim();
  if (!reference) return true;
  const transactionReferences = new Set([
    transaction.transactionNumber,
    transaction.transaction_number,
    transaction.paymentReference,
    transaction.payment_reference,
    transaction.referenceNumber,
    transaction.reference_number,
    transaction.metadata?.linkedReceiptNumber,
    transaction.metadata?.referenceNumber
  ].filter(Boolean).map((value) => String(value).trim()));
  return transactionReferences.has(reference);
}


function derivePharmacyReverseBillLinkRepair(invoice = {}, bills = [], sales = []) {
  const invoiceType = String(invoice.invoice_type || invoice.invoiceType || '').trim().toLowerCase();
  if (invoiceType !== 'pharmacy') return { deterministic: false, reason: 'not_pharmacy_invoice' };

  const invoiceId = idOf(invoice._id);
  const saleId = idOf(invoice.sale_id || invoice.saleId);
  const patientId = idOf(invoice.patient_id || invoice.patientId);
  if (!invoiceId || !saleId || !patientId) {
    return { deterministic: false, reason: 'missing_invoice_sale_or_patient_identity' };
  }

  const matchingSales = (sales || []).filter((sale) => idOf(sale._id) === saleId);
  if (matchingSales.length !== 1) {
    return { deterministic: false, reason: matchingSales.length ? 'multiple_sale_candidates' : 'sale_evidence_missing' };
  }
  const sale = matchingSales[0];
  if (idOf(sale.patient_id || sale.patientId) !== patientId) {
    return { deterministic: false, reason: 'sale_patient_mismatch' };
  }
  const saleInvoiceId = idOf(sale.invoice_id || sale.invoiceId);
  if (saleInvoiceId && saleInvoiceId !== invoiceId) {
    return { deterministic: false, reason: 'sale_invoice_mismatch' };
  }

  const candidates = (bills || []).filter((bill) => {
    if (idOf(bill.patient_id || bill.patientId) !== patientId) return false;
    if (idOf(bill.sale_id || bill.saleId) !== saleId) return false;
    const reverse = new Set([bill.invoice_id, ...(bill.invoice_ids || [])].map(idOf).filter(Boolean));
    return reverse.has(invoiceId);
  });
  if (candidates.length !== 1) {
    return { deterministic: false, reason: candidates.length ? 'multiple_pharmacy_bill_candidates' : 'no_pharmacy_bill_candidate' };
  }

  const bill = candidates[0];
  const invoiceHospital = idOf(invoice.hospital_id || invoice.hospitalId);
  const billHospital = idOf(bill.hospital_id || bill.hospitalId);
  const saleHospital = idOf(sale.hospitalId || sale.hospital_id);
  if (invoiceHospital && billHospital && invoiceHospital !== billHospital) {
    return { deterministic: false, reason: 'invoice_bill_hospital_mismatch', bill, sale };
  }
  if (invoiceHospital && saleHospital && invoiceHospital !== saleHospital) {
    return { deterministic: false, reason: 'invoice_sale_hospital_mismatch', bill, sale };
  }

  const invoiceAdmission = idOf(invoice.admission_id || invoice.admissionId);
  const billAdmission = idOf(bill.admission_id || bill.admissionId);
  const saleAdmission = idOf(sale.admission_id || sale.admissionId);
  if (invoiceAdmission && billAdmission && invoiceAdmission !== billAdmission) {
    return { deterministic: false, reason: 'invoice_bill_admission_mismatch', bill, sale };
  }
  if (invoiceAdmission && saleAdmission && invoiceAdmission !== saleAdmission) {
    return { deterministic: false, reason: 'invoice_sale_admission_mismatch', bill, sale };
  }

  const ownerValues = [
    invoice.collection_owner || invoice.collectionOwner,
    bill.collection_owner || bill.collectionOwner,
    sale.billing_owner || sale.billingOwner
  ].filter(Boolean).map((value) => String(value).trim().toUpperCase());
  if (new Set(ownerValues).size > 1) {
    return { deterministic: false, reason: 'collection_owner_mismatch', bill, sale };
  }
  const modeValues = [
    invoice.collection_mode || invoice.collectionMode,
    bill.collection_mode || bill.collectionMode,
    sale.collection_mode || sale.collectionMode
  ].filter(Boolean).map((value) => String(value).trim().toUpperCase());
  if (new Set(modeValues).size > 1) {
    return { deterministic: false, reason: 'collection_mode_mismatch', bill, sale };
  }

  const invoiceTotal = money(invoice.total ?? invoice.total_amount ?? 0);
  const invoicePaid = money(invoice.amount_paid ?? invoice.paid_amount ?? 0);
  const invoiceBalance = money(invoice.balance_due ?? Math.max(0, invoiceTotal - invoicePaid));
  const billTotal = money(bill.total_amount ?? bill.total ?? 0);
  const billPaid = money(bill.paid_amount ?? 0);
  const billBalance = money(bill.balance_due ?? Math.max(0, billTotal - billPaid));
  const saleTotal = money(sale.total_amount ?? sale.total ?? 0);
  const salePaid = money(sale.amount_paid ?? sale.total_collected_amount ?? 0);
  const saleBalance = money(sale.balance_due ?? Math.max(0, saleTotal - salePaid));

  if (!nearMoney(invoiceTotal, billTotal)
      || !nearMoney(invoicePaid, billPaid)
      || !nearMoney(invoiceBalance, billBalance)
      || !nearMoney(invoiceTotal, saleTotal)
      || !nearMoney(invoicePaid, salePaid)
      || !nearMoney(invoiceBalance, saleBalance)) {
    return { deterministic: false, reason: 'invoice_bill_sale_amounts_do_not_match', bill, sale };
  }

  return {
    deterministic: true,
    reason: 'pharmacy_same_sale_exact_amounts_and_bill_reverse_link',
    bill,
    sale
  };
}

function deriveLegacyPharmacySettlementRepair(invoice = {}, bills = [], transactions = [], sales = []) {
  const invoiceType = String(invoice.invoice_type || invoice.invoiceType || '').trim().toLowerCase();
  if (invoiceType !== 'pharmacy') return { deterministic: false, reason: 'not_pharmacy_invoice' };
  const invoiceId = idOf(invoice._id);
  const saleId = idOf(invoice.sale_id || invoice.saleId);
  const patientId = idOf(invoice.patient_id || invoice.patientId);
  if (!invoiceId || !saleId || !patientId) return { deterministic: false, reason: 'missing_invoice_sale_or_patient_identity' };

  const invoicePaid = money(invoice.amount_paid ?? invoice.paid_amount ?? 0);
  const invoiceTotal = money(invoice.total ?? invoice.total_amount ?? 0);
  const invoiceBalance = money(invoice.balance_due ?? Math.max(0, invoiceTotal - invoicePaid));
  if (invoicePaid <= 0) return { deterministic: false, reason: 'invoice_not_paid' };

  // This migration path is deliberately limited to simple historical Pharmacy
  // collections. Adjusted/refunded/advance/IPD-owned documents require manual review.
  const invoiceAdjustments = money(invoice.refunded_amount ?? invoice.refund_amount ?? 0)
    + money(invoice.settlement_discount_amount ?? 0)
    + money(invoice.credit_note_total ?? invoice.credit_note_amount ?? 0)
    + money(invoice.advance_applied ?? 0);
  if (invoiceAdjustments > 0.02) return { deterministic: false, reason: 'invoice_has_adjustments' };
  if (String(invoice.collection_owner || invoice.collectionOwner || '').toUpperCase() === 'IPD'
      || String(invoice.collection_mode || invoice.collectionMode || '').toUpperCase() === 'IPD_CONSOLIDATED'
      || invoice.collection_transferred_to_ipd === true) {
    return { deterministic: false, reason: 'pharmacy_collection_owned_by_ipd' };
  }

  const matchingSales = (sales || []).filter((sale) => idOf(sale._id) === saleId);
  if (matchingSales.length !== 1) return { deterministic: false, reason: matchingSales.length ? 'multiple_sale_candidates' : 'sale_evidence_missing' };
  const sale = matchingSales[0];
  if (idOf(sale.patient_id || sale.patientId) !== patientId) return { deterministic: false, reason: 'sale_patient_mismatch' };
  const saleInvoiceId = idOf(sale.invoice_id || sale.invoiceId);
  if (saleInvoiceId && saleInvoiceId !== invoiceId) return { deterministic: false, reason: 'sale_invoice_mismatch' };
  if (String(sale.billing_owner || sale.billingOwner || '').toUpperCase() === 'IPD'
      || String(sale.collection_mode || sale.collectionMode || '').toUpperCase() === 'IPD_CONSOLIDATED') {
    return { deterministic: false, reason: 'pharmacy_sale_owned_by_ipd' };
  }

  const candidates = (bills || []).filter((bill) => {
    if (idOf(bill.patient_id || bill.patientId) !== patientId) return false;
    if (idOf(bill.sale_id || bill.saleId) !== saleId) return false;
    const reverse = new Set([bill.invoice_id, ...(bill.invoice_ids || [])].map(idOf).filter(Boolean));
    return reverse.has(invoiceId);
  });
  if (candidates.length !== 1) return { deterministic: false, reason: candidates.length ? 'multiple_pharmacy_bill_candidates' : 'no_pharmacy_bill_candidate' };

  const bill = candidates[0];
  if (String(bill.collection_owner || bill.collectionOwner || '').toUpperCase() === 'IPD'
      || String(bill.collection_mode || bill.collectionMode || '').toUpperCase() === 'IPD_CONSOLIDATED'
      || bill.collection_transferred_to_ipd === true) {
    return { deterministic: false, reason: 'pharmacy_bill_owned_by_ipd', bill, sale };
  }

  const billTotal = money(bill.total_amount ?? bill.total ?? 0);
  const billPaid = money(bill.paid_amount ?? 0);
  const billBalance = money(bill.balance_due ?? Math.max(0, billTotal - billPaid));
  const saleTotal = money(sale.total_amount ?? sale.total ?? 0);
  const salePaid = money(sale.amount_paid ?? sale.total_collected_amount ?? 0);
  const saleBalance = money(sale.balance_due ?? Math.max(0, saleTotal - salePaid));
  if (!nearMoney(invoiceTotal, billTotal) || !nearMoney(invoicePaid, billPaid) || !nearMoney(invoiceBalance, billBalance)
      || !nearMoney(invoiceTotal, saleTotal) || !nearMoney(invoicePaid, salePaid) || !nearMoney(invoiceBalance, saleBalance)) {
    return { deterministic: false, reason: 'invoice_bill_sale_amounts_do_not_match', bill, sale };
  }
  const billAdjustments = money(bill.refund_amount ?? bill.refunded_amount ?? 0)
    + money(bill.settlement_discount_amount ?? 0)
    + money(bill.credit_note_amount ?? 0)
    + money(bill.advance_applied ?? 0);
  const saleAdjustments = money(sale.refunded_amount ?? sale.return_amount ?? 0)
    + money(sale.pharmacy_advance_used ?? 0);
  if (billAdjustments > 0.02 || saleAdjustments > 0.02) return { deterministic: false, reason: 'bill_or_sale_has_adjustments', bill, sale };

  const allowedMethods = new Set(['Cash', 'Card', 'UPI', 'Net Banking', 'Bank', 'Bank Transfer']);
  const normalizePayments = (rows = [], fallbackMethod = 'Cash') => (rows || [])
    .filter((payment) => money(payment.amount) > 0)
    .map((payment, index) => ({
      ...payment,
      __index: index,
      __amount: money(payment.amount),
      __method: String(payment.method || fallbackMethod || 'Cash').trim(),
      __reference: String(payment.reference || '').trim(),
      __time: payment.date ? new Date(payment.date).getTime() : 0
    }))
    .sort((left, right) => left.__time - right.__time || left.__index - right.__index);

  const payments = normalizePayments(bill.payments, bill.payment_method);
  const salePayments = normalizePayments(sale.payments, sale.payment_method);
  if (!payments.length || !salePayments.length) return { deterministic: false, reason: 'bill_or_sale_payment_history_missing', bill, sale };
  if (payments.some((payment) => !allowedMethods.has(payment.__method)) || salePayments.some((payment) => !allowedMethods.has(payment.__method))) {
    return { deterministic: false, reason: 'unsupported_legacy_payment_method', bill, sale };
  }
  const paymentTotal = money(payments.reduce((sum, payment) => sum + payment.__amount, 0));
  const salePaymentTotal = money(salePayments.reduce((sum, payment) => sum + payment.__amount, 0));
  if (!nearMoney(paymentTotal, invoicePaid) || !nearMoney(salePaymentTotal, invoicePaid)) {
    return { deterministic: false, reason: 'bill_or_sale_payment_history_does_not_match_invoice_paid', bill, sale };
  }
  if (payments.length !== salePayments.length) return { deterministic: false, reason: 'bill_sale_payment_count_mismatch', bill, sale };
  for (let index = 0; index < payments.length; index += 1) {
    const left = payments[index];
    const right = salePayments[index];
    if (!nearMoney(left.__amount, right.__amount) || left.__method !== right.__method) {
      return { deterministic: false, reason: 'bill_sale_payment_breakdown_mismatch', bill, sale };
    }
    if (left.__reference && right.__reference && left.__reference !== right.__reference) {
      return { deterministic: false, reason: 'bill_sale_payment_reference_mismatch', bill, sale };
    }
    if (left.__time && right.__time && Math.abs(left.__time - right.__time) > 120000) {
      return { deterministic: false, reason: 'bill_sale_payment_time_mismatch', bill, sale };
    }
  }

  const existing = (transactions || []).filter((tx) => {
    if (String(tx.status || '').toUpperCase() !== 'POSTED') return false;
    if (!['RECEIPT', 'ADVANCE_UTILISATION'].includes(String(tx.transactionType || '').toUpperCase())) return false;
    if (idOf(tx.patientId || tx.patient_id) !== patientId) return false;
    return idOf(tx.invoiceId || tx.invoice_id) === invoiceId
      || idOf(tx.billId || tx.bill_id) === idOf(bill._id)
      || (String(tx.sourceModule || '').toLowerCase() === 'pharmacy' && idOf(tx.sourceId || tx.source_id) === saleId);
  });
  if (existing.length) {
    const existingApplied = money(existing.reduce((sum, tx) => sum + transactionAppliedAmount(tx), 0));
    if (!nearMoney(existingApplied, invoicePaid)) return { deterministic: false, reason: 'existing_pharmacy_transactions_do_not_match_invoice_paid', bill, sale, existingTransactions: existing };
    return { deterministic: true, reason: 'existing_pharmacy_transaction_evidence', bill, sale, payments, existingTransactions: existing, createTransactions: false };
  }

  return {
    deterministic: true,
    reason: 'pharmacy_sale_bill_exact_payment_history',
    bill,
    sale,
    payments,
    existingTransactions: [],
    createTransactions: true
  };
}

function invoicePatientBase(invoice = {}) {
  const allocation = payerAllocationOf(invoice);
  const patientLiability = allocationValue(allocation, 'patient_liability', 'patientLiability');
  // Older documents often contain a schema-default all-zero payer_allocation
  // object even though the invoice is ordinary self-pay. Treat that object as
  // absent unless it carries payer identity or at least one meaningful amount.
  if (hasMeaningfulPayerAllocation(invoice) && hasValue(patientLiability)) return money(patientLiability);
  return money(invoice.total ?? invoice.total_amount ?? 0);
}

function billPatientBase(bill = {}) {
  const allocation = payerAllocationOf(bill);
  const patientLiability = allocationValue(allocation, 'patient_liability', 'patientLiability');
  if (hasMeaningfulPayerAllocation(bill) && hasValue(patientLiability)) return money(patientLiability);
  return money(bill.total_amount ?? bill.total ?? 0);
}

function expectedInvoiceBalance(invoice = {}) {
  return money(Math.max(
    0,
    invoicePatientBase(invoice)
      - money(invoice.amount_paid ?? invoice.paid_amount ?? 0)
      + money(invoice.refunded_amount ?? invoice.refund_amount ?? 0)
      - money(invoice.settlement_discount_amount ?? 0)
      - money(invoice.credit_note_total ?? invoice.credit_note_amount ?? 0)
  ));
}

function expectedBillBalance(bill = {}) {
  return money(Math.max(
    0,
    billPatientBase(bill)
      - money(bill.paid_amount ?? bill.amount_paid ?? 0)
      + money(bill.refund_amount ?? bill.refunded_amount ?? 0)
      - money(bill.settlement_discount_amount ?? 0)
      - money(bill.credit_note_amount ?? bill.credit_note_total ?? 0)
  ));
}

function transactionAppliedAmount(transaction = {}) {
  const type = String(transaction.transactionType || '').toUpperCase();
  const explicit = money(transaction.amountApplied ?? transaction.amount_applied ?? 0);
  if (explicit > 0) return explicit;
  // Older canonical receipts pre-date amountApplied and therefore carry the
  // settled amount only in `amount`. Zero is the schema default, not evidence
  // that nothing was applied.
  if (['RECEIPT', 'ADVANCE_UTILISATION'].includes(type)) return money(transaction.amount || 0);
  return explicit;
}

function transactionExternalAmount(transaction = {}) {
  if (transaction.status && transaction.status !== 'POSTED') return 0;
  if (transaction.externalMoneyMovement === false) return 0;
  const type = String(transaction.transactionType || '').toUpperCase();
  const cashFlowClass = String(transaction.cashFlowClass || '').toUpperCase();
  if (cashFlowClass === 'WALLET_UTILISATION' || cashFlowClass === 'NON_CASH_ADJUSTMENT') return 0;
  if (['REFUND', 'ADVANCE_REFUND'].includes(type)) return 0;
  const explicit = money(transaction.amountReceived ?? transaction.amount_received ?? 0);
  if (explicit > 0) return explicit;
  if (type === 'ADVANCE_UTILISATION') return 0;
  if (type === 'RECEIPT') return money(Math.max(0, Number(transaction.amount || 0) - Number(transaction.advanceApplied || 0)));
  if (type === 'ADVANCE_DEPOSIT') return money(transaction.amount || 0);
  return money(transaction.amount || 0);
}

function isSettlementPayment(transaction = {}) {
  const type = String(transaction.transactionType || '').toUpperCase();
  return transaction.status === 'POSTED' && ['RECEIPT', 'ADVANCE_UTILISATION'].includes(type) && String(transaction.direction || '').toUpperCase() === 'CREDIT';
}

function isRefundTransaction(transaction = {}) {
  const type = String(transaction.transactionType || '').toUpperCase();
  return transaction.status === 'POSTED' && ['REFUND', 'ADVANCE_REFUND'].includes(type) && String(transaction.direction || '').toUpperCase() === 'DEBIT';
}

function allocationTotal(transaction = {}, { documentType } = {}) {
  return money((transaction.documentAllocations || [])
    .filter((allocation) => !documentType || allocation.documentType === documentType)
    .reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0));
}

function paymentReceiptKey(payment = {}) {
  return String(payment.receipt_number || payment.receiptNumber || payment.transaction_id || payment.transactionId || payment.reference || '').trim();
}

function transactionReceiptKey(transaction = {}) {
  return String(transaction.transactionNumber || transaction.referenceNumber || transaction.paymentReference || '').trim();
}

module.exports = {
  money,
  calculateChargeAmounts,
  idOf,
  canonicalInvoiceLines,
  lineGross,
  lineDiscount,
  lineTax,
  lineNet,
  linePatientLiability,
  lineServiceSource,
  invoiceLineTotals,
  linkedBillIds,
  invoicePatientBase,
  billPatientBase,
  expectedInvoiceBalance,
  expectedBillBalance,
  transactionAppliedAmount,
  transactionExternalAmount,
  isSettlementPayment,
  isRefundTransaction,
  allocationTotal,
  paymentReceiptKey,
  transactionReceiptKey,
  strongLineIdentity,
  payerAllocationOf,
  hasMeaningfulPayerAllocation,
  isPatientSettlementInvoice,
  canonicalChargeIdentity,
  transactionTargetsInvoice,
  deriveLegacyTransactionAllocations,
  transactionMatchesAdvanceLedger,
  deriveLegacyPharmacySettlementRepair,
  derivePharmacyReverseBillLinkRepair
};
