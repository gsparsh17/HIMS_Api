#!/usr/bin/env node
'use strict';

/**
 * Complete idempotent seed for exactly three Test Hospital staff logins:
 *   pathology@gmail.com / pathology123
 *   radiology@gmail.com / radiology123
 *   finance@gmail.com   / finance123
 *
 * Creates/updates:
 *   - users (all three)
 *   - staffs (all three common staff registry entries)
 *   - pathologystaffs (pathology)
 *   - radiologystaffs (radiology)
 *   - hrstaffprofiles (all three, linked through staff_id)
 *
 * --reset deletes the exact three accounts and all linked records listed above,
 * then recreates them. It does not reset any other hospital user.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const HOSPITAL_ID = new ObjectId('69a697c0df37f940dd7906ce');
const HOSPITAL_CODE = 'AZ4967';
const SEED_TAG = 'HIMS_ROLE_USERS_WITH_STAFF_V2';
const OLD_SEED_TAG = 'HIMS_ROLE_USERS_V1';

const MAIN_FEATURES = [
  'dashboard',
  'registration_opd',
  'ipd',
  'pharmacy',
  'billing_finance',
  'laboratory',
  'radiology',
  'operation_theatre',
  'store_inventory',
  'hr_staff',
  'reports',
  'masters_settings'
];

const ROLE_ACCESS = {
  pathology_staff: {
    dashboard: 'manage',
    laboratory: 'manage',
    registration_opd: 'view',
    ipd: 'view',
    reports: 'view'
  },
  radiology_staff: {
    dashboard: 'manage',
    radiology: 'manage',
    registration_opd: 'view',
    ipd: 'view',
    reports: 'view'
  },
  accountant: {
    dashboard: 'manage',
    billing_finance: 'manage',
    reports: 'manage'
  }
};

const ROLE_ACTIONS = {
  accountant: {
    billing_finance: [
      'claim_submit',
      'preauth_decide',
      'rate_card_approve',
      'pricing_override',
      'settlement',
      'final_clearance'
    ]
  }
};

const ACCOUNTS = [
  {
    key: 'pathology',
    name: 'Pathology Staff',
    firstName: 'Pathology',
    lastName: 'Staff',
    email: 'pathology@gmail.com',
    password: 'pathology123',
    userRole: 'pathology_staff',
    commonStaffRole: 'Pathology Staff',
    staffType: 'pathology_staff',
    designation: 'Lab Technician',
    qualification: 'DMLT',
    specialization: 'General Pathology',
    employeeCode: `${HOSPITAL_CODE}-LAB-001`,
    phone: '0000000000',
    departmentPatterns: ['pathology', 'laboratory', 'lab']
  },
  {
    key: 'radiology',
    name: 'Radiology Staff',
    firstName: 'Radiology',
    lastName: 'Staff',
    email: 'radiology@gmail.com',
    password: 'radiology123',
    userRole: 'radiology_staff',
    commonStaffRole: 'Radiology Staff',
    staffType: 'radiology_staff',
    designation: 'Radiology Technician',
    qualification: 'Radiology Technician',
    specialization: 'Diagnostic Imaging',
    employeeCode: `${HOSPITAL_CODE}-RAD-001`,
    phone: '0000000000',
    departmentPatterns: ['radiology', 'imaging']
  },
  {
    key: 'finance',
    name: 'Finance Staff',
    firstName: 'Finance',
    lastName: 'Staff',
    email: 'finance@gmail.com',
    password: 'finance123',
    userRole: 'accountant',
    commonStaffRole: 'Accountant',
    staffType: 'accountant',
    designation: 'Accountant',
    qualification: '',
    specialization: 'Hospital Billing and Finance',
    employeeCode: `${HOSPITAL_CODE}-FIN-001`,
    phone: '0000000000',
    departmentPatterns: ['finance', 'account', 'billing']
  }
];

const TARGET_EMAILS = ACCOUNTS.map((account) => account.email);
const TARGET_EMPLOYEE_CODES = ACCOUNTS.map((account) => account.employeeCode);

function parseArgs(argv) {
  const args = {
    mongoUri: process.env.MONGO_URI || '',
    database: process.env.DB_NAME || '',
    dryRun: false,
    reset: false,
    resetOnly: false
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--reset') args.reset = true;
    else if (arg === '--reset-only') args.resetOnly = true;
    else if (arg.startsWith('--mongo-uri=')) args.mongoUri = arg.slice('--mongo-uri='.length);
    else if (arg.startsWith('--database=')) args.database = arg.slice('--database='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.reset && args.resetOnly) {
    throw new Error('Use either --reset or --reset-only, not both.');
  }

  return args;
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function permissionsFor(role, grantedBy) {
  const now = new Date();
  const access = ROLE_ACCESS[role] || {};
  const actions = ROLE_ACTIONS[role] || {};

  return MAIN_FEATURES.map((moduleKey) => ({
    moduleKey,
    access: access[moduleKey] || 'none',
    actions: actions[moduleKey] || [],
    ...(grantedBy ? { grantedBy } : {}),
    grantedAt: now,
    updatedAt: now
  }));
}

function dashboardAccess(modulePermissions) {
  return modulePermissions
    .filter((permission) => permission.access !== 'none')
    .map((permission) => permission.moduleKey);
}

async function findDepartment(db, patterns) {
  const departments = await db.collection('departments')
    .find({ hospitalId: HOSPITAL_ID, active: { $ne: false } })
    .sort({ name: 1 })
    .toArray();

  return departments.find((department) => {
    const searchable = `${department.name || ''} ${department.code || ''}`.toLowerCase();
    return patterns.some((pattern) => searchable.includes(pattern));
  }) || null;
}

async function upsertUser(db, account, grantedBy) {
  const collection = db.collection('users');
  const email = account.email.toLowerCase();
  const existing = await collection.findOne({ email });

  if (existing?.hospital_id && !sameId(existing.hospital_id, HOSPITAL_ID)) {
    throw new Error(
      `${email} belongs to another hospital (${existing.hospital_id}). ` +
      'No cross-hospital reassignment was performed.'
    );
  }

  const now = new Date();
  const modulePermissions = permissionsFor(account.userRole, grantedBy);
  const fields = {
    name: account.name,
    email,
    password: await bcrypt.hash(account.password, 10),
    role: account.userRole,
    phone: account.phone,
    hospital_id: HOSPITAL_ID,
    dashboard_access: dashboardAccess(modulePermissions),
    modulePermissions,
    is_active: true,
    seedTag: SEED_TAG,
    updatedAt: now
  };

  if (existing) {
    await collection.updateOne({ _id: existing._id }, { $set: fields });
    return { ...(await collection.findOne({ _id: existing._id })), created: false };
  }

  const document = { ...fields, createdAt: now };
  const result = await collection.insertOne(document);
  return { ...document, _id: result.insertedId, created: true };
}

async function upsertCommonStaff(db, account, user, department) {
  const collection = db.collection('staffs');
  const byEmail = await collection.findOne({ email: account.email });
  const byCode = await collection.findOne({ staffId: account.employeeCode });

  if (byEmail && byCode && !sameId(byEmail._id, byCode._id)) {
    throw new Error(
      `Staff collision: email ${account.email} and staffId ${account.employeeCode} ` +
      'belong to different records.'
    );
  }
  if (byCode && String(byCode.email || '').toLowerCase() !== account.email) {
    throw new Error(
      `Staff code ${account.employeeCode} is already assigned to ${byCode.email || byCode._id}.`
    );
  }

  const existing = byEmail || byCode;
  const now = new Date();
  const fields = {
    user_id: user._id,
    staffId: account.employeeCode,
    first_name: account.firstName,
    last_name: account.lastName,
    email: account.email,
    phone: account.phone,
    role: account.commonStaffRole,
    ...(department ? { department: department._id } : {}),
    specialization: account.specialization,
    status: 'Active',
    seedTag: SEED_TAG,
    joined_at: existing?.joined_at || now
  };

  if (existing) {
    await collection.updateOne({ _id: existing._id }, { $set: fields });
    return { ...(await collection.findOne({ _id: existing._id })), created: false };
  }

  const result = await collection.insertOne(fields);
  return { ...fields, _id: result.insertedId, created: true };
}

async function upsertPathologyProfile(db, account, user, department, grantedBy) {
  const collection = db.collection('pathologystaffs');
  const now = new Date();

  const labTests = await db.collection('labtests')
    .find({
      is_active: { $ne: false },
      $or: [
        { hospitalId: HOSPITAL_ID },
        { hospital_id: HOSPITAL_ID }
      ]
    })
    .sort({ category: 1, code: 1, name: 1 })
    .toArray();

  const assignedLabTests = labTests.map((test) => ({
    lab_test_id: test._id,
    lab_test_code: test.code || '',
    lab_test_name: test.name || '',
    category: test.category || '',
    can_perform: true,
    assigned_at: now
  }));

  const candidates = await collection.find({
    hospitalId: HOSPITAL_ID,
    $or: [
      { user_id: user._id },
      { email: account.email },
      { staffId: account.employeeCode }
    ]
  }).toArray();

  if (candidates.length > 1) {
    throw new Error(`Multiple pathology staff profiles match ${account.email}; reset first.`);
  }

  const existing = candidates[0] || null;
  const fields = {
    hospitalId: HOSPITAL_ID,
    user_id: user._id,
    staffId: account.employeeCode,
    first_name: account.firstName,
    last_name: account.lastName,
    email: account.email,
    phone: account.phone,
    qualification: account.qualification,
    specialization: account.specialization,
    role: 'lab_technician',
    ...(department ? { department: department._id } : {}),
    status: 'Active',
    assigned_lab_tests: assignedLabTests,
    accessible_test_ids: labTests.map((test) => test._id),
    tests_processed: existing?.tests_processed || 0,
    avg_turnaround_time: existing?.avg_turnaround_time || 0,
    accuracy_rate: existing?.accuracy_rate || 0,
    ...(grantedBy ? {
      created_by: existing?.created_by || grantedBy,
      updated_by: grantedBy
    } : {}),
    seedTag: SEED_TAG,
    updatedAt: now
  };

  if (existing) {
    await collection.updateOne({ _id: existing._id }, { $set: fields });
    return {
      ...(await collection.findOne({ _id: existing._id })),
      created: false,
      assignedTestCount: labTests.length
    };
  }

  const document = { ...fields, joined_at: now, createdAt: now };
  const result = await collection.insertOne(document);
  return { ...document, _id: result.insertedId, created: true, assignedTestCount: labTests.length };
}

function normalizeRadiologySpecialization(category) {
  const value = String(category || '').toLowerCase();
  if (value.includes('x-ray') || value.includes('x ray')) return 'X-Ray';
  if (value.includes('ct')) return 'CT Scan';
  if (value.includes('mri')) return 'MRI';
  if (value.includes('ultrasound') || value.includes('usg') || value.includes('sonography')) return 'Ultrasound';
  if (value.includes('mammo')) return 'Mammography';
  if (value.includes('interventional')) return 'Interventional Radiology';
  if (value.includes('pet') || value.includes('nuclear')) return 'Nuclear Medicine';
  return null;
}

async function upsertRadiologyProfile(db, account, user) {
  const collection = db.collection('radiologystaffs');
  const now = new Date();

  const imagingTests = await db.collection('imagingtests')
    .find({
      is_active: { $ne: false },
      $or: [
        { hospitalId: HOSPITAL_ID },
        { hospital_id: HOSPITAL_ID }
      ]
    })
    .sort({ category: 1, code: 1, name: 1 })
    .toArray();

  const modalityAssignments = Array.from(new Set(
    imagingTests.map((test) => String(test.category || '').trim()).filter(Boolean)
  ));
  const specializations = Array.from(new Set(
    modalityAssignments.map(normalizeRadiologySpecialization).filter(Boolean)
  ));

  const candidates = await collection.find({
    hospitalId: HOSPITAL_ID,
    $or: [
      { userId: user._id },
      { employeeId: account.employeeCode }
    ]
  }).toArray();

  if (candidates.length > 1) {
    throw new Error(`Multiple radiology staff profiles match ${account.email}; reset first.`);
  }

  const existing = candidates[0] || null;
  const fields = {
    hospitalId: HOSPITAL_ID,
    userId: user._id,
    employeeId: account.employeeCode,
    designation: 'Radiology Technician',
    specializations,
    qualification: account.qualification,
    experience_years: existing?.experience_years || 0,
    is_active: true,
    modalityAssignments,
    availabilityStatus: 'Available',
    seedTag: SEED_TAG,
    updatedAt: now
  };

  if (existing) {
    await collection.updateOne({ _id: existing._id }, { $set: fields });
    return {
      ...(await collection.findOne({ _id: existing._id })),
      created: false,
      imagingTestCount: imagingTests.length
    };
  }

  const document = { ...fields, joined_date: now, createdAt: now };
  const result = await collection.insertOne(document);
  return { ...document, _id: result.insertedId, created: true, imagingTestCount: imagingTests.length };
}

async function upsertHRProfile(db, options) {
  const collection = db.collection('hrstaffprofiles');
  const now = new Date();

  const candidates = await collection.find({
    hospital_id: HOSPITAL_ID,
    $or: [
      { user_id: options.user._id },
      { email: options.account.email },
      { employee_code: options.account.employeeCode },
      { staff_id: options.commonStaff._id }
    ]
  }).toArray();

  if (candidates.length > 1) {
    throw new Error(`Multiple HR profiles match ${options.account.email}; run with --reset.`);
  }

  const existing = candidates[0] || null;
  const sourceModel = options.specializedSourceModel || 'Staff';
  const sourceId = options.specializedSourceId || options.commonStaff._id;

  const fields = {
    employee_code: options.account.employeeCode,
    user_id: options.user._id,
    staff_id: options.commonStaff._id,
    ...(options.pathologyProfileId ? { pathology_staff_id: options.pathologyProfileId } : {}),
    ...(options.radiologyProfileId ? { radiology_staff_id: options.radiologyProfileId } : {}),
    source_model: sourceModel,
    source_id: sourceId,
    full_name: options.account.name,
    first_name: options.account.firstName,
    last_name: options.account.lastName,
    email: options.account.email,
    phone: options.account.phone,
    staff_type: options.account.staffType,
    designation: options.account.designation,
    ...(options.department ? {
      department: options.department._id,
      department_name: options.department.name
    } : {}),
    specialization: options.hrSpecialization || options.account.specialization,
    qualification: options.account.qualification,
    joining_date: existing?.joining_date || now,
    employment_type: 'Full Time',
    employment_status: 'Active',
    salary_type: 'Salary',
    salary_amount: existing?.salary_amount || 0,
    payroll_enabled: options.account.staffType !== 'accountant',
    pay_cycle: 'monthly',
    login_enabled: true,
    availability_status: 'available',
    hospital_id: HOSPITAL_ID,
    ...(options.grantedBy ? {
      created_by: existing?.created_by || options.grantedBy,
      updated_by: options.grantedBy
    } : {}),
    seedTag: SEED_TAG,
    updatedAt: now
  };

  if (existing) {
    await collection.updateOne(
      { _id: existing._id },
      {
        $set: fields,
        $unset: {
          ...(options.pathologyProfileId ? {} : { pathology_staff_id: '' }),
          ...(options.radiologyProfileId ? {} : { radiology_staff_id: '' })
        }
      }
    );
    return { ...(await collection.findOne({ _id: existing._id })), created: false };
  }

  const document = { ...fields, createdAt: now };
  const result = await collection.insertOne(document);
  return { ...document, _id: result.insertedId, created: true };
}

async function resetExactAccounts(db) {
  const usersCollection = db.collection('users');
  const users = await usersCollection.find({ email: { $in: TARGET_EMAILS } }).toArray();

  const foreignHospitalUsers = users.filter(
    (user) => user.hospital_id && !sameId(user.hospital_id, HOSPITAL_ID)
  );
  if (foreignHospitalUsers.length) {
    throw new Error(
      `Reset stopped because ${foreignHospitalUsers.map((user) => user.email).join(', ')} ` +
      'belongs to another hospital.'
    );
  }

  const userIds = users.map((user) => user._id);
  const userIdClause = userIds.length ? [{ user_id: { $in: userIds } }] : [];
  const radiologyUserIdClause = userIds.length ? [{ userId: { $in: userIds } }] : [];

  const staffs = await db.collection('staffs').find({
    $or: [
      { email: { $in: TARGET_EMAILS } },
      { staffId: { $in: TARGET_EMPLOYEE_CODES } },
      ...userIdClause
    ]
  }).toArray();
  const staffIds = staffs.map((staff) => staff._id);

  const pathologyProfiles = await db.collection('pathologystaffs').find({
    hospitalId: HOSPITAL_ID,
    $or: [
      { email: { $in: TARGET_EMAILS } },
      { staffId: { $in: TARGET_EMPLOYEE_CODES } },
      { seedTag: { $in: [SEED_TAG, OLD_SEED_TAG] } },
      ...userIdClause
    ]
  }).toArray();
  const pathologyIds = pathologyProfiles.map((profile) => profile._id);

  const radiologyProfiles = await db.collection('radiologystaffs').find({
    hospitalId: HOSPITAL_ID,
    $or: [
      { employeeId: { $in: TARGET_EMPLOYEE_CODES } },
      { seedTag: { $in: [SEED_TAG, OLD_SEED_TAG] } },
      ...radiologyUserIdClause
    ]
  }).toArray();
  const radiologyIds = radiologyProfiles.map((profile) => profile._id);

  const hrOr = [
    { email: { $in: TARGET_EMAILS } },
    { employee_code: { $in: TARGET_EMPLOYEE_CODES } },
    { seedTag: { $in: [SEED_TAG, OLD_SEED_TAG] } }
  ];
  if (userIds.length) hrOr.push({ user_id: { $in: userIds } });
  if (staffIds.length) hrOr.push({ staff_id: { $in: staffIds } });
  if (pathologyIds.length) hrOr.push({ pathology_staff_id: { $in: pathologyIds } });
  if (radiologyIds.length) hrOr.push({ radiology_staff_id: { $in: radiologyIds } });

  const deleted = {};
  deleted.hrstaffprofiles = (await db.collection('hrstaffprofiles').deleteMany({
    hospital_id: HOSPITAL_ID,
    $or: hrOr
  })).deletedCount || 0;

  deleted.pathologystaffs = (await db.collection('pathologystaffs').deleteMany({
    _id: { $in: pathologyIds }
  })).deletedCount || 0;

  deleted.radiologystaffs = (await db.collection('radiologystaffs').deleteMany({
    _id: { $in: radiologyIds }
  })).deletedCount || 0;

  deleted.staffs = (await db.collection('staffs').deleteMany({
    _id: { $in: staffIds }
  })).deletedCount || 0;

  deleted.users = userIds.length
    ? (await usersCollection.deleteMany({ _id: { $in: userIds } })).deletedCount || 0
    : 0;

  const resultFile = path.join(__dirname, 'seed-role-users-result.json');
  if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);

  const total = Object.values(deleted).reduce((sum, count) => sum + count, 0);
  console.log(`Reset removed ${total} record(s): ${JSON.stringify(deleted)}`);
  return deleted;
}

async function validatePasswordHash(db, email, password) {
  const user = await db.collection('users').findOne({ email });
  return Boolean(user && await bcrypt.compare(password, user.password));
}

async function verifyLinks(db, account, user, commonStaff, hrProfile) {
  const errors = [];
  if (!sameId(commonStaff.user_id, user._id)) errors.push('staffs.user_id');
  if (!sameId(hrProfile.user_id, user._id)) errors.push('hrstaffprofiles.user_id');
  if (!sameId(hrProfile.staff_id, commonStaff._id)) errors.push('hrstaffprofiles.staff_id');
  if (!sameId(user.staff_profile_id, hrProfile._id)) errors.push('users.staff_profile_id');
  if (String(commonStaff.email).toLowerCase() !== account.email) errors.push('staffs.email');
  return errors;
}

async function run() {
  const args = parseArgs(process.argv);

  if (args.dryRun) {
    console.log(JSON.stringify({
      hospitalId: String(HOSPITAL_ID),
      hospitalCode: HOSPITAL_CODE,
      accounts: ACCOUNTS.map((account) => ({
        email: account.email,
        password: account.password,
        userRole: account.userRole,
        staffRole: account.commonStaffRole,
        staffId: account.employeeCode
      })),
      collections: ['users', 'staffs', 'pathologystaffs', 'radiologystaffs', 'hrstaffprofiles'],
      resetBehavior: '--reset removes these exact three emails and their linked records, then recreates them.',
      note: 'No database connection was made.'
    }, null, 2));
    return;
  }

  if (!args.mongoUri) {
    throw new Error('MONGO_URI is required. Add it to .env or pass --mongo-uri=...');
  }

  const client = new MongoClient(args.mongoUri);
  await client.connect();

  try {
    const db = args.database ? client.db(args.database) : client.db();
    const hospital = await db.collection('hospitals').findOne({ _id: HOSPITAL_ID });
    if (!hospital) {
      throw new Error(`Hospital ${HOSPITAL_ID} was not found in database ${db.databaseName}.`);
    }

    if (args.reset || args.resetOnly) {
      await resetExactAccounts(db);
      if (args.resetOnly) {
        console.log('RESET ONLY COMPLETED');
        return;
      }
    }

    const grantedBy = hospital.createdBy || null;
    const departments = {};
    for (const account of ACCOUNTS) {
      departments[account.key] = await findDepartment(db, account.departmentPatterns);
      if (!departments[account.key]) {
        console.warn(
          `Warning: no matching department found for ${account.email}. ` +
          'The staff/profile will be created without a department reference.'
        );
      }
    }

    const users = {};
    const commonStaffs = {};
    for (const account of ACCOUNTS) {
      users[account.key] = await upsertUser(db, account, grantedBy);
      commonStaffs[account.key] = await upsertCommonStaff(
        db,
        account,
        users[account.key],
        departments[account.key]
      );
    }

    const pathologyAccount = ACCOUNTS.find((account) => account.key === 'pathology');
    const radiologyAccount = ACCOUNTS.find((account) => account.key === 'radiology');
    const financeAccount = ACCOUNTS.find((account) => account.key === 'finance');

    const pathologyProfile = await upsertPathologyProfile(
      db,
      pathologyAccount,
      users.pathology,
      departments.pathology,
      grantedBy
    );

    const radiologyProfile = await upsertRadiologyProfile(
      db,
      radiologyAccount,
      users.radiology
    );

    const pathologyHR = await upsertHRProfile(db, {
      account: pathologyAccount,
      user: users.pathology,
      commonStaff: commonStaffs.pathology,
      department: departments.pathology,
      specializedSourceModel: 'PathologyStaff',
      specializedSourceId: pathologyProfile._id,
      pathologyProfileId: pathologyProfile._id,
      grantedBy
    });

    const radiologyHR = await upsertHRProfile(db, {
      account: radiologyAccount,
      user: users.radiology,
      commonStaff: commonStaffs.radiology,
      department: departments.radiology,
      specializedSourceModel: 'RadiologyStaff',
      specializedSourceId: radiologyProfile._id,
      radiologyProfileId: radiologyProfile._id,
      hrSpecialization: Array.isArray(radiologyProfile.specializations)
        ? radiologyProfile.specializations.join(', ')
        : radiologyAccount.specialization,
      grantedBy
    });

    const financeHR = await upsertHRProfile(db, {
      account: financeAccount,
      user: users.finance,
      commonStaff: commonStaffs.finance,
      department: departments.finance,
      specializedSourceModel: 'Staff',
      specializedSourceId: commonStaffs.finance._id,
      grantedBy
    });

    const hrProfiles = {
      pathology: pathologyHR,
      radiology: radiologyHR,
      finance: financeHR
    };

    for (const account of ACCOUNTS) {
      await db.collection('users').updateOne(
        { _id: users[account.key]._id },
        { $set: { staff_profile_id: hrProfiles[account.key]._id, updatedAt: new Date() } }
      );
      users[account.key] = await db.collection('users').findOne({ _id: users[account.key]._id });
    }

    const passwordChecks = {};
    const linkChecks = {};
    for (const account of ACCOUNTS) {
      passwordChecks[account.email] = await validatePasswordHash(db, account.email, account.password);
      linkChecks[account.email] = await verifyLinks(
        db,
        account,
        users[account.key],
        commonStaffs[account.key],
        hrProfiles[account.key]
      );
    }

    if (Object.values(passwordChecks).some((valid) => !valid)) {
      throw new Error('One or more password verification checks failed.');
    }
    const brokenLinks = Object.entries(linkChecks).filter(([, errors]) => errors.length);
    if (brokenLinks.length) {
      throw new Error(`Link verification failed: ${JSON.stringify(brokenLinks)}`);
    }

    const result = {
      success: true,
      database: db.databaseName,
      hospital: {
        _id: String(HOSPITAL_ID),
        hospitalID: hospital.hospitalID,
        hospitalName: hospital.hospitalName
      },
      accounts: ACCOUNTS.map((account) => ({
        email: account.email,
        role: account.userRole,
        userId: String(users[account.key]._id),
        commonStaffId: String(commonStaffs[account.key]._id),
        staffId: commonStaffs[account.key].staffId,
        hrProfileId: String(hrProfiles[account.key]._id),
        ...(account.key === 'pathology' ? {
          pathologyStaffId: String(pathologyProfile._id),
          assignedLabTests: pathologyProfile.assignedTestCount
        } : {}),
        ...(account.key === 'radiology' ? {
          radiologyStaffId: String(radiologyProfile._id),
          availableImagingTests: radiologyProfile.imagingTestCount,
          modalityAssignments: radiologyProfile.modalityAssignments || []
        } : {}),
        passwordVerified: passwordChecks[account.email],
        linksVerified: linkChecks[account.email].length === 0
      })),
      credentials: ACCOUNTS.map(({ email, password }) => ({ email, password })),
      completedAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(__dirname, 'seed-role-users-result.json'),
      JSON.stringify(result, null, 2)
    );

    console.log('\nROLE USER + COMMON STAFF SEED COMPLETED\n');
    console.log('pathology@gmail.com / pathology123');
    console.log('radiology@gmail.com / radiology123');
    console.log('finance@gmail.com   / finance123');
    console.log('\nCommon staffs and HR links were created for all three accounts.');
    console.log(`Details: ${path.join(__dirname, 'seed-role-users-result.json')}`);
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error(`\nSEED FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
