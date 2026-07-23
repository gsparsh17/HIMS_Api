#!/usr/bin/env node

/*
 * HIMS 2026 foundation migration.
 *
 * Dry-run by default.
 *
 * Usage:
 *   node scripts/migrate-hims-2026.js \
 *     --state=migration-state/hims-2026-preview.json
 *
 *   node scripts/migrate-hims-2026.js \
 *     --apply \
 *     --state=migration-state/hims-2026-applied.json
 *
 * Add --sync-indexes only after reviewing production indexes separately.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const APPLY = process.argv.includes('--apply');
const SYNC_INDEXES = process.argv.includes('--sync-indexes');
const stateArg = process.argv.find((value) =>
  value.startsWith('--state=')
);
const STATE_PATH = path.resolve(
  stateArg
    ? stateArg.split('=').slice(1).join('=')
    : `migration-state/hims-2026-${Date.now()}.json`
);

const Hospital = require('../models/Hospital');
const User = require('../models/User');
const HRStaffProfile = require('../models/HRStaffProfile');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const Department = require('../models/Department');
const Ward = require('../models/Ward');
const Room = require('../models/Room');
const Bed = require('../models/Bed');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const PathologyStaff = require('../models/PathologyStaff');
const RadiologyStaff = require('../models/RadiologyStaff');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const IPDAdmission = require('../models/IPDAdmission');
const OfflineSyncLog = require('../models/OfflineSyncLog');
const DischargeSummary = require('../models/DischargeSummary');
const InsuranceProvider = require('../models/InsuranceProvider');
const Payer = require('../models/Payer');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const IPDAccommodationSegment = require(
  '../models/IPDAccommodationSegment'
);

const state = {
  version: 'HIMS-2026-07',
  generatedAt: new Date().toISOString(),
  applied: APPLY,
  completed: false,
  created: [],
  updated: [],
  skipped: [],
  warnings: [],
  counters: {},
  error: null
};

function count(key, amount = 1) {
  state.counters[key] = (state.counters[key] || 0) + amount;
}

function same(left, right) {
  if (left === right) {
    return true;
  }

  if (left === null || left === undefined) {
    return false;
  }

  if (right === null || right === undefined) {
    return false;
  }

  if (left instanceof Date || right instanceof Date) {
    return new Date(left).getTime() === new Date(right).getTime();
  }

  return String(left) === String(right);
}

function getPathValue(source, dottedPath) {
  return dottedPath
    .split('.')
    .reduce(
      (current, part) =>
        current === null || current === undefined
          ? undefined
          : current[part],
      source
    );
}

function rawMissingField(field) {
  return {
    $or: [
      {
        [field]: {
          $exists: false
        }
      },
      {
        [field]: null
      },
      {
        [field]: ''
      }
    ]
  };
}

function asObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }

  if (!mongoose.isValidObjectId(value)) {
    return null;
  }

  return new mongoose.Types.ObjectId(String(value));
}

function generatedDepartmentCode(name, documentId) {
  if (typeof Department.generatedCode === 'function') {
    return Department.generatedCode(name, documentId);
  }

  const base = String(name || 'DEPT')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 24) || 'DEPT';

  return `${base}-${String(documentId).slice(-6).toUpperCase()}`;
}

async function persistState() {
  fs.mkdirSync(path.dirname(STATE_PATH), {
    recursive: true
  });

  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(state, null, 2)
  );
}

async function recordCreated(model, document) {
  state.created.push({
    model,
    id: String(document._id)
  });

  count(`created.${model}`);

  if (APPLY) {
    await persistState();
  }
}

async function recordUpdated(
  model,
  documentId,
  before,
  after,
  beforeExists
) {
  state.updated.push({
    model,
    id: String(documentId),
    before,
    after,
    beforeExists
  });

  count(`updated.${model}`);

  if (APPLY) {
    await persistState();
  }
}

async function safeUpdate(Model, modelName, filter, patch) {
  const document = await Model.findOne(filter).lean();

  if (!document) {
    return null;
  }

  const before = {};
  const after = {};
  const beforeExists = {};

  for (const [key, value] of Object.entries(patch)) {
    const current = getPathValue(document, key);

    if (same(current, value)) {
      continue;
    }

    beforeExists[key] = current !== undefined;
    before[key] = current === undefined ? null : current;
    after[key] = value;
  }

  if (!Object.keys(after).length) {
    return document;
  }

  if (APPLY) {
    await Model.updateOne(
      {
        _id: document._id
      },
      {
        $set: after
      }
    );
  }

  await recordUpdated(
    modelName,
    document._id,
    before,
    after,
    beforeExists
  );

  return {
    ...document,
    ...patch
  };
}

function candidateHospital(record, hospitals) {
  const explicit =
    record.hospitalId
    || record.hospital_id
    || record.hospital;

  if (explicit) {
    return hospitals.find((hospital) =>
      same(hospital._id, explicit)
    ) || null;
  }

  if (hospitals.length === 1) {
    return hospitals[0];
  }

  return null;
}

async function backfillSimple(
  Model,
  name,
  hospitals,
  field = 'hospitalId',
  relationResolver
) {
  const rows = await Model.collection
    .find(rawMissingField(field))
    .toArray();

  for (const row of rows) {
    const hospital = relationResolver
      ? await relationResolver(row, hospitals)
      : candidateHospital(row, hospitals);

    if (!hospital) {
      state.skipped.push({
        model: name,
        id: String(row._id),
        reason: 'Ambiguous hospital relationship'
      });

      count(`skipped.${name}`);
      continue;
    }

    await safeUpdate(
      Model,
      name,
      {
        _id: row._id
      },
      {
        [field]: hospital._id
      }
    );
  }
}

async function resolveFromAdmission(row, hospitals) {
  const admissionId = asObjectId(
    row.admissionId || row.ipdAdmissionId
  );

  if (!admissionId) {
    return candidateHospital(row, hospitals);
  }

  const admission = await IPDAdmission.collection.findOne(
    {
      _id: admissionId
    },
    {
      projection: {
        hospitalId: 1,
        hospital_id: 1,
        patientId: 1,
        patient_id: 1
      }
    }
  );

  if (!admission) {
    return candidateHospital(row, hospitals);
  }

  const directHospital = candidateHospital(
    admission,
    hospitals
  );

  if (directHospital) {
    return directHospital;
  }

  return resolveFromPatient(admission, hospitals);
}

async function resolveFromPatient(row, hospitals) {
  const patientId = asObjectId(
    row.patientId || row.patient_id
  );

  if (!patientId) {
    return candidateHospital(row, hospitals);
  }

  const patient = await Patient.collection.findOne(
    {
      _id: patientId
    },
    {
      projection: {
        hospitalId: 1,
        hospital_id: 1,
        hospital: 1
      }
    }
  );

  return patient
    ? candidateHospital(patient, hospitals)
    : candidateHospital(row, hospitals);
}

async function preflightDepartments(hospitals) {
  const departments = await Department.collection
    .find({})
    .toArray();

  const nameKeys = new Map();
  const codeKeys = new Map();
  const conflicts = [];

  for (const department of departments) {
    const hospital = candidateHospital(
      department,
      hospitals
    );

    if (!hospital) {
      continue;
    }

    const name = String(department.name || '')
      .trim()
      .toLowerCase();

    const code = String(
      department.code
      || generatedDepartmentCode(
        department.name,
        department._id
      )
    )
      .trim()
      .toUpperCase();

    const nameKey = `${hospital._id}:${name}`;
    const codeKey = `${hospital._id}:${code}`;

    if (name && nameKeys.has(nameKey)) {
      conflicts.push({
        type: 'department-name',
        hospitalId: String(hospital._id),
        value: department.name,
        documentIds: [
          nameKeys.get(nameKey),
          String(department._id)
        ]
      });
    } else if (name) {
      nameKeys.set(nameKey, String(department._id));
    }

    if (code && codeKeys.has(codeKey)) {
      conflicts.push({
        type: 'department-code',
        hospitalId: String(hospital._id),
        value: code,
        documentIds: [
          codeKeys.get(codeKey),
          String(department._id)
        ]
      });
    } else if (code) {
      codeKeys.set(codeKey, String(department._id));
    }
  }

  if (conflicts.length) {
    throw new Error(
      'Department tenant-key conflicts must be resolved before '
      + `migration: ${JSON.stringify(conflicts, null, 2)}`
    );
  }
}

async function backfillDepartmentCodes() {
  const departments = await Department.collection
    .find(rawMissingField('code'))
    .toArray();

  for (const department of departments) {
    await safeUpdate(
      Department,
      'Department',
      {
        _id: department._id
      },
      {
        code: generatedDepartmentCode(
          department.name,
          department._id
        )
      }
    );
  }
}

function payerType(provider) {
  if (provider.category === 'corporate') {
    return 'corporate';
  }

  if (provider.type === 'tpa') {
    return 'tpa';
  }

  if (
    provider.type === 'government'
    || provider.category === 'government_scheme'
  ) {
    return 'government_other';
  }

  return 'private_insurer';
}

function legacyCoveragePayload(
  admission,
  hospitalId,
  selfPayer,
  mappedPayers
) {
  const legacyName = String(
    admission.sponsorName
    || admission.insuranceDetails?.providerName
    || ''
  ).trim();

  const explicitSelf =
    !legacyName
    && !admission.sponsorType
    && ![
      'insurance',
      'sponsored',
      'cashless'
    ].includes(
      String(admission.paymentType || '').toLowerCase()
    );

  let payer = selfPayer;

  if (!explicitSelf && legacyName) {
    payer = mappedPayers.find(
      (item) =>
        String(item.name || '').toLowerCase()
        === legacyName.toLowerCase()
    ) || selfPayer;
  }

  const category =
    payer.type === 'tpa'
      ? 'tpa_managed'
      : payer.type;

  return {
    hospitalId,
    admissionId: admission._id,
    patientId: admission.patientId,
    payerId: payer._id,
    payerCategory: category,
    beneficiary: {
      beneficiaryId:
        admission.insuranceDetails?.beneficiaryId,
      policyNumber:
        admission.insuranceDetails?.policyNumber,
      memberId:
        admission.insuranceDetails?.memberId,
      coverageLimit:
        admission.insuranceDetails?.coverageAmount,
      coPayPercentage: Number(
        admission.insuranceDetails?.coPayPercentage || 0
      ),
      wardEntitlement:
        admission.insuranceDetails?.wardEntitlement
        || 'semi_private'
    },
    eligibility: {
      status: explicitSelf ? 'verified' : 'pending',
      method: 'legacy_migration',
      reason:
        'Migrated from legacy admission sponsor fields'
    },
    preAuthorisation: {
      required: !explicitSelf,
      status:
        explicitSelf
          ? 'not_required'
          : 'not_started'
    },
    rateContext: {
      cityTier: 'I',
      accreditation: 'nabh_nabl'
    },
    active: true,
    effectiveFrom:
      admission.admissionDate
      || admission.createdAt
      || new Date()
  };
}

async function admissionsForHospital(
  hospital,
  hospitals
) {
  const admissions = await IPDAdmission.find({
    status: {
      $nin: [
        'Cancelled'
      ]
    }
  }).lean();

  const selected = [];

  for (const admission of admissions) {
    let resolvedHospital = candidateHospital(
      admission,
      hospitals
    );

    if (!resolvedHospital) {
      resolvedHospital = await resolveFromPatient(
        admission,
        hospitals
      );
    }

    if (
      resolvedHospital
      && same(resolvedHospital._id, hospital._id)
    ) {
      selected.push({
        ...admission,
        hospitalId: hospital._id
      });
    }
  }

  return selected;
}

async function main() {
  const mongoUri =
    process.env.MONGODB_URI
    || process.env.MONGO_URI;

  if (!mongoUri) {
    throw new Error(
      'MONGODB_URI or MONGO_URI is required'
    );
  }

  await mongoose.connect(
    mongoUri,
    {
      autoIndex: false,
      autoCreate: false
    }
  );

  const hospitals = await Hospital.find({}).lean();

  if (!hospitals.length) {
    throw new Error('No hospitals found');
  }

  console.log(
    `[HIMS 2026] ${APPLY ? 'APPLY' : 'DRY RUN'} `
    + `for ${hospitals.length} hospital(s)`
  );
  console.log(`Migration state: ${STATE_PATH}`);

  await preflightDepartments(hospitals);

  /*
   * Department codes must be populated before hospitalId. The existing unique
   * compound index treats { hospitalId, code: null } as a duplicate key for
   * the second department in the same hospital.
   */
  await backfillDepartmentCodes();
  await backfillSimple(
    Department,
    'Department',
    hospitals
  );

  await backfillSimple(
    Patient,
    'Patient',
    hospitals
  );
  await backfillSimple(
    Doctor,
    'Doctor',
    hospitals
  );
  await backfillSimple(
    Ward,
    'Ward',
    hospitals
  );

  await backfillSimple(
    Room,
    'Room',
    hospitals,
    'hospitalId',
    async (row, availableHospitals) => {
      const wardId = asObjectId(row.wardId);

      if (wardId) {
        const ward = await Ward.collection.findOne(
          {
            _id: wardId
          },
          {
            projection: {
              hospitalId: 1,
              hospital_id: 1
            }
          }
        );

        if (ward) {
          const hospital = candidateHospital(
            ward,
            availableHospitals
          );

          if (hospital) {
            return hospital;
          }
        }
      }

      return candidateHospital(
        row,
        availableHospitals
      );
    }
  );

  await backfillSimple(
    Bed,
    'Bed',
    hospitals,
    'hospitalId',
    async (row, availableHospitals) => {
      const wardId = asObjectId(row.wardId);

      if (wardId) {
        const ward = await Ward.collection.findOne(
          {
            _id: wardId
          },
          {
            projection: {
              hospitalId: 1,
              hospital_id: 1
            }
          }
        );

        if (ward) {
          const hospital = candidateHospital(
            ward,
            availableHospitals
          );

          if (hospital) {
            return hospital;
          }
        }
      }

      const roomId = asObjectId(row.roomId);

      if (roomId) {
        const room = await Room.collection.findOne(
          {
            _id: roomId
          },
          {
            projection: {
              hospitalId: 1,
              hospital_id: 1
            }
          }
        );

        if (room) {
          const hospital = candidateHospital(
            room,
            availableHospitals
          );

          if (hospital) {
            return hospital;
          }
        }
      }

      return candidateHospital(
        row,
        availableHospitals
      );
    }
  );

  await backfillSimple(
    LabTest,
    'LabTest',
    hospitals
  );
  await backfillSimple(
    ImagingTest,
    'ImagingTest',
    hospitals
  );
  await backfillSimple(
    PathologyStaff,
    'PathologyStaff',
    hospitals
  );
  await backfillSimple(
    RadiologyStaff,
    'RadiologyStaff',
    hospitals
  );

  await backfillSimple(
    IPDAdmission,
    'IPDAdmission',
    hospitals,
    'hospitalId',
    resolveFromPatient
  );

  await backfillSimple(
    LabRequest,
    'LabRequest',
    hospitals,
    'hospitalId',
    resolveFromAdmission
  );

  await backfillSimple(
    RadiologyRequest,
    'RadiologyRequest',
    hospitals,
    'hospitalId',
    resolveFromAdmission
  );

  await backfillSimple(
    OfflineSyncLog,
    'OfflineSyncLog',
    hospitals,
    'hospitalId',
    resolveFromPatient
  );

  await backfillSimple(
    DischargeSummary,
    'DischargeSummary',
    hospitals,
    'hospitalId',
    resolveFromAdmission
  );

  const profiles = await HRStaffProfile.find({
    user_id: {
      $ne: null
    }
  })
    .select(
      '_id user_id hospital_id hospitalId'
    )
    .lean();

  for (const profile of profiles) {
    const user = await User.findById(
      profile.user_id
    )
      .select(
        'staff_profile_id hospital_id hospitalId'
      )
      .lean();

    if (!user) {
      continue;
    }

    const patch = {};

    if (!user.staff_profile_id) {
      patch.staff_profile_id = profile._id;
    }

    if (
      !user.hospital_id
      && !user.hospitalId
      && (profile.hospital_id || profile.hospitalId)
    ) {
      patch.hospital_id =
        profile.hospital_id || profile.hospitalId;
    }

    if (Object.keys(patch).length) {
      await safeUpdate(
        User,
        'User',
        {
          _id: user._id
        },
        patch
      );
    }
  }

  for (const hospital of hospitals) {
    let selfPayer = await Payer.findOne({
      hospitalId: hospital._id,
      code: 'SELF'
    });

    if (!selfPayer) {
      const payload = {
        hospitalId: hospital._id,
        code: 'SELF',
        name: 'Self Pay',
        type: 'self',
        empanelment: {
          status: 'not_required'
        },
        isActive: true
      };

      selfPayer = APPLY
        ? await Payer.create(payload)
        : {
            ...payload,
            _id: new mongoose.Types.ObjectId()
          };

      await recordCreated(
        'Payer',
        selfPayer
      );
    }

    const legacyProviders = await InsuranceProvider.find({
      is_active: {
        $ne: false
      }
    }).lean();

    const mappedPayers = [
      selfPayer
    ];

    for (const provider of legacyProviders) {
      const code = (
        `LEGACY-${String(
          provider.code || provider._id
        ).toUpperCase()}`
      ).slice(0, 60);

      let payer = await Payer.findOne({
        hospitalId: hospital._id,
        code
      });

      if (!payer) {
        const payload = {
          hospitalId: hospital._id,
          code,
          name: provider.name,
          type: payerType(provider),
          empanelment: {
            status:
              provider.is_approved
                ? 'active'
                : 'pending',
            number: provider.empanelment_number,
            effectiveFrom: provider.empanelment_date,
            contractReference: String(provider._id)
          },
          contacts: [
            {
              name: provider.contact_person,
              phone: provider.contact_phone,
              email: provider.contact_email
            }
          ],
          settlementTerms: {
            notes: provider.notes
          },
          isActive: provider.is_active !== false
        };

        payer = APPLY
          ? await Payer.create(payload)
          : {
              ...payload,
              _id: new mongoose.Types.ObjectId()
            };

        await recordCreated(
          'Payer',
          payer
        );
      }

      mappedPayers.push(payer);
    }

    const admissions = await admissionsForHospital(
      hospital,
      hospitals
    );

    for (const admission of admissions) {
      const existingCoverage =
        await AdmissionCoverage.findOne({
          hospitalId: hospital._id,
          admissionId: admission._id,
          active: true
        }).lean();

      if (!existingCoverage) {
        const payload = legacyCoveragePayload(
          admission,
          hospital._id,
          selfPayer,
          mappedPayers
        );

        const coverage = APPLY
          ? await AdmissionCoverage.create(payload)
          : {
              ...payload,
              _id: new mongoose.Types.ObjectId()
            };

        await recordCreated(
          'AdmissionCoverage',
          coverage
        );

        await safeUpdate(
          IPDAdmission,
          'IPDAdmission',
          {
            _id: admission._id
          },
          {
            coverageId: coverage._id
          }
        );
      }

      const segment =
        await IPDAccommodationSegment.findOne({
          hospitalId: hospital._id,
          admissionId: admission._id,
          status: 'active'
        }).lean();

      if (!segment && admission.bedId) {
        const bed = await Bed.findOne({
          _id: admission.bedId,
          hospitalId: hospital._id
        }).lean();

        const payload = {
          hospitalId: hospital._id,
          admissionId: admission._id,
          patientId: admission.patientId,
          wardId: admission.wardId,
          roomId: admission.roomId,
          bedId: admission.bedId,
          bedType: bed?.bedType,
          startedAt:
            admission.admissionDate
            || admission.createdAt
            || new Date(),
          dailyRate: Number(
            bed?.dailyCharge
            || admission.roomCharges
            || 0
          ),
          status: 'active'
        };

        const created = APPLY
          ? await IPDAccommodationSegment.create(payload)
          : {
              ...payload,
              _id: new mongoose.Types.ObjectId()
            };

        await recordCreated(
          'IPDAccommodationSegment',
          created
        );
      }
    }

    const flags = {
      'featureFlags.radiologyDashboard': false,
      'featureFlags.pathologyUnifiedWorklist': false,
      'featureFlags.sponsorPricing': false,
      'featureFlags.bedTransferWorkflow': false,
      'featureFlags.workforceSelfService': false,
      'featureFlags.biometricAttendance': false
    };

    await safeUpdate(
      Hospital,
      'Hospital',
      {
        _id: hospital._id
      },
      flags
    );
  }

  if (APPLY && SYNC_INDEXES) {
    const models = [
      Patient,
      Doctor,
      Department,
      Ward,
      Room,
      Bed,
      LabTest,
      ImagingTest,
      PathologyStaff,
      RadiologyStaff,
      LabRequest,
      RadiologyRequest,
      IPDAdmission,
      OfflineSyncLog,
      DischargeSummary,
      User,
      Payer,
      AdmissionCoverage,
      IPDAccommodationSegment
    ];

    for (const model of models) {
      await model.syncIndexes();
      count('indexes.synced');
    }
  }

  state.completed = true;
  state.error = null;

  await persistState();

  console.log(
    JSON.stringify(
      state.counters,
      null,
      2
    )
  );

  if (!APPLY) {
    console.log(
      'No database writes were performed. '
      + 'Re-run with --apply after reviewing the state file.'
    );
  }
}

main()
  .catch(async (error) => {
    state.completed = false;
    state.error = {
      name: error.name,
      message: error.message,
      stack: error.stack
    };

    await persistState().catch(() => {});

    console.error(error);
    console.error(`Migration state: ${STATE_PATH}`);

    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
