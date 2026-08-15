#!/usr/bin/env node
'use strict';

const mongoose = require('mongoose');
const Prescription = require('../models/Prescription');
const Patient = require('../models/Patient');
const { migrationOptions, connect, close, baseReport, writeState } = require('./lib/hmsMigrationUtils');

async function main() {
  const { hospitalId, apply, statePath } = migrationOptions();
  const report = baseReport('prescription-hospital-scope-2026-08-15', apply, hospitalId);
  await connect();
  try {
    const patientIds = await Patient.find({ hospitalId }).distinct('_id');
    const cursor = Prescription.find({ patient_id: { $in: patientIds }, hospitalId: { $ne: hospitalId } })
      .select('_id patient_id hospitalId prescription_number')
      .cursor();
    for await (const prescription of cursor) {
      report.changes.push({
        _id: String(prescription._id),
        prescriptionNumber: prescription.prescription_number,
        patientId: String(prescription.patient_id),
        fromHospitalId: prescription.hospitalId ? String(prescription.hospitalId) : null,
        toHospitalId: String(hospitalId)
      });
      if (apply) {
        await Prescription.updateOne(
          { _id: prescription._id, patient_id: prescription.patient_id },
          { $set: { hospitalId } }
        );
        report.updated += 1;
      } else {
        report.updated += 1;
      }
    }
    report.patientCount = patientIds.length;
    report.dryRun = !apply;
    const out = writeState(report, statePath);
    console.log(JSON.stringify({ ...report, changes: undefined, statePath: out }, null, 2));
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
