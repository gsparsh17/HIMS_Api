/*
 * Usage: node scripts/migrations/backfill-financial-transaction-groups.js --apply
 * Backfills only deterministic group IDs. Ambiguous legacy entries are reported,
 * never guessed, and must be reconciled through finance review.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const PharmacyReturn = require('../../models/PharmacyReturn');
const PharmacyLedgerEntry = require('../../models/PharmacyLedgerEntry');
const PatientAdvanceLedger = require('../../models/PatientAdvanceLedger');
const PharmacyLedgerSettlement = require('../../models/PharmacyLedgerSettlement');
const apply = process.argv.includes('--apply');
const group = (kind, id) => `${kind}:${id}`;

async function update(Model, filter, prefix, sourceField = '_id') {
  let count = 0;
  for await (const row of Model.find(filter).cursor()) {
    const source = row[sourceField] || row._id;
    if (!source) { console.log(`AMBIGUOUS ${prefix} ${row._id}`); continue; }
    const transactionGroupId = group(prefix, source);
    console.log(`${apply ? 'APPLY' : 'DRY-RUN'} ${prefix} ${row._id} -> ${transactionGroupId}`);
    if (apply) { row.transactionGroupId = transactionGroupId; row.parentGroupId = row.parentGroupId || transactionGroupId; await row.save(); count += 1; }
  }
  return count;
}
async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const summary = {};
  summary.sales = await update(Sale, { $or: [{ transactionGroupId: { $exists: false } }, { transactionGroupId: null }, { transactionGroupId: '' }] }, 'sale');
  summary.returns = await update(PharmacyReturn, { $or: [{ transactionGroupId: { $exists: false } }, { transactionGroupId: null }, { transactionGroupId: '' }] }, 'return', 'originalSaleId');
  summary.entries = await update(PharmacyLedgerEntry, { $or: [{ transactionGroupId: { $exists: false } }, { transactionGroupId: null }, { transactionGroupId: '' }] }, 'ledger');
  summary.advances = await update(PatientAdvanceLedger, { $or: [{ transactionGroupId: { $exists: false } }, { transactionGroupId: null }, { transactionGroupId: '' }] }, 'advance');
  summary.settlements = await update(PharmacyLedgerSettlement, { $or: [{ transactionGroupId: { $exists: false } }, { transactionGroupId: null }, { transactionGroupId: '' }] }, 'settlement');
  console.log(summary);
  await mongoose.disconnect();
}
run().catch(async (error) => { console.error(error); await mongoose.disconnect().catch(() => {}); process.exit(1); });
