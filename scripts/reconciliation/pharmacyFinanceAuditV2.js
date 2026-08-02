#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const Invoice = require('../../models/Invoice');
const Bill = require('../../models/Bill');
const PharmacyLedgerEntry = require('../../models/PharmacyLedgerEntry');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name) {
  return process.argv.includes(name);
}

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const stringId = (value) => (value ? String(value) : null);

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

function hospitalScope(hospitalId) {
  const objectId = new mongoose.Types.ObjectId(hospitalId);
  return { $or: [{ hospitalId: objectId }, { hospital_id: objectId }] };
}

function firstId(row, fields) {
  for (const field of fields) {
    if (row?.[field]) return row[field];
  }
  return null;
}

async function main() {
  const hospitalId = arg('--hospital');
  if (!hospitalId || !mongoose.isValidObjectId(hospitalId)) {
    throw new Error('Usage: node scripts/reconciliation/pharmacyFinanceAuditV2.js --hospital <hospitalId> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--timezone Asia/Kolkata]');
  }

  const range = parseRange(arg('--from'), arg('--to'), arg('--timezone') || 'Asia/Kolkata');
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const scope = hospitalScope(hospitalId);
  const sales = await Sale.find({
    $and: [scope, { sale_date: { $gte: range.from, $lte: range.to } }, { status: { $nin: ['Cancelled'] } }]
  }).lean();

  const saleIds = sales.map((row) => row._id);
  const invoiceIds = sales.map((row) => firstId(row, ['invoice_id', 'invoiceId'])).filter(Boolean);
  const invoiceNumbers = sales.map((row) => row.invoice_number || row.invoiceNumber).filter(Boolean);

  const invoices = await Invoice.find({
    $and: [
      scope,
      {
        $or: [
          { _id: { $in: invoiceIds } },
          { invoice_number: { $in: invoiceNumbers } },
          { sale_id: { $in: saleIds } },
          { saleId: { $in: saleIds } },
          { pharmacy_sale_id: { $in: saleIds } },
          { pharmacySaleId: { $in: saleIds } }
        ]
      }
    ]
  }).lean();

  const allInvoiceIds = invoices.map((row) => row._id);
  const bills = await Bill.find({
    $and: [
      scope,
      {
        $or: [
          { sale_id: { $in: saleIds } },
          { saleId: { $in: saleIds } },
          { pharmacy_sale_id: { $in: saleIds } },
          { pharmacySaleId: { $in: saleIds } },
          { source_id: { $in: saleIds } },
          { sourceId: { $in: saleIds } },
          { invoice_id: { $in: allInvoiceIds } },
          { invoiceId: { $in: allInvoiceIds } },
          { invoice_ids: { $in: allInvoiceIds } },
          { invoiceIds: { $in: allInvoiceIds } }
        ]
      }
    ]
  }).lean();

  const ledgerEntries = await PharmacyLedgerEntry.find({
    $and: [scope, { saleId: { $in: saleIds } }]
  }).lean();

  const invoiceById = new Map(invoices.map((row) => [stringId(row._id), row]));
  const invoiceByNumber = new Map(invoices.map((row) => [String(row.invoice_number || row.invoiceNumber || ''), row]));
  const invoiceBySale = new Map();
  invoices.forEach((row) => {
    const saleId = stringId(firstId(row, ['sale_id', 'saleId', 'pharmacy_sale_id', 'pharmacySaleId']));
    if (saleId) invoiceBySale.set(saleId, row);
  });

  const billsBySale = new Map();
  const billsByInvoice = new Map();
  bills.forEach((row) => {
    const saleId = stringId(firstId(row, ['sale_id', 'saleId', 'pharmacy_sale_id', 'pharmacySaleId', 'source_id', 'sourceId']));
    if (saleId) {
      const list = billsBySale.get(saleId) || [];
      list.push(row);
      billsBySale.set(saleId, list);
    }
    const linkedInvoiceIds = [
      firstId(row, ['invoice_id', 'invoiceId']),
      ...(row.invoice_ids || row.invoiceIds || [])
    ].filter(Boolean);
    linkedInvoiceIds.forEach((invoiceId) => {
      const key = stringId(invoiceId);
      const list = billsByInvoice.get(key) || [];
      list.push(row);
      billsByInvoice.set(key, list);
    });
  });

  const ledgerBySale = new Map();
  ledgerEntries.forEach((row) => {
    const key = stringId(row.saleId || row.sale_id);
    if (!key) return;
    const list = ledgerBySale.get(key) || [];
    list.push(row);
    ledgerBySale.set(key, list);
  });

  const anomalies = [];
  const saleRows = sales.map((sale) => {
    const saleId = stringId(sale._id);
    const invoiceRef = firstId(sale, ['invoice_id', 'invoiceId']);
    const linkedInvoice = invoiceById.get(stringId(invoiceRef))
      || invoiceByNumber.get(String(sale.invoice_number || sale.invoiceNumber || ''))
      || invoiceBySale.get(saleId);

    const directBills = billsBySale.get(saleId) || [];
    const invoiceBills = linkedInvoice ? (billsByInvoice.get(stringId(linkedInvoice._id)) || []) : [];
    const linkedBills = [...new Map([...directBills, ...invoiceBills].map((row) => [stringId(row._id), row])).values()];
    const ledger = ledgerBySale.get(saleId) || [];

    const saleNet = money(sale.net_amount_after_returns ?? Math.max(0, (sale.total_amount || 0) - (sale.return_amount || 0)));
    const invoiceNet = money(linkedInvoice?.total ?? linkedInvoice?.total_amount ?? linkedInvoice?.net_amount ?? 0);
    const externalCollection = money(ledger.filter((entry) => {
      const direction = entry.direction || entry.transactionType;
      const method = entry.paymentMethod || entry.payment_method;
      return ['IN', 'CREDIT'].includes(direction) && ['Cash', 'UPI', 'Card', 'Bank', 'Net Banking'].includes(method);
    }).reduce((sum, entry) => sum + Number(entry.amount || 0), 0));

    if (!linkedInvoice) {
      anomalies.push({ type: 'PHARMACY_SALE_WITHOUT_INVOICE', severity: 'HIGH', saleId, saleNumber: sale.sale_number, amount: saleNet });
    }
    if (!linkedBills.length) {
      anomalies.push({ type: 'PHARMACY_SALE_WITHOUT_BILL', severity: 'HIGH', saleId, saleNumber: sale.sale_number, amount: saleNet, invoiceId: stringId(linkedInvoice?._id) });
    }
    if (linkedBills.length > 1) {
      anomalies.push({ type: 'MULTIPLE_PHARMACY_BILLS_FOR_SALE', severity: 'HIGH', saleId, saleNumber: sale.sale_number, billIds: linkedBills.map((row) => stringId(row._id)) });
    }
    if (linkedInvoice && Math.abs(saleNet - invoiceNet) > 0.02) {
      anomalies.push({ type: 'PHARMACY_SALE_INVOICE_TOTAL_MISMATCH', severity: 'HIGH', saleId, invoiceId: stringId(linkedInvoice._id), saleNet, invoiceNet });
    }

    return {
      saleId,
      saleNumber: sale.sale_number,
      invoiceId: stringId(linkedInvoice?._id),
      billIds: linkedBills.map((row) => stringId(row._id)),
      saleNet,
      invoiceNet,
      balanceDue: money(sale.balance_due),
      externalCollection,
      linked: Boolean(linkedInvoice && linkedBills.length === 1)
    };
  });

  const result = {
    range,
    summary: {
      saleCount: sales.length,
      invoiceCount: invoices.length,
      billCount: bills.length,
      linkedSaleCount: saleRows.filter((row) => row.linked).length,
      unlinkedSaleCount: saleRows.filter((row) => !row.linked).length,
      anomalyCount: anomalies.length,
      highSeverityCount: anomalies.filter((row) => row.severity === 'HIGH').length
    },
    saleRows,
    anomalies
  };

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.summary.highSeverityCount > 0 ? 2 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
