const crypto = require('crypto');
const mongoose = require('mongoose');
const IPDCharge = require('../models/IPDCharge');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const FinancialTransaction = require('../models/FinancialTransaction');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const FinancialReconciliationIssue = require('../models/FinancialReconciliationIssue');

const money = (value) => Number(Number(value || 0).toFixed(2));
const oid = (value) => value && mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : value;
const makeRunId = () => `FINREC-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

function issue(category, severity, entityType, entityId, summary, details = {}, options = {}) {
  const keySeed = `${category}:${entityType}:${entityId || ''}:${options.discriminator || ''}`;
  return {
    issueKey: crypto.createHash('sha256').update(keySeed).digest('hex'), category, severity,
    entityType, entityId: oid(entityId), summary, details,
    deterministicFix: Boolean(options.deterministicFix), suggestedAction: options.suggestedAction || ''
  };
}

async function scanCharges(hospitalId) {
  const rows = await IPDCharge.find({ hospitalId }).select('admissionId patientId status isBilled billId invoiceId sourceModule sourceId sourceReference netAmount').lean();
  const results = [];
  for (const row of rows) {
    if ((row.isBilled || row.status === 'INVOICED') && !row.invoiceId) {
      results.push(issue('CHARGE_WITHOUT_INVOICE', 'HIGH', 'IPDCharge', row._id,
        'Charge is marked invoiced but has no invoice link.', row,
        { suggestedAction: 'Locate the unique invoice line by charge_id before backfilling; otherwise resolve manually.' }));
    }
    if (row.invoiceId) {
      const invoiceExists = await Invoice.exists({ _id: row.invoiceId, hospital_id: hospitalId });
      if (!invoiceExists) results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'IPDCharge', row._id,
        'Charge references a missing or cross-hospital invoice.', { invoiceId: row.invoiceId },
        { suggestedAction: 'Do not reinvoice automatically. Investigate and correct the broken link.' }));
    }
  }

  const duplicates = await IPDCharge.aggregate([
    { $match: { hospitalId: oid(hospitalId), status: { $in: ['ACTIVE', 'INVOICED'] }, sourceId: { $ne: null } } },
    { $group: { _id: { admissionId: '$admissionId', sourceModule: '$sourceModule', sourceId: '$sourceId', lineKey: '$sourceReference.lineKey' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);
  for (const row of duplicates) results.push(issue('DUPLICATE_SOURCE_CHARGE', 'CRITICAL', 'IPDCharge', row.ids[0],
    'Multiple active/invoiced charges share the same source identity.', row,
    { discriminator: row.ids.join(','), suggestedAction: 'Review source history; void only an unbilled duplicate with an authorised reason.' }));
  return results;
}

async function scanDocuments(hospitalId) {
  const results = [];
  const invoices = await Invoice.find({ hospital_id: hospitalId }).select('bill_id bill_ids total balance_due invoice_number patient_id admission_id items').lean();
  for (const invoice of invoices) {
    const linkedIds = [invoice.bill_id, ...(invoice.bill_ids || [])].filter(Boolean);
    if (!linkedIds.length) {
      results.push(issue('ORPHAN_DOCUMENT', 'HIGH', 'Invoice', invoice._id, 'Invoice has no linked Bill.', { invoiceNumber: invoice.invoice_number }));
      continue;
    }
    const bills = await Bill.find({ _id: { $in: linkedIds }, hospital_id: hospitalId }).select('total_amount bill_number').lean();
    if (bills.length !== new Set(linkedIds.map(String)).size) {
      results.push(issue('ORPHAN_DOCUMENT', 'CRITICAL', 'Invoice', invoice._id, 'One or more linked Bills are missing.', { linkedIds, found: bills.map((b) => b._id) }));
    }
    const billTotal = money(bills.reduce((sum, bill) => sum + Number(bill.total_amount || 0), 0));
    const invoiceTotal = money(invoice.total);
    if (Math.abs(billTotal - invoiceTotal) > 0.02) {
      results.push(issue('BILL_INVOICE_TOTAL_MISMATCH', 'HIGH', 'Invoice', invoice._id,
        'Linked Bill total does not equal issued Invoice total.', { invoiceNumber: invoice.invoice_number, billTotal, invoiceTotal },
        { suggestedAction: 'Do not rewrite historical totals. Use an approved correction or credit/debit note workflow.' }));
    }
  }
  return results;
}

async function scanCollections(hospitalId) {
  const results = [];
  const duplicates = await FinancialTransaction.aggregate([
    { $match: { hospitalId: oid(hospitalId), status: 'POSTED' } },
    { $group: { _id: { idempotencyKey: '$idempotencyKey', transactionNumber: '$transactionNumber' }, ids: { $push: '$_id' }, count: { $sum: 1 }, total: { $sum: '$amount' } } },
    { $match: { count: { $gt: 1 }, '_id.idempotencyKey': { $nin: [null, ''] } } }
  ]);
  for (const row of duplicates) results.push(issue('DUPLICATE_COLLECTION', 'CRITICAL', 'FinancialTransaction', row.ids[0],
    'Multiple posted financial transactions share one idempotency key.', row,
    { discriminator: row.ids.join(','), suggestedAction: 'Reverse the confirmed duplicate; never delete posted financial history.' }));
  return results;
}

async function scanSourceState(hospitalId) {
  const results = [];
  const configs = [
    [LabRequest, 'LabRequest'], [RadiologyRequest, 'RadiologyRequest'], [ProcedureRequest, 'ProcedureRequest']
  ];
  for (const [Model, entityType] of configs) {
    const rows = await Model.find({ $or: [{ hospitalId }, { hospital_id: hospitalId }] })
      .select('billingState billing_state chargeIds charge_ids invoiceIds invoice_ids is_billed invoiceId').lean();
    for (const row of rows) {
      const chargeIds = row.chargeIds || row.charge_ids || [];
      const invoiceIds = row.invoiceIds || row.invoice_ids || (row.invoiceId ? [row.invoiceId] : []);
      const state = row.billingState || row.billing_state;
      if ((state === 'INVOICED' || row.is_billed) && !invoiceIds.length) {
        results.push(issue('SOURCE_STATE_MISMATCH', 'HIGH', entityType, row._id,
          'Source request says invoiced but has no invoice link.', { state, chargeIds, invoiceIds }));
      } else if (state === 'CHARGE_POSTED' && !chargeIds.length) {
        results.push(issue('SOURCE_STATE_MISMATCH', 'MEDIUM', entityType, row._id,
          'Source request says charge posted but has no charge link.', { state }));
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

async function runScan(hospitalId, { persist = true } = {}) {
  const runId = makeRunId();
  const groups = await Promise.all([
    scanCharges(hospitalId), scanDocuments(hospitalId), scanCollections(hospitalId), scanSourceState(hospitalId)
  ]);
  const issues = groups.flat();
  if (persist) await persistIssues(hospitalId, runId, issues);
  const bySeverity = issues.reduce((acc, row) => ({ ...acc, [row.severity]: (acc[row.severity] || 0) + 1 }), {});
  const byCategory = issues.reduce((acc, row) => ({ ...acc, [row.category]: (acc[row.category] || 0) + 1 }), {});
  return { runId, scannedAt: new Date(), total: issues.length, bySeverity, byCategory, issues };
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

module.exports = { runScan, listIssues, updateIssue };
