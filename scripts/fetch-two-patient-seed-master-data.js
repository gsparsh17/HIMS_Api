#!/usr/bin/env node
'use strict';

/**
 * Read-only preflight/master-data fetcher for the two-patient OPD/IPD fixture.
 *
 * Purpose:
 *   - Pick two DISTINCT clean patients from the same hospital (one OPD, one IPD).
 *   - Resolve the staff/master/setup records needed to build a realistic seed.
 *   - Validate that selected lab/radiology masters have structured report templates.
 *   - Validate that an available normal IPD bed and stocked hospital medicine exist.
 *   - Never writes to MongoDB. The only optional write is a local JSON snapshot file.
 *
 * Default usage:
 *   node scripts/fetch-two-patient-seed-master-data.js
 *
 * Optional targeting:
 *   node scripts/fetch-two-patient-seed-master-data.js --hospital-code CF5045
 *   node scripts/fetch-two-patient-seed-master-data.js --hospital-id <mongo-object-id>
 *   node scripts/fetch-two-patient-seed-master-data.js --hospital-name "Vrinda"
 *
 * Output control:
 *   --output <path>                    default: seed-master-data.json
 *   --no-output                        print only; do not write JSON
 *   --allow-existing-patient-history   allow patients that already have operational history
 *   --min-medicine-stock <n>           default: 10 base units
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { matchTemplateDetailed } = require('../services/radiologyReportTemplate.service');
const {
  catalogVersion: labCatalogVersion,
  getTemplate: getLabTemplate,
  matchTemplate: matchLabTemplate
} = require('../services/labReportTemplate.service');

const { ObjectId } = mongoose.Types;
const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function hasFlag(name) {
  return args.includes(name);
}

const TARGET_HOSPITAL_ID = argValue('--hospital-id');
const TARGET_HOSPITAL_CODE = argValue('--hospital-code');
const TARGET_HOSPITAL_NAME = argValue('--hospital-name');
const ALLOW_EXISTING_HISTORY = hasFlag('--allow-existing-patient-history');
const NO_OUTPUT = hasFlag('--no-output');
const OUTPUT_PATH = path.resolve(process.cwd(), argValue('--output') || 'seed-master-data.json');
const MIN_MEDICINE_STOCK = Math.max(5, Number(argValue('--min-medicine-stock') || 10));

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) {
  console.error('Missing MONGO_URI / MONGODB_URI / MONGO_URL in .env');
  process.exit(1);
}

function idString(value) {
  if (!value) return null;
  return String(value);
}

function fullName(doc) {
  if (!doc) return '';
  if (doc.name) return String(doc.name).trim();
  return [doc.firstName || doc.first_name, doc.middleName || doc.middle_name, doc.lastName || doc.last_name]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCode(value) {
  return String(value || '').trim();
}

function looksLikePlaceholderMaster(doc) {
  const text = [doc?.code, doc?.name, doc?.description].filter(Boolean).join(' ').toLowerCase();
  if (!String(doc?.name || '').trim() || String(doc?.name || '').trim().length < 3) return true;
  const code = String(doc?.code || '').trim();
  const name = String(doc?.name || '').trim();
  return /(^|[^a-z])(dummy|sample|placeholder|seed|fixture|test data|testing|postman|reuse94|qa|e2e)([^a-z]|$)/i.test(text)
    || /(^|[-_ ])src([-_ ]|$)/i.test(code)
    || /^(r94|pmqa|qa|e2e)[-_]/i.test(code)
    || /^(df|abc|xyz|test|demo)$/i.test(name)
    || /\bprocedure\s+\d{6,}\b/i.test(name);
}

async function collectionNames(db) {
  const rows = await db.listCollections({}, { nameOnly: true }).toArray();
  return new Set(rows.map((row) => row.name));
}

async function findUserForPerson(db, person, roles, hospitalId) {
  const identityFilters = [];
  if (person?.user_id) identityFilters.push({ _id: person.user_id });
  if (person?.userId) identityFilters.push({ _id: person.userId });
  if (person?.email) identityFilters.push({ email: String(person.email).trim().toLowerCase() });

  const scope = {
    hospital_id: hospitalId,
    is_active: { $ne: false },
    ...(roles?.length ? { role: { $in: roles } } : {})
  };

  if (identityFilters.length) {
    const linked = await db.collection('users').findOne({
      $and: [scope, { $or: identityFilters }]
    });
    if (linked) return linked;
  }
  return null;
}

async function selectDoctors(db, hospitalId) {
  const doctors = await db.collection('doctors').find({
    hospitalId,
    is_active: { $ne: false },
    deleted_at: null
  }).sort({ opdConsultationFee: -1, firstName: 1, lastName: 1 }).limit(100).toArray();

  const usable = [];
  for (const doctor of doctors) {
    // eslint-disable-next-line no-await-in-loop
    const user = await findUserForPerson(db, doctor, ['doctor'], hospitalId);
    if (!user) continue;
    usable.push({ doctor, user });
  }

  if (!usable.length) {
    throw new Error('No active doctor with a linked active doctor user account in this hospital.');
  }

  const opd = usable.find(({ doctor }) => doctor.department && Number(doctor.opdConsultationFee || 0) > 0)
    || usable.find(({ doctor }) => doctor.department)
    || usable[0];

  const ipd = usable.find(({ doctor }) => String(doctor._id) !== String(opd.doctor._id) && doctor.department)
    || opd;

  return { opd, ipd, usableCount: usable.length };
}

async function selectUsersAndStaff(db, hospitalId, selectedLabTestId = null) {
  const financeUser = await db.collection('users').findOne({
    hospital_id: hospitalId,
    role: { $in: ['accountant', 'admin', 'registrar', 'receptionist'] },
    is_active: { $ne: false }
  });
  if (!financeUser) throw new Error('No active hospital-scoped finance/admin/registrar/receptionist user.');

  const pharmacyUser = await db.collection('users').findOne({
    hospital_id: hospitalId,
    role: 'pharmacy',
    is_active: { $ne: false }
  }) || financeUser;

  const nurseUser = await db.collection('users').findOne({
    hospital_id: hospitalId,
    role: 'nurse',
    is_active: { $ne: false }
  });
  if (!nurseUser) throw new Error('No active hospital-scoped nurse user.');

  const nurse = await db.collection('nurses').findOne({
    hospitalId,
    email: String(nurseUser.email || '').trim().toLowerCase(),
    deleted_at: null
  }) || await db.collection('nurses').findOne({ hospitalId, deleted_at: null });
  if (!nurse) throw new Error('No nurse profile for the selected hospital.');

  const pathologyUsers = await db.collection('users').find({
    hospital_id: hospitalId,
    role: 'pathology_staff',
    is_active: { $ne: false }
  }).toArray();

  // PathologyStaff is the active hospital-scoped lab personnel model in this repo.
  // The older LabStaff model still exists for legacy references inside LabRequest,
  // but pathology users/profile management is backed by `pathologystaffs`.
  let labTechnicianProfile = null;
  let pathologistProfile = null;
  let pathologyUser = null;
  for (const user of pathologyUsers) {
    // eslint-disable-next-line no-await-in-loop
    const profile = await db.collection('pathologystaffs').findOne({
      hospitalId,
      status: 'Active',
      deleted_at: null,
      $or: [
        { user_id: user._id },
        { email: String(user.email || '').trim().toLowerCase() }
      ]
    });
    if (!profile) continue;

    if (!pathologyUser) pathologyUser = user;

    const canPerformSelectedTest = !selectedLabTestId
      || (profile.assigned_lab_tests || []).some((row) =>
        String(row?.lab_test_id || '') === String(selectedLabTestId) && row?.can_perform !== false
      )
      || (profile.accessible_test_ids || []).some((id) => String(id) === String(selectedLabTestId));

    if (!labTechnicianProfile
      && ['lab_technician', 'lab_assistant', 'lab_scientist', 'lab_manager'].includes(String(profile.role || '').toLowerCase())
      && canPerformSelectedTest) {
      labTechnicianProfile = profile;
    }

    if (!pathologistProfile && String(profile.role || '').toLowerCase() === 'pathologist') {
      pathologistProfile = profile;
    }
  }

  // If the first pathology user is not the technician selected above, use the
  // technician-linked user for sample/result audit fields where possible.
  if (labTechnicianProfile?.user_id) {
    const linked = pathologyUsers.find((user) => String(user._id) === String(labTechnicianProfile.user_id));
    if (linked) pathologyUser = linked;
  }
  pathologyUser = pathologyUser || financeUser;

  const radiologyUser = await db.collection('users').findOne({
    hospital_id: hospitalId,
    role: 'radiology_staff',
    is_active: { $ne: false }
  }) || financeUser;

  const radiologistProfile = await db.collection('radiologystaffs').findOne({
    hospitalId,
    designation: 'Radiologist',
    is_active: { $ne: false },
    deleted_at: null
  });
  const radiologyTechnicianProfile = await db.collection('radiologystaffs').findOne({
    hospitalId,
    designation: { $in: ['X-Ray Technician', 'Radiology Technician'] },
    is_active: { $ne: false },
    deleted_at: null
  });
  const fallbackRadiologyProfile = radiologistProfile
    || radiologyTechnicianProfile
    || await db.collection('radiologystaffs').findOne({ hospitalId, is_active: { $ne: false }, deleted_at: null });

  return {
    financeUser,
    pharmacyUser,
    nurseUser,
    nurse,
    pathologyUser,
    labTechnicianProfile,
    pathologistProfile,
    radiologyUser,
    radiologistProfile: radiologistProfile || fallbackRadiologyProfile,
    radiologyTechnicianProfile
  };
}

async function selectClinicalMaster(db, collection, baseFilter, label, {
  minPrice,
  preferredMaxPrice,
  preferredPatterns = [],
  excludedPatterns = [],
  templateResolver = null,
  requirePreferredMatch = false
}) {
  const candidates = await db.collection(collection).find({
    ...baseFilter,
    base_price: { $gte: minPrice },
    deleted_at: null
  }).sort({ usage_count: -1, base_price: 1, name: 1 }).limit(1000).toArray();

  const searchable = (doc) => [doc?.code, doc?.name, doc?.category, doc?.subcategory, doc?.description]
    .filter(Boolean).join(' ').toLowerCase();

  const clean = candidates.filter((doc) => {
    if (looksLikePlaceholderMaster(doc)) return false;
    const text = searchable(doc);
    return !excludedPatterns.some((pattern) => pattern.test(text));
  });

  const withTemplates = [];
  for (const doc of clean) {
    const template = templateResolver ? templateResolver(doc) : null;
    if (templateResolver && !template) continue;
    withTemplates.push({ doc, template });
  }

  let pool = templateResolver ? withTemplates : clean.map((doc) => ({ doc, template: null }));
  if (requirePreferredMatch && preferredPatterns.length) {
    pool = pool.filter(({ doc }) => {
      const text = searchable(doc);
      return preferredPatterns.some((pattern) => pattern.test(text));
    });
  }
  if (!pool.length) {
    const examples = clean.slice(0, 12).map((doc) =>
      `${doc.code || '-'} | ${doc.name || '-'} | ${doc.category || '-'} | ₹${Number(doc.base_price || 0)}`
    );
    const detail = examples.length
      ? `\nClosest clean candidates (not accepted for this fixture):\n  - ${examples.join('\n  - ')}`
      : '';
    const setupHint = label === 'procedure'
      ? `\nRun the master setup first: node scripts/ensure-two-patient-fixture-master-data.js --hospital-code ${TARGET_HOSPITAL_CODE || '<HOSPITAL_CODE>'} --expected-db-name ${mongoose.connection.name}`
      : '';
    throw new Error(`No suitable ${label}: active, billable, non-placeholder, price >= ${minPrice}${templateResolver ? ', with a structured report template' : ''}.${detail}${setupHint}`);
  }

  const preferredRank = ({ doc }) => {
    const text = searchable(doc);
    const index = preferredPatterns.findIndex((pattern) => pattern.test(text));
    return index < 0 ? preferredPatterns.length + 1 : index;
  };

  pool.sort((a, b) => {
    const preference = preferredRank(a) - preferredRank(b);
    if (preference) return preference;
    const aBand = Number(a.doc.base_price || 0) <= preferredMaxPrice ? 0 : 1;
    const bBand = Number(b.doc.base_price || 0) <= preferredMaxPrice ? 0 : 1;
    if (aBand !== bBand) return aBand - bBand;
    const usage = Number(b.doc.usage_count || 0) - Number(a.doc.usage_count || 0);
    if (usage) return usage;
    const price = Number(a.doc.base_price || 0) - Number(b.doc.base_price || 0);
    if (price) return price;
    return String(a.doc.name || '').localeCompare(String(b.doc.name || ''));
  });

  return pool[0];
}

async function selectClinicalMasters(db, hospitalId) {
  const lab = await selectClinicalMaster(
    db,
    'labtests',
    { hospitalId, is_active: { $ne: false }, is_billable: { $ne: false } },
    'lab test',
    {
      minPrice: 50,
      preferredMaxPrice: 3000,
      preferredPatterns: [/complete blood count|\bcbc\b|ha?emogram/i],
      templateResolver: (doc) => getLabTemplate(doc.report_template_id)
        || matchLabTemplate(doc.name, doc.code, doc.report_template_id || '')
    }
  );

  const imaging = await selectClinicalMaster(
    db,
    'imagingtests',
    { hospitalId, is_active: { $ne: false }, is_billable: { $ne: false }, template_only: { $ne: true } },
    'imaging test',
    {
      minPrice: 100,
      preferredMaxPrice: 10000,
      preferredPatterns: [/chest.*x[- ]?ray|x[- ]?ray.*chest|chest radiograph/i, /x[- ]?ray|radiograph/i],
      templateResolver: (doc) => matchTemplateDetailed(doc.name, doc.code, doc.report_template_id || '')?.template || null
    }
  );

  const procedure = await selectClinicalMaster(
    db,
    'procedures',
    { hospitalId, is_active: { $ne: false }, is_billable: { $ne: false } },
    'procedure',
    {
      minPrice: 100,
      preferredMaxPrice: 25000,
      preferredPatterns: [/nebul/i, /intravenous|\biv\b.*infusion|infusion/i, /injection/i, /dressing/i, /cannula|iv access|venous access/i, /oxygen|suction/i],
      // For this fixture, the procedure must actually match the medical scenario.
      // Do not silently substitute an arbitrary surgery/QA master merely because it is billable.
      requirePreferredMatch: true,
      excludedPatterns: [/\bd\d{4}\b|dental|dentist|tooth|teeth|oral evaluation|oral exam|restorative|composite|amalgam|root canal|endodont|orthodont|periodont|prosthodont|crown|dental implant|tooth extraction|cataract|cesarean|hysterectomy|angioplasty|dialysis|endoscopy|bronchoscopy|biopsy/i]
    }
  );

  return { lab, imaging, procedure };
}

async function patientHistory(db, existingCollections, patientId) {
  const probes = [
    ['appointments', { patient_id: patientId }],
    ['vitals', { $or: [{ patient_id: patientId }, { patientId }] }],
    ['prescriptions', { patient_id: patientId }],
    ['labrequests', { patientId }],
    ['labreports', { patientId }],
    ['radiologyrequests', { patientId }],
    ['procedurerequests', { patientId }],
    ['sales', { patient_id: patientId }],
    ['bills', { patient_id: patientId }],
    ['invoices', { patient_id: patientId }],
    ['financialtransactions', { patientId }],
    ['deskcheckouts', { patientId }],
    ['ipdadmissions', { patientId }],
    ['ipdaccommodationsegments', { patientId }],
    ['ipdrounds', { patientId }],
    ['ipdvitals', { patientId }],
    ['ipdinitialassessments', { patientId }],
    ['ipdnursingadmissionassessments', { patientId }],
    ['nursingnotes', { patientId }],
    ['ipdmedicationcharts', { patientId }],
    ['ipdpatientmedicinestocks', { patientId }],
    ['ipdcharges', { patientId }],
    ['patientadvanceledgers', { patientId }],
    ['dischargesummaries', { patientId }]
  ];

  const counts = {};
  let total = 0;
  for (const [collection, filter] of probes) {
    if (!existingCollections.has(collection)) continue;
    // eslint-disable-next-line no-await-in-loop
    const count = await db.collection(collection).countDocuments(filter, { limit: 1 });
    if (count) {
      counts[collection] = count;
      total += count;
    }
  }
  return { total, counts };
}

async function selectTwoPatients(db, existingCollections, hospitalId) {
  const candidates = await db.collection('patients').find({
    hospitalId,
    deleted_at: null,
    is_walkin: { $ne: true }
  }).sort({ created_at: 1, createdAt: 1, _id: 1 }).limit(300).toArray();

  if (candidates.length < 2) throw new Error('Fewer than two normal patient master records exist for this hospital.');

  const clean = [];
  const dirty = [];
  for (const patient of candidates) {
    const activeAdmissions = Array.isArray(patient.active_admissions) ? patient.active_admissions.length : 0;
    // eslint-disable-next-line no-await-in-loop
    const history = await patientHistory(db, existingCollections, patient._id);
    const summary = { patient, history, activeAdmissions };
    if (!activeAdmissions && history.total === 0) clean.push(summary);
    else dirty.push(summary);
    if (clean.length >= 2 && !ALLOW_EXISTING_HISTORY) break;
  }

  const selected = clean.length >= 2
    ? clean.slice(0, 2)
    : (ALLOW_EXISTING_HISTORY ? [...clean, ...dirty].slice(0, 2) : []);

  if (selected.length < 2) {
    const dirtySummary = dirty.slice(0, 5).map(({ patient, history, activeAdmissions }) =>
      `${fullName(patient)}(${idString(patient._id)}): history=${history.total}, activeAdmissions=${activeAdmissions}`
    ).join('; ');
    throw new Error(`Could not find two clean patients. Run the operational reset first.${dirtySummary ? ` Examples: ${dirtySummary}` : ''}`);
  }

  return {
    opd: selected[0],
    ipd: selected[1],
    totalPatientMasters: candidates.length,
    cleanPatientsFound: clean.length
  };
}

async function selectNormalIpdBed(db, hospitalId, ipdPatient) {
  const gender = String(ipdPatient?.gender || '').toLowerCase();
  const beds = await db.collection('beds').find({
    hospitalId,
    status: 'Available',
    isActive: { $ne: false },
    deleted_at: null,
    wardId: { $exists: true, $ne: null },
    bedType: { $in: ['General', 'Semi Private', 'Private', 'Deluxe'] }
  }).sort({ dailyCharge: -1, bedNumber: 1 }).limit(500).toArray();

  for (const bed of beds) {
    if (bed.genderPolicy && bed.genderPolicy !== 'any' && gender && bed.genderPolicy !== gender) continue;
    // eslint-disable-next-line no-await-in-loop
    const room = await db.collection('rooms').findOne({
      _id: bed.roomId,
      hospitalId,
      deleted_at: null,
      status: { $in: ['Available', 'Partially Occupied'] },
      type: { $nin: ['Operation Theater', 'Operation Theatre', 'OT', 'Emergency', 'Day Care'] },
      $or: [
        { operationalStatus: 'open' },
        { operationalStatus: { $exists: false } },
        { operationalStatus: null }
      ]
    });
    if (!room) continue;
    // eslint-disable-next-line no-await-in-loop
    const ward = await db.collection('wards').findOne({
      _id: bed.wardId,
      hospitalId,
      deleted_at: null,
      isActive: { $ne: false },
      type: { $nin: ['Emergency'] }
    });
    if (ward) return { bed, room, ward };
  }

  throw new Error('No available normal IPD bed/room/ward combination compatible with the selected IPD patient.');
}

async function selectPharmacy(db, hospitalId) {
  const scoped = await db.collection('pharmacies').findOne({
    hospitalId,
    status: { $ne: 'Inactive' },
    deleted_at: null
  });
  if (scoped) return { pharmacy: scoped, legacyUnscoped: false };

  const legacy = await db.collection('pharmacies').find({
    $or: [{ hospitalId: null }, { hospitalId: { $exists: false } }],
    status: { $ne: 'Inactive' },
    deleted_at: null
  }).limit(2).toArray();

  if (legacy.length === 1) return { pharmacy: legacy[0], legacyUnscoped: true };
  throw new Error('No active hospital-scoped pharmacy (and no unique legacy unscoped pharmacy fallback).');
}

async function selectStockedMedicine(db, hospitalId) {
  const medicines = await db.collection('medicines').find({
    hospitalId,
    is_active: { $ne: false },
    deleted_at: null
  }, { projection: { _id: 1, name: 1, generic_name: 1, brand: 1, units_per_pack: 1, hsn_code: 1, gst_rate: 1, is_active: 1 } })
    .sort({ name: 1 })
    .limit(5000)
    .toArray();

  if (!medicines.length) throw new Error('No active hospital-scoped medicine master records.');
  const byId = new Map(medicines.map((medicine) => [String(medicine._id), medicine]));
  const now = new Date();

  const batches = await db.collection('medicinebatches').find({
    medicine_id: { $in: medicines.map((medicine) => medicine._id) },
    is_active: { $ne: false },
    quantity_base_units: { $gte: MIN_MEDICINE_STOCK },
    expiry_date: { $gt: now }
  }).sort({ expiry_date: 1, quantity_base_units: -1 }).limit(200).toArray();

  const batch = batches.find((candidate) => {
    const price = Number(candidate.selling_price_per_base_unit
      ?? (candidate.selling_price_per_pack && candidate.units_per_pack
        ? candidate.selling_price_per_pack / candidate.units_per_pack
        : candidate.selling_price));
    return Number.isFinite(price) && price > 0 && byId.has(String(candidate.medicine_id));
  });

  if (!batch) {
    throw new Error(`No active, unexpired hospital medicine batch with >= ${MIN_MEDICINE_STOCK} base units and a positive selling price.`);
  }
  return { medicine: byId.get(String(batch.medicine_id)), batch };
}

async function fetchOptionalSetup(db, hospitalId, pharmacyId) {
  const now = new Date();
  const [
    hospitalCharges,
    billingServices,
    selfPayer,
    payerCount,
    activeRateCards,
    admissionPolicy,
    financeFlags,
    pharmacySetting
  ] = await Promise.all([
    db.collection('hospitalcharges').findOne({ hospital: hospitalId, deleted_at: null }, { sort: { effectiveFrom: -1, createdAt: -1 } }),
    db.collection('billingservicemasters').find({
      hospitalId,
      active: { $ne: false },
      effectiveFrom: { $lte: now },
      $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: now } }]
    }).sort({ category: 1, serviceType: 1, chargeName: 1 }).limit(100).toArray(),
    db.collection('payers').findOne({
      hospitalId,
      isActive: { $ne: false },
      $or: [
        { code: { $regex: /SELF|CASH/i } },
        { name: { $regex: /SELF|CASH/i } },
        { type: 'self' }
      ]
    }),
    db.collection('payers').countDocuments({ hospitalId, isActive: { $ne: false } }),
    db.collection('ratecards').find({ hospitalId, status: 'active' }).sort({ effectiveFrom: -1 }).limit(20).toArray(),
    db.collection('admissionworkflowpolicies').findOne({
      hospitalId,
      active: { $ne: false },
      effectiveFrom: { $lte: now },
      $or: [{ effectiveTo: null }, { effectiveTo: { $exists: false } }, { effectiveTo: { $gte: now } }]
    }, { sort: { version: -1, effectiveFrom: -1 } }),
    db.collection('financefeatureflags').find({ hospitalId }).sort({ key: 1 }).toArray(),
    db.collection('hospitalpharmacysettings').findOne({ hospitalId, pharmacyId })
      .then((setting) => setting || db.collection('hospitalpharmacysettings').findOne({ hospitalId }))
  ]);

  return {
    hospitalCharges,
    billingServices,
    selfPayer,
    payerCount,
    activeRateCards,
    admissionPolicy,
    financeFlags,
    pharmacySetting
  };
}

function patientSummary(selection) {
  const patient = selection.patient;
  return {
    id: idString(patient._id),
    uhid: patient.uhid || patient.patientId || null,
    patientId: patient.patientId || patient.uhid || null,
    name: fullName(patient),
    gender: patient.gender || null,
    dob: patient.dob || null,
    existingOperationalHistory: selection.history,
    activeAdmissions: selection.activeAdmissions
  };
}

function userSummary(user) {
  if (!user) return null;
  return {
    id: idString(user._id),
    name: user.name || null,
    role: user.role || null
  };
}

function staffSummary(profile) {
  if (!profile) return null;
  return {
    id: idString(profile._id),
    userId: idString(profile.userId || profile.user_id),
    name: fullName(profile) || profile.name || null,
    role: profile.role || null,
    designation: profile.designation || null,
    employeeId: profile.employeeId || profile.staffId || null
  };
}

function doctorSummary(pair) {
  if (!pair) return null;
  const { doctor, user } = pair;
  return {
    doctorId: idString(doctor._id),
    doctorCode: doctor.doctorId || null,
    name: fullName(doctor),
    departmentId: idString(doctor.department),
    specialization: doctor.specialization || null,
    opdConsultationFee: Number(doctor.opdConsultationFee || 0),
    user: userSummary(user)
  };
}

function clinicalMasterSummary(selected, kind) {
  const doc = selected.doc;
  const result = {
    id: idString(doc._id),
    code: doc.code || null,
    name: doc.name || null,
    category: doc.category || null,
    price: Number(doc.base_price || 0),
    reportTemplateId: doc.report_template_id || null,
    reportTemplateName: doc.report_template_name || null
  };
  if (selected.template) {
    result.resolvedTemplate = {
      id: selected.template.id || doc.report_template_id || null,
      name: selected.template.name || doc.report_template_name || null,
      version: kind === 'lab' ? labCatalogVersion : (selected.template.version || null),
      observationCount: kind === 'lab' ? (selected.template.observations || []).length : undefined,
      sectionCount: kind === 'imaging' ? (selected.template.sections || []).length : undefined
    };
  }
  return result;
}

function billingServiceSummary(service) {
  return {
    id: idString(service._id),
    code: service.chargeCode || null,
    name: service.chargeName || null,
    category: service.category || null,
    serviceType: service.serviceType || null,
    price: Number(service.price || 0),
    taxRate: Number(service.taxRate || 0),
    departmentId: idString(service.departmentId)
  };
}

function relevantBillingServices(rows) {
  const re = /admission|registration|consult|nurs|rmo|duty doctor|bed|room|procedure|lab|radiology|pharmacy/i;
  const relevant = rows.filter((row) => re.test(`${row.chargeCode || ''} ${row.chargeName || ''} ${row.category || ''} ${row.serviceType || ''}`));
  return (relevant.length ? relevant : rows).slice(0, 30).map(billingServiceSummary);
}

async function buildSnapshot(db, existingCollections, hospital) {
  const hospitalId = hospital._id;
  const patients = await selectTwoPatients(db, existingCollections, hospitalId);
  const doctors = await selectDoctors(db, hospitalId);
  const clinical = await selectClinicalMasters(db, hospitalId);
  const staff = await selectUsersAndStaff(db, hospitalId, clinical.lab.doc._id);
  const bedSelection = await selectNormalIpdBed(db, hospitalId, patients.ipd.patient);
  const pharmacySelection = await selectPharmacy(db, hospitalId);
  const stocked = await selectStockedMedicine(db, hospitalId);
  const setup = await fetchOptionalSetup(db, hospitalId, pharmacySelection.pharmacy._id);

  const departmentIds = [...new Set([
    idString(doctors.opd.doctor.department),
    idString(doctors.ipd.doctor.department),
    idString(staff.nurse.department_id),
    idString(bedSelection.ward.departmentId)
  ].filter(Boolean))].map((id) => new ObjectId(id));

  const departments = departmentIds.length
    ? await db.collection('departments').find({ _id: { $in: departmentIds }, hospitalId, deleted_at: null }).toArray()
    : [];

  const allCounts = await Promise.all([
    db.collection('patients').countDocuments({ hospitalId, deleted_at: null, is_walkin: { $ne: true } }),
    db.collection('doctors').countDocuments({ hospitalId, is_active: { $ne: false }, deleted_at: null }),
    db.collection('labtests').countDocuments({ hospitalId, is_active: { $ne: false }, is_billable: { $ne: false }, deleted_at: null }),
    db.collection('imagingtests').countDocuments({ hospitalId, is_active: { $ne: false }, is_billable: { $ne: false }, template_only: { $ne: true }, deleted_at: null }),
    db.collection('procedures').countDocuments({ hospitalId, is_active: { $ne: false }, is_billable: { $ne: false }, deleted_at: null }),
    db.collection('beds').countDocuments({ hospitalId, status: 'Available', isActive: { $ne: false }, deleted_at: null })
  ]);

  return {
    generatedAt: new Date().toISOString(),
    database: db.databaseName,
    readOnly: true,
    hospital: {
      id: idString(hospital._id),
      hospitalID: hospital.hospitalID || null,
      tenantCode: hospital.tenantCode || null,
      name: hospital.hospitalName || hospital.name || null,
      timezone: hospital.timezone || 'Asia/Kolkata',
      opdWorkflowMode: hospital.opdWorkflowMode || 'HYBRID',
      vitalsEnabled: hospital.vitalsEnabled !== false,
      vitalsController: hospital.vitalsController || 'nurse'
    },
    selectedPatients: {
      opd: patientSummary(patients.opd),
      ipd: patientSummary(patients.ipd)
    },
    staff: {
      opdDoctor: doctorSummary(doctors.opd),
      ipdDoctor: doctorSummary(doctors.ipd),
      usableDoctorCount: doctors.usableCount,
      financeUser: userSummary(staff.financeUser),
      pharmacyUser: userSummary(staff.pharmacyUser),
      nurseUser: userSummary(staff.nurseUser),
      nurseProfile: staffSummary(staff.nurse),
      pathologyUser: userSummary(staff.pathologyUser),
      labTechnicianProfile: staffSummary(staff.labTechnicianProfile),
      pathologistProfile: staffSummary(staff.pathologistProfile),
      radiologyUser: userSummary(staff.radiologyUser),
      radiologistProfile: staffSummary(staff.radiologistProfile),
      radiologyTechnicianProfile: staffSummary(staff.radiologyTechnicianProfile)
    },
    departments: departments.map((department) => ({
      id: idString(department._id),
      code: department.code || null,
      name: department.name || null,
      departmentType: department.departmentType || null
    })),
    clinicalMasters: {
      labTest: clinicalMasterSummary(clinical.lab, 'lab'),
      imagingTest: clinicalMasterSummary(clinical.imaging, 'imaging'),
      procedure: clinicalMasterSummary(clinical.procedure, 'procedure')
    },
    ipdFacility: {
      ward: {
        id: idString(bedSelection.ward._id),
        code: bedSelection.ward.code || null,
        name: bedSelection.ward.name || null,
        type: bedSelection.ward.type || null,
        departmentId: idString(bedSelection.ward.departmentId)
      },
      room: {
        id: idString(bedSelection.room._id),
        roomNumber: bedSelection.room.room_number || null,
        type: bedSelection.room.type || null,
        status: bedSelection.room.status || null,
        operationalStatus: bedSelection.room.operationalStatus || 'open'
      },
      bed: {
        id: idString(bedSelection.bed._id),
        bedNumber: bedSelection.bed.bedNumber || null,
        bedCode: bedSelection.bed.bedCode || null,
        bedType: bedSelection.bed.bedType || null,
        status: bedSelection.bed.status || null,
        genderPolicy: bedSelection.bed.genderPolicy || 'any',
        dailyCharge: Number(bedSelection.bed.dailyCharge || 0)
      }
    },
    pharmacy: {
      master: {
        id: idString(pharmacySelection.pharmacy._id),
        name: pharmacySelection.pharmacy.name || null,
        status: pharmacySelection.pharmacy.status || null,
        legacyUnscoped: pharmacySelection.legacyUnscoped
      },
      medicine: {
        id: idString(stocked.medicine._id),
        name: stocked.medicine.name || null,
        genericName: stocked.medicine.generic_name || null,
        brand: stocked.medicine.brand || null,
        hsnCode: stocked.medicine.hsn_code || null,
        gstRate: Number(stocked.medicine.gst_rate || 0),
        unitsPerPack: Number(stocked.medicine.units_per_pack || stocked.batch.units_per_pack || 1)
      },
      batch: {
        id: idString(stocked.batch._id),
        batchNumber: stocked.batch.batch_number || null,
        expiryDate: stocked.batch.expiry_date || null,
        quantityBaseUnits: Number(stocked.batch.quantity_base_units || 0),
        unitsPerPack: Number(stocked.batch.units_per_pack || 1),
        sellingPricePerBaseUnit: Number(
          stocked.batch.selling_price_per_base_unit
          ?? ((stocked.batch.selling_price_per_pack || stocked.batch.selling_price || 0) / (stocked.batch.units_per_pack || 1))
        )
      },
      setting: setup.pharmacySetting ? {
        id: idString(setup.pharmacySetting._id),
        ipdPharmacyBillingOwner: setup.pharmacySetting.ipdPharmacyBillingOwner || 'PHARMACY',
        ipdAdvanceMode: setup.pharmacySetting.ipdAdvanceMode || 'HYBRID',
        defaultIpdBillingMode: setup.pharmacySetting.defaultIpdBillingMode || 'DEDUCT_FROM_ADVANCE',
        allowNegativeIpdPharmacyBalance: Boolean(setup.pharmacySetting.allowNegativeIpdPharmacyBalance)
      } : null
    },
    billingAndFinanceMasters: {
      hospitalCharges: setup.hospitalCharges ? {
        id: idString(setup.hospitalCharges._id),
        opdCharges: setup.hospitalCharges.opdCharges || null,
        ipdCharges: setup.hospitalCharges.ipdCharges || null,
        effectiveFrom: setup.hospitalCharges.effectiveFrom || null
      } : null,
      relevantBillingServices: relevantBillingServices(setup.billingServices),
      activePayerCount: setup.payerCount,
      selfOrCashPayer: setup.selfPayer ? {
        id: idString(setup.selfPayer._id),
        code: setup.selfPayer.code || null,
        name: setup.selfPayer.name || null,
        type: setup.selfPayer.type || null
      } : null,
      activeRateCards: setup.activeRateCards.map((card) => ({
        id: idString(card._id),
        payerId: idString(card.payerId),
        name: card.name || null,
        version: card.version || null,
        effectiveFrom: card.effectiveFrom || null
      })),
      admissionWorkflowPolicy: setup.admissionPolicy ? {
        id: idString(setup.admissionPolicy._id),
        admissionType: setup.admissionPolicy.admissionType || null,
        version: setup.admissionPolicy.version || null,
        requiredDocuments: setup.admissionPolicy.requiredDocuments || [],
        requiredSteps: setup.admissionPolicy.requiredSteps || []
      } : null,
      financeFeatureFlags: setup.financeFlags.map((flag) => ({ key: flag.key, enabled: Boolean(flag.enabled) }))
    },
    readiness: {
      normalPatientMasters: allCounts[0],
      cleanPatientsObserved: patients.cleanPatientsFound,
      activeDoctors: allCounts[1],
      billableLabTests: allCounts[2],
      billableImagingTests: allCounts[3],
      billableProcedures: allCounts[4],
      availableBeds: allCounts[5],
      minMedicineStockRequired: MIN_MEDICINE_STOCK,
      readyForMainSeed: true,
      notes: [
        pharmacySelection.legacyUnscoped ? 'Using the single legacy unscoped pharmacy master.' : null,
        staff.labTechnicianProfile ? null : 'No active PathologyStaff technician profile assigned to the selected lab test; main seed will use pathology user identity for user-level audit fields.',
        staff.pathologistProfile ? null : 'No active PathologyStaff profile with role=pathologist; main seed will keep the real pathology user as report actor and avoid inventing a pathologist profile.',
        staff.radiologistProfile ? null : 'No radiologist staff profile; main seed may use radiology user identity for report audit fields.',
        setup.hospitalCharges ? null : 'No HospitalCharges master found; main seed should use doctor/bed/service master prices with explicit fixture fallbacks.',
        setup.pharmacySetting ? null : 'No HospitalPharmacySetting found; application defaults must be used.'
      ].filter(Boolean)
    }
  };
}

function hospitalMatchesTarget(hospital) {
  if (TARGET_HOSPITAL_ID && String(hospital._id) !== TARGET_HOSPITAL_ID) return false;
  if (TARGET_HOSPITAL_CODE) {
    const target = TARGET_HOSPITAL_CODE.trim().toUpperCase();
    if (![hospital.hospitalID, hospital.tenantCode].filter(Boolean).map((v) => String(v).toUpperCase()).includes(target)) return false;
  }
  if (TARGET_HOSPITAL_NAME) {
    const target = TARGET_HOSPITAL_NAME.trim().toLowerCase();
    const name = String(hospital.hospitalName || hospital.name || '').toLowerCase();
    if (!name.includes(target)) return false;
  }
  return true;
}

function printSnapshot(snapshot) {
  console.log('\n=== SELECTED HOSPITAL ===');
  console.log(`${snapshot.hospital.name} | ${snapshot.hospital.hospitalID || snapshot.hospital.tenantCode || '-'} | ${snapshot.hospital.id}`);

  console.log('\n=== PATIENTS ===');
  console.log(`OPD: ${snapshot.selectedPatients.opd.name} | ${snapshot.selectedPatients.opd.uhid || '-'} | ${snapshot.selectedPatients.opd.id}`);
  console.log(`IPD: ${snapshot.selectedPatients.ipd.name} | ${snapshot.selectedPatients.ipd.uhid || '-'} | ${snapshot.selectedPatients.ipd.id}`);

  console.log('\n=== STAFF ===');
  console.log(`OPD doctor: ${snapshot.staff.opdDoctor.name} | doctor=${snapshot.staff.opdDoctor.doctorId} | user=${snapshot.staff.opdDoctor.user?.id || '-'}`);
  console.log(`IPD doctor: ${snapshot.staff.ipdDoctor.name} | doctor=${snapshot.staff.ipdDoctor.doctorId} | user=${snapshot.staff.ipdDoctor.user?.id || '-'}`);
  console.log(`Finance: ${snapshot.staff.financeUser?.name || '-'} (${snapshot.staff.financeUser?.role || '-'}) | ${snapshot.staff.financeUser?.id || '-'}`);
  console.log(`Pharmacy: ${snapshot.staff.pharmacyUser?.name || '-'} (${snapshot.staff.pharmacyUser?.role || '-'}) | ${snapshot.staff.pharmacyUser?.id || '-'}`);
  console.log(`Nurse: ${snapshot.staff.nurseProfile?.name || snapshot.staff.nurseUser?.name || '-'} | ${snapshot.staff.nurseProfile?.id || '-'}`);

  console.log('\n=== CLINICAL MASTERS ===');
  console.log(`Lab: ${snapshot.clinicalMasters.labTest.code || '-'} ${snapshot.clinicalMasters.labTest.name} | ₹${snapshot.clinicalMasters.labTest.price} | template=${snapshot.clinicalMasters.labTest.resolvedTemplate?.id || '-'}`);
  console.log(`Imaging: ${snapshot.clinicalMasters.imagingTest.code || '-'} ${snapshot.clinicalMasters.imagingTest.name} | ₹${snapshot.clinicalMasters.imagingTest.price} | template=${snapshot.clinicalMasters.imagingTest.resolvedTemplate?.id || '-'}`);
  console.log(`Procedure: ${snapshot.clinicalMasters.procedure.code || '-'} ${snapshot.clinicalMasters.procedure.name} | ₹${snapshot.clinicalMasters.procedure.price}`);

  console.log('\n=== IPD FACILITY ===');
  console.log(`Ward: ${snapshot.ipdFacility.ward.name} (${snapshot.ipdFacility.ward.type || '-'}) | ${snapshot.ipdFacility.ward.id}`);
  console.log(`Room: ${snapshot.ipdFacility.room.roomNumber} (${snapshot.ipdFacility.room.type || '-'}) | ${snapshot.ipdFacility.room.id}`);
  console.log(`Bed: ${snapshot.ipdFacility.bed.bedNumber} (${snapshot.ipdFacility.bed.bedType || '-'}) | ₹${snapshot.ipdFacility.bed.dailyCharge}/day | ${snapshot.ipdFacility.bed.id}`);

  console.log('\n=== PHARMACY MASTER/STOCK ===');
  console.log(`Pharmacy: ${snapshot.pharmacy.master.name} | ${snapshot.pharmacy.master.id}${snapshot.pharmacy.master.legacyUnscoped ? ' [legacy unscoped]' : ''}`);
  console.log(`Medicine: ${snapshot.pharmacy.medicine.name} | ${snapshot.pharmacy.medicine.id}`);
  console.log(`Batch: ${snapshot.pharmacy.batch.batchNumber} | stock=${snapshot.pharmacy.batch.quantityBaseUnits} | unitPrice=₹${snapshot.pharmacy.batch.sellingPricePerBaseUnit} | expiry=${snapshot.pharmacy.batch.expiryDate}`);

  console.log('\n=== BILLING/FINANCE SETUP ===');
  console.log(`HospitalCharges: ${snapshot.billingAndFinanceMasters.hospitalCharges ? snapshot.billingAndFinanceMasters.hospitalCharges.id : 'NOT FOUND (optional)'}`);
  console.log(`Relevant BillingServiceMaster rows: ${snapshot.billingAndFinanceMasters.relevantBillingServices.length}`);
  console.log(`Active payers: ${snapshot.billingAndFinanceMasters.activePayerCount}; self/cash payer: ${snapshot.billingAndFinanceMasters.selfOrCashPayer?.name || 'not required / not found'}`);
  console.log(`HospitalPharmacySetting: ${snapshot.pharmacy.setting ? snapshot.pharmacy.setting.id : 'NOT FOUND (defaults apply)'}`);

  if (snapshot.readiness.notes.length) {
    console.log('\n=== NOTES ===');
    snapshot.readiness.notes.forEach((note) => console.log(`- ${note}`));
  }

  console.log('\nREADY FOR MAIN OPD/IPD SEED:', snapshot.readiness.readyForMainSeed ? 'YES' : 'NO');
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(`Usage: node scripts/fetch-two-patient-seed-master-data.js [options]\n\nOptions:\n  --hospital-id <ObjectId>\n  --hospital-code <hospitalID|tenantCode>\n  --hospital-name <substring>\n  --output <path>\n  --no-output\n  --allow-existing-patient-history\n  --min-medicine-stock <n>`);
    return;
  }

  if (TARGET_HOSPITAL_ID && !ObjectId.isValid(TARGET_HOSPITAL_ID)) {
    throw new Error(`Invalid --hospital-id: ${TARGET_HOSPITAL_ID}`);
  }

  console.log('Mode: READ-ONLY MASTER/PREFLIGHT FETCH');
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}`);

  const existingCollections = await collectionNames(db);
  const hospitals = await db.collection('hospitals').find({ deleted_at: null })
    .sort({ hospitalName: 1, name: 1, _id: 1 })
    .toArray();

  const candidates = hospitals.filter(hospitalMatchesTarget);
  if (!candidates.length) {
    throw new Error('No hospital matches the supplied hospital selector.');
  }

  let snapshot = null;
  const failures = [];
  for (const hospital of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      snapshot = await buildSnapshot(db, existingCollections, hospital);
      break;
    } catch (error) {
      failures.push({
        hospital: `${hospital.hospitalName || hospital.name} | ${hospital.hospitalID || hospital.tenantCode || '-'} | ${hospital._id}`,
        reason: error.message
      });
      if (TARGET_HOSPITAL_ID || TARGET_HOSPITAL_CODE || TARGET_HOSPITAL_NAME) break;
    }
  }

  if (!snapshot) {
    console.error('\nNo hospital is currently ready for the complete two-patient fixture.');
    for (const failure of failures) console.error(`- ${failure.hospital}: ${failure.reason}`);
    process.exitCode = 2;
    return;
  }

  if (failures.length) {
    console.log('\nHospitals skipped before finding a ready candidate:');
    failures.forEach((failure) => console.log(`- ${failure.hospital}: ${failure.reason}`));
  }

  printSnapshot(snapshot);

  if (!NO_OUTPUT) {
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`\nJSON snapshot written to: ${OUTPUT_PATH}`);
    console.log('This file contains IDs/names/master pricing needed to author and verify the main seed script; it contains no passwords or tokens.');
  } else {
    console.log('\n--no-output supplied: no local JSON file was written.');
  }
}

main()
  .catch((error) => {
    console.error(`\nMASTER FETCH FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  });
