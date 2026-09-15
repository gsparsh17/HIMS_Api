#!/usr/bin/env node
'use strict';

/**
 * Read-only audit for the seeded two-patient complete-flow fixture.
 *
 * Usage:
 *   node scripts/audit-two-patient-ui-api-data.js --expected-db-name test
 *
 * IMPORTANT: fixture identity is discovered from the immutable _testScenario
 * tags written by the seed. It intentionally does NOT depend on the mutable
 * seed-master-data.json preflight snapshot, because rerunning the preflight
 * after seeding will select a new pair of clean patients.
 *
 * Optional narrowing:
 *   --hospital-id <ObjectId>
 *
 * This script performs no writes.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const expectedDb = argValue('--expected-db-name');
const requestedHospitalId = argValue('--hospital-id');
const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;

if (!uri) throw new Error('Missing MONGO_URI / MONGODB_URI / MONGO_URL in .env');

const { ObjectId } = mongoose.Types;
const oid = (value, label) => {
  if (!ObjectId.isValid(value)) throw new Error(`Invalid ObjectId for ${label}: ${value}`);
  return new ObjectId(value);
};
const OPD_TAG = 'FLOW_FIXTURE_OPD_V2';
const IPD_TAG = 'FLOW_FIXTURE_IPD_V2';

const checks = [];
function pass(label, detail = '') { checks.push({ level: 'PASS', label, detail }); }
function warn(label, detail = '') { checks.push({ level: 'WARN', label, detail }); }
function fail(label, detail = '') { checks.push({ level: 'FAIL', label, detail }); }
function money(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }
function id(value) { return String(value?._id || value || ''); }
function eqId(a, b) { return id(a) === id(b); }

async function one(db, collection, filter) {
  return db.collection(collection).findOne(filter);
}
async function many(db, collection, filter, sort = { createdAt: 1 }) {
  return db.collection(collection).find(filter).sort(sort).toArray();
}

async function main() {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  console.log('Mode: READ-ONLY SEEDED UI/API AUDIT');
  console.log(`Database: ${dbName}`);
  if (expectedDb && expectedDb !== dbName) throw new Error(`Connected database ${dbName} does not match --expected-db-name ${expectedDb}`);

  // Discover the actual seeded fixture from immutable scenario tags. The
  // preflight JSON is deliberately ignored here because it is expected to
  // change after the original patients acquire operational history.
  const opdAppointmentCandidates = await db.collection('appointments')
    .find({ _testScenario: OPD_TAG, ...(requestedHospitalId ? { hospital_id: oid(requestedHospitalId, 'hospital') } : {}) })
    .sort({ createdAt: -1, created_at: -1, _id: -1 })
    .limit(2)
    .toArray();
  const ipdAdmissionCandidates = await db.collection('ipdadmissions')
    .find({ _testScenario: IPD_TAG, ...(requestedHospitalId ? { hospitalId: oid(requestedHospitalId, 'hospital') } : {}) })
    .sort({ createdAt: -1, created_at: -1, _id: -1 })
    .limit(2)
    .toArray();

  if (!opdAppointmentCandidates.length || !ipdAdmissionCandidates.length) {
    if (!opdAppointmentCandidates.length) fail('OPD appointment', `no document tagged ${OPD_TAG}`);
    if (!ipdAdmissionCandidates.length) fail('IPD admission', `no document tagged ${IPD_TAG}`);
    return report();
  }
  if (!requestedHospitalId && (opdAppointmentCandidates.length > 1 || ipdAdmissionCandidates.length > 1)) {
    warn('Fixture discovery', 'multiple tagged fixtures exist; auditing the newest pair. Use --hospital-id to narrow explicitly if needed.');
  }

  const opdAppointment = opdAppointmentCandidates[0];
  const ipdAdmission = ipdAdmissionCandidates[0];
  const hospitalId = oid(opdAppointment.hospital_id || opdAppointment.hospitalId, 'OPD fixture hospital');
  const ipdHospitalId = oid(ipdAdmission.hospitalId || ipdAdmission.hospital_id, 'IPD fixture hospital');
  if (String(hospitalId) !== String(ipdHospitalId)) {
    fail('Fixture hospital consistency', `OPD=${hospitalId} IPD=${ipdHospitalId}`);
    return report();
  }
  const opdPatientId = oid(opdAppointment.patient_id || opdAppointment.patientId, 'OPD fixture patient');
  const ipdPatientId = oid(ipdAdmission.patientId || ipdAdmission.patient_id, 'IPD fixture patient');
  const [opdPatient, ipdPatient] = await Promise.all([
    one(db, 'patients', { _id: opdPatientId, hospitalId }),
    one(db, 'patients', { _id: ipdPatientId, hospitalId })
  ]);

  pass('Fixture discovery', `${OPD_TAG}/${IPD_TAG} · hospital=${hospitalId}`);

  opdPatient ? pass('OPD patient master', `${opdPatient.first_name || ''} ${opdPatient.last_name || ''}`.trim()) : fail('OPD patient master', 'missing');
  ipdPatient ? pass('IPD patient master', `${ipdPatient.first_name || ''} ${ipdPatient.last_name || ''}`.trim()) : fail('IPD patient master', 'missing');
  opdAppointment ? pass('OPD appointment', id(opdAppointment._id)) : fail('OPD appointment', 'missing fixture appointment');
  ipdAdmission ? pass('IPD admission', `${ipdAdmission.admissionNumber || id(ipdAdmission._id)} · ${ipdAdmission.status}`) : fail('IPD admission', 'missing fixture admission');
  if (!opdAppointment || !ipdAdmission) return report();

  // Demographics used by the patient-file/discharge surfaces.
  for (const [label, patient] of [['OPD', opdPatient], ['IPD', ipdPatient]]) {
    if (!patient) continue;
    if (patient.address || patient.city || patient.state) pass(`${label} printable address`, patient.address || [patient.city, patient.state].filter(Boolean).join(', '));
    else warn(`${label} printable address`, 'patient master has no address/city/state value; UI will correctly show blank/N/A');
    if (patient.dob || patient.age || patient.enteredAgeYears != null) pass(`${label} printable age source`);
    else warn(`${label} printable age source`, 'no DOB/age metadata found');
  }

  // OPD clinical journey.
  const [opdVitals, opdRx, opdLabs, opdRad, opdProcedures, opdBills, opdInvoices, opdSales, opdCheckout] = await Promise.all([
    many(db, 'vitals', { _testScenario: OPD_TAG, patient_id: opdPatientId }),
    many(db, 'prescriptions', { _testScenario: OPD_TAG, patient_id: opdPatientId }),
    many(db, 'labrequests', { _testScenario: OPD_TAG, patientId: opdPatientId }),
    many(db, 'radiologyrequests', { _testScenario: OPD_TAG, patientId: opdPatientId }),
    many(db, 'procedurerequests', { _testScenario: OPD_TAG, patientId: opdPatientId }),
    many(db, 'bills', { _testScenario: OPD_TAG, hospital_id: hospitalId, patient_id: opdPatientId }),
    many(db, 'invoices', { _testScenario: OPD_TAG, hospital_id: hospitalId, patient_id: opdPatientId }),
    many(db, 'sales', { _testScenario: OPD_TAG, hospitalId, patient_id: opdPatientId }),
    one(db, 'deskcheckouts', { _testScenario: OPD_TAG, patientId: opdPatientId })
  ]);
  opdVitals.length ? pass('OPD vitals', `${opdVitals.length} row(s)`) : fail('OPD vitals', 'missing');
  opdRx.length ? pass('OPD prescription', `${opdRx.length} row(s)`) : fail('OPD prescription', 'missing');
  const opdLab = opdLabs[0];
  if (opdLab?.reportFinalisation?.isFinal && Array.isArray(opdLab?.manual_report?.observations) && opdLab.manual_report.observations.length === 14) pass('OPD CBC structured report', 'final · 14 observations');
  else fail('OPD CBC structured report', 'not final or template observations missing');
  const opdRadiology = opdRad[0];
  if (opdRadiology?.reportFinalisation?.isFinal && Array.isArray(opdRadiology?.manual_report?.sections) && opdRadiology.manual_report.sections.length === 8) pass('OPD X-ray structured report', 'final · 8 sections');
  else fail('OPD X-ray structured report', 'not final or sections missing');
  opdProcedures.some((row) => String(row.status).toLowerCase() === 'completed') ? pass('OPD procedure completion') : fail('OPD procedure completion');
  const opdClinicalInvoice = opdInvoices.find((row) => !row.is_pharmacy_sale);
  const opdPharmacyInvoice = opdInvoices.find((row) => row.is_pharmacy_sale || String(row.invoice_type).toLowerCase() === 'pharmacy');
  if (money(opdClinicalInvoice?.total) === 2800 && money(opdClinicalInvoice?.balance_due) === 0) pass('OPD clinical invoice', '₹2800 · settled');
  else fail('OPD clinical invoice', `total=${money(opdClinicalInvoice?.total)} due=${money(opdClinicalInvoice?.balance_due)}`);
  if (money(opdPharmacyInvoice?.total) === 150 && money(opdPharmacyInvoice?.balance_due) === 0) pass('OPD pharmacy invoice', '₹150 · settled');
  else fail('OPD pharmacy invoice', `total=${money(opdPharmacyInvoice?.total)} due=${money(opdPharmacyInvoice?.balance_due)}`);
  const opdPharmacyBill = opdBills.find((row) => row.is_pharmacy_bill);
  const opdSale = opdSales[0];
  if (opdPharmacyBill && opdPharmacyInvoice && opdSale && eqId(opdPharmacyBill.invoice_id, opdPharmacyInvoice._id) && eqId(opdPharmacyBill.sale_id, opdSale._id)) pass('OPD Pharmacy Bill ↔ Invoice ↔ Sale links');
  else fail('OPD Pharmacy Bill ↔ Invoice ↔ Sale links');
  opdCheckout ? pass('OPD desk checkout', id(opdCheckout._id)) : fail('OPD desk checkout', 'missing');

  // IPD location and clinical file.
  const [room, bed, ward] = await Promise.all([
    one(db, 'rooms', { _id: ipdAdmission.roomId, hospitalId }),
    one(db, 'beds', { _id: ipdAdmission.bedId, hospitalId }),
    one(db, 'wards', { _id: ipdAdmission.wardId, hospitalId })
  ]);
  room?.room_number ? pass('IPD room display contract', room.room_number) : fail('IPD room display contract', 'Room.room_number missing');
  ward ? pass('IPD ward display contract', ward.name || ward.wardName || id(ward._id)) : fail('IPD ward display contract');
  if (bed && String(bed.status).toLowerCase() === 'available') pass('Bed released after discharge', `${bed.bedNumber || ''} · ${bed.status}`);
  else fail('Bed released after discharge', bed ? String(bed.status) : 'bed missing');

  const [rounds, nursingNotes, ipdVitals, charges, doctorAssessment, nursingAssessment, ipdLabs, ipdRad, ipdProcedures, ipdBills, ipdInvoices, ipdSales, advanceRows, pharmacyLedger, settlement, discharge] = await Promise.all([
    many(db, 'ipdrounds', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    many(db, 'nursingnotes', { _testScenario: IPD_TAG, admissionId: ipdAdmission._id }),
    many(db, 'ipdvitals', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    many(db, 'ipdcharges', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    one(db, 'ipdinitialassessments', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    one(db, 'ipdnursingadmissionassessments', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    many(db, 'labrequests', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    many(db, 'radiologyrequests', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    many(db, 'procedurerequests', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    many(db, 'bills', { _testScenario: IPD_TAG, hospital_id: hospitalId, admission_id: ipdAdmission._id }),
    many(db, 'invoices', { _testScenario: IPD_TAG, hospital_id: hospitalId, admission_id: ipdAdmission._id }),
    many(db, 'sales', { _testScenario: IPD_TAG, hospitalId, admission_id: ipdAdmission._id }),
    many(db, 'patientadvanceledgers', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    many(db, 'pharmacyledgerentries', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    one(db, 'pharmacyledgersettlements', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id }),
    one(db, 'dischargesummaries', { _testScenario: IPD_TAG, hospitalId, admissionId: ipdAdmission._id })
  ]);

  rounds.length === 3 ? pass('IPD consultant rounds', '3 rows') : fail('IPD consultant rounds', `${rounds.length} rows`);
  nursingNotes.length ? pass('IPD nursing notes', `${nursingNotes.length} row(s)`) : fail('IPD nursing notes', 'missing');
  ipdVitals.length >= 3 ? pass('IPD vitals', `${ipdVitals.length} row(s)`) : fail('IPD vitals', `${ipdVitals.length} rows`);
  doctorAssessment?.formStatus === 'Signed' ? pass('Doctor initial assessment', 'Signed') : fail('Doctor initial assessment', doctorAssessment?.formStatus || 'missing');
  nursingAssessment?.status === 'Signed' && nursingAssessment?.initialVitals?.vitalId ? pass('Nursing admission assessment', 'Signed · baseline vital linked') : fail('Nursing admission assessment', nursingAssessment?.status || 'missing/baseline vital not linked');

  const activeCharges = charges.filter((row) => row.is_active !== false && !['VOIDED', 'CANCELLED'].includes(row.status));
  const recurring = activeCharges.filter((row) => ['Bed', 'Nursing', 'RMO / Duty Doctor'].includes(row.chargeType));
  const roundCharges = activeCharges.filter((row) => row.sourceModule === 'DoctorRound' || row.chargeType === 'Doctor Visit');
  recurring.length === 6 ? pass('Canonical recurring charge rows', '6 = 3 bed + 3 nursing + 0 RMO') : fail('Canonical recurring charge rows', `${recurring.length}`);
  if (roundCharges.length === 3 && roundCharges.every((row) => money(row.netAmount ?? row.amount) === 900)) pass('Doctor-round charge rows', '3 × ₹900');
  else fail('Doctor-round charge rows', `${roundCharges.length} rows · rates=${roundCharges.map((row) => money(row.netAmount ?? row.amount)).join(',')}`);

  const ipdLab = ipdLabs[0];
  if (ipdLab?.reportFinalisation?.isFinal && ipdLab?.manual_report?.observations?.length === 14) pass('IPD CBC structured report', 'final · 14 observations');
  else fail('IPD CBC structured report');
  const ipdRadiology = ipdRad[0];
  if (ipdRadiology?.reportFinalisation?.isFinal && ipdRadiology?.manual_report?.sections?.length === 8) pass('IPD X-ray structured report', 'final · 8 sections');
  else fail('IPD X-ray structured report');
  ipdProcedures.some((row) => String(row.status).toLowerCase() === 'completed') ? pass('IPD procedure completion') : fail('IPD procedure completion');

  const finalInvoice = ipdInvoices.find((row) => eqId(row._id, ipdAdmission.finalInvoiceId)) || ipdInvoices.find((row) => money(row.total) === 20200);
  if (finalInvoice && money(finalInvoice.total) === 20200 && money(finalInvoice.balance_due) === 0) pass('IPD final invoice', '₹20200 · settled');
  else fail('IPD final invoice', finalInvoice ? `total=${money(finalInvoice.total)} due=${money(finalInvoice.balance_due)}` : 'missing');
  const pharmacyBill = ipdBills.find((row) => row.is_pharmacy_bill);
  const pharmacyInvoice = ipdInvoices.find((row) => row.is_pharmacy_sale || String(row.invoice_type).toLowerCase() === 'pharmacy');
  const pharmacySale = ipdSales[0];
  if (pharmacyBill && pharmacyInvoice && pharmacySale && money(pharmacyBill.balance_due) === 0 && money(pharmacyInvoice.balance_due) === 0 && eqId(pharmacyBill.invoice_id, pharmacyInvoice._id) && eqId(pharmacyBill.sale_id, pharmacySale._id)) pass('IPD Pharmacy Bill ↔ Invoice ↔ Sale', '₹225 · settled');
  else fail('IPD Pharmacy Bill ↔ Invoice ↔ Sale');

  const walletBalance = (wallet) => {
    const rows = advanceRows.filter((row) => row.walletType === wallet).sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    return rows.length ? money(rows[rows.length - 1].balanceAfter ?? rows[rows.length - 1].balance_after) : 0;
  };
  for (const wallet of ['IPD_SHARED', 'PHARMACY_IPD']) {
    walletBalance(wallet) === 0 ? pass(`${wallet} wallet`, '₹0') : fail(`${wallet} wallet`, `₹${walletBalance(wallet)}`);
  }
  settlement?.status === 'POSTED' ? pass('Pharmacy final settlement', `${settlement.settlement_type || settlement.type || 'FINAL_CLEARANCE'} · POSTED`) : fail('Pharmacy final settlement', settlement?.status || 'missing');
  pharmacyLedger.length ? pass('Pharmacy ledger trail', `${pharmacyLedger.length} entries`) : fail('Pharmacy ledger trail');

  if (discharge?.status === 'StaffCompleted' && discharge?.emergencyInstructions && discharge?.followUpDetails) pass('Discharge summary print content', 'StaffCompleted · saved emergency/follow-up instructions present');
  else fail('Discharge summary print content', discharge?.status || 'missing fields/status');
  if (discharge?.admissionSnapshot?.room) pass('Discharge immutable room snapshot', discharge.admissionSnapshot.room);
  else fail('Discharge immutable room snapshot', 'missing room');

  if (ipdAdmission.financialClearanceStatus === 'cleared') pass('IPD financial clearance', 'cleared');
  else fail('IPD financial clearance', ipdAdmission.financialClearanceStatus || 'missing');
  if (ipdAdmission.pharmacyClearanceStatus === 'cleared') pass('IPD pharmacy clearance', 'cleared');
  else fail('IPD pharmacy clearance', ipdAdmission.pharmacyClearanceStatus || 'missing');
  if (money(ipdPatient?.pharmacy_outstanding_balance) === 0 && money(ipdPatient?.pharmacy_advance_balance) === 0) pass('IPD patient pharmacy cache balances', '₹0 / ₹0');
  else fail('IPD patient pharmacy cache balances', `outstanding=${money(ipdPatient?.pharmacy_outstanding_balance)} advance=${money(ipdPatient?.pharmacy_advance_balance)}`);

  const grand = money(2000 + (finalInvoice?.total || 0) + (pharmacyInvoice?.total || 0));
  grand === 22425 ? pass('IPD grand settled amount', '₹22425') : fail('IPD grand settled amount', `₹${grand}`);

  report();
}

function report() {
  console.log('\n=== UI/API DATA AUDIT ===');
  for (const row of checks) {
    const icon = row.level === 'PASS' ? '✓' : row.level === 'WARN' ? '!' : '✗';
    console.log(`${icon} [${row.level}] ${row.label}${row.detail ? ` — ${row.detail}` : ''}`);
  }
  const counts = checks.reduce((acc, row) => ((acc[row.level] = (acc[row.level] || 0) + 1), acc), {});
  console.log(`\nSummary: PASS=${counts.PASS || 0} WARN=${counts.WARN || 0} FAIL=${counts.FAIL || 0}`);
  if (counts.FAIL) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(`AUDIT FAILED TO RUN: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
