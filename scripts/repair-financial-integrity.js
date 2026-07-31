#!/usr/bin/env node
'use strict';

/*
 * Preview (default):
 *   node scripts/repair-financial-integrity.js --hospital-id=69a697c0df37f940dd7906ce
 * Apply:
 *   node scripts/repair-financial-integrity.js --hospital-id=69a697c0df37f940dd7906ce --apply
 * Assign records that have no relational ownership evidence at all:
 *   add --force-unresolved only after reviewing the preview.
 */

const {
  Bill,
  Invoice,
  IPDCharge,
  Sale,
  RelationResolver,
  parseArgs,
  connect,
  assertHospital,
  auditFinancialIntegrity,
  idString,
  money,
  tenantNeedsRepair,
  ensureFinancialIndexes,
  uniqueIds,
  mongoose
} = require('./financial-integrity.lib');
const { nextFinancialNumber } = require('../utils/financeNumbers');

function billPaymentTotal(bill) {
  return money((bill.payments || []).reduce((sum, payment) => sum + Number(payment?.amount || 0), 0));
}

function invoicePaymentTotal(invoice) {
  return money((invoice.payment_history || [])
    .filter((payment) => !payment.status || payment.status === 'Completed')
    .reduce((sum, payment) => sum + Number(payment?.amount || 0), 0));
}

function billFinancialState(bill, linkedInvoice) {
  const paidAmount = money(Math.max(
    Number(bill.paid_amount || 0),
    billPaymentTotal(bill),
    Number(linkedInvoice?.amount_paid || 0)
  ));
  const settlementDiscount = money(Math.max(
    Number(bill.settlement_discount_amount || 0),
    Number(linkedInvoice?.settlement_discount_amount || 0)
  ));
  const creditNote = money(Math.max(
    Number(bill.credit_note_amount || 0),
    Number(linkedInvoice?.credit_note_total || 0)
  ));
  const balanceDue = money(Math.max(0, Number(bill.total_amount || 0) - paidAmount - settlementDiscount - creditNote));
  let status = bill.status;
  if (!['Cancelled', 'Refunded', 'Partially Returned', 'Fully Returned'].includes(status)) {
    status = balanceDue <= 0
      ? 'Paid'
      : (paidAmount > 0 || settlementDiscount > 0 || creditNote > 0 ? 'Partially Paid' : (status === 'Draft' ? 'Draft' : 'Pending'));
  }
  return { paidAmount, settlementDiscount, creditNote, balanceDue, status };
}

function invoiceFinancialState(invoice, linkedBill) {
  const amountPaid = money(Math.max(
    Number(invoice.amount_paid || 0),
    invoicePaymentTotal(invoice),
    Number(linkedBill?.paid_amount || 0)
  ));
  const settlementDiscount = money(Math.max(
    Number(invoice.settlement_discount_amount || 0),
    Number(linkedBill?.settlement_discount_amount || 0)
  ));
  const creditNote = money(Math.max(
    Number(invoice.credit_note_total || 0),
    Number(linkedBill?.credit_note_amount || 0)
  ));
  const balanceDue = money(Math.max(0, Number(invoice.total || 0) - amountPaid - settlementDiscount - creditNote));
  let status = invoice.status;
  if (!['Cancelled', 'Refunded'].includes(status) && invoice.document_stage !== 'VOID') {
    status = balanceDue <= 0
      ? 'Paid'
      : (amountPaid > 0 || settlementDiscount > 0 || creditNote > 0
        ? 'Partial'
        : (invoice.due_date && new Date() > new Date(invoice.due_date) ? 'Overdue' : 'Pending'));
  }
  return { amountPaid, settlementDiscount, creditNote, balanceDue, status };
}

async function nextAvailableBillNumber({ hospitalId, date }) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = await nextFinancialNumber({ documentType: 'BILL', hospitalId, date });
    const exists = await Bill.exists({ bill_number: candidate });
    if (!exists) return candidate;
  }
  throw new Error('Unable to allocate a unique bill number after 1000 attempts');
}

async function applyOrPreview({ apply, model, id, update, label, counters }) {
  counters.candidates += 1;
  if (!apply) {
    console.log(`WOULD UPDATE ${label} ${id}: ${JSON.stringify(update.$set || update)}`);
    return;
  }
  await model.updateOne({ _id: id }, update, { runValidators: false });
  counters.updated += 1;
}

async function repairTenancy({ args, resolver, counters }) {
  const resolvedIds = { Sale: [], Bill: [], Invoice: [], IPDCharge: [] };
  const targets = [
    { name: 'Sale', model: Sale, field: 'hospitalId', type: 'sale' },
    { name: 'Bill', model: Bill, field: 'hospital_id', type: 'bill' },
    { name: 'Invoice', model: Invoice, field: 'hospital_id', type: 'invoice' },
    { name: 'IPDCharge', model: IPDCharge, field: 'hospitalId', type: 'charge' }
  ];

  for (const target of targets) {
    const cursor = target.model.find(tenantNeedsRepair(target.field)).lean().cursor({ batchSize: 100 });
    for await (const doc of cursor) {
      counters.scanned += 1;
      const resolution = await resolver.resolve(doc, target.type, { forceUnresolved: args.forceUnresolved });
      if (resolution.status === 'conflict') {
        counters.conflicts += 1;
        console.error(`CONFLICT ${target.name} ${doc._id}: ${resolution.candidates.join(', ')}`);
        continue;
      }
      if (resolution.status === 'other-hospital') {
        counters.otherHospital += 1;
        continue;
      }
      if (resolution.status !== 'resolved') {
        counters.unresolved += 1;
        console.error(`UNRESOLVED ${target.name} ${doc._id}`);
        continue;
      }
      resolvedIds[target.name].push(doc._id);
      await applyOrPreview({
        apply: args.apply,
        model: target.model,
        id: doc._id,
        update: { $set: { [target.field]: args.hospitalObjectId } },
        label: `${target.name} tenant`,
        counters
      });
    }
  }
  return resolvedIds;
}

function scopedOrResolved(field, hospitalObjectId, ids = []) {
  if (!ids.length) return { [field]: hospitalObjectId };
  return { $or: [{ [field]: hospitalObjectId }, { _id: { $in: ids } }] };
}

async function findInvoiceForBill(bill) {
  const ids = uniqueIds([...(bill.invoice_ids || []), bill.invoice_id]);
  if (ids.length) {
    const invoice = await Invoice.findOne({ _id: { $in: ids } }).lean();
    if (invoice) return invoice;
  }
  return Invoice.findOne({ bill_id: bill._id }).lean();
}

async function findBillForInvoice(invoice) {
  if (invoice.bill_id) {
    const bill = await Bill.findById(invoice.bill_id).lean();
    if (bill) return bill;
  }
  return Bill.findOne({ $or: [{ invoice_id: invoice._id }, { invoice_ids: invoice._id }] }).lean();
}

async function repairBills(args, counters, resolvedIds = []) {
  const cursor = Bill.find({ ...scopedOrResolved('hospital_id', args.hospitalObjectId, resolvedIds), is_deleted: { $ne: true } }).lean().cursor({ batchSize: 100 });
  for await (const bill of cursor) {
    counters.scanned += 1;
    const invoice = await findInvoiceForBill(bill);
    if (invoice?.hospital_id && idString(invoice.hospital_id) !== args.hospitalId) {
      counters.conflicts += 1;
      console.error(`CONFLICT Bill ${bill._id}: linked invoice belongs to ${invoice.hospital_id}`);
      continue;
    }

    const state = billFinancialState(bill, invoice);
    const linkedIds = uniqueIds([...(bill.invoice_ids || []), bill.invoice_id, invoice?._id]);
    const set = {
      paid_amount: state.paidAmount,
      settlement_discount_amount: state.settlementDiscount,
      credit_note_amount: state.creditNote,
      balance_due: state.balanceDue,
      status: state.status,
      invoice_ids: linkedIds.map((id) => new mongoose.Types.ObjectId(id)),
      document_stage: linkedIds.length ? 'INVOICED' : (state.status === 'Draft' ? 'DRAFT' : 'GENERATED')
    };
    if (invoice?._id) set.invoice_id = invoice._id;
    if (linkedIds.length) set.invoiced_at = bill.invoiced_at || invoice?.issued_at || invoice?.issue_date || new Date();
    if (state.status === 'Paid') set.paid_at = bill.paid_at || invoice?.updated_at || invoice?.issue_date || new Date();

    if (!bill.bill_number) {
      set.bill_number = args.apply
        ? await nextAvailableBillNumber({ hospitalId: args.hospitalObjectId, date: bill.generated_at || bill.createdAt || new Date() })
        : '<GENERATED ON APPLY>';
    }

    await applyOrPreview({ apply: args.apply, model: Bill, id: bill._id, update: { $set: set }, label: 'Bill reconcile', counters });
  }
}

async function repairInvoices(args, counters, resolvedIds = []) {
  const cursor = Invoice.find({ ...scopedOrResolved('hospital_id', args.hospitalObjectId, resolvedIds), is_deleted: { $ne: true } }).lean().cursor({ batchSize: 100 });
  for await (const invoice of cursor) {
    counters.scanned += 1;
    const bill = await findBillForInvoice(invoice);
    if (bill?.hospital_id && idString(bill.hospital_id) !== args.hospitalId) {
      counters.conflicts += 1;
      console.error(`CONFLICT Invoice ${invoice._id}: linked bill belongs to ${bill.hospital_id}`);
      continue;
    }
    const state = invoiceFinancialState(invoice, bill);
    const issued = invoice.document_stage !== 'VOID' && (
      invoice.document_stage === 'ISSUED' || invoice.status !== 'Draft' || invoice.invoice_number || bill
    );
    const set = {
      amount_paid: state.amountPaid,
      settlement_discount_amount: state.settlementDiscount,
      credit_note_total: state.creditNote,
      balance_due: state.balanceDue,
      status: state.status,
      document_stage: issued ? 'ISSUED' : 'DRAFT'
    };
    if (bill?._id) set.bill_id = bill._id;
    if (issued) set.issued_at = invoice.issued_at || invoice.issue_date || new Date();

    await applyOrPreview({ apply: args.apply, model: Invoice, id: invoice._id, update: { $set: set }, label: 'Invoice reconcile', counters });
  }
}

async function repairCharges(args, counters, resolvedIds = []) {
  const cursor = IPDCharge.find(scopedOrResolved('hospitalId', args.hospitalObjectId, resolvedIds)).lean().cursor({ batchSize: 100 });
  for await (const charge of cursor) {
    counters.scanned += 1;
    let invoice = charge.invoiceId ? await Invoice.findById(charge.invoiceId).lean() : null;
    let bill = charge.billId ? await Bill.findById(charge.billId).lean() : null;
    if (!invoice && bill) invoice = await findInvoiceForBill(bill);
    if (!bill && invoice) bill = await findBillForInvoice(invoice);

    const linked = Boolean(charge.isBilled || charge.invoiceId || charge.billId || invoice || bill || charge.status === 'INVOICED');
    const set = {
      isBilled: linked,
      status: linked ? 'INVOICED' : (['VOIDED', 'CANCELLED'].includes(charge.status) ? charge.status : 'ACTIVE')
    };
    if (invoice?._id) set.invoiceId = invoice._id;
    if (bill?._id) set.billId = bill._id;
    if (linked) set.billedAt = charge.billedAt || invoice?.issued_at || invoice?.issue_date || bill?.invoiced_at || new Date();

    await applyOrPreview({ apply: args.apply, model: IPDCharge, id: charge._id, update: { $set: set }, label: 'IPDCharge reconcile', counters });
  }
}

async function main() {
  const args = parseArgs();
  await connect();
  const hospital = await assertHospital(args.hospitalObjectId);
  console.log(JSON.stringify({ mode: args.apply ? 'APPLY' : 'PREVIEW', hospital, forceUnresolved: args.forceUnresolved }, null, 2));

  const before = await auditFinancialIntegrity(args.hospitalObjectId);
  const indexPreparation = await ensureFinancialIndexes({ apply: args.apply });
  const counters = { scanned: 0, candidates: 0, updated: 0, unresolved: 0, conflicts: 0, otherHospital: 0 };
  const resolver = new RelationResolver(args.hospitalObjectId);

  const resolvedIds = await repairTenancy({ args, resolver, counters });
  await repairBills(args, counters, resolvedIds.Bill);
  await repairInvoices(args, counters, resolvedIds.Invoice);
  await repairCharges(args, counters, resolvedIds.IPDCharge);

  const after = args.apply ? await auditFinancialIntegrity(args.hospitalObjectId) : null;
  console.log(JSON.stringify({ before, after, indexPreparation, counters }, null, 2));
  if (counters.conflicts || counters.unresolved) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
