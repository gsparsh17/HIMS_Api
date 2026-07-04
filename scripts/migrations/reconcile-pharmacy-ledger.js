/* Usage: node scripts/migrations/reconcile-pharmacy-ledger.js > reconciliation.json */
require('dotenv').config();
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const PharmacyReturn = require('../../models/PharmacyReturn');

const n = (value) => Number(value || 0);
async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  const exceptions = [];
  for await (const sale of Sale.find({}).cursor()) {
    const returns = await PharmacyReturn.find({ originalSaleId: sale._id, status: { $in: ['Completed', 'Approved'] } });
    const returnValue = returns.reduce((sum, row) => sum + n(row.totalRefundAmount), 0);
    const expected = Math.max(0, n(sale.total_amount) - n(sale.amount_paid) - n(sale.settlement_amount) - returnValue);
    const actual = n(sale.balance_due);
    if (Math.abs(expected - actual) > 0.01) exceptions.push({ saleId: String(sale._id), saleNumber: sale.sale_number, total: n(sale.total_amount), amountPaid: n(sale.amount_paid), settlement: n(sale.settlement_amount), returns: returnValue, expectedDue: expected, actualDue: actual, reason: 'ARITHMETIC_MISMATCH' });
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), exceptionCount: exceptions.length, exceptions }, null, 2));
  await mongoose.disconnect();
}
run().catch(async (error) => { console.error(error); await mongoose.disconnect().catch(() => {}); process.exit(1); });
