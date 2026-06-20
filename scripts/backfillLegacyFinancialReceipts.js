/*
 * Rebuild receipt-ledger rows for historical invoices created before the
 * finance patch. Safe to run repeatedly: it creates only the missing amount
 * after comparing Invoice.amount_paid with already posted receipt entries.
 *
 * Preview: node scripts/backfillLegacyFinancialReceipts.js
 * Apply:   node scripts/backfillLegacyFinancialReceipts.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Invoice = require('../models/Invoice');
const FinancialTransaction = require('../models/FinancialTransaction');
const { nextFinancialNumber, money } = require('../utils/financeNumbers');

const APPLY = process.argv.includes('--apply');
const BATCH_SIZE = 100;
const receiptTypes = ['RECEIPT', 'ADVANCE_UTILISATION', 'SETTLEMENT'];
const paymentMethods = ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance', 'Government Scheme', 'Bank', 'IPDAdvance', 'PharmacyAdvance', 'Adjustment'];

function paymentMethodFor(invoice) {
  const last = invoice.payment_history?.[invoice.payment_history.length - 1];
  return paymentMethods.includes(last?.method) ? last.method : 'Cash';
}

async function existingReceiptAmount(invoiceId) {
  const result = await FinancialTransaction.aggregate([
    { $match: { invoiceId, status: 'POSTED', direction: 'CREDIT', transactionType: { $in: receiptTypes } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  return money(result[0]?.total || 0);
}

async function backfill() {
  await connectDB();
  const filter = {
    amount_paid: { $gt: 0 },
    is_deleted: { $ne: true },
    status: { $nin: ['Cancelled', 'Refunded'] }
  };
  let cursor = Invoice.find(filter).sort({ issue_date: 1, _id: 1 }).cursor({ batchSize: BATCH_SIZE });
  let scanned = 0;
  let candidates = 0;
  let created = 0;
  let skipped = 0;

  for await (const invoice of cursor) {
    scanned += 1;
    if (!invoice.patient_id) {
      skipped += 1;
      continue;
    }
    const recorded = await existingReceiptAmount(invoice._id);
    const expected = money(invoice.amount_paid || 0);
    const missing = money(expected - recorded);
    if (missing <= 0) {
      skipped += 1;
      continue;
    }
    candidates += 1;
    const method = paymentMethodFor(invoice);
    const preview = `${invoice.invoice_number || invoice._id}: ₹${missing} (${method})`;
    if (!APPLY) {
      console.log(`WOULD CREATE  ${preview}`);
      continue;
    }

    const receiptNumber = await nextFinancialNumber({ documentType: 'RECEIPT', hospitalId: invoice.hospital_id });
    await FinancialTransaction.create({
      hospitalId: invoice.hospital_id,
      patientId: invoice.patient_id,
      admissionId: invoice.admission_id,
      billId: invoice.bill_id,
      invoiceId: invoice._id,
      transactionNumber: receiptNumber,
      transactionType: method === 'IPDAdvance' ? 'ADVANCE_UTILISATION' : 'RECEIPT',
      direction: 'CREDIT',
      amount: missing,
      paymentMethod: method,
      paymentReference: invoice.payment_history?.[invoice.payment_history.length - 1]?.reference,
      sourceModule: invoice.admission_id ? 'IPD' : 'Billing',
      sourceId: invoice.bill_id || invoice._id,
      status: 'POSTED',
      remarks: `Historical invoice receipt backfill for ${invoice.invoice_number || invoice._id}`,
      metadata: { legacyBackfill: true, invoiceNumber: invoice.invoice_number }
    });
    invoice.receipt_numbers = Array.from(new Set([...(invoice.receipt_numbers || []), receiptNumber]));
    await invoice.save();
    created += 1;
    console.log(`CREATED       ${preview} → ${receiptNumber}`);
  }

  console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'PREVIEW', scanned, candidates, created, skipped }, null, 2));
  await mongoose.connection.close();
}

backfill().catch(async (error) => {
  console.error(error);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
