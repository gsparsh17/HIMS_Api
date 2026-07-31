#!/usr/bin/env node
'use strict';

/*
 * Preview:
 *   node scripts/prepare-financial-indexes.js
 * Apply:
 *   node scripts/prepare-financial-indexes.js --apply
 */

const {
  parseArgs,
  connect,
  ensureFinancialIndexes,
  mongoose
} = require('./financial-integrity.lib');

async function main() {
  const args = parseArgs();
  await connect();
  const result = await ensureFinancialIndexes({ apply: args.apply });
  console.log(JSON.stringify({ mode: args.apply ? 'APPLY' : 'PREVIEW', result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
