#!/usr/bin/env node
'use strict';

/*
 * Repairs the legacy IPDAdmission.hospitalId defect where Mongo Extended JSON
 * was imported as a literal string, e.g. '{"$oid":"69..."}'.
 *
 * Dry-run:
 *   node scripts/migrate-legacy-objectid-values-2026-08-15.js --hospital-id=<ObjectId>
 *
 * Apply:
 *   node scripts/migrate-legacy-objectid-values-2026-08-15.js --hospital-id=<ObjectId> --apply
 */
require('dotenv').config();

const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const hospitalArg = args.find((value) => value.startsWith('--hospital-id='));
const hospitalIdText = hospitalArg?.split('=')[1];

if (!process.env.MONGO_URI || !mongoose.isValidObjectId(hospitalIdText)) {
  console.error('MONGO_URI and --hospital-id=<ObjectId> are required');
  process.exit(2);
}

const targetHospitalId = new mongoose.Types.ObjectId(hospitalIdText);

function parseLegacyObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === 'object' && value?.$oid && mongoose.isValidObjectId(value.$oid)) {
    return new mongoose.Types.ObjectId(String(value.$oid));
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (mongoose.isValidObjectId(trimmed)) return new mongoose.Types.ObjectId(trimmed);

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed?.$oid && mongoose.isValidObjectId(parsed.$oid)) {
      return new mongoose.Types.ObjectId(String(parsed.$oid));
    }
  } catch {
    // Ignore malformed JSON; try ObjectId("...") next.
  }

  const match = trimmed.match(/^ObjectId\s*\(\s*["']?([a-fA-F0-9]{24})["']?\s*\)$/);
  return match ? new mongoose.Types.ObjectId(match[1]) : null;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const cursor = IPDAdmission.collection.find({ hospitalId: { $type: 'string' } });
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    hospitalId: hospitalIdText,
    scannedStringHospitalIds: 0,
    matchingLegacyRows: 0,
    updated: 0,
    ignoredDifferentHospital: 0,
    invalidLegacyValues: 0,
    admissionIds: []
  };

  while (await cursor.hasNext()) {
    const row = await cursor.next();
    report.scannedStringHospitalIds += 1;
    const parsed = parseLegacyObjectId(row.hospitalId);
    if (!parsed) {
      report.invalidLegacyValues += 1;
      continue;
    }
    if (String(parsed) !== String(targetHospitalId)) {
      report.ignoredDifferentHospital += 1;
      continue;
    }

    report.matchingLegacyRows += 1;
    report.admissionIds.push(String(row._id));

    if (apply) {
      const result = await IPDAdmission.collection.updateOne(
        { _id: row._id, hospitalId: row.hospitalId },
        { $set: { hospitalId: targetHospitalId } }
      );
      report.updated += result.modifiedCount || 0;
    }
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
