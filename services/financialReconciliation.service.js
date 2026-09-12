const crypto = require('crypto');
const mongoose = require('mongoose');
const IPDCharge = require('../models/IPDCharge');
const IPDAdmission = require('../models/IPDAdmission');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const FinancialTransaction = require('../models/FinancialTransaction');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const FinancialReconciliationIssue = require('../models/FinancialReconciliationIssue');
const {
  money,
  idOf,
  canonicalInvoiceLines,
  invoiceLineTotals,
  linkedBillIds,
  expectedInvoiceBalance,
  expectedBillBalance,
  transactionAppliedAmount,
  allocationTotal,
  paymentReceiptKey,
  transactionReceiptKey,
  isPatientSettlementInvoice,
  canonicalChargeIdentity,
  transactionTargetsInvoice,
  deriveLegacyTransactionAllocations,
  transactionMatchesAdvanceLedger
} = require('./financeInvariant.service');

const EPSILON = 0.02;
const oid = (value) => value && mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : value;
const makeRunId = () => `FINREC-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
const near = (left, right, tolerance = EPSILON) => Math.abs(money(left) - money(right)) <= tolerance;

function issue(category, severity, entityType, entityId, summary, details = {}, options = {}) {
  const keySeed = `${category}:${entityType}:${entityId || ''}:${options.discriminator || ''}`;
  return {
    issueKey: crypto.createHash('sha256').update(keySeed).digest('hex'),
    category,
    severity,
    entityType,
    entityId: oid(entityId),
    summary,
    details,
    deterministicFix: Boolean(options.deterministicFix),
    suggestedAction: options.suggestedAction || ''
  };
}

function appointmentIdFromBill(bill = {}) {
  if (bill.appointment_id) return idOf(bill.appointment_id);
  const ids = new Set();
  for (const item of bill.items || []) {
    const snapshot = item?.source_snapshot || item?.sourceSnapshot || {};
    const origin = String(snapshot.originModule || snapshot.sourceModule || '').toLowerCase();
    if (origin === 'appointment' && snapshot.sourceId) ids.add(idOf(snapshot.sourceId));
    const match = String(snapshot.sourceLineKey || '').match(/^appointment:([^:]+):/i);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids.size === 1 ? [...ids][0] : '';
}

function paymentTransactionsForInvoice(transactions, invoice, invoiceBillIds = []) {
  return transactions.filter((tx) => {
    if (tx.status !== 'POSTED') return false;
    const type = String(tx.transactionType || '').toUpperCase();
    if (!['RECEIPT', 'ADVANCE_UTILISATION'].includes(type)) return false;
    return transactionTargetsInvoice(tx, invoice, invoiceBillIds);
  });
}

function adjustmentTransactionsForInvoice(transactions, invoice, type, invoiceBillIds = []) {
  return transactions.filter((tx) => tx.status === 'POSTED'
    && String(tx.transactionType || '').toUpperCase() === type
    && transactionTargetsInvoice(tx, invoice, invoiceBillIds));
}

async function scanCharges(hospitalId, invoiceMap) {
  const rows = await IPDCharge.find({ hospitalId }).select('admissionId patientId hospitalId status isBilled billId invoiceId sourceModule sourceId sourceReference netAmount').lean();
  const results = [];
  for (const row of rows) {
    if ((row.isBilled || row.status === 'INVOICED') && !row.invoiceId) {
      results.push(issue('CHARGE_WITHOUT_INVOICE', 'HIGH', 'IPDCharge', row._id,
        'Charge is marked invoiced but has no invoice link.', row,
        { suggestedAction: 'Locate the unique invoice line by charge_id before backfilling; otherwise resolve manually.' }));
    }
    if (row.invoiceId && !invoiceMap.has(idOf(row.invoiceId))) {
      results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'IPDCharge', row._id,
        'Charge references a missing or cross-hospital invoice.', { invoiceId: row.invoiceId },
        { suggestedAction: 'Do not reinvoice automatically. Investigate and correct the broken link.' }));
    }
  }

  // Duplicate detection must use a real source-line identity. Recurring daily
  // room/bed/nursing charges intentionally reuse their source document across
  // different service days, and Admission may legitimately produce more than
  // one source line (for example registration + admission). Grouping only on
  // admission/sourceModule/sourceId therefore creates destructive false positives.
  const activeSourceRows = await IPDCharge.find({
    hospitalId,
    status: { $in: ['ACTIVE', 'INVOICED'] },
    sourceId: { $ne: null }
  }).select(
    '_id admissionId sourceModule sourceId sourceReference chargeDate chargeDateKey chargeType description pricingSnapshot idempotencyKey status isBilled invoiceId billId'
  ).lean();
  const groups = new Map();
  for (const charge of activeSourceRows) {
    const identity = canonicalChargeIdentity(charge);
    if (!identity) continue;
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(charge);
  }
  for (const [identity, matches] of groups.entries()) {
    if (matches.length <= 1) continue;
    results.push(issue('DUPLICATE_SOURCE_CHARGE', 'CRITICAL', 'IPDCharge', matches[0]._id,
      'Multiple active/invoiced charges share the same canonical source-line identity.',
      {
        identity,
        ids: matches.map((row) => row._id),
        count: matches.length,
        sourceModule: matches[0].sourceModule,
        sourceId: matches[0].sourceId,
        chargeDateKey: matches[0].chargeDateKey,
        serviceCode: matches[0].pricingSnapshot?.serviceCode
      },
      { discriminator: matches.map((row) => idOf(row._id)).sort().join(','), suggestedAction: 'Review source history; void only a genuinely duplicated unbilled source line with an authorised reason.' }));
  }
  return results;
}

async function scanDocuments(hospitalId, { invoices, bills, transactions }) {
  const results = [];
  const billMap = new Map(bills.map((row) => [idOf(row._id), row]));
  const invoiceMap = new Map(invoices.map((row) => [idOf(row._id), row]));

  for (const invoice of invoices) {
    const isCreditNote = invoice.document_stage === 'CREDIT_NOTE' || invoice.invoice_type === 'Credit Note';
    const patientSettlementDocument = isPatientSettlementInvoice(invoice);
    const linkedIds = linkedBillIds(invoice);
    const linkedBills = linkedIds.map((billId) => billMap.get(billId)).filter(Boolean);

    if (!isCreditNote && patientSettlementDocument && !linkedIds.length && !invoice.is_pharmacy_sale) {
      results.push(issue('ORPHAN_DOCUMENT', 'HIGH', 'Invoice', invoice._id,
        'Patient invoice has no linked Bill.', { invoiceNumber: invoice.invoice_number },
        { suggestedAction: 'Confirm the source document and backfill only when the relationship is unambiguous.' }));
    }
    if (linkedBills.length !== linkedIds.length) {
      results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'Invoice', invoice._id,
        'One or more linked Bills are missing or outside the hospital scope.', { linkedIds, found: linkedBills.map((row) => row._id) }));
    }

    // Any Invoice-shaped document that explicitly references Bills, including
    // Credit Notes, must be mirrored by Bill.invoice_ids. Bill.invoice_id remains
    // the primary issued settlement document; adjustment documents belong only in
    // the plural audit linkage.
    for (const linkedBill of linkedBills) {
      const reverseIds = new Set([linkedBill.invoice_id, ...(linkedBill.invoice_ids || [])].map(idOf).filter(Boolean));
      if (!reverseIds.has(idOf(invoice._id))) {
        results.push(issue('BIDIRECTIONAL_LINK_MISMATCH', 'HIGH', 'Invoice', invoice._id,
          'Invoice links a Bill that does not link back to the Invoice.', { billId: linkedBill._id, billNumber: linkedBill.bill_number },
          { discriminator: idOf(linkedBill._id) }));
      }
    }

    if (!isCreditNote && patientSettlementDocument) {
      const lineTotals = invoiceLineTotals(invoice);
      if (lineTotals.count > 0 && !near(lineTotals.net, invoice.total)) {
        results.push(issue('INVOICE_SERVICE_TOTAL_MISMATCH', 'CRITICAL', 'Invoice', invoice._id,
          'Persisted invoice service-line net total does not equal the issued invoice total.',
          { invoiceNumber: invoice.invoice_number, lineCount: lineTotals.count, lineNetTotal: lineTotals.net, invoiceTotal: money(invoice.total) },
          { suggestedAction: 'Do not recompute the historical invoice. Inspect source snapshots and issue an approved correction if required.' }));
      }

      if (linkedBills.length) {
        const billTotal = money(linkedBills.reduce((sum, bill) => sum + Number(bill.total_amount || 0), 0));
        if (!near(billTotal, invoice.total)) {
          results.push(issue('BILL_INVOICE_TOTAL_MISMATCH', 'HIGH', 'Invoice', invoice._id,
            'Linked Bill total does not equal issued Invoice total.',
            { invoiceNumber: invoice.invoice_number, billTotal, invoiceTotal: money(invoice.total), billIds: linkedIds },
            { suggestedAction: 'Do not rewrite historical totals. Use an approved correction or credit/debit note workflow.' }));
        }
      }

      const expectedBalance = expectedInvoiceBalance(invoice);
      if (!near(expectedBalance, invoice.balance_due)) {
        results.push(issue('INVOICE_BALANCE_MISMATCH', 'CRITICAL', 'Invoice', invoice._id,
          'Invoice balance does not reconcile from liability, payments, refunds, settlement discounts and credit notes.',
          { invoiceNumber: invoice.invoice_number, expectedBalance, actualBalance: money(invoice.balance_due), amountPaid: money(invoice.amount_paid), refunded: money(invoice.refunded_amount), advanceTransferred: money(invoice.advance_transferred_amount), settlementDiscount: money(invoice.settlement_discount_amount), creditNotes: money(invoice.credit_note_total) },
          { suggestedAction: 'Repair the projection only after confirming the posted transaction ledger.' }));
      }

      if (Number(invoice.balance_due || 0) < -EPSILON) {
        results.push(issue('NEGATIVE_BALANCE', 'CRITICAL', 'Invoice', invoice._id, 'Invoice has a negative balance.', { balanceDue: invoice.balance_due }));
      }
      if (String(invoice.status || '').toLowerCase() === 'paid' && Number(invoice.balance_due || 0) > EPSILON) {
        results.push(issue('PAID_DOCUMENT_WITH_POSITIVE_BALANCE', 'CRITICAL', 'Invoice', invoice._id,
          'Invoice is marked Paid while a positive balance remains.', { balanceDue: invoice.balance_due }));
      }

      const appointmentIds = new Set(linkedBills.map(appointmentIdFromBill).filter(Boolean));
      if (appointmentIds.size > 1) {
        results.push(issue('INVOICE_WITH_MULTIPLE_UNRELATED_ENCOUNTERS', 'CRITICAL', 'Invoice', invoice._id,
          'One OPD invoice links Bills from multiple appointments.', { appointmentIds: [...appointmentIds], billIds: linkedIds }));
      }

      const paymentTx = paymentTransactionsForInvoice(transactions, invoice, linkedIds);
      const postedPaid = money(paymentTx.reduce((sum, tx) => sum + transactionAppliedAmount(tx), 0));
      if (!near(postedPaid, invoice.amount_paid)) {
        results.push(issue('INVOICE_PAYMENT_TOTAL_MISMATCH', 'HIGH', 'Invoice', invoice._id,
          'Invoice amount_paid does not equal posted receipt/advance-utilisation allocations.',
          { invoiceNumber: invoice.invoice_number, invoiceAmountPaid: money(invoice.amount_paid), postedApplied: postedPaid, transactionIds: paymentTx.map((row) => row._id) },
          { suggestedAction: 'Treat FinancialTransaction as settlement authority; inspect legacy payment history before projection repair.' }));
      }

      const settlementTx = adjustmentTransactionsForInvoice(transactions, invoice, 'SETTLEMENT', linkedIds);
      const postedSettlement = money(settlementTx.reduce((sum, tx) => sum + Number(tx.settlementDiscountAmount || tx.amount || 0), 0));
      if (!near(postedSettlement, invoice.settlement_discount_amount)) {
        results.push(issue('SETTLEMENT_PROJECTION_MISMATCH', 'MEDIUM', 'Invoice', invoice._id,
          'Invoice settlement-discount projection does not equal posted settlement transactions.',
          { invoiceSettlementDiscount: money(invoice.settlement_discount_amount), postedSettlement },
          { discriminator: 'SETTLEMENT' }));
      }

      const creditTx = adjustmentTransactionsForInvoice(transactions, invoice, 'CREDIT_NOTE', linkedIds);
      const postedCredit = money(creditTx.reduce((sum, tx) => sum + Number(tx.amount || 0), 0));
      if (!near(postedCredit, invoice.credit_note_total)) {
        results.push(issue('CREDIT_NOTE_PROJECTION_MISMATCH', 'HIGH', 'Invoice', invoice._id,
          'Invoice credit-note projection does not equal posted CREDIT_NOTE transactions.',
          { invoiceCreditNoteTotal: money(invoice.credit_note_total), postedCredit }));
      }

      const refundTx = adjustmentTransactionsForInvoice(transactions, invoice, 'REFUND', linkedIds);
      const postedRefund = money(refundTx.reduce((sum, tx) => sum + Number(tx.amount || 0), 0));
      if (!near(postedRefund, invoice.refunded_amount)) {
        results.push(issue('REFUND_PROJECTION_MISMATCH', 'HIGH', 'Invoice', invoice._id,
          'Invoice refunded_amount does not equal posted REFUND transactions.',
          { invoiceRefundedAmount: money(invoice.refunded_amount), postedRefund }));
      }

      const historyByReceipt = new Map();
      for (const payment of invoice.payment_history || []) {
        if (payment.status && payment.status !== 'Completed') continue;
        const receipt = paymentReceiptKey(payment);
        if (!receipt) continue;
        historyByReceipt.set(receipt, money((historyByReceipt.get(receipt) || 0) + Number(payment.amount || 0)));
      }
      for (const [receipt, historyAmount] of historyByReceipt.entries()) {
        const matched = paymentTx.filter((tx) => transactionReceiptKey(tx) === receipt);
        if (!matched.length) {
          results.push(issue('RECEIPT_TRANSACTION_MISMATCH', 'HIGH', 'Invoice', invoice._id,
            'Invoice payment history references a receipt with no posted FinancialTransaction.',
            { invoiceNumber: invoice.invoice_number, receipt, historyAmount }, { discriminator: receipt }));
          continue;
        }
        const transactionAmount = money(matched.reduce((sum, tx) => sum + transactionAppliedAmount(tx), 0));
        if (!near(historyAmount, transactionAmount)) {
          results.push(issue('RECEIPT_AMOUNT_MISMATCH', 'CRITICAL', 'Invoice', invoice._id,
            'Invoice payment-history amount does not equal the posted transaction amount for the same receipt.',
            { receipt, historyAmount, transactionAmount }, { discriminator: receipt }));
        }
      }
    }
  }

  for (const creditNote of invoices.filter((row) => row.document_stage === 'CREDIT_NOTE' || row.invoice_type === 'Credit Note')) {
    const linkedInvoiceId = idOf(creditNote.linked_invoice_id);
    const matchingTransaction = transactions.find((tx) => tx.status === 'POSTED'
      && String(tx.transactionType || '').toUpperCase() === 'CREDIT_NOTE'
      && idOf(tx.sourceId) === idOf(creditNote._id));
    if (!matchingTransaction) {
      results.push(issue('CREDIT_NOTE_WITHOUT_TRANSACTION', 'HIGH', 'Invoice', creditNote._id,
        'Credit-note document has no matching posted CREDIT_NOTE FinancialTransaction.',
        { creditNoteNumber: creditNote.invoice_number, linkedInvoiceId }));
    }
    if (linkedInvoiceId && !invoiceMap.has(linkedInvoiceId)) {
      results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'Invoice', creditNote._id,
        'Credit note references a missing or cross-hospital original Invoice.',
        { creditNoteNumber: creditNote.invoice_number, linkedInvoiceId }, { discriminator: linkedInvoiceId }));
    }
  }

  for (const bill of bills) {
    const expectedBalance = expectedBillBalance(bill);
    if (!near(expectedBalance, bill.balance_due)) {
      results.push(issue('BILL_BALANCE_MISMATCH', 'HIGH', 'Bill', bill._id,
        'Bill balance projection does not reconcile from liability, payments, refunds, discounts and credit notes.',
        { billNumber: bill.bill_number, expectedBalance, actualBalance: money(bill.balance_due), paid: money(bill.paid_amount), refunded: money(bill.refund_amount), settlementDiscount: money(bill.settlement_discount_amount), creditNote: money(bill.credit_note_amount) }));
    }
    if (Number(bill.balance_due || 0) < -EPSILON) {
      results.push(issue('NEGATIVE_BALANCE', 'CRITICAL', 'Bill', bill._id, 'Bill has a negative balance.', { balanceDue: bill.balance_due }));
    }
    if (String(bill.status || '').toLowerCase() === 'paid' && Number(bill.balance_due || 0) > EPSILON) {
      results.push(issue('PAID_DOCUMENT_WITH_POSITIVE_BALANCE', 'CRITICAL', 'Bill', bill._id,
        'Bill is marked Paid while a positive balance remains.', { balanceDue: bill.balance_due }));
    }

    const invoiceIds = new Set([bill.invoice_id, ...(bill.invoice_ids || [])].map(idOf).filter(Boolean));
    for (const invoiceId of invoiceIds) {
      const invoice = invoiceMap.get(invoiceId);
      if (!invoice) {
        results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'Bill', bill._id,
          'Bill references a missing or cross-hospital Invoice.', { invoiceId }, { discriminator: invoiceId }));
      } else if (!new Set(linkedBillIds(invoice)).has(idOf(bill._id))) {
        results.push(issue('BIDIRECTIONAL_LINK_MISMATCH', 'HIGH', 'Bill', bill._id,
          'Bill links an Invoice that does not contain the Bill in bill_id/bill_ids.', { invoiceId, invoiceNumber: invoice.invoice_number }, { discriminator: invoiceId }));
      }
    }
  }

  return results;
}

async function scanCollections(hospitalId, { invoices, bills, archivedInvoices = [], archivedBills = [], transactions }) {
  const results = [];
  // Posted financial history is append-only. An administrator may emergency-
  // archive an issued document after its money is fully resolved; that soft-
  // deleted document still exists as the audit target for historical ledger
  // transactions and must not be treated as a missing/orphan document.
  const invoiceMap = new Map([...invoices, ...archivedInvoices].map((row) => [idOf(row._id), row]));
  const billMap = new Map([...bills, ...archivedBills].map((row) => [idOf(row._id), row]));

  const duplicates = await FinancialTransaction.aggregate([
    { $match: { hospitalId: oid(hospitalId), status: 'POSTED' } },
    { $group: { _id: { idempotencyKey: '$idempotencyKey' }, ids: { $push: '$_id' }, count: { $sum: 1 }, total: { $sum: '$amount' } } },
    { $match: { count: { $gt: 1 }, '_id.idempotencyKey': { $nin: [null, ''] } } }
  ]);
  for (const row of duplicates) {
    results.push(issue('DUPLICATE_COLLECTION', 'CRITICAL', 'FinancialTransaction', row.ids[0],
      'Multiple posted financial transactions share one idempotency key.', row,
      { discriminator: row.ids.join(','), suggestedAction: 'Reverse the confirmed duplicate; never delete posted financial history.' }));
  }

  for (const tx of transactions) {
    if (tx.status !== 'POSTED') continue;
    const type = String(tx.transactionType || '').toUpperCase();
    const allocations = tx.documentAllocations || [];
    if (tx.invoiceId) {
      const targetInvoice = invoiceMap.get(idOf(tx.invoiceId));
      if (!targetInvoice) {
        results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'FinancialTransaction', tx._id,
          'Transaction references a missing or cross-hospital Invoice.',
          { invoiceId: tx.invoiceId, transactionNumber: tx.transactionNumber }, { discriminator: `invoice:${idOf(tx.invoiceId)}` }));
      } else if (targetInvoice.document_stage === 'VOID' || targetInvoice.status === 'Cancelled') {
        results.push(issue('PAYMENT_ALLOCATED_TO_VOID_INVOICE', 'CRITICAL', 'FinancialTransaction', tx._id,
          'Posted transaction targets a void/cancelled Invoice.',
          { invoiceId: targetInvoice._id, invoiceNumber: targetInvoice.invoice_number, transactionNumber: tx.transactionNumber },
          { discriminator: `top:${idOf(targetInvoice._id)}` }));
      }
    }
    if (type === 'REFUND') {
      const creditNoteId = idOf(tx.metadata?.creditNoteId || tx.sourceId);
      const creditTransactionId = idOf(tx.metadata?.creditTransactionId);
      const creditDocument = creditNoteId ? invoiceMap.get(creditNoteId) : null;
      const creditTransaction = creditTransactionId
        ? transactions.find((row) => idOf(row._id) === creditTransactionId && row.status === 'POSTED' && String(row.transactionType || '').toUpperCase() === 'CREDIT_NOTE')
        : transactions.find((row) => row.status === 'POSTED' && String(row.transactionType || '').toUpperCase() === 'CREDIT_NOTE' && idOf(row.sourceId) === creditNoteId);
      if (!creditDocument || !creditTransaction || !near(creditTransaction.amount, tx.amount)) {
        results.push(issue('REFUND_WITHOUT_CREDIT_NOTE', 'CRITICAL', 'FinancialTransaction', tx._id,
          'Invoice refund is not paired with an equal posted credit-note document/transaction.',
          { transactionNumber: tx.transactionNumber, refundAmount: money(tx.amount), creditNoteId, creditTransactionId: creditTransaction?._id, creditAmount: money(creditTransaction?.amount) }));
      }
    }
    const requiresAllocation = ['RECEIPT', 'ADVANCE_UTILISATION', 'SETTLEMENT', 'CREDIT_NOTE', 'REFUND'].includes(type)
      && Boolean(tx.invoiceId || tx.billId);
    if (requiresAllocation && !allocations.length) {
      const invoice = tx.invoiceId ? invoiceMap.get(idOf(tx.invoiceId)) : null;
      const linkedBills = invoice
        ? linkedBillIds(invoice).map((billId) => billMap.get(billId)).filter(Boolean)
        : [];
      const repair = deriveLegacyTransactionAllocations(tx, invoice, linkedBills);
      results.push(issue('PAYMENT_WITHOUT_ALLOCATION', type === 'RECEIPT' ? 'HIGH' : 'MEDIUM', 'FinancialTransaction', tx._id,
        'Posted financial transaction targets a document but has no documentAllocations.',
        {
          transactionNumber: tx.transactionNumber,
          transactionType: tx.transactionType,
          invoiceId: tx.invoiceId,
          billId: tx.billId,
          deterministicRepair: repair.deterministic,
          repairReason: repair.reason,
          proposedAllocations: repair.deterministic ? repair.allocations : []
        },
        {
          deterministicFix: repair.deterministic,
          suggestedAction: repair.deterministic
            ? 'Run the dry-run legacy allocation repair utility and review the proposed allocation before applying.'
            : 'Historical allocation is ambiguous; retain for manual reconciliation rather than assigning the full payment to a primary Bill.'
        }));
    }

    if (allocations.length && ['RECEIPT', 'ADVANCE_UTILISATION', 'SETTLEMENT', 'CREDIT_NOTE', 'REFUND'].includes(type)) {
      const allocated = allocationTotal(tx);
      if (!near(allocated, tx.amount)) {
        results.push(issue('PAYMENT_ALLOCATION_MISMATCH', 'CRITICAL', 'FinancialTransaction', tx._id,
          'Transaction amount does not equal the sum of document allocations.',
          { transactionNumber: tx.transactionNumber, transactionAmount: money(tx.amount), allocationTotal: allocated }));
      }
    }

    for (const allocation of allocations) {
      if (allocation.documentType === 'Invoice') {
        const invoice = invoiceMap.get(idOf(allocation.documentId));
        if (!invoice) {
          results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'FinancialTransaction', tx._id,
            'Transaction allocation references a missing Invoice.', { allocation }, { discriminator: idOf(allocation.documentId) }));
        } else if (invoice.document_stage === 'VOID' || invoice.status === 'Cancelled') {
          results.push(issue('PAYMENT_ALLOCATED_TO_VOID_INVOICE', 'CRITICAL', 'FinancialTransaction', tx._id,
            'Posted transaction is allocated to a void/cancelled Invoice.',
            { invoiceId: invoice._id, invoiceNumber: invoice.invoice_number, transactionNumber: tx.transactionNumber },
            { discriminator: idOf(invoice._id) }));
        }
      } else if (allocation.documentType === 'Bill' && !billMap.has(idOf(allocation.documentId))) {
        results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'FinancialTransaction', tx._id,
          'Transaction allocation references a missing Bill.', { allocation }, { discriminator: idOf(allocation.documentId) }));
      }
    }

    if (type === 'SETTLEMENT' && Number(tx.amount || 0) > 0) {
      if (!String(tx.settlementDiscountReason || tx.remarks || '').trim() || !tx.settlementDiscountApprovedBy) {
        results.push(issue('DISCOUNT_WITHOUT_APPROVAL', 'HIGH', 'FinancialTransaction', tx._id,
          'Settlement discount is missing an approval actor and/or reason.',
          { transactionNumber: tx.transactionNumber, amount: tx.amount, reason: tx.settlementDiscountReason, approvedBy: tx.settlementDiscountApprovedBy }));
      }
      if (tx.externalMoneyMovement !== false) {
        results.push(issue('RECEIPT_TRANSACTION_MISMATCH', 'HIGH', 'FinancialTransaction', tx._id,
          'Settlement discount is marked as external money movement.',
          { transactionNumber: tx.transactionNumber, externalMoneyMovement: tx.externalMoneyMovement },
          { discriminator: 'SETTLEMENT_EXTERNAL' }));
      }
    }

    if (Number(tx.taxAdjustmentAmount || 0) !== 0) {
      results.push(issue('TAX_WITHOUT_AUTHORIZATION', 'HIGH', 'FinancialTransaction', tx._id,
        'Historical payment-time tax adjustment exists. Issued-invoice tax is immutable in the canonical workflow.',
        { transactionNumber: tx.transactionNumber, taxAdjustmentAmount: tx.taxAdjustmentAmount },
        { suggestedAction: 'Review authorization and migrate the correction to a dedicated debit/credit adjustment document.' }));
    }
  }
  return results;
}

async function scanAdvanceLedger(hospitalId, transactions = []) {
  const results = [];
  const [entries, admissions] = await Promise.all([
    PatientAdvanceLedger.find({ hospitalId, status: 'POSTED' }).sort({ patientId: 1, admissionId: 1, walletType: 1, postedAt: 1, createdAt: 1 }).lean(),
    IPDAdmission.find({ hospitalId }).select('_id advanceAmount patientId').lean()
  ]);
  const admissionMap = new Map(admissions.map((row) => [idOf(row._id), row]));
  const groups = new Map();
  for (const entry of entries) {
    const key = [idOf(entry.patientId), idOf(entry.admissionId), entry.walletType || 'IPD_SHARED'].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  for (const [key, rows] of groups.entries()) {
    let running = null;
    for (const row of rows) {
      const opening = money(row.openingBalance || 0);
      if (running !== null && !near(opening, running)) {
        results.push(issue('ADVANCE_LEDGER_MISMATCH', 'HIGH', 'PatientAdvanceLedger', row._id,
          'Advance-ledger opening balance does not equal the previous posted balance.',
          { wallet: key, expectedOpening: running, actualOpening: opening }, { discriminator: 'OPENING' }));
      }
      const base = running === null ? opening : running;
      const expectedAfter = money(base + (row.direction === 'CREDIT' ? Number(row.amount || 0) : -Number(row.amount || 0)));
      if (!near(expectedAfter, row.balanceAfter)) {
        results.push(issue('ADVANCE_LEDGER_MISMATCH', 'CRITICAL', 'PatientAdvanceLedger', row._id,
          'Advance-ledger balanceAfter does not reconcile from opening balance and direction.',
          { wallet: key, expectedAfter, actualAfter: money(row.balanceAfter), direction: row.direction, amount: money(row.amount) },
          { discriminator: 'BALANCE_AFTER' }));
      }
      if (Number(row.balanceAfter || 0) < -EPSILON) {
        results.push(issue('NEGATIVE_BALANCE', 'CRITICAL', 'PatientAdvanceLedger', row._id,
          'Advance wallet has a negative posted balance.', { wallet: key, balanceAfter: row.balanceAfter }));
      }
      const txType = row.transactionType === 'ADVANCE_DEPOSIT'
        ? 'ADVANCE_DEPOSIT'
        : row.transactionType === 'REFUND_PAID'
          ? 'ADVANCE_REFUND'
          : ['IPD_INVOICE_DEBIT', 'OUTSTANDING_SETTLEMENT_DEBIT'].includes(row.transactionType)
            ? 'ADVANCE_UTILISATION'
            : null;
      if (txType && ['IPD_SHARED', 'OPD_SHARED'].includes(row.walletType)) {
        const ref = String(row.referenceNumber || '').trim();
        const matching = transactions.filter((tx) => transactionMatchesAdvanceLedger(row, tx));
        if (!matching.length) {
          results.push(issue('ADVANCE_LEDGER_MISMATCH', 'HIGH', 'PatientAdvanceLedger', row._id,
            'Canonical advance-ledger row has no matching posted FinancialTransaction.',
            { wallet: key, transactionType: row.transactionType, referenceNumber: ref }, { discriminator: 'MISSING_TRANSACTION' }));
        } else if (!near(matching.reduce((sum, tx) => sum + Number(tx.amount || 0), 0), row.amount)) {
          results.push(issue('ADVANCE_LEDGER_MISMATCH', 'CRITICAL', 'PatientAdvanceLedger', row._id,
            'Advance-ledger amount does not equal the matching FinancialTransaction amount.',
            { wallet: key, ledgerAmount: money(row.amount), transactionAmount: money(matching.reduce((sum, tx) => sum + Number(tx.amount || 0), 0)), referenceNumber: ref },
            { discriminator: 'TRANSACTION_AMOUNT' }));
        }
      }
      running = money(row.balanceAfter);
    }

    const last = rows[rows.length - 1];
    if (last?.walletType === 'IPD_SHARED' && last.admissionId) {
      const admission = admissionMap.get(idOf(last.admissionId));
      if (admission && !near(admission.advanceAmount, last.balanceAfter)) {
        results.push(issue('ADVANCE_LEDGER_MISMATCH', 'HIGH', 'IPDAdmission', admission._id,
          'Admission advanceAmount projection does not equal the authoritative IPD advance ledger balance.',
          { ledgerBalance: money(last.balanceAfter), admissionAdvanceAmount: money(admission.advanceAmount) },
          { discriminator: 'ADMISSION_PROJECTION' }));
      }
    }
  }
  return results;
}

async function scanSourceState(hospitalId, invoiceMap) {
  const results = [];
  const configs = [[LabRequest, 'LabRequest'], [RadiologyRequest, 'RadiologyRequest'], [ProcedureRequest, 'ProcedureRequest']];
  for (const [Model, entityType] of configs) {
    const rows = await Model.find({ $or: [{ hospitalId }, { hospital_id: hospitalId }] })
      .select('billingState billing_state chargeIds charge_ids invoiceIds invoice_ids is_billed invoiceId').lean();
    for (const row of rows) {
      const chargeIds = row.chargeIds || row.charge_ids || [];
      const invoiceIds = Array.from(new Set([...(row.invoiceIds || row.invoice_ids || []), ...(row.invoiceId ? [row.invoiceId] : [])].map(idOf).filter(Boolean)));
      const state = row.billingState || row.billing_state;
      if ((state === 'INVOICED' || row.is_billed) && !invoiceIds.length) {
        results.push(issue('SOURCE_STATE_MISMATCH', 'HIGH', entityType, row._id,
          'Source request says invoiced but has no invoice link.', { state, chargeIds, invoiceIds }));
      } else if (state === 'CHARGE_POSTED' && !chargeIds.length) {
        results.push(issue('SOURCE_STATE_MISMATCH', 'MEDIUM', entityType, row._id,
          'Source request says charge posted but has no charge link.', { state }));
      }
      const activeInvoiceIds = invoiceIds.filter((invoiceId) => {
        const invoice = invoiceMap.get(invoiceId);
        return invoice && invoice.document_stage !== 'VOID' && invoice.status !== 'Cancelled';
      });
      if (activeInvoiceIds.length > 1) {
        results.push(issue('SOURCE_CHARGE_WITH_MULTIPLE_INVOICES', 'CRITICAL', entityType, row._id,
          'One clinical source request points to multiple active invoices.', { invoiceIds: activeInvoiceIds }));
      }
    }
  }
  return results;
}

async function persistIssues(hospitalId, runId, issues) {
  if (!issues.length) return;
  const now = new Date();
  await FinancialReconciliationIssue.bulkWrite(issues.map((row) => ({
    updateOne: {
      filter: { hospitalId, issueKey: row.issueKey },
      update: {
        $set: { ...row, hospitalId, runId, lastSeenAt: now },
        $setOnInsert: { detectedAt: now },
        $inc: { occurrenceCount: 1 }
      },
      upsert: true
    }
  })));
}

async function loadScope(hospitalId) {
  const [invoices, bills, archivedInvoices, archivedBills, transactions] = await Promise.all([
    Invoice.find({ hospital_id: hospitalId, is_deleted: { $ne: true } }).lean(),
    Bill.find({ hospital_id: hospitalId, is_deleted: { $ne: true } }).lean(),
    Invoice.find({ hospital_id: hospitalId, is_deleted: true }).lean(),
    Bill.find({ hospital_id: hospitalId, is_deleted: true }).lean(),
    FinancialTransaction.find({ hospitalId, status: 'POSTED' }).lean()
  ]);
  return { invoices, bills, archivedInvoices, archivedBills, transactions };
}

async function runScan(hospitalId, { persist = true } = {}) {
  const runId = makeRunId();
  const scope = await loadScope(hospitalId);
  const invoiceMap = new Map(scope.invoices.map((row) => [idOf(row._id), row]));
  const groups = await Promise.all([
    scanCharges(hospitalId, invoiceMap),
    scanDocuments(hospitalId, scope),
    scanCollections(hospitalId, scope),
    scanAdvanceLedger(hospitalId, scope.transactions),
    scanSourceState(hospitalId, invoiceMap)
  ]);
  const issues = groups.flat();
  if (persist) await persistIssues(hospitalId, runId, issues);
  const bySeverity = issues.reduce((acc, row) => ({ ...acc, [row.severity]: (acc[row.severity] || 0) + 1 }), {});
  const byCategory = issues.reduce((acc, row) => ({ ...acc, [row.category]: (acc[row.category] || 0) + 1 }), {});
  return {
    runId,
    scannedAt: new Date(),
    scope: { invoices: scope.invoices.length, bills: scope.bills.length, transactions: scope.transactions.length },
    total: issues.length,
    bySeverity,
    byCategory,
    issues
  };
}

async function listIssues(hospitalId, filters = {}) {
  const query = { hospitalId };
  if (filters.status) query.status = filters.status;
  if (filters.severity) query.severity = filters.severity;
  if (filters.category) query.category = filters.category;
  const limit = Math.min(Math.max(Number(filters.limit || 100), 1), 500);
  const rows = await FinancialReconciliationIssue.find(query).sort({ severity: -1, lastSeenAt: -1 }).limit(limit).lean();
  const summary = await FinancialReconciliationIssue.aggregate([
    { $match: { hospitalId: oid(hospitalId), status: { $in: ['OPEN', 'ACKNOWLEDGED'] } } },
    { $group: { _id: '$severity', count: { $sum: 1 } } }
  ]);
  return { summary: Object.fromEntries(summary.map((row) => [row._id, row.count])), rows };
}

async function updateIssue(hospitalId, issueId, payload, userId) {
  const allowed = ['ACKNOWLEDGED', 'RESOLVED', 'IGNORED'];
  if (!allowed.includes(payload.status)) throw Object.assign(new Error('Invalid reconciliation status'), { statusCode: 400 });
  if (!payload.reason?.trim()) throw Object.assign(new Error('A reason is required'), { statusCode: 400 });
  const issueRow = await FinancialReconciliationIssue.findOne({ _id: issueId, hospitalId });
  if (!issueRow) throw Object.assign(new Error('Reconciliation issue not found'), { statusCode: 404 });
  issueRow.status = payload.status;
  issueRow.resolution = {
    action: payload.action || payload.status,
    reason: payload.reason.trim(),
    resolvedBy: userId,
    resolvedAt: new Date(),
    before: payload.before,
    after: payload.after
  };
  await issueRow.save();
  return issueRow;
}

module.exports = {
  runScan,
  listIssues,
  updateIssue,
  appointmentIdFromBill,
  paymentTransactionsForInvoice,
  adjustmentTransactionsForInvoice
};
