#!/usr/bin/env node
'use strict';

const {
  parseArgs,
  connect,
  assertHospital,
  auditFinancialIntegrity,
  mongoose
} = require('./financial-integrity.lib');

async function main() {
  const args = parseArgs();
  await connect();
  const hospital = await assertHospital(args.hospitalObjectId);
  const report = await auditFinancialIntegrity(args.hospitalObjectId);
  const critical = {
    ...report.missingTenantFields,
    ...report.inconsistencies
  };
  const failed = Object.values(critical).some((value) => Number(value || 0) > 0);
  console.log(JSON.stringify({ hospital, verified: !failed, critical, report }, null, 2));
  if (failed) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
