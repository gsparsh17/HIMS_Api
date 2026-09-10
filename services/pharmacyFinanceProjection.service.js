const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Bill = require('../models/Bill');
const PharmacyLedgerEntry = require('../models/PharmacyLedgerEntry');
const PharmacyReturn = require('../models/PharmacyReturn');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const id = (value) => value ? String(value) : null;

function hospitalIdFrom(user = {}, query = {}) {
  return query.hospitalId || user.hospital_id || user.hospitalId;
}

function parseRange(query = {}) {
  const now = new Date();
  const fromText = query.from || query.dateFrom || now.toISOString().slice(0, 10);
  const toText = query.to || query.dateTo || fromText;
  const offsetMinutes = (query.timezone || 'Asia/Kolkata') === 'Asia/Kolkata' ? 330 : 0;
  const from = new Date(`${fromText}T00:00:00.000Z`);
  const to = new Date(`${toText}T23:59:59.999Z`);
  from.setUTCMinutes(from.getUTCMinutes() - offsetMinutes);
  to.setUTCMinutes(to.getUTCMinutes() - offsetMinutes);
  return { from, to, fromDate: fromText, toDate: toText, timezone: query.timezone || 'Asia/Kolkata' };
}

async function loadData(query = {}, user = {}) {
  const range = parseRange(query);
  const hospitalId = hospitalIdFrom(user, query);
  const hospitalObjectId = hospitalId ? new mongoose.Types.ObjectId(hospitalId) : null;

  // Each finance collection uses its persisted tenant field. In particular,
  // Bill is hospital_id (not hospitalId). The previous generic scoped()
  // helper silently queried a non-schema field and could make a real
  // Pharmacy Bill invisible to the integration audit.
  const saleFilter = {
    ...(hospitalObjectId ? { hospitalId: hospitalObjectId } : {}),
    sale_date: { $gte: range.from, $lte: range.to },
    status: { $nin: ['Cancelled'] }
  };
  const invoiceFilter = {
    ...(hospitalObjectId ? { hospital_id: hospitalObjectId } : {}),
    issue_date: { $gte: range.from, $lte: range.to },
    $or: [{ is_pharmacy_sale: true }, { invoice_type: /pharmacy/i }],
    is_deleted: { $ne: true },
    status: { $nin: ['Cancelled', 'Draft'] },
    document_stage: { $ne: 'VOID' }
  };
  const ledgerFilter = {
    ...(hospitalObjectId ? { hospitalId: hospitalObjectId } : {}),
    entryDate: { $gte: range.from, $lte: range.to }
  };

  const [sales, invoices, ledgerEntries, returns, advanceRows] = await Promise.all([
    Sale.find(saleFilter).lean(),
    Invoice.find(invoiceFilter).lean(),
    PharmacyLedgerEntry.find(ledgerFilter).lean(),
    PharmacyReturn.find({
      ...(hospitalObjectId ? { hospitalId: hospitalObjectId } : {}),
      createdAt: { $gte: range.from, $lte: range.to }
    }).lean(),
    PatientAdvanceLedger.find({
      ...(hospitalObjectId ? { hospitalId: hospitalObjectId } : {}),
      createdAt: { $gte: range.from, $lte: range.to },
      sourceModule: /pharmacy/i
    }).lean()
  ]);

  // Load Bills from authoritative relationships, not a guessed Pharmacy type
  // discriminator. Canonical Pharmacy Bills are marked is_pharmacy_bill and
  // contain sale_id / invoice_id links, but do not need sourceModule,
  // bill_type or invoice_type to be present.
  const saleIds = sales.map((row) => row._id).filter(Boolean);
  const invoiceIds = invoices.map((row) => row._id).filter(Boolean);
  const invoiceBillIds = invoices.flatMap((row) => [row.bill_id, ...(row.bill_ids || [])]).filter(Boolean);
  const billRelationshipClauses = [];
  if (saleIds.length) {
    billRelationshipClauses.push(
      { sale_id: { $in: saleIds } },
      { source_id: { $in: saleIds } }
    );
  }
  if (invoiceIds.length) {
    billRelationshipClauses.push(
      { invoice_id: { $in: invoiceIds } },
      { invoice_ids: { $in: invoiceIds } }
    );
  }
  if (invoiceBillIds.length) {
    billRelationshipClauses.push({ _id: { $in: invoiceBillIds } });
  }

  const bills = billRelationshipClauses.length
    ? await Bill.find({
        ...(hospitalObjectId ? { hospital_id: hospitalObjectId } : {}),
        $or: billRelationshipClauses,
        is_deleted: { $ne: true }
      }).lean()
    : [];

  return { range, hospitalId, sales, invoices, bills, ledgerEntries, returns, advanceRows };
}
function buildAudit(data) {
  const invoiceById = new Map(data.invoices.map((row) => [id(row._id), row]));
  const invoiceByNumber = new Map(data.invoices.map((row) => [String(row.invoice_number || row.invoiceNumber || ''), row]));
  const invoiceBySale = new Map();
  data.invoices.forEach((row) => {
    const key = id(row.sale_id || row.saleId || row.pharmacy_sale_id || row.pharmacySaleId);
    if (key) invoiceBySale.set(key, row);
  });

  const billById = new Map(data.bills.map((row) => [id(row._id), row]));
  const billBySale = new Map();
  const billByInvoice = new Map();
  data.bills.forEach((row) => {
    const saleKey = id(row.sale_id || row.saleId || row.pharmacy_sale_id || row.pharmacySaleId || row.source_id || row.sourceId);
    if (saleKey) {
      const list = billBySale.get(saleKey) || [];
      list.push(row);
      billBySale.set(saleKey, list);
    }

    const linkedInvoiceIds = [
      row.invoice_id || row.invoiceId,
      ...(row.invoice_ids || row.invoiceIds || [])
    ].filter(Boolean);
    linkedInvoiceIds.forEach((invoiceId) => {
      const key = id(invoiceId);
      const list = billByInvoice.get(key) || [];
      list.push(row);
      billByInvoice.set(key, list);
    });
  });
  const ledgerBySale = new Map();
  data.ledgerEntries.forEach((row) => {
    const key = id(row.saleId);
    if (!key) return;
    const list = ledgerBySale.get(key) || [];
    list.push(row);
    ledgerBySale.set(key, list);
  });

  const anomalies = [];
  const saleRows = data.sales.map((sale) => {
    const saleId = id(sale._id);
    const linkedInvoice = invoiceById.get(id(sale.invoice_id || sale.invoiceId))
      || invoiceByNumber.get(String(sale.invoice_number || sale.invoiceNumber || ''))
      || invoiceBySale.get(saleId);
    const directBills = billBySale.get(saleId) || [];
    const invoiceBills = linkedInvoice ? (billByInvoice.get(id(linkedInvoice._id)) || []) : [];
    const explicitInvoiceBills = linkedInvoice
      ? [linkedInvoice.bill_id, ...(linkedInvoice.bill_ids || [])].map((billId) => billById.get(id(billId))).filter(Boolean)
      : [];
    const linkedBills = [...new Map([...directBills, ...invoiceBills, ...explicitInvoiceBills].map((row) => [id(row._id), row])).values()];
    const ledger = ledgerBySale.get(saleId) || [];
    const saleNet = money(sale.net_amount_after_returns || Math.max(0, (sale.total_amount || 0) - (sale.return_amount || 0)));
    const invoiceNet = money(linkedInvoice?.total || linkedInvoice?.net_amount || 0);
    const externalIn = money(ledger.filter((entry) => entry.direction === 'IN' && ['Cash', 'UPI', 'Card', 'Bank', 'Net Banking'].includes(entry.paymentMethod)).reduce((sum, entry) => sum + entry.amount, 0));
    const externalOut = money(ledger.filter((entry) => entry.direction === 'OUT').reduce((sum, entry) => sum + entry.amount, 0));
    const walletUsed = money(ledger.filter((entry) => entry.entryType === 'ADVANCE_USED').reduce((sum, entry) => sum + entry.amount, 0));

    if (!linkedInvoice) anomalies.push({ type: 'PHARMACY_SALE_WITHOUT_INVOICE', severity: 'HIGH', saleId, saleNumber: sale.sale_number, amount: saleNet });
    if (!linkedBills.length) anomalies.push({ type: 'PHARMACY_SALE_WITHOUT_BILL', severity: 'HIGH', saleId, saleNumber: sale.sale_number, amount: saleNet });
    if (linkedBills.length > 1) anomalies.push({ type: 'MULTIPLE_PHARMACY_BILLS_FOR_SALE', severity: 'HIGH', saleId, saleNumber: sale.sale_number, count: linkedBills.length });
    if (linkedInvoice && Math.abs(saleNet - invoiceNet) > 0.02) anomalies.push({ type: 'PHARMACY_SALE_INVOICE_TOTAL_MISMATCH', severity: 'HIGH', saleId, invoiceId: id(linkedInvoice._id), saleNet, invoiceNet });
    if (sale.balance_due < -0.009) anomalies.push({ type: 'NEGATIVE_PHARMACY_BALANCE', severity: 'HIGH', saleId, balanceDue: sale.balance_due });
    if (money((sale.amount_paid || 0) + (sale.balance_due || 0)) > money((sale.total_amount || 0) + 0.02) && !sale.return_amount) {
      anomalies.push({ type: 'PHARMACY_PAYMENT_EXCEEDS_SALE', severity: 'MEDIUM', saleId, amountPaid: sale.amount_paid, balanceDue: sale.balance_due, total: sale.total_amount });
    }

    return {
      saleId,
      saleNumber: sale.sale_number,
      invoiceId: id(linkedInvoice?._id),
      billIds: linkedBills.map((row) => id(row._id)),
      status: sale.status,
      saleNet,
      invoiceNet,
      balanceDue: money(sale.balance_due),
      externalCollection: externalIn,
      externalRefund: externalOut,
      advanceUsed: walletUsed,
      returnAmount: money(sale.return_amount),
      linked: Boolean(linkedInvoice && linkedBills.length === 1)
    };
  });

  const duplicateInvoiceLinks = Object.values(data.sales.reduce((acc, sale) => {
    const key = id(sale.invoice_id);
    if (!key) return acc;
    acc[key] ||= [];
    acc[key].push(id(sale._id));
    return acc;
  }, {})).filter((rows) => rows.length > 1);
  duplicateInvoiceLinks.forEach((saleIds) => anomalies.push({ type: 'PHARMACY_INVOICE_LINKED_TO_MULTIPLE_SALES', severity: 'HIGH', saleIds }));

  const summary = {
    saleCount: data.sales.length,
    invoiceCount: data.invoices.length,
    linkedSaleCount: saleRows.filter((row) => row.linked).length,
    unlinkedSaleCount: saleRows.filter((row) => !row.linked).length,
    grossSales: money(data.sales.reduce((sum, row) => sum + (row.total_amount || 0), 0)),
    netSalesAfterReturns: money(data.sales.reduce((sum, row) => sum + (row.net_amount_after_returns || Math.max(0, (row.total_amount || 0) - (row.return_amount || 0))), 0)),
    returns: money(data.sales.reduce((sum, row) => sum + (row.return_amount || 0), 0)),
    refunds: money(data.ledgerEntries.filter((row) => row.entryType === 'REFUND' && row.direction === 'OUT').reduce((sum, row) => sum + row.amount, 0)),
    externalCollections: money(data.ledgerEntries.filter((row) => row.direction === 'IN' && ['SALE', 'OUTSTANDING_PAYMENT', 'ADVANCE_RECEIVED', 'DEFERRED_SETTLEMENT'].includes(row.entryType) && ['Cash', 'UPI', 'Card', 'Bank', 'Net Banking'].includes(row.paymentMethod)).reduce((sum, row) => sum + row.amount, 0)),
    advancesReceived: money(data.ledgerEntries.filter((row) => row.entryType === 'ADVANCE_RECEIVED' && row.direction === 'IN').reduce((sum, row) => sum + row.amount, 0)),
    advancesUsed: money(data.ledgerEntries.filter((row) => row.entryType === 'ADVANCE_USED').reduce((sum, row) => sum + row.amount, 0)),
    outstanding: money(data.sales.filter((row) => !['Cancelled', 'Refunded'].includes(row.status)).reduce((sum, row) => sum + (row.balance_due || 0), 0)),
    anomalyCount: anomalies.length,
    highSeverityCount: anomalies.filter((row) => row.severity === 'HIGH').length
  };
  return { range: data.range, summary, saleRows, anomalies };
}

async function getIntegrationAudit(query, user) {
  return buildAudit(await loadData(query, user));
}

async function getProjection(query, user) {
  const audit = await getIntegrationAudit(query, user);
  return {
    range: audit.range,
    summary: {
      pharmacyNetSales: audit.summary.netSalesAfterReturns,
      pharmacyExternalCollections: audit.summary.externalCollections,
      pharmacyRefunds: audit.summary.refunds,
      pharmacyOutstanding: audit.summary.outstanding,
      pharmacyAdvancesReceived: audit.summary.advancesReceived,
      pharmacyAdvancesUsed: audit.summary.advancesUsed
    },
    lineage: {
      revenueSource: 'Invoice (linked pharmacy invoice counted once)',
      operationalSource: 'Sale and PharmacyReturn',
      collectionSource: 'PharmacyLedgerEntry external IN/OUT only',
      inventorySource: 'Sale items and InventoryLedger'
    }
  };
}

module.exports = { parseRange, getIntegrationAudit, getProjection, buildAudit };
