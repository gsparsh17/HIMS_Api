#!/usr/bin/env node

/*
 * Reference documents, audited billing and discharge-summary migration.
 *
 * Dry-run is the default. No document is written unless --apply is supplied.
 *
 * Usage:
 *   npm run hims:migrate:reference-documents
 *   npm run hims:migrate:reference-documents -- --apply
 *   node scripts/migrate-reference-documents-2026.js --apply --state=migration-state/reference-documents-2026.json
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const APPLY = process.argv.includes('--apply');
const stateArg = process.argv.find((value) => value.startsWith('--state='));
const STATE_PATH = path.resolve(
  stateArg
    ? stateArg.split('=').slice(1).join('=')
    : `migration-state/reference-documents-2026-${Date.now()}.json`
);
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

const IPDCharge = require('../models/IPDCharge');
const Bill = require('../models/Bill');
const Invoice = require('../models/Invoice');
const DischargeSummary = require('../models/DischargeSummary');
const IPDConsent = require('../models/IPDConsent');

const state = {
  version: 'REFERENCE-DOCUMENTS-2026-08',
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  completed: false,
  collections: {},
  warnings: [],
  error: null
};

const money = (value) => Number(Number(value || 0).toFixed(2));
const missing = (value) => value === undefined || value === null || value === '';

function collectionState(name) {
  state.collections[name] ||= { scanned: 0, candidates: 0, updated: 0, unchanged: 0 };
  return state.collections[name];
}

function setIfMissing(patch, source, key, value) {
  if (missing(source?.[key]) && !missing(value)) patch[key] = value;
}

function changed(source, patch) {
  return Object.entries(patch).some(([key, value]) => JSON.stringify(source?.[key]) !== JSON.stringify(value));
}

async function persist() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function scanAndPatch(Model, name, makePatch) {
  const stats = collectionState(name);
  const cursor = Model.collection.find({});
  const operations = [];

  for await (const document of cursor) {
    stats.scanned += 1;
    const patch = await makePatch(document);
    if (!patch || !Object.keys(patch).length || !changed(document, patch)) {
      stats.unchanged += 1;
      continue;
    }
    stats.candidates += 1;
    if (APPLY) {
      operations.push({ updateOne: { filter: { _id: document._id }, update: { $set: patch } } });
      if (operations.length >= 250) {
        const result = await Model.collection.bulkWrite(operations, { ordered: false });
        stats.updated += result.modifiedCount || 0;
        operations.length = 0;
        await persist();
      }
    }
  }

  if (APPLY && operations.length) {
    const result = await Model.collection.bulkWrite(operations, { ordered: false });
    stats.updated += result.modifiedCount || 0;
  }
}

function chargePatch(charge) {
  const patch = {};
  const quantity = Number(charge.quantity || 1);
  const gross = money(!missing(charge.grossAmount) ? charge.grossAmount : (!missing(charge.amount) ? charge.amount : quantity * Number(charge.rate || 0)));
  const discountAmount = money(!missing(charge.discountAmount) ? charge.discountAmount : charge.discount);
  const taxAmount = money(!missing(charge.taxAmount) ? charge.taxAmount : charge.tax);
  const taxableAmount = money(Math.max(0, gross - discountAmount));
  const calculatedNet = money(taxableAmount + taxAmount + Number(charge.roundingAdjustment || 0));
  const isDiscount = charge.adjustmentType === 'DISCOUNT' || charge.chargeType === 'Discount';
  const isTax = charge.adjustmentType === 'TAX' || charge.chargeType === 'Tax';
  const netAmount = isDiscount ? -Math.abs(discountAmount) : isTax ? Math.abs(taxAmount) : money(!missing(charge.netAmount) ? charge.netAmount : calculatedNet);

  setIfMissing(patch, charge, 'grossAmount', gross);
  setIfMissing(patch, charge, 'discountAmount', discountAmount);
  setIfMissing(patch, charge, 'taxAmount', taxAmount);
  setIfMissing(patch, charge, 'taxableAmount', taxableAmount);
  setIfMissing(patch, charge, 'netAmount', netAmount);
  setIfMissing(patch, charge, 'discountType', String(charge.discountDetails?.type || 'fixed').toLowerCase());
  setIfMissing(patch, charge, 'discountReason', charge.discountDetails?.reason || '');
  setIfMissing(patch, charge, 'discountApprovedBy', charge.discountDetails?.approvedBy);
  setIfMissing(patch, charge, 'discountApprovedAt', charge.discountDetails?.approvedAt);
  setIfMissing(patch, charge, 'taxMode', taxAmount ? 'exclusive' : 'exempt');
  setIfMissing(patch, charge, 'patientLiability', Number(charge.pricingSnapshot?.amounts?.patientLiability ?? netAmount));
  return patch;
}

function billItemPatch(item = {}) {
  const quantity = Number(item.quantity || 1);
  const gross = money(!missing(item.gross_amount) ? item.gross_amount : (!missing(item.unit_price) ? Number(item.unit_price) * quantity : item.amount));
  const discount = money(item.discount_amount);
  const tax = money(item.tax_amount);
  const taxable = money(!missing(item.taxable_amount) ? item.taxable_amount : Math.max(0, gross - discount));
  return {
    ...item,
    gross_amount: gross,
    discount_type: item.discount_type || 'fixed',
    discount_rate: money(item.discount_rate),
    discount_amount: discount,
    taxable_amount: taxable,
    tax_mode: item.tax_mode || (tax ? 'exclusive' : 'exempt'),
    tax_amount: tax,
    net_amount: money(!missing(item.net_amount) ? item.net_amount : taxable + tax),
    charge_head: item.charge_head || item.item_type || 'Other'
  };
}

function billPatch(bill) {
  const patch = {};
  const items = Array.isArray(bill.items) ? bill.items.map(billItemPatch) : [];
  const gross = money(!missing(bill.gross_amount) ? bill.gross_amount : (bill.subtotal || items.reduce((sum, item) => sum + item.gross_amount, 0)));
  const lineDiscount = money(!missing(bill.line_discount_total) ? bill.line_discount_total : items.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0));
  const billDiscount = money(!missing(bill.bill_discount_total) ? bill.bill_discount_total : Math.max(0, Number(bill.discount || 0) - lineDiscount));
  const taxable = money(!missing(bill.taxable_amount) ? bill.taxable_amount : Math.max(0, gross - lineDiscount - billDiscount));

  if (items.length && JSON.stringify(items) !== JSON.stringify(bill.items)) patch.items = items;
  setIfMissing(patch, bill, 'gross_amount', gross);
  setIfMissing(patch, bill, 'line_discount_total', lineDiscount);
  setIfMissing(patch, bill, 'bill_discount_total', billDiscount);
  setIfMissing(patch, bill, 'taxable_amount', taxable);
  setIfMissing(patch, bill, 'rounding_adjustment', 0);
  setIfMissing(patch, bill, 'advance_applied', 0);
  setIfMissing(patch, bill, 'refund_amount', 0);
  setIfMissing(patch, bill, 'balance_due', Math.max(0, money(Number(bill.total_amount || 0) - Number(bill.paid_amount || 0) - Number(bill.settlement_discount_amount || 0) - Number(bill.credit_note_amount || 0))));
  return patch;
}

function invoiceLinePatch(item = {}) {
  const quantity = Number(item.quantity || 1);
  const gross = money(!missing(item.gross_amount) ? item.gross_amount : (!missing(item.unit_price) ? Number(item.unit_price) * quantity : item.total_price));
  const discount = money(item.discount_amount);
  const tax = money(item.tax_amount);
  const taxable = money(!missing(item.taxable_amount) ? item.taxable_amount : Math.max(0, gross - discount));
  return {
    ...item,
    gross_amount: gross,
    discount_type: item.discount_type || 'fixed',
    discount_rate: money(item.discount_rate),
    discount_amount: discount,
    taxable_amount: taxable,
    tax_mode: item.tax_mode || (tax ? 'exclusive' : 'exempt'),
    tax_amount: tax,
    net_amount: money(!missing(item.net_amount) ? item.net_amount : taxable + tax),
    charge_head: item.charge_head || item.service_type || 'Miscellaneous'
  };
}

function invoicePatch(invoice) {
  const patch = {};
  const items = Array.isArray(invoice.service_items) ? invoice.service_items.map(invoiceLinePatch) : [];
  const gross = money(!missing(invoice.gross_amount) ? invoice.gross_amount : (invoice.subtotal || items.reduce((sum, item) => sum + item.gross_amount, 0)));
  const lineDiscount = money(!missing(invoice.line_discount_total) ? invoice.line_discount_total : items.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0));
  const billDiscount = money(!missing(invoice.bill_discount_total) ? invoice.bill_discount_total : Math.max(0, Number(invoice.discount || 0) - lineDiscount));
  const taxable = money(!missing(invoice.taxable_amount) ? invoice.taxable_amount : Math.max(0, gross - lineDiscount - billDiscount));

  if (items.length && JSON.stringify(items) !== JSON.stringify(invoice.service_items)) patch.service_items = items;
  setIfMissing(patch, invoice, 'gross_amount', gross);
  setIfMissing(patch, invoice, 'line_discount_total', lineDiscount);
  setIfMissing(patch, invoice, 'bill_discount_total', billDiscount);
  setIfMissing(patch, invoice, 'taxable_amount', taxable);
  setIfMissing(patch, invoice, 'rounding_adjustment', 0);
  setIfMissing(patch, invoice, 'advance_applied', 0);
  return patch;
}

function medicinePatch(medicine = {}) {
  const durationText = String(medicine.duration || '');
  const daysMatch = durationText.match(/(\d+(?:\.\d+)?)/);
  const schedule = String(medicine.frequency || medicine.type || '').trim().toUpperCase();
  const explicit = [medicine.morning, medicine.noon, medicine.evening, medicine.extra]
    .some((value) => !missing(value));
  let morning = medicine.morning || '';
  let noon = medicine.noon || '';
  let evening = medicine.evening || '';
  let extra = medicine.extra || '';

  if (!explicit) {
    if (['OD', 'QD', 'ONCE DAILY'].includes(schedule)) morning = '1';
    if (['BD', 'BID', 'TWICE DAILY'].includes(schedule)) { morning = '1'; evening = '1'; }
    if (['TDS', 'TID', 'THRICE DAILY'].includes(schedule)) { morning = '1'; noon = '1'; evening = '1'; }
    if (['QID', 'FOUR TIMES DAILY'].includes(schedule)) { morning = '1'; noon = '1'; evening = '1'; extra = '1'; }
    if (['HS', 'BEDTIME', 'NIGHT'].includes(schedule)) evening = '1';
  }

  return {
    ...medicine,
    saltName: medicine.saltName || '',
    days: medicine.days || (daysMatch ? daysMatch[1] : ''),
    type: medicine.type || medicine.frequency || '',
    meal: medicine.meal || medicine.instructions || '',
    morning,
    noon,
    evening,
    extra,
    unit: medicine.unit || ''
  };
}

function dischargePatch(summary) {
  const patch = {};
  const medicines = Array.isArray(summary.dischargeMedications) ? summary.dischargeMedications.map(medicinePatch) : [];
  if (JSON.stringify(medicines) !== JSON.stringify(summary.dischargeMedications || [])) patch.dischargeMedications = medicines;
  setIfMissing(patch, summary, 'templateVersion', '2.0');
  setIfMissing(patch, summary, 'operativeNotes', summary.surgeriesDone || summary.proceduresDone || '');
  setIfMissing(patch, summary, 'conditionAtDischargeText', summary.conditionOnDischarge || '');
  setIfMissing(patch, summary, 'followUpDetails', summary.followUpAdvice || '');
  setIfMissing(patch, summary, 'adviceAtDischarge', [summary.dietAdvice, summary.activityAdvice].filter(Boolean).join('\n'));
  return patch;
}

function consentPatch(consent) {
  const patch = {};
  const responses = consent.responses || {};
  const legacyLama = consent.templateId === 'mlc-refusal-consent' && (
    String(consent.templateVersion || '').startsWith('1') ||
    Object.prototype.hasOwnProperty.call(responses, 'refusalType') ||
    Object.prototype.hasOwnProperty.call(responses, 'reasonForRefusal') ||
    Object.prototype.hasOwnProperty.call(responses, 'risksOfRefusalExplained')
  );

  if (legacyLama) {
    patch.templateId = 'lama-dor-consent';
    patch.rendererId = 'native-consent-document';
    patch.templateVersion = '4.0';
  } else {
    setIfMissing(patch, consent, 'rendererId', 'native-consent-document');
    setIfMissing(patch, consent, 'templateVersion', '4.0');
  }
  if (consent.status === 'Finalized') {
    setIfMissing(patch, consent, 'finalizedAt', consent.updatedAt || consent.createdAt || new Date());
    setIfMissing(patch, consent, 'finalizedBy', consent.updatedBy || consent.createdBy);
  }
  return patch;
}

async function main() {
  if (!MONGO_URI) throw new Error('MONGODB_URI or MONGO_URI is required.');
  await mongoose.connect(MONGO_URI, { autoIndex: false, autoCreate: false });

  await scanAndPatch(IPDCharge, 'IPDCharge', chargePatch);
  await scanAndPatch(Bill, 'Bill', billPatch);
  await scanAndPatch(Invoice, 'Invoice', invoicePatch);
  await scanAndPatch(DischargeSummary, 'DischargeSummary', dischargePatch);
  await scanAndPatch(IPDConsent, 'IPDConsent', consentPatch);

  state.completed = true;
  state.completedAt = new Date().toISOString();
  await persist();
  console.log(JSON.stringify(state, null, 2));
  console.log(APPLY ? 'Migration applied.' : 'Dry run complete. Re-run with --apply after reviewing the state file.');
}

main()
  .catch(async (error) => {
    state.error = { message: error.message, stack: error.stack };
    await persist().catch(() => {});
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
