#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const Invoice = require('../../models/Invoice');
const Bill = require('../../models/Bill');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name) {
  return process.argv.includes(name);
}

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const id = (value) => (value ? String(value) : null);

function parseRange(fromText, toText, timezone = 'Asia/Kolkata') {
  const now = new Date().toISOString().slice(0, 10);
  const fromDate = fromText || now;
  const toDate = toText || fromDate;
  const offsetMinutes = timezone === 'Asia/Kolkata' ? 330 : 0;
  const from = new Date(`${fromDate}T00:00:00.000Z`);
  const to = new Date(`${toDate}T23:59:59.999Z`);
  from.setUTCMinutes(from.getUTCMinutes() - offsetMinutes);
  to.setUTCMinutes(to.getUTCMinutes() - offsetMinutes);
  return { from, to, fromDate, toDate, timezone };
}

function scope(hospitalId) {
  const objectId = new mongoose.Types.ObjectId(hospitalId);
  return { $or: [{ hospitalId: objectId }, { hospital_id: objectId }] };
}

function first(row, fields) {
  for (const field of fields) {
    if (row?.[field]) return row[field];
  }
  return null;
}

function isSeedSale(sale) {
  return /SEED|TEST|DEMO/i.test(String(sale.sale_number || sale.saleNumber || ''));
}

function statusFromInvoice(invoice) {
  if (invoice.status === 'Paid' || Number(invoice.balance_due || 0) <= 0.009) return 'Paid';
  if (invoice.status === 'Partial') return 'Partially Paid';
  if (invoice.status === 'Cancelled') return 'Cancelled';
  return 'Pending';
}

function paymentMethodFromSale(sale) {
  const allowed = new Set(['Pending', 'Cash', 'Card', 'Insurance', 'UPI', 'Net Banking', 'Bank', 'Government Scheme', 'IPDAdvance', 'OPDAdvance', 'PharmacyAdvance', 'Split', 'NoPayment', 'Adjustment']);
  const value = sale.payment_method || sale.paymentMethod || 'Pending';
  return allowed.has(value) ? value : 'Pending';
}

function buildBillItems(invoice, sale) {
  const medicineItems = Array.isArray(invoice.medicine_items) ? invoice.medicine_items : [];
  if (medicineItems.length) {
    return medicineItems.map((item) => ({
      description: item.medicine_name || item.description || 'Pharmacy item',
      amount: money(item.total_price ?? (Number(item.unit_price || 0) * Number(item.quantity || 1))),
      quantity: Number(item.quantity || 1),
      item_type: item.is_return || item.item_type === 'Medicine Return' ? 'Medicine Return' : 'Pharmacy',
      medicine_id: item.medicine_id,
      batch_id: item.batch_id,
      medicine_name: item.medicine_name,
      batch_number: item.batch_number,
      expiry_date: item.expiry_date,
      base_unit: item.base_unit || 'unit',
      quantity_base_units: item.quantity_base_units,
      unit_price: money(item.unit_price),
      tax_rate: Number(item.tax_rate || 0),
      tax_amount: money(item.tax_amount),
      discount_amount: money(item.discount_amount),
      taxable_amount: money(item.taxable_amount),
      hsn_code: item.hsn_code
    }));
  }

  return [{
    description: `Historical pharmacy sale ${sale.sale_number || sale._id}`,
    amount: money(invoice.total ?? sale.total_amount),
    quantity: 1,
    item_type: 'Pharmacy',
    unit_price: money(invoice.total ?? sale.total_amount),
    tax_rate: 0,
    tax_amount: money(invoice.tax ?? sale.tax),
    discount_amount: money(invoice.discount ?? sale.discount_amount),
    taxable_amount: money(invoice.taxable_amount ?? sale.taxable_amount)
  }];
}

async function findInvoiceForSale(sale, hospitalId) {
  const invoiceId = first(sale, ['invoice_id', 'invoiceId']);
  const invoiceNumber = sale.invoice_number || sale.invoiceNumber;
  const conditions = [];
  if (invoiceId) conditions.push({ _id: invoiceId });
  if (invoiceNumber) conditions.push({ invoice_number: invoiceNumber });
  conditions.push({ sale_id: sale._id }, { saleId: sale._id }, { pharmacy_sale_id: sale._id }, { pharmacySaleId: sale._id });
  return Invoice.findOne({ $and: [scope(hospitalId), { $or: conditions }] }).lean();
}

async function findBills(sale, invoice, hospitalId) {
  const conditions = [
    { sale_id: sale._id },
    { saleId: sale._id },
    { pharmacy_sale_id: sale._id },
    { pharmacySaleId: sale._id },
    { source_id: sale._id },
    { sourceId: sale._id }
  ];
  if (invoice?._id) {
    conditions.push(
      { invoice_id: invoice._id },
      { invoiceId: invoice._id },
      { invoice_ids: invoice._id },
      { invoiceIds: invoice._id }
    );
  }
  return Bill.find({ $and: [scope(hospitalId), { $or: conditions }] }).lean();
}

async function linkExisting({ sale, invoice, bill, hospitalId, apply, session }) {
  const updates = [];
  const saleInvoiceId = first(sale, ['invoice_id', 'invoiceId']);
  if (!saleInvoiceId && invoice) {
    updates.push({ collection: 'sales', id: sale._id, set: { invoice_id: invoice._id, invoice_number: invoice.invoice_number } });
  }

  if (!bill.sale_id || id(bill.sale_id) !== id(sale._id)) {
    updates.push({ collection: 'bills', id: bill._id, set: { sale_id: sale._id, is_pharmacy_bill: true } });
  }

  const billInvoiceIds = [bill.invoice_id, ...(bill.invoice_ids || [])].filter(Boolean).map(id);
  if (invoice && !billInvoiceIds.includes(id(invoice._id))) {
    updates.push({
      collection: 'bills',
      id: bill._id,
      set: {
        invoice_id: invoice._id,
        invoice_ids: [...new Set([...(bill.invoice_ids || []).map(id), id(invoice._id)])].map((value) => new mongoose.Types.ObjectId(value)),
        document_stage: 'INVOICED',
        invoiced_at: invoice.issued_at || invoice.issue_date || new Date()
      }
    });
  }

  if (invoice) {
    const invoiceBillIds = [invoice.bill_id, ...(invoice.bill_ids || [])].filter(Boolean).map(id);
    const set = {};
    if (!invoice.sale_id || id(invoice.sale_id) !== id(sale._id)) set.sale_id = sale._id;
    if (!invoiceBillIds.includes(id(bill._id))) {
      set.bill_id = bill._id;
      set.bill_ids = [...new Set([...(invoice.bill_ids || []).map(id), id(bill._id)])].map((value) => new mongoose.Types.ObjectId(value));
    }
    if (Object.keys(set).length) updates.push({ collection: 'invoices', id: invoice._id, set });
  }

  if (apply) {
    for (const update of updates) {
      await mongoose.connection.collection(update.collection).updateOne(
        { _id: update.id },
        { $set: update.set },
        { session }
      );
    }
  }
  return updates;
}

async function createHistoricalBill({ sale, invoice, hospitalId, apply, session }) {
  const billNumber = `MIG-PH-${String(sale._id).slice(-12).toUpperCase()}`;
  const existing = await Bill.findOne({ bill_number: billNumber }).session(session || null).lean();
  if (existing) return { bill: existing, created: false, reason: 'IDEMPOTENT_EXISTING_MIGRATION_BILL' };

  const total = money(invoice.total ?? sale.total_amount);
  const subtotal = money(invoice.subtotal ?? sale.subtotal ?? sale.gross_amount ?? total);
  const tax = money(invoice.tax ?? sale.tax);
  const discount = money(invoice.discount ?? sale.discount_amount);
  const balanceDue = money(invoice.balance_due ?? sale.balance_due);
  const paidAmount = money(invoice.amount_paid ?? Math.max(0, total - balanceDue));

  const document = {
    bill_number: billNumber,
    document_stage: 'INVOICED',
    invoice_id: invoice._id,
    invoice_ids: [invoice._id],
    invoiced_at: invoice.issued_at || invoice.issue_date || sale.sale_date || new Date(),
    hospital_id: new mongoose.Types.ObjectId(hospitalId),
    patient_id: sale.patient_id || invoice.patient_id,
    admission_id: sale.admission_id || invoice.admission_id,
    sale_id: sale._id,
    total_amount: total,
    gross_amount: money(invoice.gross_amount ?? sale.gross_amount ?? subtotal),
    subtotal,
    tax_amount: tax,
    taxable_amount: money(invoice.taxable_amount ?? sale.taxable_amount),
    discount,
    discount_type: sale.discount_type || 'fixed',
    discount_reason: sale.discount_reason || 'Historical pharmacy link migration',
    payment_method: paymentMethodFromSale(sale),
    payments: Array.isArray(sale.payments) ? sale.payments.map((payment) => ({
      method: payment.method,
      amount: money(payment.amount),
      reference: payment.reference || '',
      date: payment.date || sale.discharged_settled_at || sale.updatedAt || sale.sale_date
    })) : [],
    items: buildBillItems(invoice, sale),
    status: statusFromInvoice(invoice),
    generated_at: invoice.issue_date || sale.sale_date || sale.createdAt,
    paid_at: paidAmount > 0 ? (sale.discharged_settled_at || invoice.updatedAt || sale.updatedAt) : undefined,
    paid_amount: paidAmount,
    balance_due: balanceDue,
    created_by: sale.created_by || invoice.created_by,
    notes: `Migration-generated historical Bill for pharmacy Sale ${sale.sale_number}. No payment, stock or invoice total was changed.`,
    idempotency_key: `migration:pharmacy-bill:${sale._id}`,
    is_pharmacy_bill: true,
    pharmacy_outstanding_before: money(sale.previous_outstanding),
    pharmacy_outstanding_after: balanceDue,
    pharmacy_advance_used: money(sale.pharmacy_advance_before) - money(sale.pharmacy_advance_after),
    is_deleted: false
  };

  if (!apply) return { bill: { ...document, _id: null }, created: true, dryRun: true };
  const [created] = await Bill.create([document], { session });
  return { bill: created.toObject(), created: true };
}

async function main() {
  const hospitalId = arg('--hospital');
  if (!hospitalId || !mongoose.isValidObjectId(hospitalId)) {
    throw new Error('Usage: node scripts/migrations/pharmacyFinancialLinkRepair.js --hospital <hospitalId> --from YYYY-MM-DD --to YYYY-MM-DD [--apply] [--create-missing-bills] [--include-seed]');
  }

  const apply = has('--apply');
  const createMissingBills = has('--create-missing-bills');
  const includeSeed = has('--include-seed');
  const range = parseRange(arg('--from'), arg('--to'), arg('--timezone') || 'Asia/Kolkata');

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const sales = await Sale.find({
    $and: [scope(hospitalId), { sale_date: { $gte: range.from, $lte: range.to } }, { status: { $nin: ['Cancelled'] } }]
  }).lean();

  const report = {
    mode: apply ? 'APPLY' : 'DRY_RUN',
    createMissingBills,
    includeSeed,
    range,
    totals: { scanned: sales.length, linkedExisting: 0, createdBills: 0, skipped: 0, errors: 0 },
    rows: []
  };

  for (const sale of sales) {
    const row = { saleId: id(sale._id), saleNumber: sale.sale_number, actions: [], status: 'PENDING' };
    const session = apply ? await mongoose.startSession() : null;
    try {
      if (isSeedSale(sale) && !includeSeed) {
        row.status = 'SKIPPED_SEED';
        row.reason = 'Use --include-seed only after confirming this is a genuine financial sale.';
        report.totals.skipped += 1;
        report.rows.push(row);
        if (session) await session.endSession();
        continue;
      }

      const execute = async () => {
        const invoice = await findInvoiceForSale(sale, hospitalId);
        if (!invoice) {
          row.status = 'SKIPPED_NO_INVOICE';
          row.reason = 'No invoice exists. This script deliberately does not create historical invoices.';
          report.totals.skipped += 1;
          return;
        }

        const saleNet = money(sale.net_amount_after_returns ?? sale.total_amount);
        const invoiceNet = money(invoice.total ?? invoice.total_amount);
        if (Math.abs(saleNet - invoiceNet) > 0.02) {
          row.status = 'SKIPPED_AMOUNT_MISMATCH';
          row.reason = `Sale ${saleNet} and invoice ${invoiceNet} differ.`;
          report.totals.skipped += 1;
          return;
        }

        let bills = await findBills(sale, invoice, hospitalId);
        if (bills.length > 1) {
          row.status = 'SKIPPED_MULTIPLE_BILLS';
          row.reason = `Found ${bills.length} candidate Bills; manual resolution required.`;
          row.billIds = bills.map((bill) => id(bill._id));
          report.totals.skipped += 1;
          return;
        }

        if (!bills.length) {
          if (!createMissingBills) {
            row.status = 'MISSING_BILL';
            row.reason = 'Rerun with --create-missing-bills after reviewing this dry run.';
            report.totals.skipped += 1;
            return;
          }
          const created = await createHistoricalBill({ sale, invoice, hospitalId, apply, session });
          bills = [created.bill];
          row.actions.push(created.created ? 'CREATE_HISTORICAL_BILL' : 'REUSE_MIGRATION_BILL');
          if (created.created) report.totals.createdBills += 1;
        }

        const updates = await linkExisting({ sale, invoice, bill: bills[0], hospitalId, apply, session });
        row.actions.push(...updates.map((update) => `LINK_${update.collection.toUpperCase()}`));
        row.invoiceId = id(invoice._id);
        row.billId = id(bills[0]._id) || `(dry-run ${bills[0].bill_number})`;
        row.status = 'READY';
        report.totals.linkedExisting += 1;
      };

      if (apply) {
        await session.withTransaction(execute);
      } else {
        await execute();
      }
    } catch (error) {
      row.status = 'ERROR';
      row.error = error.message;
      report.totals.errors += 1;
    } finally {
      if (session) await session.endSession();
      report.rows.push(row);
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.totals.errors > 0) process.exitCode = 1;
  else if (report.rows.some((row) => row.status.startsWith('SKIPPED_') || row.status === 'MISSING_BILL')) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
