#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const reconciliation = require('../../services/financialReconciliation.service');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

(async () => {
  const hospitalId = arg('--hospital');
  const persist = process.argv.includes('--persist');
  if (!hospitalId || !mongoose.Types.ObjectId.isValid(hospitalId)) {
    throw new Error('Usage: node scripts/reconciliation/financeReconciliation.js --hospital <hospitalId> [--persist]');
  }
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const result = await reconciliation.runScan(hospitalId, { persist });
  console.log(JSON.stringify({ runId: result.runId, scannedAt: result.scannedAt, total: result.total, bySeverity: result.bySeverity, byCategory: result.byCategory, issues: result.issues }, null, 2));
  await mongoose.disconnect();
  process.exit((result.bySeverity.CRITICAL || 0) > 0 ? 2 : 0);
})().catch(async (error) => {
  console.error(error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
