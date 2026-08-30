#!/usr/bin/env node
'use strict';

/**
 * Seed two complete, already-finished hospital journeys in the current database.
 *
 * Defaults:
 *   OPD: Mohit Sharma  _id=6a608b8b09bddeeac27e9c20  UHID=TH260783784837
 *   IPD: Amit Verma    _id=6a4a7b0eda2544aff0921dd9  UHID=AZ4967-DEMP6465-2607
 *
 * This is a DATABASE FIXTURE SEED, not an HTTP/API end-to-end test. It creates
 * coherent historical documents using the final repo's current collection
 * shapes while preserving all setup/master records.
 *
 * Safety:
 *   - DRY RUN by default.
 *   - Writes require --execute --confirm SEED_TWO_PATIENT_FLOWS
 *   - Re-running removes only documents carrying this script's marker and
 *     restores medicine-batch stock used by the prior seed before reseeding.
 *   - Aborts when the selected patients already have non-seed operational data.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { matchTemplateDetailed } = require('../services/radiologyReportTemplate.service');

const { ObjectId } = mongoose.Types;

const OPD_PATIENT_ID = new ObjectId('6a608b8b09bddeeac27e9c20');
const IPD_PATIENT_ID = new ObjectId('6a4a7b0eda2544aff0921dd9');
const OPD_TAG = 'FLOW_FIXTURE_OPD_MOHIT_V1';
const IPD_TAG = 'FLOW_FIXTURE_IPD_AMIT_V1';
const TAGS = [OPD_TAG, IPD_TAG];
const CONFIRM_TEXT = 'SEED_TWO_PATIENT_FLOWS';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const FORCE_EXISTING = args.includes('--allow-existing-patient-history');
const confirmArg = (() => {
  const i = args.indexOf('--confirm');
  return i >= 0 ? args[i + 1] : null;
})();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) {
  console.error('Missing MONGO_URI / MONGODB_URI / MONGO_URL in .env');
  process.exit(1);
}

function money(v) {
  return Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
}
function addHours(date, hours) {
  return new Date(new Date(date).getTime() + hours * 60 * 60 * 1000);
}
function addDays(date, days) {
  return addHours(date, days * 24);
}
function dateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateKeysBetween(fromDate, throughDate) {
  const fromKey = dateKey(fromDate);
  const throughKey = dateKey(throughDate);
  const out = [];
  let cursor = new Date(`${fromKey}T12:00:00.000Z`);
  const end = new Date(`${throughKey}T12:00:00.000Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return out;
}

function chargeDateForKey(key) {
  return new Date(`${key}T12:00:00.000Z`);
}

function shiftDateKey(key, days) {
  const cursor = new Date(`${key}T12:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + Number(days || 0));
  return cursor.toISOString().slice(0, 10);
}

function hospitalDateTimeForKey(key, hour = 8, minute = 0) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  // This fixture is intentionally scoped to the Test Hospital's configured
  // Asia/Kolkata timezone.
  return new Date(`${key}T${hh}:${mm}:00+05:30`);
}
function fullName(doc) {
  return [doc?.firstName || doc?.first_name, doc?.middleName || doc?.middle_name, doc?.lastName || doc?.last_name]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
function docTimes(createdAt, updatedAt = createdAt) {
  return { createdAt, updatedAt, created_at: createdAt, updated_at: updatedAt };
}
function snapshotPatient(p) {
  return {
    _id: p._id,
    uhid: p.uhid || p.patientId,
    patientId: p.patientId || p.uhid,
    name: fullName(p),
    first_name: p.first_name,
    last_name: p.last_name,
    gender: p.gender,
    dob: p.dob,
    phone: p.phone,
    address: p.address,
    blood_group: p.blood_group
  };
}
function commonBilling({ billId, invoiceId, amount, at, userId }) {
  return {
    billingIntent: 'BILL_NOW',
    billingState: 'INVOICED',
    chargeIds: [],
    billIds: billId ? [billId] : [],
    invoiceIds: invoiceId ? [invoiceId] : [],
    pricingSnapshot: { resultType: 'self', amounts: { hospitalStandard: amount, patientLiability: amount }, pricedAt: at },
    financialPolicySnapshot: { payerCategory: 'self', billingMode: 'FULL_PREPAY', fixture: true },
    selectedBillingMode: 'FULL_PREPAY',
    requiredNowAmount: 0,
    financialClearanceState: 'CLEARED',
    billingHistory: [
      { from: 'PENDING_CHARGE', to: 'CHARGE_POSTED', action: 'FIXTURE_CHARGE', at, by: userId },
      { from: 'CHARGE_POSTED', to: 'INVOICED', action: 'FIXTURE_INVOICE', documentId: invoiceId, at, by: userId }
    ]
  };
}


function looksLikePlaceholderMaster(doc) {
  const text = [doc?.code, doc?.name, doc?.description].filter(Boolean).join(' ').toLowerCase();
  if (!String(doc?.name || '').trim() || String(doc?.name || '').trim().length < 3) return true;
  return /(^|[^a-z])(dummy|sample|placeholder|seed|fixture|test data|testing)([^a-z]|$)/i.test(text)
    || /(^|[-_ ])src([-_ ]|$)/i.test(String(doc?.code || ''))
    || /^(df|abc|xyz|test|demo)$/i.test(String(doc?.name || '').trim());
}

async function selectClinicalMaster(db, collection, baseFilter, label, {
  minPrice,
  preferredMaxPrice,
  preferredPatterns = [],
  excludedPatterns = []
}) {
  const candidates = await db.collection(collection).find({
    ...baseFilter,
    base_price: { $gte: minPrice }
  }).sort({ usage_count: -1, base_price: 1, name: 1 }).limit(500).toArray();

  const searchable = (doc) => [doc?.code, doc?.name, doc?.category, doc?.subcategory, doc?.description]
    .filter(Boolean).join(' ').toLowerCase();

  const clean = candidates.filter((doc) => {
    if (looksLikePlaceholderMaster(doc)) return false;
    const text = searchable(doc);
    return !excludedPatterns.some((pattern) => pattern.test(text));
  });
  if (!clean.length) {
    throw new Error(`No suitable ${label} found. Need an active billable non-placeholder master with base_price >= ${minPrice}.`);
  }

  const preferredRank = (doc) => {
    const text = searchable(doc);
    const idx = preferredPatterns.findIndex((pattern) => pattern.test(text));
    return idx < 0 ? preferredPatterns.length + 1 : idx;
  };

  // Prefer clinically coherent fixture masters first, then a normal cash-price band,
  // then usage and deterministic price/name ordering.
  return clean.sort((a, b) => {
    const pref = preferredRank(a) - preferredRank(b);
    if (pref) return pref;
    const aBand = Number(a.base_price || 0) <= preferredMaxPrice ? 0 : 1;
    const bBand = Number(b.base_price || 0) <= preferredMaxPrice ? 0 : 1;
    if (aBand !== bBand) return aBand - bBand;
    const usage = Number(b.usage_count || 0) - Number(a.usage_count || 0);
    if (usage) return usage;
    const price = Number(a.base_price || 0) - Number(b.base_price || 0);
    if (price) return price;
    return String(a.name || '').localeCompare(String(b.name || ''));
  })[0];
}

async function selectNormalIpdBed(db, hospitalId) {
  const beds = await db.collection('beds').find({
    hospitalId,
    status: 'Available',
    isActive: { $ne: false },
    wardId: { $exists: true, $ne: null },
    bedType: { $in: ['General', 'Semi Private', 'Private', 'Deluxe'] }
  }).sort({ dailyCharge: -1, bedNumber: 1 }).limit(300).toArray();

  for (const bed of beds) {
    const [room, ward] = await Promise.all([
      db.collection('rooms').findOne({
        _id: bed.roomId,
        hospitalId,
        status: { $in: ['Available', 'Partially Occupied'] },
        type: { $nin: ['Operation Theater', 'Operation Theatre', 'OT', 'Emergency', 'Day Care'] },
        // Legacy Room documents created before operationalStatus was introduced do not
        // contain the field. In the application schema, missing operationalStatus is
        // equivalent to the current default of "open". Reject only explicit
        // maintenance/closed rooms.
        $or: [
          { operationalStatus: 'open' },
          { operationalStatus: { $exists: false } },
          { operationalStatus: null }
        ]
      }),
      db.collection('wards').findOne({
        _id: bed.wardId,
        hospitalId,
        isActive: { $ne: false },
        type: { $nin: ['Emergency'] }
      })
    ]);
    if (room && ward) return { bed, room, ward };
  }

  throw new Error('No suitable normal IPD bed found. Need an Available active General/Semi Private/Private/Deluxe bed linked to an active ward and an Available/Partially Occupied non-OT room (legacy rooms with missing operationalStatus are treated as open).');
}

async function findOneRequired(db, collection, filter, label, sort = null) {
  let cursor = db.collection(collection).find(filter);
  if (sort) cursor = cursor.sort(sort);
  const doc = await cursor.limit(1).next();
  if (!doc) throw new Error(`Required master data not found: ${label} (${collection})`);
  return doc;
}

async function findUserForPerson(db, person, roles = [], hospitalId = null) {
  const filters = [];
  if (person?.user_id) filters.push({ _id: person.user_id });
  if (person?.userId) filters.push({ _id: person.userId });
  if (person?.email) filters.push({ email: String(person.email).toLowerCase() });
  const roleFilter = { ...(roles.length ? { role: { $in: roles } } : {}), ...(hospitalId ? { hospital_id: hospitalId } : {}) };
  if (filters.length) {
    const found = await db.collection('users').findOne({ $and: [roleFilter, { $or: filters }] });
    if (found) return found;
  }
  return db.collection('users').findOne(roleFilter);
}

async function currentNonSeedHistoryCounts(db, patientId) {
  const probes = [
    ['appointments', { patient_id: patientId }],
    ['prescriptions', { patient_id: patientId }],
    ['labrequests', { patientId }],
    ['radiologyrequests', { patientId }],
    ['procedurerequests', { patientId }],
    ['sales', { patient_id: patientId }],
    ['bills', { patient_id: patientId }],
    ['invoices', { patient_id: patientId }],
    ['financialtransactions', { patientId }],
    ['ipdadmissions', { patientId }],
    ['ipdcharges', { patientId }]
  ];
  const out = [];
  for (const [collection, filter] of probes) {
    const n = await db.collection(collection).countDocuments({ ...filter, _testScenario: { $nin: TAGS } });
    if (n) out.push([collection, n]);
  }
  return out;
}

async function restorePreviousSeedStock(db, session) {
  const sales = await db.collection('sales').find({ _testScenario: { $in: TAGS } }, { session }).toArray();
  const restore = new Map();
  for (const sale of sales) {
    for (const item of sale.items || []) {
      if (!item.batch_id) continue;
      const qty = Number(item.quantity_base_units ?? item.quantity ?? 0);
      if (!(qty > 0)) continue;
      const key = String(item.batch_id);
      restore.set(key, (restore.get(key) || 0) + qty);
    }
  }
  for (const [batchId, qty] of restore) {
    await db.collection('medicinebatches').updateOne(
      { _id: new ObjectId(batchId) },
      { $inc: { quantity_base_units: qty, quantity: qty } },
      { session }
    );
  }
}

const SEEDED_COLLECTIONS = [
  'appointments', 'vitals', 'prescriptions', 'labrequests', 'labreports', 'radiologyrequests', 'procedurerequests',
  'bills', 'invoices', 'financialtransactions', 'deskcheckouts', 'sales', 'pharmacyledgerentries',
  'pharmacyledgersettlements', 'ipdadmissions', 'ipdaccommodationsegments', 'ipdrounds', 'ipdvitals',
  'nursingnotes', 'ipdmedicationcharts', 'ipdpatientmedicinestocks', 'ipdcharges', 'dischargesummaries',
  'patientadvanceledgers'
];

async function cleanupPreviousSeed(db, session) {
  await restorePreviousSeedStock(db, session);
  for (const collection of SEEDED_COLLECTIONS) {
    await db.collection(collection).deleteMany({ _testScenario: { $in: TAGS } }, { session });
  }
}

async function main() {
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN (no writes)'}`);
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}`);

  const opdPatient = await db.collection('patients').findOne({ _id: OPD_PATIENT_ID });
  const ipdPatient = await db.collection('patients').findOne({ _id: IPD_PATIENT_ID });
  if (!opdPatient) throw new Error('Mohit Sharma OPD patient not found by expected _id.');
  if (!ipdPatient) throw new Error('Amit Verma IPD patient not found by expected _id.');
  if (String(opdPatient.hospitalId || '') !== String(ipdPatient.hospitalId || '')) {
    throw new Error('Selected OPD/IPD patients do not belong to the same hospital.');
  }
  const hospitalId = opdPatient.hospitalId;
  const hospital = await findOneRequired(db, 'hospitals', { _id: hospitalId }, 'patient hospital');

  const doctors = await db.collection('doctors').find({ hospitalId, is_active: { $ne: false }, deleted_at: null })
    .sort({ opdConsultationFee: -1, firstName: 1 }).limit(20).toArray();
  if (!doctors.length) throw new Error('No active doctor found for selected hospital.');
  const opdDoctor = doctors.find(d => d.department && Number(d.opdConsultationFee || 0) > 0) || doctors.find(d => d.department) || doctors[0];
  const ipdDoctor = doctors.find(d => String(d._id) !== String(opdDoctor._id) && d.department) || opdDoctor;
  const opdDepartmentId = opdDoctor.department || (await findOneRequired(db, 'departments', { hospitalId }, 'department'))._id;
  const ipdDepartmentId = ipdDoctor.department || opdDepartmentId;

  const opdDoctorUser = await findUserForPerson(db, opdDoctor, ['doctor'], hospitalId);
  const ipdDoctorUser = await findUserForPerson(db, ipdDoctor, ['doctor'], hospitalId);
  const financeUser = await db.collection('users').findOne({ hospital_id: hospitalId, role: { $in: ['accountant', 'admin', 'registrar', 'receptionist'] }, is_active: { $ne: false } })
    || await findOneRequired(db, 'users', { is_active: { $ne: false } }, 'finance/admin user');
  const pharmacyUser = await db.collection('users').findOne({ hospital_id: hospitalId, role: 'pharmacy', is_active: { $ne: false } }) || financeUser;
  const nurseUser = await db.collection('users').findOne({ hospital_id: hospitalId, role: 'nurse', is_active: { $ne: false } });
  if (!nurseUser) throw new Error('No active nurse user found.');
  const nurse = await db.collection('nurses').findOne({ email: String(nurseUser.email || '').toLowerCase() })
    || await findOneRequired(db, 'nurses', {}, 'nurse profile');

  const pathologyUser = await db.collection('users').findOne({ hospital_id: hospitalId, role: 'pathology_staff', is_active: { $ne: false } }) || financeUser;
  const labStaff = await db.collection('labstaffs').findOne({}) || null;
  const radiologyUser = await db.collection('users').findOne({ hospital_id: hospitalId, role: 'radiology_staff', is_active: { $ne: false } }) || financeUser;
  const radiologyStaff = await db.collection('radiologystaffs').findOne({}) || null;

  const labTest = await selectClinicalMaster(
    db, 'labtests',
    { hospitalId, is_active: { $ne: false }, is_billable: { $ne: false } },
    'Lab Test', {
      minPrice: 50,
      preferredMaxPrice: 3000,
      preferredPatterns: [/complete blood count|\bcbc\b|ha?emogram/i]
    }
  );
  const imagingTest = await selectClinicalMaster(
    db, 'imagingtests',
    { hospitalId, is_active: { $ne: false }, is_billable: { $ne: false }, template_only: { $ne: true } },
    'Imaging Test', {
      minPrice: 100,
      preferredMaxPrice: 10000,
      preferredPatterns: [/chest.*x[- ]?ray|x[- ]?ray.*chest|chest radiograph/i, /x[- ]?ray|radiograph/i]
    }
  );
  const radiologyTemplateMatch = matchTemplateDetailed(imagingTest.name, imagingTest.code);
  if (!radiologyTemplateMatch?.template) {
    throw new Error(`No structured radiology report template matches ${imagingTest.code || ''} ${imagingTest.name || ''}`.trim());
  }
  const radiologyTemplate = radiologyTemplateMatch.template;
  const radiologistPrintName = fullName(radiologyStaff) || radiologyUser?.name || 'Radiologist';
  const radiologyManualReport = ({ findings, impression, at }) => ({
    templateId: radiologyTemplate.id,
    templateNumber: radiologyTemplate.number,
    templateVersion: radiologyTemplate.version,
    templateName: radiologyTemplate.name,
    sections: [
      { key: 'findings', label: 'Findings', text: findings },
      { key: 'impression', label: 'Impression', text: impression }
    ],
    tables: [],
    images: [],
    radiologistName: radiologistPrintName,
    technicianName: radiologistPrintName,
    disclaimer: 'Fixture report generated from the structured radiology workflow.',
    reportedAt: at,
    reportedBy: radiologyUser._id
  });

  const procedure = await selectClinicalMaster(
    db, 'procedures',
    { hospitalId, is_active: { $ne: false }, is_billable: { $ne: false } },
    'Procedure', {
      minPrice: 100,
      preferredMaxPrice: 25000,
      preferredPatterns: [/nebul/i, /intravenous|\biv\b.*infusion|infusion/i, /injection/i, /dressing/i],
      excludedPatterns: [/dental|dentist|tooth|teeth|amalgam|root canal|orthodont|periodont|crown|implant|extraction/i]
    }
  );
  const { bed, room, ward } = await selectNormalIpdBed(db, hospitalId);
  const pharmacy = await findOneRequired(db, 'pharmacies', { status: { $ne: 'Inactive' } }, 'active pharmacy');

  // Pick a stocked batch with enough quantity for both OPD and IPD medication flows.
  const batch = await db.collection('medicinebatches').find({
    is_active: { $ne: false },
    quantity_base_units: { $gte: 5 },
    expiry_date: { $gt: new Date() }
  }).sort({ expiry_date: 1 }).limit(1).next();
  if (!batch) throw new Error('No active, unexpired medicine batch with at least 5 base units found.');
  const medicine = await findOneRequired(db, 'medicines', { _id: batch.medicine_id, is_active: { $ne: false } }, 'medicine for stocked batch');

  const existingOpd = await currentNonSeedHistoryCounts(db, opdPatient._id);
  const existingIpd = await currentNonSeedHistoryCounts(db, ipdPatient._id);
  const embeddedActive = [
    ...(Array.isArray(opdPatient.active_admissions) ? opdPatient.active_admissions : []),
    ...(Array.isArray(ipdPatient.active_admissions) ? ipdPatient.active_admissions : [])
  ];
  if (!FORCE_EXISTING && (existingOpd.length || existingIpd.length || embeddedActive.length)) {
    console.error('\nSelected patients still have non-seed operational history:');
    if (existingOpd.length) console.error('  OPD patient:', existingOpd.map(([c,n]) => `${c}=${n}`).join(', '));
    if (existingIpd.length) console.error('  IPD patient:', existingIpd.map(([c,n]) => `${c}=${n}`).join(', '));
    if (embeddedActive.length) console.error(`  Embedded active_admissions rows=${embeddedActive.length}`);
    console.error('Run the operational reset first. If this is intentional, add --allow-existing-patient-history.');
    process.exitCode = 2;
    return;
  }

  const now = new Date();
  const opdStart = addHours(now, -10);
  const opdConsultStart = addHours(opdStart, 1);
  const opdClinicalEnd = addHours(opdStart, 4);
  const opdPaidAt = addHours(opdStart, 5);
  const opdPharmacyAt = addHours(opdStart, 6);
  const opdCompleteAt = addHours(opdStart, 6.5);

  const ipdFreezeAt = addHours(now, -4);
  // Keep this fixture to exactly THREE hospital calendar billing dates. The
  // previous `now - 3 days` start often spanned four IST date keys (27/28/29/30)
  // even though the intended fixture was a three-day inpatient journey.
  const ipdFreezeKey = dateKey(ipdFreezeAt);
  const ipdAdmissionKey = shiftDateKey(ipdFreezeKey, -2);
  const ipdAdmissionAt = hospitalDateTimeForKey(ipdAdmissionKey, 8, 0);
  const ipdDischargeAt = addHours(now, -2);

  const consultFee = money(opdDoctor.opdConsultationFee || 500);
  const labPrice = money(labTest.base_price || 300);
  const imagingPrice = money(imagingTest.base_price || 500);
  const procedurePrice = money(procedure.base_price || 750);
  const unitPrice = money(batch.selling_price_per_base_unit || ((batch.selling_price_per_pack || batch.selling_price || 10) / (batch.units_per_pack || 1)) || 10);
  const opdMedQty = 2;
  const ipdMedQty = 3;
  const opdPharmacyTotal = money(unitPrice * opdMedQty);
  const ipdPharmacyTotal = money(unitPrice * ipdMedQty);

  console.log('\nSelected patients');
  console.log(`  OPD: ${fullName(opdPatient)} | ${opdPatient.uhid || opdPatient.patientId} | ${opdPatient._id}`);
  console.log(`  IPD: ${fullName(ipdPatient)} | ${ipdPatient.uhid || ipdPatient.patientId} | ${ipdPatient._id}`);
  console.log('\nSelected masters');
  console.log(`  Hospital: ${hospital.hospitalName || hospital.name} (${hospital._id})`);
  console.log(`  OPD doctor: ${fullName(opdDoctor)} | fee ${consultFee}`);
  console.log(`  IPD doctor: ${fullName(ipdDoctor)}`);
  console.log(`  Lab: ${labTest.code} ${labTest.name} | ${labPrice}`);
  console.log(`  Imaging: ${imagingTest.code} ${imagingTest.name} | ${imagingPrice}`);
  console.log(`  Procedure: ${procedure.code} ${procedure.name} | ${procedurePrice}`);
  console.log(`  Medicine: ${medicine.name} | batch ${batch.batch_number} | stock ${batch.quantity_base_units} | unit ${unitPrice}`);
  console.log(`  IPD bed: ${bed.bedNumber} | ${bed.bedType} | room ${room.room_number} (${room.type}) | ward ${ward.name} (${ward.type}) | daily ${money(bed.dailyCharge || 0)}`);
  console.log('  Clinical request keys: deterministic non-null Lab collection + OPD/IPD desk keys');

  if (!EXECUTE) {
    console.log('\nDRY RUN COMPLETE. No data was changed.');
    console.log(`To execute: node scripts/seed-two-patient-complete-flows.js --execute --confirm ${CONFIRM_TEXT}`);
    return;
  }
  if (confirmArg !== CONFIRM_TEXT) {
    throw new Error(`Execution requires: --confirm ${CONFIRM_TEXT}`);
  }

  const session = await mongoose.startSession();
  const summary = {};
  try {
    await session.withTransaction(async () => {
      await cleanupPreviousSeed(db, session);

      const ids = Object.fromEntries([
        'opdAppointment','opdVital','opdPrescription','opdLab','opdLabReport','opdRad','opdProc','opdBill','opdInvoice','opdPharmacyInvoice','opdSale','opdDeskCheckout',
        'ipdAdmission','ipdInitialBill','ipdInitialInvoice','ipdSegment','ipdPrescription','ipdLab','ipdLabReport','ipdRad','ipdProc','ipdMar','ipdStock','ipdPharmacyInvoice','ipdSale','ipdPharmacySettlement','ipdFinalBill','ipdFinalInvoice','ipdDischargeSummary'
      ].map(k => [k, new ObjectId()]));
      ids.ipdRounds = [new ObjectId(), new ObjectId(), new ObjectId()];
      ids.ipdVitals = [new ObjectId(), new ObjectId(), new ObjectId()];

      // ---------- OPD ----------
      const opdServiceSubtotal = money(consultFee + labPrice + imagingPrice + procedurePrice);
      const opdDoctorUserId = opdDoctorUser?._id || financeUser._id;
      const opdPatientSnapshot = snapshotPatient(opdPatient);

      await db.collection('appointments').insertOne({
        _id: ids.opdAppointment, _testScenario: OPD_TAG,
        patient_id: opdPatient._id, doctor_id: opdDoctor._id, hospital_id: hospitalId, department_id: opdDepartmentId,
        appointment_date: opdStart, appointment_date_key: dateKey(opdStart), scheduled_timezone: hospital.timezone || 'Asia/Kolkata',
        start_time: opdConsultStart, end_time: opdClinicalEnd, type: 'time-based', appointment_type: 'consultation', priority: 'Normal',
        notes: 'Fixture: complete OPD visit with vitals, consultation, diagnostics, procedure, pharmacy and settlement.',
        status: 'Completed', actual_start_time: opdConsultStart, actual_end_time: opdCompleteAt, duration: Math.round((opdCompleteAt-opdConsultStart)/60000),
        token: `OPD-FLOW-${dateKey(opdStart).replace(/-/g,'')}-001`, submissionSource: 'FLOW_FIXTURE', bookedBy: financeUser._id,
        sponsorType: 'self', sponsorName: 'Self / Cash', selectedBillingMode: 'FULL_PREPAY', requiredNowAmount: 0,
        financialPolicySnapshot: { payerCategory: 'self', fixture: true }, financialClearanceState: 'CLEARED', visit_mode: 'physical',
        lifecycleTimestamps: { bookedAt: opdStart, checkedInAt: opdConsultStart, consultationStartedAt: opdConsultStart, consultationEndedAt: opdClinicalEnd, checkoutCompletedAt: opdCompleteAt },
        ...docTimes(opdStart, opdCompleteAt)
      }, { session });

      await db.collection('vitals').insertOne({
        _id: ids.opdVital, _testScenario: OPD_TAG,
        patient_id: opdPatient._id, appointment_id: ids.opdAppointment, recorded_by: nurseUser._id,
        bp: '122/78', weight: '71 kg', pulse: '76', spo2: '98', temperature: '98.4 F', respiratory_rate: '16', random_blood_sugar: '104', height: '174 cm',
        recorded_at: addHours(opdConsultStart, 0.1), ...docTimes(addHours(opdConsultStart, 0.1))
      }, { session });

      await db.collection('prescriptions').insertOne({
        _id: ids.opdPrescription, _testScenario: OPD_TAG,
        prescription_number: 'FLOW-OPD-RX-001', hospitalId, patient_id: opdPatient._id, doctor_id: opdDoctor._id, appointment_id: ids.opdAppointment, source_type: 'OPD',
        presenting_complaint: 'Fever, body ache and intermittent cough for three days.', history_of_presenting_complaint: 'No breathlessness; tolerating oral intake.',
        diagnosis: 'Acute upper respiratory tract infection - fixture', symptoms: 'Fever, myalgia, cough', investigation: 'CBC, imaging and minor procedure as clinically indicated.',
        treatment_plan: 'Symptomatic treatment, investigations, medicine, hydration and follow-up.', physical_examination: 'Afebrile at consultation; chest clear; vitals stable.', outcome_expected: 'Clinical improvement.',
        items: [{ medicine_name: medicine.name, generic_name: medicine.generic_name || medicine.composition || medicine.name, medicine_id: medicine._id, dosage_form: medicine.dosage_form || 'Tablet', medicine_type: 'Tablet', route_of_administration: 'Oral', dosage: '1 unit', frequency: 'BD', duration: '1 day', quantity: opdMedQty, dose_qty_base_units: 1, required_qty_base_units: opdMedQty, requires_pharmacy_dispense: true, instructions: 'After food', timing: 'After food', is_dispensed: true, dispensed_quantity: opdMedQty, dispensed_date: opdPharmacyAt }],
        lab_test_requests: [{ lab_test_id: labTest._id, lab_test_code: labTest.code, lab_test_name: labTest.name, category: labTest.category, clinical_history: 'Fever work-up', priority: 'Routine', cost: labPrice, request_id: ids.opdLab, created_at: opdClinicalEnd }],
        radiology_test_requests: [{ imaging_test_id: imagingTest._id, imaging_test_code: imagingTest.code, imaging_test_name: imagingTest.name, category: imagingTest.category, clinical_history: 'Persistent cough', priority: 'Routine', cost: imagingPrice, request_id: ids.opdRad, created_at: opdClinicalEnd }],
        procedure_requests: [{ procedure_id: procedure._id, procedure_code: procedure.code, procedure_name: procedure.name, category: procedure.category, clinical_history: 'OPD fixture procedure', clinical_indication: 'Diagnostic/therapeutic indication', priority: 'Routine', cost: procedurePrice, request_id: ids.opdProc, created_at: opdClinicalEnd }],
        notes: 'Completed OPD fixture prescription.', status: 'Completed', issue_date: opdClinicalEnd, validity_days: 30, follow_up_date: addDays(opdClinicalEnd, 7), created_by: opdDoctorUserId,
        ...docTimes(opdClinicalEnd, opdCompleteAt)
      }, { session });

      const opdBilling = commonBilling({ billId: ids.opdBill, invoiceId: ids.opdInvoice, amount: opdServiceSubtotal, at: opdPaidAt, userId: financeUser._id });
      await db.collection('labrequests').insertOne({
        _id: ids.opdLab, _testScenario: OPD_TAG, hospitalId, requestNumber: 'FLOW-OPD-LAB-001', requestGroupKey: 'FLOW-OPD-ORDER-GRP-001', collectionEventKey: 'FLOW-OPD-LAB-COLLECTION-001', deskCheckoutKey: 'FLOW-OPD-DESK-LAB-001', sourceType: 'OPD', appointmentId: ids.opdAppointment, prescriptionId: ids.opdPrescription,
        patientId: opdPatient._id, doctorId: opdDoctor._id, labTestId: labTest._id, testCode: labTest.code, testName: labTest.name, category: labTest.category,
        clinical_indication: 'Fever work-up', priority: 'Routine', requestedDate: opdClinicalEnd, scheduledDate: opdClinicalEnd,
        sample_collected_at: addHours(opdClinicalEnd, .25), sample_collected_by: labStaff?._id, processing_started_at: addHours(opdClinicalEnd,.5), processing_completed_at: addHours(opdClinicalEnd,1),
        status: 'Reported', approvedBy: labStaff?._id, approvedAt: opdClinicalEnd, verifiedBy: labStaff?._id, verifiedAt: addHours(opdClinicalEnd,1.25),
        result_value: 'Within expected fixture range', result_interpretation: 'No significant abnormality in fixture result.', normal_range_used: 'Fixture reference range', is_abnormal: false,
        report_mode: 'manual', manual_report: { templateName: labTest.report_template_name || labTest.name, specimenType: labTest.specimen_type || 'Blood', observations: [{ name: 'Fixture Result', resultType: 'text', resultText: 'Within normal limits', isAbnormal: false }], reportedAt: addHours(opdClinicalEnd,1.25), reportedBy: pathologyUser._id },
        reportFinalisation: { isFinal: true, finalisedAt: addHours(opdClinicalEnd,1.25), finalisedBy: pathologyUser._id, checksum: 'FLOW-OPD-LAB-FINAL', version: 1 },
        accessionNumber: 'FLOW-OPD-ACC-001', specimen: { type: labTest.specimen_type || 'Blood', barcode: 'FLOWOPDLAB001', collectedAt: addHours(opdClinicalEnd,.25), collectedBy: pathologyUser._id, receivedAt: addHours(opdClinicalEnd,.4), receivedBy: pathologyUser._id, condition: 'Acceptable' },
        collectedByUserId: pathologyUser._id, receivedAt: addHours(opdClinicalEnd,.4), receivedBy: pathologyUser._id, resultEnteredAt: addHours(opdClinicalEnd,1), verifierUserId: pathologyUser._id, releasedAt: addHours(opdClinicalEnd,1.25), releasedBy: pathologyUser._id,
        cost: labPrice, is_billed: true, invoiceId: ids.opdInvoice, payerContext: { payerCategory: 'self', payerName: 'Self / Cash', source: 'EXPLICIT' }, createdBy: opdDoctorUserId,
        ...opdBilling, ...docTimes(opdClinicalEnd, opdPaidAt)
      }, { session });
      await db.collection('labreports').insertOne({
        _id: ids.opdLabReport, _testScenario: OPD_TAG, hospitalId, lab_request_id: ids.opdLab, patient_id: opdPatient._id, doctor_id: opdDoctor._id, prescription_id: ids.opdPrescription, lab_test_id: labTest._id,
        report_type: labTest.name, report_mode: 'manual', manual_report: { result: 'Within normal limits', interpretation: 'Fixture normal report' }, report_date: addHours(opdClinicalEnd,1.25), notes: 'Finalized OPD fixture lab report.', created_by: pathologyUser._id,
        ...docTimes(addHours(opdClinicalEnd,1.25))
      }, { session });
      await db.collection('radiologyrequests').insertOne({
        _id: ids.opdRad, _testScenario: OPD_TAG, hospitalId, requestNumber: 'FLOW-OPD-RAD-001', deskCheckoutKey: 'FLOW-OPD-DESK-RAD-001', sourceType: 'OPD', appointmentId: ids.opdAppointment, prescriptionId: ids.opdPrescription,
        patientId: opdPatient._id, doctorId: opdDoctor._id, imagingTestId: imagingTest._id, testCode: imagingTest.code, testName: imagingTest.name, category: imagingTest.category,
        clinical_indication: 'Persistent cough', priority: 'Routine', requestedDate: opdClinicalEnd, scheduledDate: addHours(opdClinicalEnd,.5), status: 'Reported',
        approvedBy: radiologyStaff?._id, approvedAt: opdClinicalEnd, performedBy: radiologyStaff?._id, performedAt: addHours(opdClinicalEnd,.75), reportedBy: radiologyStaff?._id, reportedAt: addHours(opdClinicalEnd,1.5),
        findings: 'No acute abnormality identified in fixture study.', impression: 'No significant acute radiological finding.', report_mode: 'manual', reportTemplateId: radiologyTemplate.id, reportTemplateName: radiologyTemplate.name, manual_report: radiologyManualReport({ findings: 'No acute abnormality identified in fixture study.', impression: 'No significant acute radiological finding.', at: addHours(opdClinicalEnd,1.5) }), reportFinalisation: { isFinal: true, finalisedAt: addHours(opdClinicalEnd,1.5), finalisedBy: radiologyUser._id, checksum: 'FLOW-OPD-RAD-FINAL', version: 1 },
        contraindicationAssessment: { pregnancyStatus: 'not_applicable', renalRisk: 'low', contrastAllergy: false, decision: 'proceed', assessedAt: opdClinicalEnd, assessedBy: radiologyUser._id },
        patientPreparation: { instructions: 'Routine preparation', status: 'complete', completedAt: addHours(opdClinicalEnd,.4), completedBy: radiologyUser._id },
        resultEnteredAt: addHours(opdClinicalEnd,1.25), verifiedAt: addHours(opdClinicalEnd,1.4), verifiedByUserId: radiologyUser._id, releasedAt: addHours(opdClinicalEnd,1.5), releasedBy: radiologyUser._id,
        cost: imagingPrice, is_billed: true, invoiceId: ids.opdInvoice, payerContext: { payerCategory: 'self', payerName: 'Self / Cash', source: 'EXPLICIT' }, createdBy: opdDoctorUserId,
        ...opdBilling, ...docTimes(opdClinicalEnd, opdPaidAt)
      }, { session });
      await db.collection('procedurerequests').insertOne({
        _id: ids.opdProc, _testScenario: OPD_TAG, hospitalId, requestNumber: 'FLOW-OPD-PROC-001', deskCheckoutKey: 'FLOW-OPD-DESK-PROC-001', sourceType: 'OPD', appointmentId: ids.opdAppointment, prescriptionId: ids.opdPrescription,
        patientId: opdPatient._id, doctorId: opdDoctor._id, procedureId: procedure._id, procedureCode: procedure.code, procedureName: procedure.name, category: procedure.category, subcategory: procedure.subcategory,
        clinical_indication: 'Fixture outpatient procedure', priority: 'Routine', requestedDate: opdClinicalEnd, scheduledDate: addHours(opdClinicalEnd,.75), estimated_duration_minutes: procedure.duration_minutes || 30,
        anesthesia_type: 'None', consent_obtained: true, consent_obtained_at: addHours(opdClinicalEnd,.5), consent_obtained_by: financeUser._id,
        status: 'Completed', approvedBy: financeUser._id, approvedAt: opdClinicalEnd, performedBy: opdDoctorUserId, performedAt: addHours(opdClinicalEnd,.8), completedBy: opdDoctorUserId, completedAt: addHours(opdClinicalEnd,1.3), findings: 'Procedure completed uneventfully.', complications: 'None', post_procedure_instructions: 'Routine observation and discharge.', surgeon_notes: 'Fixture OPD procedure completed.',
        cost: procedurePrice, is_billed: true, invoiceId: ids.opdInvoice, payerContext: { payerCategory: 'self', payerName: 'Self / Cash', source: 'EXPLICIT' }, createdBy: opdDoctorUserId,
        ...opdBilling, ...docTimes(opdClinicalEnd, opdPaidAt)
      }, { session });

      const opdBillItems = [
        ['Consultation', `Consultation - ${fullName(opdDoctor)}`, consultFee],
        ['Lab Test', `${labTest.code} - ${labTest.name}`, labPrice],
        ['Radiology', `${imagingTest.code} - ${imagingTest.name}`, imagingPrice],
        ['Procedure', `${procedure.code} - ${procedure.name}`, procedurePrice]
      ].map(([item_type, description, amount]) => ({ description, amount, quantity: 1, item_type, gross_amount: amount, net_amount: amount, taxable_amount: amount, unit_price: amount, tax_rate: 0, tax_amount: 0, discount_amount: 0 }));
      await db.collection('bills').insertOne({
        _id: ids.opdBill, _testScenario: OPD_TAG, bill_number: 'FLOW-OPD-BILL-001', document_stage: 'INVOICED', invoice_ids: [ids.opdInvoice], invoiced_at: opdPaidAt,
        hospital_id: hospitalId, patient_id: opdPatient._id, appointment_id: ids.opdAppointment, prescription_id: ids.opdPrescription, invoice_id: ids.opdInvoice,
        total_amount: opdServiceSubtotal, gross_amount: opdServiceSubtotal, subtotal: opdServiceSubtotal, taxable_amount: opdServiceSubtotal, tax_amount: 0, discount: 0,
        payment_method: 'UPI', payments: [{ method: 'UPI', amount: opdServiceSubtotal, reference: 'FLOW-OPD-RCPT-001', externalReference: 'FLOW-OPD-UPI', date: opdPaidAt }], items: opdBillItems,
        status: 'Paid', generated_at: opdClinicalEnd, paid_at: opdPaidAt, paid_amount: opdServiceSubtotal, balance_due: 0, created_by: financeUser._id, notes: 'Complete OPD fixture bill.',
        ...docTimes(opdClinicalEnd, opdPaidAt)
      }, { session });
      await db.collection('invoices').insertOne({
        _id: ids.opdInvoice, _testScenario: OPD_TAG, invoice_number: 'FLOW-OPD-INV-001', hospital_id: hospitalId, patient_id: opdPatient._id, customer_type: 'Patient', customer_name: fullName(opdPatient), customer_phone: opdPatient.phone,
        appointment_id: ids.opdAppointment, bill_id: ids.opdBill, bill_ids: [ids.opdBill], prescription_id: ids.opdPrescription, invoice_type: 'Mixed', document_stage: 'ISSUED', issued_at: opdPaidAt,
        gross_amount: opdServiceSubtotal, taxable_amount: opdServiceSubtotal, issue_date: opdPaidAt, due_date: opdPaidAt,
        service_items: opdBillItems.map(i => ({ description: i.description, quantity: 1, unit_price: i.amount, total_price: i.amount, tax_rate: 0, tax_amount: 0, service_type: i.item_type === 'Lab Test' ? 'Lab Test' : i.item_type })),
        subtotal: opdServiceSubtotal, total: opdServiceSubtotal, discount: 0, tax: 0, amount_paid: opdServiceSubtotal, balance_due: 0,
        payment_history: [{ date: opdPaidAt, amount: opdServiceSubtotal, method: 'UPI', reference: 'FLOW-OPD-UPI', status: 'Completed', collected_by: financeUser._id, transaction_id: 'FLOW-OPD-RCPT-001', receipt_number: 'FLOW-OPD-RCPT-001', receipt_type: 'Payment', balance_after: 0 }],
        status: 'Paid', created_by: financeUser._id, patient_snapshot: opdPatientSnapshot, hospital_snapshot: { _id: hospital._id, hospitalName: hospital.hospitalName, hospitalID: hospital.hospitalID },
        has_procedures: true, procedures_status: 'Paid', has_lab_tests: true, lab_tests_status: 'Paid', has_radiology: true, radiology_status: 'Paid',
        ...docTimes(opdPaidAt)
      }, { session });
      await db.collection('financialtransactions').insertOne({
        _id: new ObjectId(), _testScenario: OPD_TAG, hospitalId, patientId: opdPatient._id, billId: ids.opdBill, invoiceId: ids.opdInvoice, transactionNumber: 'FLOW-OPD-RCPT-001', transactionType: 'RECEIPT', direction: 'CREDIT', amount: opdServiceSubtotal,
        postedAt: opdPaidAt, externalMoneyMovement: true, cashFlowClass: 'EXTERNAL_COLLECTION', amountTendered: opdServiceSubtotal, amountApplied: opdServiceSubtotal, amountReceived: opdServiceSubtotal, balanceAfter: 0,
        paymentMethod: 'UPI', paymentReference: 'FLOW-OPD-UPI', receiptType: 'Payment', sourceModule: 'OPD', sourceId: ids.opdAppointment, status: 'POSTED', remarks: 'OPD complete-flow fixture payment.', idempotencyKey: 'FLOW-OPD-RCPT-001', documentAllocations: [{ documentType: 'Invoice', documentId: ids.opdInvoice, amount: opdServiceSubtotal }], createdBy: financeUser._id, metadata: { fixture: true },
        ...docTimes(opdPaidAt)
      }, { session });

      const saleItem = (qty, chartId = null) => ({
        medicine_id: medicine._id, batch_id: batch._id, medicine_name: medicine.name, generic_name: medicine.generic_name || medicine.composition || medicine.name, brand: medicine.brand,
        hsn_code: medicine.hsn_code, batch_number: batch.batch_number, expiry_date: batch.expiry_date, quantity: qty, quantity_base_units: qty, base_unit: medicine.base_unit || 'unit', pack_unit: medicine.pack_unit || 'unit', units_per_pack: medicine.units_per_pack || batch.units_per_pack || 1,
        unit_price: unitPrice, rate_per_base_unit: unitPrice, gross_amount: money(unitPrice*qty), taxable_amount: money(unitPrice*qty), tax_rate: 0, tax_amount: 0, total_price: money(unitPrice*qty), net_amount: money(unitPrice*qty), prescription_item_id: null, ipd_medication_chart_id: chartId,
        prescribed_by: opdDoctor._id, prescribed_by_name: fullName(opdDoctor), doctor_id: opdDoctor._id, doctor_name: fullName(opdDoctor), returned_quantity_base_units: 0, returned_amount: 0,
        standard_amount: money(unitPrice*qty), contracted_amount: money(unitPrice*qty), eligible_amount: money(unitPrice*qty), patient_liability: money(unitPrice*qty), sponsor_liability: 0
      });
      await db.collection('sales').insertOne({
        _id: ids.opdSale, _testScenario: OPD_TAG, sale_number: 'FLOW-OPD-SALE-001', invoice_number: 'FLOW-OPD-PHARM-INV-001', invoice_id: ids.opdPharmacyInvoice, hospitalId, pharmacy_id: pharmacy._id,
        customer_type: 'OPD', source_type: 'OPD_PRESCRIPTION', patient_id: opdPatient._id, appointment_id: ids.opdAppointment, prescription_id: ids.opdPrescription, doctor_id: opdDoctor._id, doctor_name: fullName(opdDoctor), uhid: opdPatient.uhid || opdPatient.patientId,
        sponsor_type: 'Self', sponsor_name: 'Self / Cash', selected_billing_mode: 'FULL_PREPAY', required_now_amount: 0, financial_clearance_state: 'CLEARED', financial_policy_snapshot: { payerCategory: 'self', fixture: true },
        customer_name: fullName(opdPatient), customer_phone: opdPatient.phone, sale_date: opdPharmacyAt, items: [saleItem(opdMedQty)], gross_amount: opdPharmacyTotal, subtotal: opdPharmacyTotal, taxable_amount: opdPharmacyTotal, total_amount: opdPharmacyTotal,
        current_bill_amount: opdPharmacyTotal, total_collected_amount: opdPharmacyTotal, amount_paid: opdPharmacyTotal, settlement_amount: opdPharmacyTotal, balance_due: 0, closing_outstanding: 0,
        payment_method: 'Cash', payments: [{ method: 'Cash', amount: opdPharmacyTotal, reference: 'FLOW-OPD-PHARM-RCPT-001', externalReference: 'FLOW-OPD-PHARM-CASH' }], transactionGroupId: 'FLOW-OPD-PHARM-GRP', idempotencyKey: 'FLOW-OPD-SALE-001', status: 'Completed', prescription_required: true, prescription_details: 'Linked OPD prescription', created_by: pharmacyUser._id, net_amount_after_returns: opdPharmacyTotal,
        ...docTimes(opdPharmacyAt)
      }, { session });
      await db.collection('invoices').insertOne({
        _id: ids.opdPharmacyInvoice, _testScenario: OPD_TAG, invoice_number: 'FLOW-OPD-PHARM-INV-001', hospital_id: hospitalId, patient_id: opdPatient._id, customer_type: 'Patient', customer_name: fullName(opdPatient), customer_phone: opdPatient.phone,
        appointment_id: ids.opdAppointment, sale_id: ids.opdSale, prescription_id: ids.opdPrescription, invoice_type: 'Pharmacy', document_stage: 'ISSUED', is_pharmacy_sale: true, issued_at: opdPharmacyAt, issue_date: opdPharmacyAt, due_date: opdPharmacyAt,
        gross_amount: opdPharmacyTotal, taxable_amount: opdPharmacyTotal, medicine_items: [{ medicine_id: medicine._id, batch_id: batch._id, medicine_name: medicine.name, item_type: 'Pharmacy', batch_number: batch.batch_number, expiry_date: batch.expiry_date, quantity: opdMedQty, quantity_base_units: opdMedQty, base_unit: medicine.base_unit || 'unit', unit_price: unitPrice, total_price: opdPharmacyTotal, tax_rate: 0, tax_amount: 0 }],
        subtotal: opdPharmacyTotal, total: opdPharmacyTotal, discount: 0, tax: 0, amount_paid: opdPharmacyTotal, balance_due: 0, payment_history: [{ date: opdPharmacyAt, amount: opdPharmacyTotal, method: 'Cash', reference: 'FLOW-OPD-PHARM-CASH', status: 'Completed', collected_by: pharmacyUser._id, receipt_number: 'FLOW-OPD-PHARM-RCPT-001', receipt_type: 'Payment', balance_after: 0 }],
        status: 'Paid', dispensing_date: opdPharmacyAt, dispensed_by: pharmacyUser._id, created_by: pharmacyUser._id, patient_snapshot: opdPatientSnapshot,
        ...docTimes(opdPharmacyAt)
      }, { session });
      await db.collection('financialtransactions').insertOne({
        _id: new ObjectId(), _testScenario: OPD_TAG, hospitalId, patientId: opdPatient._id, invoiceId: ids.opdPharmacyInvoice, transactionNumber: 'FLOW-OPD-PHARM-RCPT-001', transactionType: 'RECEIPT', direction: 'CREDIT', amount: opdPharmacyTotal,
        postedAt: opdPharmacyAt, externalMoneyMovement: true, cashFlowClass: 'EXTERNAL_COLLECTION', amountTendered: opdPharmacyTotal, amountApplied: opdPharmacyTotal, amountReceived: opdPharmacyTotal, balanceAfter: 0, paymentMethod: 'Cash', paymentReference: 'FLOW-OPD-PHARM-CASH', receiptType: 'Payment', sourceModule: 'Pharmacy', sourceId: ids.opdSale, status: 'POSTED', idempotencyKey: 'FLOW-OPD-PHARM-RCPT-001', createdBy: pharmacyUser._id, metadata: { fixture: true },
        ...docTimes(opdPharmacyAt)
      }, { session });
      await db.collection('pharmacyledgerentries').insertOne({
        _id: new ObjectId(), _testScenario: OPD_TAG, hospitalId, pharmacyId: pharmacy._id, entryDate: opdPharmacyAt, entryType: 'SALE', direction: 'IN', amount: opdPharmacyTotal, paymentMethod: 'Cash', patientId: opdPatient._id, saleId: ids.opdSale, invoiceId: ids.opdPharmacyInvoice, notes: 'Paid OPD pharmacy fixture sale.', idempotencyKey: 'FLOW-OPD-PHARM-LEDGER-001', transactionGroupId: 'FLOW-OPD-PHARM-GRP', createdBy: pharmacyUser._id,
        ...docTimes(opdPharmacyAt)
      }, { session });
      await db.collection('deskcheckouts').insertOne({
        _id: ids.opdDeskCheckout, _testScenario: OPD_TAG, hospitalId, idempotencyKey: 'FLOW-OPD-CHECKOUT-001', status: 'COMPLETED', requestHash: 'FLOW-OPD-CHECKOUT-HASH', patientId: opdPatient._id, appointmentId: ids.opdAppointment,
        billIds: [ids.opdBill], invoiceIds: [ids.opdInvoice, ids.opdPharmacyInvoice], chargeIds: [], result: { appointmentStatus: 'Completed', financialClearanceState: 'CLEARED', pharmacyPaid: true, fixture: true }, createdBy: financeUser._id, completedAt: opdCompleteAt,
        ...docTimes(opdCompleteAt)
      }, { session });

      // ---------- IPD ----------
      const admissionFee = 500;
      const bedRate = money(bed.dailyCharge || 1500);
      const doctorVisitRate = 700;
      const nursingRate = 350;
      const ipdChargeRows = [];
      const pushCharge = (chargeType, description, rate, date, sourceModule, sourceId, auto = true, overrides = {}) => {
        const id = new ObjectId();
        const amount = money(rate);
        ipdChargeRows.push({
          _id: id, _testScenario: IPD_TAG, hospitalId, admissionId: ids.ipdAdmission, patientId: ipdPatient._id, chargeType, adjustmentType: 'CHARGE', status: 'INVOICED', description, quantity: 1, rate: amount, grossAmount: amount, amount, discountAmount: 0, taxRate: 0, taxAmount: 0, taxableAmount: amount, netAmount: amount,
          sourceModule, sourceId, sourceReference: { module: sourceModule === 'LabRequest' ? 'LabRequest' : sourceModule === 'RadiologyRequest' ? 'RadiologyRequest' : sourceModule === 'ProcedureRequest' ? 'ProcedureRequest' : sourceModule === 'Pharmacy' ? 'Pharmacy' : sourceModule === 'DoctorRound' ? 'DoctorVisit' : sourceModule === 'Bed' || sourceModule === 'RecurringDaily' ? 'Bed' : 'IPD', documentId: sourceId, lineKey: `FLOW-${id}` },
          chargeDate: date, chargeDateKey: dateKey(date), idempotencyKey: `FLOW-IPD-CHG-${id}`, isAutoGenerated: auto, isBilled: true, billId: sourceModule === 'Pharmacy' ? null : sourceModule === 'Admission' ? ids.ipdInitialBill : ids.ipdFinalBill, invoiceId: sourceModule === 'Pharmacy' ? ids.ipdPharmacyInvoice : sourceModule === 'Admission' ? ids.ipdInitialInvoice : ids.ipdFinalInvoice, billedAt: ipdFreezeAt,
          pricingSnapshot: { resultType: 'self', amounts: { hospitalStandard: amount, contracted: amount, eligible: amount, patientLiability: amount, sponsorLiability: 0 }, pricedAt: date },
          standardAmount: amount, contractedAmount: amount, eligibleAmount: amount, patientLiability: amount, sponsorLiability: 0, addedBy: financeUser._id, ...docTimes(date, ipdFreezeAt),
          ...overrides
        });
        return id;
      };
      const ipdAdmissionChargeId = pushCharge('Miscellaneous', 'IPD admission / registration charge', admissionFee, ipdAdmissionAt, 'Admission', ids.ipdAdmission, true);

      // Mirror the production recurring-charge identity exactly. The previous
      // fixture used random FLOW-IPD-CHG-* keys for bed/nursing/doctor rows.
      // Opening the running-bill endpoint therefore treated those rows as
      // missing and created a second set of daily charges. Use the canonical
      // daily:<hospital>:<admission>:<date>:<kind> keys and cover every hospital
      // calendar date through the freeze boundary.
      const recurringKeys = dateKeysBetween(ipdAdmissionAt, ipdFreezeAt);
      if (recurringKeys.length !== 3) {
        throw new Error(`Fixture timing error: expected exactly 3 canonical IPD billing dates, found ${recurringKeys.length} (${recurringKeys.join(', ')})`);
      }
      for (const key of recurringKeys) {
        const dt = chargeDateForKey(key);
        const wardLabel = bed.bedType || room.type || ward.type || 'General';

        pushCharge(
          'Bed',
          `Room / Bed Charges - ${wardLabel} - ${key}`,
          bedRate,
          dt,
          'RecurringDaily',
          ids.ipdSegment,
          true,
          {
            chargeDateKey: key,
            idempotencyKey: `daily:${hospitalId}:${ids.ipdAdmission}:${key}:bed`,
            accommodationSegmentId: ids.ipdSegment,
            sourceReference: { module: 'Bed', documentId: ids.ipdSegment, lineKey: `HBT-001:${key}` }
          }
        );

        pushCharge(
          'Nursing',
          `Nursing Charges - ${wardLabel} - ${key}`,
          nursingRate,
          dt,
          'RecurringDaily',
          ids.ipdSegment,
          true,
          {
            chargeDateKey: key,
            idempotencyKey: `daily:${hospitalId}:${ids.ipdAdmission}:${key}:nursing`,
            accommodationSegmentId: ids.ipdSegment,
            sourceReference: { module: 'IPD', documentId: ids.ipdSegment, lineKey: `HBT-002:${key}` }
          }
        );

        pushCharge(
          'RMO / Duty Doctor',
          `RMO & Duty Doctor Charges - ${wardLabel} - ${key}`,
          doctorVisitRate,
          dt,
          'RecurringDaily',
          ids.ipdSegment,
          true,
          {
            chargeDateKey: key,
            idempotencyKey: `daily:${hospitalId}:${ids.ipdAdmission}:${key}:rmo`,
            accommodationSegmentId: ids.ipdSegment,
            sourceReference: { module: 'IPD', documentId: ids.ipdSegment, lineKey: `HBT-003:${key}` }
          }
        );
      }
      const ipdLabChargeId = pushCharge('Lab Test', `${labTest.code} - ${labTest.name}`, labPrice, addHours(ipdAdmissionAt,8), 'LabRequest', ids.ipdLab);
      const ipdRadChargeId = pushCharge('Radiology', `${imagingTest.code} - ${imagingTest.name}`, imagingPrice, addHours(ipdAdmissionAt,10), 'RadiologyRequest', ids.ipdRad);
      const ipdProcChargeId = pushCharge('Procedure', `${procedure.code} - ${procedure.name}`, procedurePrice, addHours(ipdAdmissionAt,28), 'ProcedureRequest', ids.ipdProc);
      const ipdPharmacyChargeId = pushCharge('Pharmacy', `${medicine.name} bedside supply`, ipdPharmacyTotal, addHours(ipdAdmissionAt,7), 'Pharmacy', ids.ipdSale);
      const finalChargeRows = ipdChargeRows.filter(c => !['Pharmacy','Admission'].includes(c.sourceModule));
      const ipdFinalTotal = money(finalChargeRows.reduce((s,c)=>s+c.netAmount,0));
      const ipdGrandTotal = money(admissionFee + ipdFinalTotal + ipdPharmacyTotal);
      const initialInvoiceCollection = admissionFee;
      const advanceDeposit = Math.min(2500, ipdFinalTotal);
      const initialCollection = money(initialInvoiceCollection + advanceDeposit);
      const finalCash = money(ipdFinalTotal - advanceDeposit);
      const ipdDoctorUserId = ipdDoctorUser?._id || financeUser._id;
      const ipdPatientSnapshot = snapshotPatient(ipdPatient);

      await db.collection('ipdadmissions').insertOne({
        _id: ids.ipdAdmission, _testScenario: IPD_TAG, admissionNumber: 'FLOW-IPD-ADM-001', shipNumber: 'FLOW-IPD-SHIP-001', patientId: ipdPatient._id, hospitalId, admissionDate: ipdAdmissionAt, dischargeDate: ipdDischargeAt,
        admissionType: 'Planned', status: 'Discharged', departmentId: ipdDepartmentId, primaryDoctorId: ipdDoctor._id, secondaryDoctorIds: [], bedId: bed._id, roomId: room._id, wardId: ward._id,
        provisionalDiagnosis: 'Acute febrile illness with dehydration - fixture', finalDiagnosis: 'Acute febrile illness - improved', chiefComplaints: 'Fever, weakness and reduced oral intake.', historyOfPresentIllness: 'Symptoms for four days before admission.', clinicalAssessmentCompleted: true, clinicalAssessmentCompletedAt: addHours(ipdAdmissionAt,1), clinicalAssessmentCompletedBy: ipdDoctorUserId,
        attendant: { name: 'Fixture Attendant', relation: 'Relative', mobile: '9999999999', address: ipdPatient.address || '' }, selectedBillingMode: 'PARTIAL_PREPAY', financialPolicySnapshot: { payerCategory: 'self', fixture: true },
        financeInitialization: { status: 'ready', requestedCollection: initialCollection, requestedDeposit: advanceDeposit, paymentMethod: 'Cash', selectedMode: 'PARTIAL_PREPAY', payerCategory: 'self', initialInvoiceId: ids.ipdInitialInvoice, plannedInvoiceCollection: initialInvoiceCollection, plannedAdvanceAmount: advanceDeposit, retryCount: 0, lastAttemptAt: ipdAdmissionAt, completedAt: ipdAdmissionAt, lastAttemptBy: financeUser._id },
        chargeFreeze: { status: 'frozen', frozenAt: ipdFreezeAt, frozenBy: financeUser._id, freezeReason: 'Fixture: all clinical and pharmacy activity completed before final billing.', reopenCount: 0 },
        requiredNowAmount: 0, paymentType: 'Cash', sponsorType: 'self', sponsorName: 'Self / Cash', advanceAmount: 0, totalBillAmount: ipdGrandTotal, paidAmount: ipdGrandTotal, dueAmount: 0, patientReceivable: 0, sponsorReceivable: 0,
        admissionNotes: 'Complete IPD fixture admission.', dischargeReason: 'Clinically improved and fit for discharge.', dischargeType: 'Normal', plannedDischargeAt: ipdDischargeAt, plannedDischargeType: 'PLANNED', plannedDischargeReason: 'Recovered sufficiently for home care.',
        pharmacyClearanceStatus: 'cleared', pharmacyClearanceDate: addHours(ipdFreezeAt,.5), pharmacyClearanceBy: pharmacyUser._id, pharmacyFinalBalance: 0,
        advanceReceivedAmount: advanceDeposit, advanceUtilizedAmount: advanceDeposit, advanceRefundedAmount: 0, advanceClearanceDisposition: 'none', advanceClearanceDispositionAt: addHours(ipdFreezeAt,1), advanceClearanceDispositionBy: financeUser._id,
        invoicedAmount: ipdGrandTotal, financialClearanceStatus: 'cleared', financialClearedAt: addHours(ipdFreezeAt,1.5), financialClearedBy: financeUser._id, finalInvoiceId: ids.ipdFinalInvoice, finalSettlementReceiptNumber: 'FLOW-IPD-FINAL-RCPT-001', finalDischargedAt: ipdDischargeAt, finalDischargedBy: financeUser._id,
        createdBy: financeUser._id, updatedBy: financeUser._id, ...docTimes(ipdAdmissionAt, ipdDischargeAt)
      }, { session });
      await db.collection('ipdaccommodationsegments').insertOne({
        _id: ids.ipdSegment, _testScenario: IPD_TAG, hospitalId, admissionId: ids.ipdAdmission, patientId: ipdPatient._id, wardId: ward._id, roomId: room._id, bedId: bed._id, bedType: bed.bedType,
        startedAt: ipdAdmissionAt, endedAt: ipdFreezeAt, pricingSnapshot: { dailyRate: bedRate, source: 'bed_master', fixture: true }, dailyRate: bedRate, status: 'closed', createdBy: financeUser._id, ...docTimes(ipdAdmissionAt, ipdFreezeAt)
      }, { session });

      for (let d=0; d<3; d++) {
        const desiredRoundAt = hospitalDateTimeForKey(recurringKeys[d], 13, 0);
        const roundAt = d === 2 && desiredRoundAt >= ipdFreezeAt
          ? addHours(ipdFreezeAt, -1)
          : desiredRoundAt;
        const vitalAt = addHours(roundAt, -.5);
        await db.collection('ipdvitals').insertOne({
          _id: ids.ipdVitals[d], _testScenario: IPD_TAG, admissionId: ids.ipdAdmission, patientId: ipdPatient._id, hospitalId, recordedBy: nurseUser._id, recordedByName: nurseUser.name || fullName(nurse), recordedByInitials: (nurseUser.name || 'NU').split(/\s+/).map(x=>x[0]).join('').slice(0,3).toUpperCase(), source: 'manual', recordedAt: vitalAt, recordedTimezone: hospital.timezone || 'Asia/Kolkata', chartDate: dateKey(vitalAt), clinicalShift: 'M',
          temperature: d===0?38.1:d===1?37.4:36.9, temperatureUnit: 'Celsius', pulse: d===0?96:d===1?84:76, bloodPressure: { systolic: 118, diastolic: 76, map: 90 }, bloodPressureString: '118/76', respiratoryRate: 18, spo2: 98, consciousnessResponse: 'Alert', painScore: d===0?3:1, onOxygen: false, roomAir: true, noUrineOverSixHours: false,
          ewsTotal: 0, escalationRequired: false, createdBy: nurseUser._id, ...docTimes(vitalAt)
        }, { session });
        await db.collection('ipdrounds').insertOne({
          _id: ids.ipdRounds[d], _testScenario: IPD_TAG, admissionId: ids.ipdAdmission, patientId: ipdPatient._id, hospitalId, doctorId: ipdDoctor._id, roundDateTime: roundAt,
          patientCondition: d===0?'Stable':d===1?'Improving':'Recovering', complaints: d===0?'Fever and weakness':d===1?'Mild weakness':'No active complaints', examinationFindings: 'Hemodynamically stable; hydration improving.', dailyHistoryAndExamination: `Fixture day ${d+1} consultant review.`, diagnosis: 'Acute febrile illness', treatmentPlan: d<2?'Continue hydration, medication and monitoring.':'Discharge planning after final clearance.', medicationChanges: d===0?'Start ordered medicine.':'Continue same medication.', advice: d===2?'Fit for discharge after billing and pharmacy clearance.':'Continue inpatient care.', vitalId: ids.ipdVitals[d], vitalSnapshot: { sourceTime: vitalAt, bp: '118/76', pulse: d===0?96:d===1?84:76, respiratoryRate: 18, spo2: 98 }, dischargeSuggested: d===2, dischargeAssessment: d===2?{ isFitForDischarge:true, intendedDischargeDate: ipdDischargeAt, dischargeInstructions:'Hydration, medicines and OPD follow-up.', consultantSignedAt: roundAt, consultantSignedBy: ipdDoctorUserId }:{ isFitForDischarge:false }, painScore: d===0?3:1,
          status: 'Signed', signedAt: addHours(roundAt,.25), signedBy: ipdDoctorUserId, createdBy: ipdDoctorUserId, idempotencyKey: `FLOW-IPD-ROUND-${d+1}`, ...docTimes(roundAt, addHours(roundAt,.25))
        }, { session });
        await db.collection('nursingnotes').insertOne({
          _id: new ObjectId(), _testScenario: IPD_TAG, hospitalId, admissionId: ids.ipdAdmission, patientId: ipdPatient._id, nurseId: nurse._id, actorUserId: nurseUser._id, actorRole: 'nurse', actorNameSnapshot: nurseUser.name || fullName(nurse), noteDateTime: addHours(roundAt,1), noteType: 'Shift Note', note: d===0?'Patient admitted, IV/oral hydration maintained, medication received from pharmacy.':d===1?'Patient comfortable; vitals stable; medications administered as charted.':'Patient stable; discharge education provided after doctor review.', priority: 'Normal', shift: 'Morning', createdBy: nurseUser._id,
          ...docTimes(addHours(roundAt,1))
        }, { session });
      }

      await db.collection('prescriptions').insertOne({
        _id: ids.ipdPrescription, _testScenario: IPD_TAG, prescription_number: 'FLOW-IPD-RX-001', hospitalId, patient_id: ipdPatient._id, doctor_id: ipdDoctor._id, ipd_admission_id: ids.ipdAdmission, source_type: 'IPD', round_id: ids.ipdRounds[0],
        presenting_complaint: 'Fever, weakness and dehydration', diagnosis: 'Acute febrile illness', symptoms: 'Fever, fatigue', investigation: 'Lab, imaging and procedure as indicated', treatment_plan: 'Inpatient hydration, monitoring and medication.',
        items: [{ medicine_name: medicine.name, generic_name: medicine.generic_name || medicine.composition || medicine.name, medicine_id: medicine._id, dosage_form: medicine.dosage_form || 'Tablet', medicine_type: 'Tablet', route_of_administration: 'Oral', dosage: '1 unit', frequency: 'OD', duration: '3 days', quantity: ipdMedQty, dose_qty_base_units: 1, required_qty_base_units: ipdMedQty, requires_pharmacy_dispense: true, instructions: 'Administer as per MAR', timing: 'After food', is_dispensed: true, dispensed_quantity: ipdMedQty, dispensed_date: addHours(ipdAdmissionAt,7) }],
        lab_test_requests: [{ lab_test_id: labTest._id, lab_test_code: labTest.code, lab_test_name: labTest.name, category: labTest.category, priority: 'Routine', cost: labPrice, request_id: ids.ipdLab, created_at: addHours(ipdAdmissionAt,6) }],
        radiology_test_requests: [{ imaging_test_id: imagingTest._id, imaging_test_code: imagingTest.code, imaging_test_name: imagingTest.name, category: imagingTest.category, priority: 'Routine', cost: imagingPrice, request_id: ids.ipdRad, created_at: addHours(ipdAdmissionAt,6) }],
        procedure_requests: [{ procedure_id: procedure._id, procedure_code: procedure.code, procedure_name: procedure.name, category: procedure.category, priority: 'Routine', cost: procedurePrice, request_id: ids.ipdProc, created_at: addHours(ipdAdmissionAt,6) }],
        notes: 'Initial IPD order bundle from first signed ward round.', status: 'Completed', issue_date: addHours(ipdAdmissionAt,6), validity_days: 30, created_by: ipdDoctorUserId, ipd_medication_ids: [ids.ipdMar],
        ...docTimes(addHours(ipdAdmissionAt,6), ipdFreezeAt)
      }, { session });
      await db.collection('ipdrounds').updateOne({ _id: ids.ipdRounds[0] }, { $set: { prescriptionId: ids.ipdPrescription } }, { session });

      const ipdRequestBilling = (chargeId, amount) => ({
        billingIntent: 'BILL_NOW', billingState: 'INVOICED', chargeIds: [chargeId], billIds: [ids.ipdFinalBill], invoiceIds: [ids.ipdFinalInvoice], pricingSnapshot: { resultType: 'self', amounts: { hospitalStandard: amount, patientLiability: amount }, pricedAt: ipdFreezeAt }, financialPolicySnapshot: { payerCategory:'self', fixture:true }, selectedBillingMode:'PARTIAL_PREPAY', requiredNowAmount:0, financialClearanceState:'CLEARED', billingHistory:[{from:'PENDING_CHARGE',to:'CHARGE_POSTED',action:'FIXTURE_CHARGE',documentId:chargeId,at:ipdFreezeAt,by:financeUser._id},{from:'CHARGE_POSTED',to:'INVOICED',action:'FIXTURE_FINAL_INVOICE',documentId:ids.ipdFinalInvoice,at:ipdFreezeAt,by:financeUser._id}]
      });
      await db.collection('labrequests').insertOne({
        _id: ids.ipdLab, _testScenario: IPD_TAG, hospitalId, requestNumber: 'FLOW-IPD-LAB-001', requestGroupKey: 'FLOW-IPD-ORDER-GRP-001', collectionEventKey: 'FLOW-IPD-LAB-COLLECTION-001', deskCheckoutKey: 'FLOW-IPD-DESK-LAB-001', sourceType: 'IPD', admissionId: ids.ipdAdmission, prescriptionId: ids.ipdPrescription, patientId: ipdPatient._id, doctorId: ipdDoctor._id, labTestId: labTest._id, testCode: labTest.code, testName: labTest.name, category: labTest.category,
        clinical_indication:'Febrile illness work-up', priority:'Routine', requestedDate:addHours(ipdAdmissionAt,6), sample_collected_at:addHours(ipdAdmissionAt,8), status:'Reported', approvedBy:labStaff?._id, approvedAt:addHours(ipdAdmissionAt,7), verifiedBy:labStaff?._id, verifiedAt:addHours(ipdAdmissionAt,11),
        result_value:'Fixture result within acceptable range', result_interpretation:'No critical abnormality.', is_abnormal:false, report_mode:'manual', manual_report:{templateName:labTest.report_template_name||labTest.name,specimenType:labTest.specimen_type||'Blood',observations:[{name:'Fixture Result',resultType:'text',resultText:'Acceptable',isAbnormal:false}],reportedAt:addHours(ipdAdmissionAt,11),reportedBy:pathologyUser._id}, reportFinalisation:{isFinal:true,finalisedAt:addHours(ipdAdmissionAt,11),finalisedBy:pathologyUser._id,checksum:'FLOW-IPD-LAB-FINAL',version:1},
        accessionNumber:'FLOW-IPD-ACC-001', specimen:{type:labTest.specimen_type||'Blood',barcode:'FLOWIPDLAB001',collectedAt:addHours(ipdAdmissionAt,8),collectedBy:pathologyUser._id,receivedAt:addHours(ipdAdmissionAt,8.5),receivedBy:pathologyUser._id,condition:'Acceptable'}, collectedByUserId:pathologyUser._id,receivedAt:addHours(ipdAdmissionAt,8.5),receivedBy:pathologyUser._id,resultEnteredAt:addHours(ipdAdmissionAt,10.5),verifierUserId:pathologyUser._id,releasedAt:addHours(ipdAdmissionAt,11),releasedBy:pathologyUser._id,
        cost:labPrice,is_billed:true,invoiceId:ids.ipdFinalInvoice,payerContext:{payerCategory:'self',payerName:'Self / Cash',source:'EXPLICIT'},createdBy:ipdDoctorUserId,...ipdRequestBilling(ipdLabChargeId,labPrice),...docTimes(addHours(ipdAdmissionAt,6),ipdFreezeAt)
      }, { session });
      await db.collection('labreports').insertOne({ _id:ids.ipdLabReport,_testScenario:IPD_TAG,hospitalId,lab_request_id:ids.ipdLab,patient_id:ipdPatient._id,doctor_id:ipdDoctor._id,prescription_id:ids.ipdPrescription,lab_test_id:labTest._id,report_type:labTest.name,report_mode:'manual',manual_report:{result:'Acceptable fixture result'},report_date:addHours(ipdAdmissionAt,11),notes:'Final IPD fixture lab report.',created_by:pathologyUser._id,...docTimes(addHours(ipdAdmissionAt,11)) }, { session });
      await db.collection('radiologyrequests').insertOne({
        _id:ids.ipdRad,_testScenario:IPD_TAG,hospitalId,requestNumber:'FLOW-IPD-RAD-001',deskCheckoutKey:'FLOW-IPD-DESK-RAD-001',sourceType:'IPD',admissionId:ids.ipdAdmission,prescriptionId:ids.ipdPrescription,patientId:ipdPatient._id,doctorId:ipdDoctor._id,imagingTestId:imagingTest._id,testCode:imagingTest.code,testName:imagingTest.name,category:imagingTest.category,clinical_indication:'Inpatient assessment',priority:'Routine',requestedDate:addHours(ipdAdmissionAt,6),scheduledDate:addHours(ipdAdmissionAt,10),status:'Reported',
        approvedBy:radiologyStaff?._id,approvedAt:addHours(ipdAdmissionAt,7),performedBy:radiologyStaff?._id,performedAt:addHours(ipdAdmissionAt,10),reportedBy:radiologyStaff?._id,reportedAt:addHours(ipdAdmissionAt,12),findings:'No acute fixture abnormality.',impression:'No significant acute finding.',report_mode:'manual',reportTemplateId:radiologyTemplate.id,reportTemplateName:radiologyTemplate.name,manual_report:radiologyManualReport({findings:'No acute fixture abnormality.',impression:'No significant acute finding.',at:addHours(ipdAdmissionAt,12)}),reportFinalisation:{isFinal:true,finalisedAt:addHours(ipdAdmissionAt,12),finalisedBy:radiologyUser._id,checksum:'FLOW-IPD-RAD-FINAL',version:1},contraindicationAssessment:{pregnancyStatus:'not_applicable',renalRisk:'low',contrastAllergy:false,decision:'proceed',assessedAt:addHours(ipdAdmissionAt,7),assessedBy:radiologyUser._id},patientPreparation:{instructions:'Routine preparation',status:'complete',completedAt:addHours(ipdAdmissionAt,9),completedBy:radiologyUser._id},resultEnteredAt:addHours(ipdAdmissionAt,11.5),verifiedAt:addHours(ipdAdmissionAt,11.75),verifiedByUserId:radiologyUser._id,releasedAt:addHours(ipdAdmissionAt,12),releasedBy:radiologyUser._id,
        cost:imagingPrice,is_billed:true,invoiceId:ids.ipdFinalInvoice,payerContext:{payerCategory:'self',payerName:'Self / Cash',source:'EXPLICIT'},createdBy:ipdDoctorUserId,...ipdRequestBilling(ipdRadChargeId,imagingPrice),...docTimes(addHours(ipdAdmissionAt,6),ipdFreezeAt)
      }, { session });
      await db.collection('procedurerequests').insertOne({
        _id:ids.ipdProc,_testScenario:IPD_TAG,hospitalId,requestNumber:'FLOW-IPD-PROC-001',deskCheckoutKey:'FLOW-IPD-DESK-PROC-001',sourceType:'IPD',admissionId:ids.ipdAdmission,prescriptionId:ids.ipdPrescription,patientId:ipdPatient._id,doctorId:ipdDoctor._id,procedureId:procedure._id,procedureCode:procedure.code,procedureName:procedure.name,category:procedure.category,clinical_indication:'Inpatient fixture procedure',priority:'Routine',requestedDate:addHours(ipdAdmissionAt,6),scheduledDate:addHours(ipdAdmissionAt,28),estimated_duration_minutes:procedure.duration_minutes||30,anesthesia_type:'None',consent_obtained:true,consent_obtained_at:addHours(ipdAdmissionAt,26),consent_obtained_by:financeUser._id,status:'Completed',approvedBy:financeUser._id,approvedAt:addHours(ipdAdmissionAt,24),performedBy:ipdDoctorUserId,performedAt:addHours(ipdAdmissionAt,28),completedBy:ipdDoctorUserId,completedAt:addHours(ipdAdmissionAt,29),findings:'Completed without complication.',complications:'None',post_procedure_instructions:'Continue routine inpatient observation.',surgeon_notes:'Fixture procedure completed.',
        cost:procedurePrice,is_billed:true,invoiceId:ids.ipdFinalInvoice,payerContext:{payerCategory:'self',payerName:'Self / Cash',source:'EXPLICIT'},createdBy:ipdDoctorUserId,...ipdRequestBilling(ipdProcChargeId,procedurePrice),...docTimes(addHours(ipdAdmissionAt,6),ipdFreezeAt)
      }, { session });

      const marTimings = [0,1,2].map((d) => {
        const desired = hospitalDateTimeForKey(recurringKeys[d], 9, 0);
        const t = d === 2 && desired >= ipdFreezeAt ? addHours(ipdFreezeAt, -.75) : desired;
        return { date:t,time:new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false}).format(t),status:'Administered',administeredAt:t,administeredBy:nurse._id,administeredByUser:nurseUser._id,administeredByStaffProfile:nurse._id,administeredByStaffModel:'Nurse',administeredByInitials:(nurseUser.name||'NU').split(/\s+/).map(x=>x[0]).join('').slice(0,3).toUpperCase(),remarks:'Administered from acknowledged bedside stock.',signOffName:nurseUser.name||fullName(nurse) };
      });
      await db.collection('ipdmedicationcharts').insertOne({
        _id:ids.ipdMar,_testScenario:IPD_TAG,admissionId:ids.ipdAdmission,hospitalId,patientId:ipdPatient._id,prescribedBy:ipdDoctor._id,prescribedByNameSnapshot:fullName(ipdDoctor),roundId:ids.ipdRounds[0],prescriptionId:ids.ipdPrescription,medicineId:medicine._id,medicineName:medicine.name,doseQtyBaseUnits:1,requiredQtyBaseUnits:ipdMedQty,genericName:medicine.generic_name||medicine.composition||medicine.name,dosageForm:medicine.dosage_form||'Tablet',route:'Oral',dosage:'1 unit',frequency:'OD',startDate:addHours(ipdAdmissionAt,6),endDate:marTimings[2].administeredAt,duration:3,durationUnit:'Days',specialInstructions:'After food',timing:marTimings,status:'Completed',isHighRisk:false,requiresDoubleVerification:false,
        pharmacyRequest:{requestedToPharmacy:true,requestedAt:addHours(ipdAdmissionAt,6.1),requestedBy:ipdDoctorUserId,requestedQuantity:ipdMedQty,saleId:ids.ipdSale,saleIds:[ids.ipdSale],dispenseHistory:[{saleId:ids.ipdSale,medicineId:medicine._id,batchId:batch._id,quantityBaseUnits:ipdMedQty,dispensedAt:addHours(ipdAdmissionAt,7),receivedAt:addHours(ipdAdmissionAt,7.5),receivedBy:nurseUser._id}],pharmacyId:pharmacy._id,pharmacyRequestNumber:'FLOW-IPD-INDENT-001',pharmacyStatus:'Delivered',dispensedFromPharmacy:true,dispensedQuantity:ipdMedQty,dispensedBatchId:batch._id,dispensedMedicineId:medicine._id,dispensedMedicineName:medicine.name,dispensedAt:addHours(ipdAdmissionAt,7),pharmacyNotes:'Fixture full indent dispensed.',stockReceivedByNurse:true,stockReceivedAt:addHours(ipdAdmissionAt,7.5),stockReceivedBy:nurseUser._id},
        requiresPharmacyDispense:true,stockReceiptStatus:'RECEIVED',costPerUnit:unitPrice,totalCost:ipdPharmacyTotal,isBilled:true,createdBy:ipdDoctorUserId,...docTimes(addHours(ipdAdmissionAt,6),ipdFreezeAt)
      }, { session });
      await db.collection('ipdpatientmedicinestocks').insertOne({
        _id:ids.ipdStock,_testScenario:IPD_TAG,hospitalId,admissionId:ids.ipdAdmission,patientId:ipdPatient._id,medicineId:medicine._id,batchId:batch._id,medicineName:medicine.name,baseUnit:medicine.base_unit||'unit',packUnit:medicine.pack_unit||'unit',unitsPerPack:medicine.units_per_pack||batch.units_per_pack||1,issuedQtyBaseUnits:ipdMedQty,administeredQtyBaseUnits:ipdMedQty,returnedQtyBaseUnits:0,wastedQtyBaseUnits:0,currentBalanceBaseUnits:0,sourceSaleIds:[ids.ipdSale],medicationChartIds:[ids.ipdMar],lastIssuedAt:addHours(ipdAdmissionAt,7),lastAdministeredAt:marTimings[2].administeredAt,stockSource:'INTERNAL_PHARMACY',receiptAcknowledged:true,receiptAcknowledgedAt:addHours(ipdAdmissionAt,7.5),receiptAcknowledgedBy:nurseUser._id,...docTimes(addHours(ipdAdmissionAt,7),ipdFreezeAt)
      }, { session });

      // IPD pharmacy sale was deferred during stay, then completely settled at discharge.
      await db.collection('sales').insertOne({
        _id:ids.ipdSale,_testScenario:IPD_TAG,sale_number:'FLOW-IPD-SALE-001',invoice_number:'FLOW-IPD-PHARM-INV-001',invoice_id:ids.ipdPharmacyInvoice,hospitalId,pharmacy_id:pharmacy._id,customer_type:'IPD',source_type:'IPD_MEDICATION',patient_id:ipdPatient._id,admission_id:ids.ipdAdmission,prescription_id:ids.ipdPrescription,doctor_id:ipdDoctor._id,doctor_name:fullName(ipdDoctor),uhid:ipdPatient.uhid||ipdPatient.patientId,registration_number:'FLOW-IPD-ADM-001',ship_no:'FLOW-IPD-SHIP-001',sponsor_type:'Self',sponsor_name:'Self / Cash',selected_billing_mode:'POSTPAID',required_now_amount:0,financial_clearance_state:'CLEARED',financial_policy_snapshot:{payerCategory:'self',fixture:true},customer_name:fullName(ipdPatient),customer_phone:ipdPatient.phone,sale_date:addHours(ipdAdmissionAt,7),
        items:[{...saleItem(ipdMedQty,ids.ipdMar),prescribed_by:ipdDoctor._id,prescribed_by_name:fullName(ipdDoctor),doctor_id:ipdDoctor._id,doctor_name:fullName(ipdDoctor)}],gross_amount:ipdPharmacyTotal,subtotal:ipdPharmacyTotal,taxable_amount:ipdPharmacyTotal,total_amount:ipdPharmacyTotal,current_bill_amount:ipdPharmacyTotal,total_collected_amount:ipdPharmacyTotal,previous_outstanding:0,amount_paid:ipdPharmacyTotal,settlement_amount:ipdPharmacyTotal,balance_due:0,closing_outstanding:0,payment_method:'UPI',payments:[{method:'UPI',amount:ipdPharmacyTotal,reference:'FLOW-IPD-PHARM-UPI'}],transactionGroupId:'FLOW-IPD-PHARM-GRP',idempotencyKey:'FLOW-IPD-SALE-001',status:'Completed',prescription_required:true,prescription_details:'Linked IPD MAR and prescription',created_by:pharmacyUser._id,payment_deferred:false,include_in_discharge_clearance:true,discharged_settled_at:addHours(ipdFreezeAt,.5),discharge_settlement_id:ids.ipdPharmacySettlement,net_amount_after_returns:ipdPharmacyTotal,settlement_refs:[{settlement_id:ids.ipdPharmacySettlement,amount:ipdPharmacyTotal,settled_at:addHours(ipdFreezeAt,.5)}],
        ...docTimes(addHours(ipdAdmissionAt,7),addHours(ipdFreezeAt,.5))
      }, { session });
      await db.collection('invoices').insertOne({
        _id:ids.ipdPharmacyInvoice,_testScenario:IPD_TAG,invoice_number:'FLOW-IPD-PHARM-INV-001',hospital_id:hospitalId,patient_id:ipdPatient._id,customer_type:'Patient',customer_name:fullName(ipdPatient),customer_phone:ipdPatient.phone,admission_id:ids.ipdAdmission,sale_id:ids.ipdSale,prescription_id:ids.ipdPrescription,invoice_type:'Pharmacy',document_stage:'ISSUED',issued_at:addHours(ipdAdmissionAt,7),issue_date:addHours(ipdAdmissionAt,7),due_date:ipdFreezeAt,gross_amount:ipdPharmacyTotal,taxable_amount:ipdPharmacyTotal,medicine_items:[{medicine_id:medicine._id,batch_id:batch._id,medicine_name:medicine.name,item_type:'Pharmacy',batch_number:batch.batch_number,expiry_date:batch.expiry_date,quantity:ipdMedQty,quantity_base_units:ipdMedQty,base_unit:medicine.base_unit||'unit',unit_price:unitPrice,total_price:ipdPharmacyTotal,tax_rate:0,tax_amount:0}],subtotal:ipdPharmacyTotal,total:ipdPharmacyTotal,discount:0,tax:0,amount_paid:ipdPharmacyTotal,balance_due:0,payment_history:[{date:addHours(ipdFreezeAt,.5),amount:ipdPharmacyTotal,method:'UPI',reference:'FLOW-IPD-PHARM-UPI',status:'Completed',collected_by:pharmacyUser._id,receipt_number:'FLOW-IPD-PHARM-RCPT-001',receipt_type:'Final Settlement',balance_after:0}],status:'Paid',is_pharmacy_sale:true,dispensing_date:addHours(ipdAdmissionAt,7),dispensed_by:pharmacyUser._id,created_by:pharmacyUser._id,patient_snapshot:ipdPatientSnapshot,...docTimes(addHours(ipdAdmissionAt,7),addHours(ipdFreezeAt,.5))
      }, { session });
      await db.collection('pharmacyledgersettlements').insertOne({
        _id:ids.ipdPharmacySettlement,_testScenario:IPD_TAG,settlement_number:'FLOW-IPD-PLS-001',settledAt:addHours(ipdFreezeAt,.5),hospital_id:hospitalId,pharmacy_id:pharmacy._id,patient_id:ipdPatient._id,admission_id:ids.ipdAdmission,status:'POSTED',settlement_type:'FINAL_CLEARANCE',discount_scope:'UNPAID_DUE',discount_type:'FIXED',discount_value:0,percentage_treatment:'ADDITIONAL',allocation_policy:'FIFO',opening_ledger_gross:ipdPharmacyTotal,opening_ledger_net:ipdPharmacyTotal,opening_paid_total:0,opening_outstanding_total:ipdPharmacyTotal,existing_discount_total:0,calculated_discount:0,discount_applied:0,discount_unapplied:0,payment_received:ipdPharmacyTotal,patient_credit_created:0,patient_credit_disposition:'NONE',payment_breakdown:[{method:'UPI',amount:ipdPharmacyTotal,reference:'FLOW-IPD-PHARM-UPI',walletType:null}],allocations:[{_id:new ObjectId(),sale_id:ids.ipdSale,sale_number:'FLOW-IPD-SALE-001',invoice_id:ids.ipdPharmacyInvoice,opening_due:ipdPharmacyTotal,opening_paid:0,gross_amount:ipdPharmacyTotal,existing_discounts:0,payment_allocated:ipdPharmacyTotal,settlement_discount_allocated:0,credit_note_allocated:0,unapplied_discount:0,closing_due:0,payment_breakdown:[{method:'UPI',amount:ipdPharmacyTotal,reference:'FLOW-IPD-PHARM-UPI',walletType:null}]}],reason:'Fixture final pharmacy clearance settlement.',created_by:pharmacyUser._id,approved_by:financeUser._id,idempotency_key:'FLOW-IPD-PLS-001',transactionGroupId:'FLOW-IPD-PHARM-GRP',unusedPharmacyAdvanceDisposition:'none',unusedPharmacyAdvanceAmount:0,
        ...docTimes(addHours(ipdFreezeAt,.5))
      }, { session });
      await db.collection('pharmacyledgerentries').insertMany([
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,pharmacyId:pharmacy._id,entryDate:addHours(ipdAdmissionAt,7),entryType:'SALE',direction:'NON_CASH',amount:ipdPharmacyTotal,paymentMethod:'Deferred',patientId:ipdPatient._id,admissionId:ids.ipdAdmission,saleId:ids.ipdSale,invoiceId:ids.ipdPharmacyInvoice,notes:'IPD medicine issued; due carried to discharge clearance.',idempotencyKey:'FLOW-IPD-PHARM-LEDGER-SALE',transactionGroupId:'FLOW-IPD-PHARM-GRP',createdBy:pharmacyUser._id,...docTimes(addHours(ipdAdmissionAt,7))},
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,pharmacyId:pharmacy._id,entryDate:addHours(ipdFreezeAt,.5),entryType:'OUTSTANDING_PAYMENT',direction:'IN',amount:ipdPharmacyTotal,paymentMethod:'UPI',patientId:ipdPatient._id,admissionId:ids.ipdAdmission,saleId:ids.ipdSale,invoiceId:ids.ipdPharmacyInvoice,settlementId:ids.ipdPharmacySettlement,notes:'Outstanding pharmacy due settled.',idempotencyKey:'FLOW-IPD-PHARM-LEDGER-PAY',transactionGroupId:'FLOW-IPD-PHARM-GRP',createdBy:pharmacyUser._id,...docTimes(addHours(ipdFreezeAt,.5))},
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,pharmacyId:pharmacy._id,entryDate:addHours(ipdFreezeAt,.6),entryType:'FINAL_CLEARANCE',direction:'NON_CASH',amount:0,paymentMethod:'Adjustment',patientId:ipdPatient._id,admissionId:ids.ipdAdmission,settlementId:ids.ipdPharmacySettlement,notes:'Pharmacy final clearance issued; zero balance.',idempotencyKey:'FLOW-IPD-PHARM-CLEAR',transactionGroupId:'FLOW-IPD-PHARM-GRP',createdBy:pharmacyUser._id,...docTimes(addHours(ipdFreezeAt,.6))}
      ], { session });

      await db.collection('ipdcharges').insertMany(ipdChargeRows, { session });
      await db.collection('bills').insertOne({
        _id:ids.ipdInitialBill,_testScenario:IPD_TAG,bill_number:'FLOW-IPD-INITIAL-BILL-001',document_stage:'INVOICED',invoice_ids:[ids.ipdInitialInvoice],invoiced_at:addHours(ipdAdmissionAt,.25),hospital_id:hospitalId,patient_id:ipdPatient._id,admission_id:ids.ipdAdmission,invoice_id:ids.ipdInitialInvoice,total_amount:admissionFee,gross_amount:admissionFee,subtotal:admissionFee,taxable_amount:admissionFee,tax_amount:0,discount:0,payment_method:'Cash',payments:[{method:'Cash',amount:admissionFee,reference:'FLOW-IPD-INITIAL-RCPT-001',externalReference:'FLOW-IPD-INITIAL-CASH',date:addHours(ipdAdmissionAt,.25)}],items:[{charge_id:ipdAdmissionChargeId,description:'IPD admission / registration charge',charge_type:'Miscellaneous',charge_head:'Admission',charge_date:ipdAdmissionAt,gross_amount:admissionFee,net_amount:admissionFee,amount:admissionFee,quantity:1,item_type:'Other',unit_price:admissionFee,tax_rate:0,tax_amount:0,discount_amount:0,admission_id:ids.ipdAdmission}],status:'Paid',generated_at:ipdAdmissionAt,paid_at:addHours(ipdAdmissionAt,.25),paid_amount:admissionFee,balance_due:0,created_by:financeUser._id,notes:'Initial IPD admission invoice created during finance initialization.',...docTimes(ipdAdmissionAt,addHours(ipdAdmissionAt,.25))
      }, { session });
      await db.collection('invoices').insertOne({
        _id:ids.ipdInitialInvoice,_testScenario:IPD_TAG,invoice_number:'FLOW-IPD-INITIAL-INV-001',hospital_id:hospitalId,patient_id:ipdPatient._id,customer_type:'Patient',customer_name:fullName(ipdPatient),customer_phone:ipdPatient.phone,admission_id:ids.ipdAdmission,bill_id:ids.ipdInitialBill,bill_ids:[ids.ipdInitialBill],invoice_type:'IPD Admission',document_stage:'ISSUED',issued_at:addHours(ipdAdmissionAt,.25),issue_date:addHours(ipdAdmissionAt,.25),due_date:addHours(ipdAdmissionAt,.25),gross_amount:admissionFee,taxable_amount:admissionFee,service_items:[{description:'IPD admission / registration charge',charge_id:ipdAdmissionChargeId,charge_type:'Miscellaneous',charge_head:'Admission',charge_date:ipdAdmissionAt,gross_amount:admissionFee,net_amount:admissionFee,quantity:1,unit_price:admissionFee,total_price:admissionFee,tax_rate:0,tax_amount:0,service_type:'Other'}],subtotal:admissionFee,total:admissionFee,discount:0,tax:0,amount_paid:admissionFee,balance_due:0,payment_history:[{date:addHours(ipdAdmissionAt,.25),amount:admissionFee,method:'Cash',reference:'FLOW-IPD-INITIAL-RCPT-001',externalReference:'FLOW-IPD-INITIAL-CASH',status:'Completed',collected_by:financeUser._id,transaction_id:'FLOW-IPD-INITIAL-RCPT-001',receipt_number:'FLOW-IPD-INITIAL-RCPT-001',receipt_type:'Payment',balance_after:0}],status:'Paid',created_by:financeUser._id,patient_snapshot:ipdPatientSnapshot,admission_snapshot:{admissionNumber:'FLOW-IPD-ADM-001',shipNumber:'FLOW-IPD-SHIP-001'},...docTimes(addHours(ipdAdmissionAt,.25))
      }, { session });
      await db.collection('ipdcharges').updateOne({ _id: ipdAdmissionChargeId }, { $set: { billId: ids.ipdInitialBill, invoiceId: ids.ipdInitialInvoice } }, { session });
      const finalBillItems = finalChargeRows.map(c => ({ charge_id:c._id,description:c.description,charge_type:c.chargeType,charge_head:c.chargeType,charge_date:c.chargeDate,gross_amount:c.grossAmount,net_amount:c.netAmount,amount:c.netAmount,quantity:1,item_type:c.chargeType==='Lab Test'?'Lab Test':c.chargeType==='Radiology'?'Radiology':c.chargeType==='Procedure'?'Procedure':['Doctor Visit','RMO / Duty Doctor'].includes(c.chargeType)?'Consultation':'Other',unit_price:c.rate,tax_rate:0,tax_amount:0,discount_amount:0,admission_id:ids.ipdAdmission,doctor_id:['Doctor Visit','RMO / Duty Doctor'].includes(c.chargeType)?ipdDoctor._id:undefined,doctor_name:['Doctor Visit','RMO / Duty Doctor'].includes(c.chargeType)?fullName(ipdDoctor):undefined }));
      await db.collection('bills').insertOne({
        _id:ids.ipdFinalBill,_testScenario:IPD_TAG,bill_number:'FLOW-IPD-FINAL-BILL-001',document_stage:'INVOICED',invoice_ids:[ids.ipdFinalInvoice],invoiced_at:ipdFreezeAt,hospital_id:hospitalId,patient_id:ipdPatient._id,admission_id:ids.ipdAdmission,invoice_id:ids.ipdFinalInvoice,total_amount:ipdFinalTotal,gross_amount:ipdFinalTotal,subtotal:ipdFinalTotal,taxable_amount:ipdFinalTotal,tax_amount:0,discount:0,advance_applied:advanceDeposit,payment_method:'Split',payments:[{method:'IPDAdvance',amount:advanceDeposit,reference:'FLOW-IPD-ADV-001',date:ipdFreezeAt},{method:'Cash',amount:finalCash,reference:'FLOW-IPD-FINAL-RCPT-001',externalReference:'FLOW-IPD-FINAL-CASH',date:addHours(ipdFreezeAt,1)}],items:finalBillItems,status:'Paid',generated_at:ipdFreezeAt,paid_at:addHours(ipdFreezeAt,1),paid_amount:ipdFinalTotal,balance_due:0,created_by:financeUser._id,notes:'Final IPD fixture bill after charge freeze.',...docTimes(ipdFreezeAt,addHours(ipdFreezeAt,1))
      }, { session });
      await db.collection('invoices').insertOne({
        _id:ids.ipdFinalInvoice,_testScenario:IPD_TAG,invoice_number:'FLOW-IPD-FINAL-INV-001',hospital_id:hospitalId,patient_id:ipdPatient._id,customer_type:'Patient',customer_name:fullName(ipdPatient),customer_phone:ipdPatient.phone,admission_id:ids.ipdAdmission,bill_id:ids.ipdFinalBill,bill_ids:[ids.ipdFinalBill],invoice_type:'IPD Final',document_stage:'ISSUED',is_final_ipd_invoice:true,issued_at:ipdFreezeAt,issue_date:ipdFreezeAt,due_date:ipdFreezeAt,gross_amount:ipdFinalTotal,taxable_amount:ipdFinalTotal,advance_applied:advanceDeposit,
        service_items:finalChargeRows.map(c=>({description:c.description,charge_id:c._id,charge_type:c.chargeType,charge_head:c.chargeType,charge_date:c.chargeDate,gross_amount:c.grossAmount,net_amount:c.netAmount,quantity:1,unit_price:c.rate,total_price:c.netAmount,tax_rate:0,tax_amount:0,service_type:c.chargeType==='Lab Test'?'Lab Test':c.chargeType==='Radiology'?'Radiology':c.chargeType==='Procedure'?'Procedure':['Doctor Visit','RMO / Duty Doctor'].includes(c.chargeType)?'Consultation':'Other'})),subtotal:ipdFinalTotal,total:ipdFinalTotal,discount:0,tax:0,amount_paid:ipdFinalTotal,balance_due:0,payment_history:[{date:ipdFreezeAt,amount:advanceDeposit,method:'IPDAdvance',reference:'FLOW-IPD-ADV-001',status:'Completed',collected_by:financeUser._id,receipt_number:'FLOW-IPD-ADV-UTIL-001',receipt_type:'Final Settlement',advance_applied:advanceDeposit,balance_after:finalCash},{date:addHours(ipdFreezeAt,1),amount:finalCash,method:'Cash',reference:'FLOW-IPD-FINAL-RCPT-001',externalReference:'FLOW-IPD-FINAL-CASH',status:'Completed',collected_by:financeUser._id,receipt_number:'FLOW-IPD-FINAL-RCPT-001',receipt_type:'Final Settlement',balance_after:0}],status:'Paid',created_by:financeUser._id,patient_snapshot:ipdPatientSnapshot,admission_snapshot:{admissionNumber:'FLOW-IPD-ADM-001',shipNumber:'FLOW-IPD-SHIP-001',admissionDate:ipdAdmissionAt,dischargeDate:ipdDischargeAt,bed:bed.bedNumber,room:room.room_number,ward:ward.name,finalDiagnosis:'Acute febrile illness - improved'},hospital_snapshot:{_id:hospital._id,hospitalName:hospital.hospitalName,hospitalID:hospital.hospitalID},has_procedures:true,procedures_status:'Paid',has_lab_tests:true,lab_tests_status:'Paid',has_radiology:true,radiology_status:'Paid',...docTimes(ipdFreezeAt,addHours(ipdFreezeAt,1))
      }, { session });

      await db.collection('patientadvanceledgers').insertMany([
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,patientId:ipdPatient._id,admissionId:ids.ipdAdmission,walletType:'IPD_SHARED',transactionType:'ADVANCE_DEPOSIT',direction:'CREDIT',amount:advanceDeposit,openingBalance:0,paymentMethod:'Cash',referenceNumber:'FLOW-IPD-ADV-001',documentType:'Receipt',sourceModule:'IPD',sourceId:ids.ipdAdmission,balanceAfter:advanceDeposit,status:'POSTED',idempotencyKey:'FLOW-IPD-ADV-DEPOSIT',transactionGroupId:'FLOW-IPD-FIN-GRP',notes:'Admission advance fixture.',postedAt:ipdAdmissionAt,createdBy:financeUser._id,...docTimes(ipdAdmissionAt)},
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,patientId:ipdPatient._id,admissionId:ids.ipdAdmission,walletType:'IPD_SHARED',transactionType:'IPD_INVOICE_DEBIT',direction:'DEBIT',amount:advanceDeposit,openingBalance:advanceDeposit,paymentMethod:'IPDAdvance',referenceNumber:'FLOW-IPD-ADV-UTIL-001',documentType:'Invoice',documentId:ids.ipdFinalInvoice,sourceModule:'Discharge',sourceId:ids.ipdFinalInvoice,balanceAfter:0,status:'POSTED',idempotencyKey:'FLOW-IPD-ADV-UTIL',transactionGroupId:'FLOW-IPD-FIN-GRP',notes:'Advance applied to final IPD invoice.',postedAt:ipdFreezeAt,createdBy:financeUser._id,...docTimes(ipdFreezeAt)}
      ], { session });
      await db.collection('financialtransactions').insertMany([
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,patientId:ipdPatient._id,admissionId:ids.ipdAdmission,billId:ids.ipdInitialBill,invoiceId:ids.ipdInitialInvoice,transactionNumber:'FLOW-IPD-INITIAL-RCPT-001',transactionType:'RECEIPT',direction:'CREDIT',amount:admissionFee,postedAt:addHours(ipdAdmissionAt,.25),externalMoneyMovement:true,cashFlowClass:'EXTERNAL_COLLECTION',amountTendered:admissionFee,amountApplied:admissionFee,amountReceived:admissionFee,balanceAfter:0,paymentMethod:'Cash',paymentReference:'FLOW-IPD-INITIAL-CASH',receiptType:'Payment',sourceModule:'IPD',sourceId:ids.ipdInitialInvoice,status:'POSTED',idempotencyKey:'FLOW-IPD-INITIAL-RCPT-001',documentAllocations:[{documentType:'Invoice',documentId:ids.ipdInitialInvoice,amount:admissionFee}],createdBy:financeUser._id,metadata:{fixture:true},...docTimes(addHours(ipdAdmissionAt,.25))},
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,patientId:ipdPatient._id,admissionId:ids.ipdAdmission,transactionNumber:'FLOW-IPD-ADV-RCPT-001',transactionType:'ADVANCE_DEPOSIT',direction:'CREDIT',amount:advanceDeposit,postedAt:ipdAdmissionAt,externalMoneyMovement:true,cashFlowClass:'ADVANCE_RECEIPT',amountTendered:advanceDeposit,amountApplied:0,advanceCreated:advanceDeposit,paymentMethod:'Cash',paymentReference:'FLOW-IPD-ADV-001',receiptType:'Advance',sourceModule:'IPD',sourceId:ids.ipdAdmission,status:'POSTED',idempotencyKey:'FLOW-IPD-ADV-RCPT-001',createdBy:financeUser._id,metadata:{fixture:true},...docTimes(ipdAdmissionAt)},
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,patientId:ipdPatient._id,admissionId:ids.ipdAdmission,billId:ids.ipdFinalBill,invoiceId:ids.ipdFinalInvoice,transactionNumber:'FLOW-IPD-ADV-UTIL-001',transactionType:'ADVANCE_UTILISATION',direction:'DEBIT',amount:advanceDeposit,postedAt:ipdFreezeAt,externalMoneyMovement:false,cashFlowClass:'WALLET_UTILISATION',amountApplied:advanceDeposit,advanceApplied:advanceDeposit,paymentMethod:'IPDAdvance',paymentReference:'FLOW-IPD-ADV-UTIL-001',receiptType:'Final Settlement',sourceModule:'Discharge',sourceId:ids.ipdFinalInvoice,status:'POSTED',idempotencyKey:'FLOW-IPD-ADV-UTIL-001',documentAllocations:[{documentType:'Invoice',documentId:ids.ipdFinalInvoice,amount:advanceDeposit}],createdBy:financeUser._id,metadata:{fixture:true},...docTimes(ipdFreezeAt)},
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,patientId:ipdPatient._id,admissionId:ids.ipdAdmission,billId:ids.ipdFinalBill,invoiceId:ids.ipdFinalInvoice,transactionNumber:'FLOW-IPD-FINAL-RCPT-001',transactionType:'RECEIPT',direction:'CREDIT',amount:finalCash,postedAt:addHours(ipdFreezeAt,1),externalMoneyMovement:true,cashFlowClass:'EXTERNAL_COLLECTION',amountTendered:finalCash,amountApplied:finalCash,amountReceived:finalCash,balanceAfter:0,paymentMethod:'Cash',paymentReference:'FLOW-IPD-FINAL-CASH',receiptType:'Final Settlement',sourceModule:'Discharge',sourceId:ids.ipdFinalInvoice,status:'POSTED',idempotencyKey:'FLOW-IPD-FINAL-RCPT-001',documentAllocations:[{documentType:'Invoice',documentId:ids.ipdFinalInvoice,amount:finalCash}],createdBy:financeUser._id,metadata:{fixture:true},...docTimes(addHours(ipdFreezeAt,1))},
        {_id:new ObjectId(),_testScenario:IPD_TAG,hospitalId,patientId:ipdPatient._id,admissionId:ids.ipdAdmission,invoiceId:ids.ipdPharmacyInvoice,transactionNumber:'FLOW-IPD-PHARM-RCPT-001',transactionType:'RECEIPT',direction:'CREDIT',amount:ipdPharmacyTotal,postedAt:addHours(ipdFreezeAt,.5),externalMoneyMovement:true,cashFlowClass:'EXTERNAL_COLLECTION',amountTendered:ipdPharmacyTotal,amountApplied:ipdPharmacyTotal,amountReceived:ipdPharmacyTotal,balanceAfter:0,paymentMethod:'UPI',paymentReference:'FLOW-IPD-PHARM-UPI',receiptType:'Final Settlement',sourceModule:'Pharmacy',sourceId:ids.ipdSale,status:'POSTED',idempotencyKey:'FLOW-IPD-PHARM-RCPT-001',documentAllocations:[{documentType:'Invoice',documentId:ids.ipdPharmacyInvoice,amount:ipdPharmacyTotal}],createdBy:pharmacyUser._id,metadata:{fixture:true},...docTimes(addHours(ipdFreezeAt,.5))}
      ], { session });

      const dischargeMeds = [{ medicineId:medicine._id,medicineName:medicine.name,morning:'1',noon:'',evening:'',extra:'',type:'OD',frequency:'OD',days:'3 days',duration:'3 days',instructions:'After food; complete course as advised.',source:'prescription',reconciliationAction:'Continue',reconciliationReason:'Continue short course after discharge.' }];
      await db.collection('dischargesummaries').insertOne({
        _id:ids.ipdDischargeSummary,_testScenario:IPD_TAG,hospitalId,admissionId:ids.ipdAdmission,patientId:ipdPatient._id,templateVersion:'reference-2026.1',preparedBy:ipdDoctor._id,admissionDate:ipdAdmissionAt,dischargeDate:ipdDischargeAt,dischargeType:'Normal',finalDiagnosis:'Acute febrile illness - improved',chiefComplaints:'Fever, weakness and reduced oral intake.',historyOfPresentIllness:'Admitted for hydration, monitoring and evaluation.',examinationFindings:'Stable vitals; afebrile before discharge.',investigations:`${labTest.name}: no critical abnormality. ${imagingTest.name}: no acute significant finding.`,treatmentGiven:'Hydration, symptomatic medication, nursing monitoring and daily consultant review.',proceduresDone:`${procedure.name} completed without complication.`,conditionOnDischarge:'Improved',conditionAtDischargeText:'Afebrile, oral intake adequate, ambulatory and hemodynamically stable.',medicationReconciliation:{performedAt:addHours(ipdFreezeAt,-.5),performedBy:ipdDoctorUserId,admissionMedicines:[{name:medicine.name,medicineId:medicine._id,action:'continue',dischargeInstruction:'OD for 3 days after food',reason:'Complete short course'}],discrepancies:[],completed:true},dischargeMedications:dischargeMeds,followUpAdvice:'Review in OPD or earlier if symptoms recur.',followUpAfterDays:7,followUpDate:addDays(ipdDischargeAt,7),followUpDetails:'Medicine/General Medicine OPD follow-up.',emergencyInstructions:'Return for high fever, breathlessness, persistent vomiting or altered sensorium.',adviceAtDischarge:'Hydration and adequate rest.',dietAdvice:'Regular light diet and fluids.',activityAdvice:'Gradual activity as tolerated.',patientAcknowledgement:'Discharge instructions explained.',patientSnapshot:ipdPatientSnapshot,admissionSnapshot:{admissionNumber:'FLOW-IPD-ADM-001',shipNumber:'FLOW-IPD-SHIP-001',bed:bed.bedNumber,room:room.room_number,ward:ward.name},hospitalSnapshot:{_id:hospital._id,hospitalName:hospital.hospitalName,hospitalID:hospital.hospitalID},reviewedBy:ipdDoctor._id,reviewedAt:addHours(ipdFreezeAt,-.25),status:'StaffCompleted',finalizedAt:addHours(ipdFreezeAt,-.25),revisionNumber:1,revisionHistory:[],createdBy:ipdDoctorUserId,updatedBy:financeUser._id,...docTimes(addHours(ipdFreezeAt,-1),ipdFreezeAt)
      }, { session });

      // Batch inventory movement: 2 OPD + 3 IPD units dispensed.
      const stockMove = await db.collection('medicinebatches').updateOne(
        { _id: batch._id, quantity_base_units: { $gte: opdMedQty + ipdMedQty } },
        { $inc: { quantity_base_units: -(opdMedQty + ipdMedQty), quantity: -(opdMedQty + ipdMedQty) } },
        { session }
      );
      if (stockMove.matchedCount !== 1) throw new Error('Medicine batch stock changed during seeding; transaction aborted.');

      // Keep patient master records, but update only current operational summary/cache fields.
      await db.collection('patients').updateOne({ _id: opdPatient._id }, { $set: { pharmacy_outstanding_balance:0, pharmacy_advance_balance:0, active_admissions:[], last_pharmacy_visit:opdPharmacyAt, last_pharmacy_transaction:opdPharmacyAt, lastCoveragePreference:{payerCategory:'self',payerName:'Self / Cash',beneficiary:{},source:'OPD',encounterId:ids.opdAppointment,usedAt:opdPaidAt,updatedBy:financeUser._id}, updated_at:opdCompleteAt } }, { session });
      await db.collection('patients').updateOne({ _id: ipdPatient._id }, { $set: { pharmacy_outstanding_balance:0, pharmacy_advance_balance:0, active_admissions:[], last_pharmacy_visit:addHours(ipdFreezeAt,.5), last_pharmacy_transaction:addHours(ipdFreezeAt,.5), lastCoveragePreference:{payerCategory:'self',payerName:'Self / Cash',beneficiary:{},source:'IPD',encounterId:ids.ipdAdmission,usedAt:ipdFreezeAt,updatedBy:financeUser._id}, updated_at:ipdDischargeAt } }, { session });
      await db.collection('beds').updateOne({ _id: bed._id }, { $set: { status:'Available' }, $unset: { currentAdmissionId:'', reservedTransferId:'', reservationExpiresAt:'', cleaningStartedAt:'', cleaningCompletedAt:'', cleaningNote:'' } }, { session });
      await db.collection('rooms').updateOne({ _id: room._id }, { $set: { status: room.operationalStatus === 'maintenance' ? 'Maintenance' : room.operationalStatus === 'closed' ? 'Closed' : 'Available' }, $unset: { assigned_patient_id:'' } }, { session });

      summary.opd = { appointmentId: ids.opdAppointment, prescriptionId: ids.opdPrescription, billId: ids.opdBill, invoiceId: ids.opdInvoice, pharmacySaleId: ids.opdSale, totalClinical: opdServiceSubtotal, pharmacyTotal: opdPharmacyTotal };
      summary.ipd = { admissionId: ids.ipdAdmission, finalBillId: ids.ipdFinalBill, finalInvoiceId: ids.ipdFinalInvoice, pharmacySaleId: ids.ipdSale, radiologyRequestId: ids.ipdRad, dischargeSummaryId: ids.ipdDischargeSummary, finalIpdTotal: ipdFinalTotal, pharmacyTotal: ipdPharmacyTotal, grandTotal: ipdGrandTotal, recurringDays: recurringKeys.length };
    });
  } finally {
    await session.endSession();
  }

  // Post-transaction financial sanity check. This intentionally validates the
  // persisted records using the same values the UI will later read.
  const [seededAdmission, seededFinalInvoice, seededPharmacyInvoice, seededRadiology, recurringRows, fixtureTransactions] = await Promise.all([
    db.collection('ipdadmissions').findOne({ _id: summary.ipd.admissionId }),
    db.collection('invoices').findOne({ _id: summary.ipd.finalInvoiceId }),
    db.collection('invoices').findOne({ invoice_number: 'FLOW-IPD-PHARM-INV-001', admission_id: summary.ipd.admissionId }),
    db.collection('radiologyrequests').findOne({ _id: summary.ipd.radiologyRequestId }),
    db.collection('ipdcharges').find({ admissionId: summary.ipd.admissionId, sourceModule: 'RecurringDaily' }).toArray(),
    db.collection('financialtransactions').find({ _testScenario: { $in: TAGS } }).toArray()
  ]);

  const expectedDailyPrefix = `daily:${hospitalId}:${summary.ipd.admissionId}:`;
  const nonCanonicalRecurring = recurringRows.filter((row) => !String(row.idempotencyKey || '').startsWith(expectedDailyPrefix));
  if (!seededAdmission || Number(seededAdmission.dueAmount || 0) !== 0 || Number(seededAdmission.patientReceivable || 0) !== 0) {
    throw new Error(`IPD fixture sanity check failed: admission due must be zero (due=${seededAdmission?.dueAmount}, receivable=${seededAdmission?.patientReceivable})`);
  }
  if (!seededFinalInvoice || Number(seededFinalInvoice.balance_due || 0) !== 0) {
    throw new Error(`IPD fixture sanity check failed: final invoice balance must be zero (balance=${seededFinalInvoice?.balance_due})`);
  }
  if (!seededPharmacyInvoice || Number(seededPharmacyInvoice.balance_due || 0) !== 0) {
    throw new Error(`IPD fixture sanity check failed: pharmacy invoice balance must be zero (balance=${seededPharmacyInvoice?.balance_due})`);
  }
  if (recurringRows.length !== 9 || nonCanonicalRecurring.length) {
    throw new Error(`IPD fixture sanity check failed: expected 9 canonical recurring rows (3 days x bed/nursing/rmo); found ${recurringRows.length}, nonCanonical=${nonCanonicalRecurring.length}`);
  }
  if (!seededRadiology?.manual_report?.templateId || !Array.isArray(seededRadiology?.manual_report?.sections) || seededRadiology.manual_report.sections.length < 2) {
    throw new Error('IPD fixture sanity check failed: structured radiology report is incomplete; View/Print/Download PDF would not be usable');
  }
  const legacyTransactionNumbers = fixtureTransactions
    .map((row) => String(row.transactionNumber || ''))
    .filter((number) => /(?:OPD|IPD).*-TXN-\d+$/i.test(number));
  if (legacyTransactionNumbers.length) {
    throw new Error(`Fixture sanity check failed: payment events must use one canonical hospital receipt/transaction number; legacy aliases remain: ${legacyTransactionNumbers.join(', ')}`);
  }

  console.log('\nSEED COMPLETE');
  console.log(`OPD ${fullName(opdPatient)}: appointment=${summary.opd.appointmentId}`);
  console.log(`  Consultation/diagnostics/procedure invoice: ${summary.opd.invoiceId} | ${summary.opd.totalClinical}`);
  console.log(`  Pharmacy sale: ${summary.opd.pharmacySaleId} | ${summary.opd.pharmacyTotal}`);
  console.log(`IPD ${fullName(ipdPatient)}: admission=${summary.ipd.admissionId}`);
  console.log(`  Final IPD invoice: ${summary.ipd.finalInvoiceId} | ${summary.ipd.finalIpdTotal}`);
  console.log(`  Pharmacy sale/clearance: ${summary.ipd.pharmacySaleId} | ${summary.ipd.pharmacyTotal}`);
  console.log(`  Grand settled amount: ${summary.ipd.grandTotal}`);
  console.log(`  Canonical recurring billing days through freeze: ${summary.ipd.recurringDays}`);
  console.log(`  Canonical recurring rows: ${recurringRows.length}`);
  console.log('  Financial sanity: admission due=0, final invoice balance=0, pharmacy invoice balance=0');
  console.log('  Receipt sanity: one canonical hospital receipt/transaction number per payment event');
  console.log('  Radiology sanity: structured manual report is printable/downloadable');
  console.log('Both patients end with zero current balance; frozen IPD ledgers must remain read-only after this point.');
}

main()
  .catch(err => {
    console.error('\nSEED FAILED:', err?.stack || err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) {}
  });
