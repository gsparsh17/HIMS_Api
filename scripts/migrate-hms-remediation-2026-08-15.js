#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const scripts = [
  'migrate-prescription-hospital-scope-2026-08-15.js',
  'migrate-department-master-2026-08-15.js',
  'migrate-medicine-master-2026-08-15.js',
  'migrate-pathology-master-2026-08-15.js',
  'migrate-hospital-basic-tariff-2026-08-15.js'
];
const forwarded = process.argv.slice(2);
for (const script of scripts) {
  console.log(`\n=== ${script} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...forwarded], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
