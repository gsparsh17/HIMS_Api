#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const service = require('../../services/pharmacyFinanceProjection.service');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const hospitalId = arg('--hospital');
  if (!hospitalId) throw new Error('Usage: node scripts/reconciliation/pharmacyFinanceAudit.js --hospital <hospitalId> [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const result = await service.getIntegrationAudit({ hospitalId, from: arg('--from'), to: arg('--to'), timezone: arg('--timezone') || 'Asia/Kolkata' }, {});
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.summary.highSeverityCount > 0 ? 2 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => mongoose.disconnect());
