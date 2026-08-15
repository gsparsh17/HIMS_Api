#!/usr/bin/env node
/*
 * MRD backfill migration. Dry-run by default.
 * Usage:
 *   MONGO_URI=... node scripts/migrate-mrd-2026-08-15.js --hospital-id=<id>
 *   MONGO_URI=... node scripts/migrate-mrd-2026-08-15.js --hospital-id=<id> --apply
 */
require('dotenv').config();

const mongoose = require('mongoose');
const IPDAdmission = require('../models/IPDAdmission');
const EmergencyEncounter = require('../models/EmergencyEncounter');
const MRDFileTracking = require('../models/MRDFileTracking');
const MRDBirthDeathRecord = require('../models/MRDBirthDeathRecord');
const MRDMedicoLegalRecord = require('../models/MRDMedicoLegalRecord');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const hospitalArg = args.find((v) => v.startsWith('--hospital-id='));
const hospitalId = hospitalArg?.split('=')[1];
if (!process.env.MONGO_URI || !hospitalId || !mongoose.isValidObjectId(hospitalId)) {
  console.error('MONGO_URI and --hospital-id=<ObjectId> are required'); process.exit(2);
}
function clean(value) { return String(value || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60); }
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const report = { mode: apply ? 'apply' : 'dry-run', hospitalId, fileTracking: { candidates: 0, inserted: 0 }, deaths: { candidates: 0, inserted: 0 }, mlc: { candidates: 0, inserted: 0 } };
  const admissions = await IPDAdmission.find({ hospitalId }).select('_id patientId admissionNumber status dischargeDate primaryDoctorId departmentId wardId bedId').lean();
  for (const a of admissions) {
    const fileNumber = `MRD-IPD-${clean(a.admissionNumber || a._id)}`;
    if (!(await MRDFileTracking.exists({ hospitalId, fileNumber }))) {
      report.fileTracking.candidates++;
      if (apply) { await MRDFileTracking.create({ hospitalId, fileNumber, patientId: a.patientId, admissionId: a._id, recordType: 'IPD', currentHolderType: 'MRD', currentHolderName: 'MRD', status: 'in_registry', notes: 'Backfilled from existing IPD admission' }); report.fileTracking.inserted++; }
    }
    if (a.status === 'Expired' && !(await MRDBirthDeathRecord.exists({ hospitalId, recordType: 'death', admissionId: a._id }))) {
      report.deaths.candidates++;
      if (apply) { await MRDBirthDeathRecord.create({ hospitalId, recordType: 'death', recordNumber: `DTH-${clean(a.admissionNumber || a._id)}`, patientId: a.patientId, admissionId: a._id, eventDateTime: a.dischargeDate || new Date(), attendingDoctorId: a.primaryDoctorId, departmentId: a.departmentId, wardId: a.wardId, bedId: a.bedId, registrationStatus: 'registered', details: { migrationSource: 'IPDAdmission.status=Expired' } }); report.deaths.inserted++; }
    }
  }
  const emergencyRows = await EmergencyEncounter.find({ hospitalId, 'medicoLegal.isMlc': true }).select('_id patientId admissionId arrivalAt medicoLegal').lean();
  for (const e of emergencyRows) {
    if (await MRDMedicoLegalRecord.exists({ hospitalId, emergencyEncounterId: e._id })) continue;
    report.mlc.candidates++;
    if (apply) { await MRDMedicoLegalRecord.create({ hospitalId, patientId: e.patientId, admissionId: e.admissionId, emergencyEncounterId: e._id, caseNumber: e.medicoLegal?.caseNumber || `MLC-${clean(e._id)}`, caseType: 'MLC', registeredAt: e.arrivalAt || new Date(), policeStation: e.medicoLegal?.policeStation, policeInformedAt: e.medicoLegal?.policeInformedAt, notes: e.medicoLegal?.notes, status: 'open' }); report.mlc.inserted++; }
  }
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
})().catch(async (error) => { console.error(error); try { await mongoose.disconnect(); } catch {} process.exit(1); });
