#!/usr/bin/env node

/*
 * Imports the ICICI Lombard / Vy Hospital rate list and seeds the missing
 * non-dental procedure catalogue for one hospital.
 *
 * Safety model:
 *   - dry-run by default
 *   - rate card always remains STAGING
 *   - generated Procedure mappings remain SUGGESTED, never approved
 *   - generated procedures remain inactive unless --activate-procedures is used
 *   - source has no W.E.F. date, therefore --effective-from is mandatory
 *
 * Required model support:
 *   - Procedure.hospitalId with unique { hospitalId, code }
 *   - RateCardItem.wardRates for exact general/semi-private/private prices
 *
 * Preview:
 *   node scripts/import-lombard-vy-rate-list.js \
 *     --hospital 69a697c0df37f940dd7906ce \
 *     --effective-from 2026-08-01
 *
 * Apply:
 *   node scripts/import-lombard-vy-rate-list.js \
 *     --hospital 69a697c0df37f940dd7906ce \
 *     --payer LEGACY-ICICI \
 *     --effective-from 2026-08-01 \
 *     --apply --migrate-indexes
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const connectDB = require('../config/db');
const Hospital = require('../models/Hospital');
const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');
const Procedure = require('../models/Procedure');
const ImagingTest = require('../models/ImagingTest');

const APPLY = process.argv.includes('--apply');
const MIGRATE_INDEXES = process.argv.includes('--migrate-indexes');
const ACTIVATE_PROCEDURES = process.argv.includes('--activate-procedures');
const PROCEDURES_ONLY = process.argv.includes('--procedures-only');
const RATE_CARD_ONLY = process.argv.includes('--rate-card-only');

function arg(name) {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArg(name) {
  const value = arg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function asObjectId(value) {
  return mongoose.isValidObjectId(value)
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function isoDate(value, label) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date in YYYY-MM-DD format`);
  }
  return date;
}

function sha256(filepath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== undefined)
  );
}

function wardRateDocument(wardRates) {
  return compactObject({
    general: wardRates?.general,
    semi_private: wardRates?.semi_private,
    private: wardRates?.private,
    icu: wardRates?.icu,
    day_care: wardRates?.day_care,
    not_applicable: wardRates?.not_applicable
  });
}

function allEqual(values) {
  const numbers = values.filter((value) => value !== null && value !== undefined);
  return numbers.length > 0 && numbers.every((value) => Number(value) === Number(numbers[0]));
}

function sourceRaw(payload, extra = {}) {
  return {
    sourceHospital: payload.source.hospitalName,
    sourceLocation: payload.source.location,
    networkCode: payload.source.networkCode,
    sourceEffectiveDate: payload.source.effectiveDate,
    generatedExternalCode: true,
    ...extra
  };
}

function procedureDocument(payload, row, hospitalId, createdBy) {
  return {
    hospitalId,
    code: row.internalProcedureCode,
    name: row.externalName,
    category: row.specialty,
    subcategory: row.sourceCategory,
    description: `Procedure catalogue seed from ${payload.source.title}, page ${row.sourceRow.page}. Payer-contracted prices are stored in the payer rate card and are not used as the hospital standard price.`,
    base_price: 0,
    insurance_coverage: 'Pre-authorization Required',
    facility_level: ['Secondary'],
    consent_required: true,
    is_active: ACTIVATE_PROCEDURES,
    created_by: createdBy || undefined,
    version: '1.0',
    tags: ['lombard-seed', 'payer-derived-catalogue', row.specialty],
    notes: `Source external code ${row.externalCode}; source category ${row.sourceCategory}. Hospital standard price requires review before activation.`
  };
}

async function resolveHospital(hospitalRef) {
  const objectId = asObjectId(hospitalRef);
  const clauses = [
    objectId ? { _id: objectId } : null,
    { hospitalID: hospitalRef },
    { tenantCode: hospitalRef }
  ].filter(Boolean);
  const hospital = await Hospital.findOne({ $or: clauses });
  if (!hospital) throw new Error(`Hospital not found: ${hospitalRef}`);
  return hospital;
}

async function resolvePayer({ hospitalId, payerRef, createdBy }) {
  const objectId = asObjectId(payerRef);
  const clauses = [
    objectId ? { _id: objectId } : null,
    { code: String(payerRef).toUpperCase() }
  ].filter(Boolean);

  let payer = await Payer.findOne({ hospitalId, $or: clauses });
  if (payer || !APPLY) return payer;

  payer = await Payer.create({
    hospitalId,
    code: 'ICICI-LOMBARD',
    name: 'ICICI Lombard General Insurance Co. Ltd.',
    type: 'private_insurer',
    empanelment: { status: 'pending' },
    settlementTerms: { creditDays: 30, claimSubmissionDays: 7 },
    contacts: [],
    documentChecklist: [],
    isActive: true,
    createdBy,
    updatedBy: createdBy
  });
  return payer;
}

async function previewProcedureScope(hospitalId) {
  const collection = mongoose.connection.collection(Procedure.collection.name);
  const [total, unscoped, scoped] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({ hospitalId: { $exists: false } }),
    collection.countDocuments({ hospitalId })
  ]);
  return { total, unscoped, scopedToSelectedHospital: scoped };
}

async function assignUnscopedProcedures(hospitalId) {
  const collection = mongoose.connection.collection(Procedure.collection.name);
  return collection.updateMany(
    { $or: [{ hospitalId: { $exists: false } }, { hospitalId: null }] },
    { $set: { hospitalId } }
  );
}

async function migrateProcedureIndexes() {
  const collection = mongoose.connection.collection(Procedure.collection.name);
  const indexes = await collection.indexes();
  const globalCodeIndex = indexes.find(
    (index) => index.unique && JSON.stringify(index.key) === JSON.stringify({ code: 1 })
  );
  if (globalCodeIndex) await collection.dropIndex(globalCodeIndex.name);
  await collection.createIndex(
    { hospitalId: 1, code: 1 },
    { unique: true, name: 'hospitalId_1_code_1' }
  );
  return { droppedGlobalCodeIndex: globalCodeIndex?.name || null };
}

async function seedProcedures(payload, hospitalId, createdBy) {
  const operations = payload.packages.map((row) => ({
    updateOne: {
      filter: { hospitalId, code: row.internalProcedureCode },
      update: {
        $set: procedureDocument(payload, row, hospitalId, createdBy),
        $setOnInsert: { usage_count: 0 }
      },
      upsert: true
    }
  }));

  if (!APPLY) {
    const existing = await Procedure.countDocuments({
      hospitalId,
      code: { $in: payload.packages.map((row) => row.internalProcedureCode) }
    });
    return {
      planned: operations.length,
      existing,
      new: operations.length - existing,
      activated: ACTIVATE_PROCEDURES
    };
  }

  const result = await Procedure.bulkWrite(operations, { ordered: false });
  const count = await Procedure.countDocuments({
    hospitalId,
    code: { $in: payload.packages.map((row) => row.internalProcedureCode) }
  });
  if (count !== payload.counts.packageItems) {
    throw new Error(`Procedure validation failed: expected ${payload.counts.packageItems}, found ${count}`);
  }
  return {
    planned: operations.length,
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount,
    validated: count,
    activated: ACTIVATE_PROCEDURES
  };
}

async function procedureMap(hospitalId, code) {
  const procedure = await Procedure.findOne({ hospitalId, code }).select('_id code');
  if (!procedure) return { mappingStatus: 'unmapped' };
  return {
    model: 'Procedure',
    id: procedure._id,
    code: procedure.code,
    mappingStatus: 'suggested'
  };
}

async function investigationMap(hospitalId, name) {
  const aliases = {
    'MammoGraphy': ['Mammography'],
    '2D Echo': ['Echocardiography', 'Echocardiography (2D/Doppler)']
  };
  const names = [name, ...(aliases[name] || [])];
  const row = await ImagingTest.findOne({
    hospitalId,
    is_active: { $ne: false },
    name: { $in: names }
  }).select('_id code name');
  if (!row) return { mappingStatus: 'unmapped' };
  return {
    model: 'ImagingTest',
    id: row._id,
    code: row.code,
    mappingStatus: 'suggested'
  };
}

async function buildRateCardItems(payload, hospitalId) {
  const items = [];
  let serialNumber = 0;
  const nextSourceRow = (page, raw) => ({
    page,
    serialNumber: ++serialNumber,
    raw: sourceRaw(payload, raw)
  });

  for (const row of payload.packages) {
    const wardRates = wardRateDocument(row.wardRates);
    items.push({
      externalCode: row.externalCode,
      externalName: row.externalName,
      serviceType: 'procedure',
      specialty: row.specialty,
      category: row.sourceCategory,
      internalService: await procedureMap(hospitalId, row.internalProcedureCode),
      rates: {},
      wardRates,
      billingUnit: 'package',
      packagePeriodDays: null,
      wardUniform: allEqual(Object.values(wardRates)),
      allowedWards: Object.keys(wardRates),
      inclusions: row.inclusions,
      exclusions: row.exclusions,
      nonAdmissibleRules: [],
      active: true,
      sourceRow: nextSourceRow(row.sourceRow.page, {
        sourceSerialNumber: row.sourceRow.serialNumber,
        sourceCategory: row.sourceCategory,
        inclusionCodes: row.inclusionCodes,
        exclusionCodes: row.exclusionCodes,
        internalProcedureCode: row.internalProcedureCode,
        wardRates
      })
    });
  }

  for (const grade of payload.nonPackageGrades) {
    for (const component of grade.components) {
      const wardRates = wardRateDocument(component.wardRates);
      items.push({
        externalCode: `IL-VY-NP-G${grade.grade}-${component.code}`,
        externalName: `${grade.label} - ${component.name}`,
        serviceType: component.code === 'OT' || component.code === 'OT-GASES' ? 'ot' : 'procedure',
        specialty: 'Surgery',
        category: `Non Package Grade ${grade.grade}`,
        internalService: { mappingStatus: 'unmapped' },
        rates: {},
        wardRates,
        billingUnit: 'component',
        wardUniform: allEqual(Object.values(wardRates)),
        allowedWards: Object.keys(wardRates),
        inclusions: [],
        exclusions: [],
        nonAdmissibleRules: [],
        active: true,
        sourceRow: nextSourceRow(grade.page, {
          grade: grade.grade,
          gradeLabel: grade.label,
          componentCode: component.code,
          wardRates
        })
      });
    }
  }

  for (const room of payload.generalHospitalCharges.rooms) {
    items.push({
      externalCode: room.externalCode,
      externalName: `${room.roomName} - Room Rent`,
      serviceType: 'bed',
      specialty: 'Accommodation',
      category: room.roomType,
      internalService: { mappingStatus: 'unmapped' },
      rates: { flatAmount: room.roomRent },
      billingUnit: 'per_day',
      wardUniform: true,
      allowedWards: [room.ward],
      inclusions: [room.nursing],
      exclusions: [],
      nonAdmissibleRules: [],
      active: true,
      sourceRow: nextSourceRow(room.page, { room })
    });

    items.push({
      externalCode: `${room.externalCode}-DOCTOR-VISIT`,
      externalName: `${room.roomName} - Doctor Visit Charges Per Day`,
      serviceType: 'consultation',
      specialty: 'Consultation',
      category: room.roomType,
      internalService: { mappingStatus: 'unmapped' },
      rates: { flatAmount: room.doctorVisitPerDay },
      billingUnit: 'per_day',
      wardUniform: true,
      allowedWards: [room.ward],
      inclusions: [],
      exclusions: [],
      nonAdmissibleRules: [],
      active: true,
      sourceRow: nextSourceRow(room.page, { room, chargeKind: 'doctor_visit' })
    });

    items.push({
      externalCode: `${room.externalCode}-SUPER-SPECIALIST`,
      externalName: `${room.roomName} - Super Specialist Charges Per Visit`,
      serviceType: 'consultation',
      specialty: 'Consultation',
      category: room.roomType,
      internalService: { mappingStatus: 'unmapped' },
      rates: { flatAmount: room.superSpecialistPerVisit },
      billingUnit: 'per_visit',
      wardUniform: true,
      allowedWards: [room.ward],
      inclusions: [],
      exclusions: [],
      nonAdmissibleRules: [],
      active: true,
      sourceRow: nextSourceRow(room.page, { room, chargeKind: 'super_specialist_visit' })
    });
  }

  for (const equipment of payload.specialEquipmentAndInvestigations.roomEquipment) {
    items.push({
      externalCode: equipment.externalCode,
      externalName: equipment.name,
      serviceType: 'equipment',
      specialty: 'Room/ICU Equipment',
      category: 'Equipment',
      internalService: { mappingStatus: 'unmapped' },
      rates: { flatAmount: equipment.amount },
      billingUnit: 'per_use',
      wardUniform: true,
      allowedWards: ['general', 'semi_private', 'private', 'icu', 'day_care'],
      inclusions: [],
      exclusions: [],
      nonAdmissibleRules: [],
      active: true,
      sourceRow: nextSourceRow(equipment.page, { equipment })
    });
  }

  for (const equipment of payload.specialEquipmentAndInvestigations.otEquipment) {
    const code = String(equipment.name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    items.push({
      externalCode: `IL-VY-OT-EQ-${code}`,
      externalName: equipment.name,
      serviceType: 'equipment',
      specialty: 'OT Equipment',
      category: 'Inclusive in OT Charges',
      internalService: { mappingStatus: 'unmapped' },
      rates: { flatAmount: 0 },
      billingUnit: 'per_use',
      wardUniform: true,
      allowedWards: [],
      inclusions: ['Inclusive in OT Charges'],
      exclusions: ['Standalone billing is not permitted under this rate list'],
      nonAdmissibleRules: [{
        code: 'INCLUSIVE_IN_OT',
        description: 'This equipment is inclusive in OT charges and must not be billed separately',
        percentage: 100
      }],
      active: false,
      sourceRow: nextSourceRow(equipment.page, { equipment })
    });
  }

  for (const investigation of payload.specialEquipmentAndInvestigations.specialInvestigations) {
    items.push({
      externalCode: investigation.externalCode,
      externalName: investigation.name,
      serviceType: investigation.serviceType,
      specialty: 'Special Investigation',
      category: 'Special Investigation',
      internalService: await investigationMap(hospitalId, investigation.name),
      rates: { flatAmount: investigation.amount },
      billingUnit: 'per_procedure',
      wardUniform: true,
      allowedWards: ['general', 'semi_private', 'private', 'icu', 'day_care', 'not_applicable'],
      inclusions: [],
      exclusions: [],
      nonAdmissibleRules: [],
      active: true,
      sourceRow: nextSourceRow(investigation.page, { investigation })
    });
  }

  return items;
}

async function importRateCard({ payload, hospital, payer, effectiveFrom, version, createdBy }) {
  if (!payer && !APPLY) {
    return {
      planned: true,
      blocker: 'Payer does not exist. Apply mode would create ICICI-LOMBARD in pending empanelment status.'
    };
  }

  const payerId = payer?._id;
  let card = payerId
    ? await RateCard.findOne({ hospitalId: hospital._id, payerId, version })
    : null;

  if (card?.status === 'active') {
    throw new Error('An active rate card cannot be overwritten. Use a new --version.');
  }

  const items = await buildRateCardItems(payload, hospital._id);
  const uniqueCodes = new Set(items.map((item) => item.externalCode));
  if (uniqueCodes.size !== items.length) throw new Error('Generated Lombard external codes are not unique');

  const expected =
    payload.counts.packageItems +
    payload.counts.nonPackageGradeComponents +
    payload.counts.roomTypes * 3 +
    payload.counts.roomEquipment +
    payload.counts.otEquipmentInclusive +
    payload.counts.specialInvestigations;
  if (items.length !== expected) {
    throw new Error(`Rate item build failed: expected ${expected}, generated ${items.length}`);
  }

  const summary = {
    version,
    status: 'staging',
    expectedItems: expected,
    procedurePackages: payload.counts.packageItems,
    suggestedMappings: items.filter((item) => item.internalService?.mappingStatus === 'suggested').length,
    unmapped: items.filter((item) => item.internalService?.mappingStatus === 'unmapped').length,
    inactiveInclusiveItems: items.filter((item) => item.active === false).length
  };

  if (!APPLY) return { planned: true, ...summary };

  card = await RateCard.findOneAndUpdate(
    { hospitalId: hospital._id, payerId: payer._id, version },
    {
      $set: {
        name: 'ICICI Lombard - Vy Hospital Rate List',
        currency: 'INR',
        effectiveFrom,
        status: 'staging',
        applicability: {
          cityTiers: [],
          accreditations: [],
          wardEntitlements: ['general', 'semi_private', 'private', 'icu', 'day_care', 'not_applicable']
        },
        rules: {
          baseWard: 'semi_private',
          wardFactors: { general: 1, semi_private: 1, private: 1, icu: 1, day_care: 1 },
          accreditationFactors: { non_nabh_non_nabl: 1, nabh_nabl: 1, super_speciality: 1 },
          cityTierFactors: { I: 1, II: 1, III: 1 },
          sameOtSession: payload.rules.sameOtSession,
          bilateralSecondFactor: 0.5,
          withinPackagePeriodFactor: 1,
          wardUniformCategories: [],
          rounding: 'two_decimals'
        },
        source: {
          title: payload.source.title,
          filename: payload.source.filename,
          checksum: payload.source.sha256,
          effectiveDate: effectiveFrom,
          pageOrAnnexure: 'Pages 1-7',
          uploadedBy: createdBy,
          uploadedAt: new Date()
        },
        itemCount: items.length,
        updatedBy: createdBy
      },
      $setOnInsert: { createdBy }
    },
    { new: true, upsert: true, runValidators: true }
  );

  const operations = items.map((item) => ({
    updateOne: {
      filter: { rateCardId: card._id, externalCode: item.externalCode },
      update: {
        $set: {
          ...item,
          hospitalId: hospital._id,
          payerId: payer._id,
          rateCardId: card._id
        }
      },
      upsert: true
    }
  }));

  const result = await RateCardItem.bulkWrite(operations, { ordered: false });
  const count = await RateCardItem.countDocuments({ rateCardId: card._id });
  if (count !== expected) {
    throw new Error(`Post-import validation failed: expected ${expected}, found ${count}`);
  }
  card.itemCount = count;
  await card.save();

  return {
    planned: false,
    ...summary,
    payerId: payer._id,
    rateCardId: card._id,
    itemCount: count,
    bulkResult: {
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upserted: result.upsertedCount
    }
  };
}

async function main() {
  if (PROCEDURES_ONLY && RATE_CARD_ONLY) {
    throw new Error('--procedures-only and --rate-card-only cannot be used together');
  }

  const hospitalRef = requiredArg('hospital');
  const payerRef = arg('payer') || 'LEGACY-ICICI';
  const createdBy = asObjectId(arg('created-by'));
  const dataPath = path.resolve(
    arg('file') || path.join(__dirname, '../data/lombard-vy-rate-list.json')
  );
  const payload = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  if (payload.counts?.packageItems !== 125 || payload.packages?.length !== 125) {
    throw new Error('Lombard source validation failed: exactly 125 package procedures are required');
  }
  if (new Set(payload.packages.map((row) => row.externalCode)).size !== 125) {
    throw new Error('Duplicate package external codes detected');
  }
  if (new Set(payload.packages.map((row) => row.internalProcedureCode)).size !== 125) {
    throw new Error('Duplicate generated internal procedure codes detected');
  }

  const sourcePdfArg = arg('source-pdf');
  if (sourcePdfArg) {
    const sourcePdf = path.resolve(sourcePdfArg);
    const actualChecksum = sha256(sourcePdf);
    if (actualChecksum !== payload.source.sha256) {
      throw new Error(`Source PDF checksum mismatch: expected ${payload.source.sha256}, got ${actualChecksum}`);
    }
  }

  const effectiveFrom = RATE_CARD_ONLY || !PROCEDURES_ONLY
    ? isoDate(requiredArg('effective-from'), '--effective-from')
    : null;
  const defaultVersion = effectiveFrom
    ? `ICICI-LOMBARD-VY-${effectiveFrom.toISOString().slice(0, 10)}-v1`
    : null;
  const version = arg('version') || defaultVersion;

  await connectDB();
  const hospital = await resolveHospital(hospitalRef);
  const scopeBefore = await previewProcedureScope(hospital._id);

  const output = {
    mode: APPLY ? 'apply' : 'dry-run',
    hospital: {
      id: hospital._id,
      name: hospital.name || hospital.hospitalName || hospital.hospitalID
    },
    source: payload.source,
    warnings: [
      'The source PDF identifies the hospital as Non Network.',
      'The W.E.F. / effective-date field is blank in the source; the CLI date is operator-supplied.',
      'The source contains no payer procedure codes; deterministic IL-VY-* external codes are generated.',
      'Procedure base prices are set to 0 because contracted insurer prices must not become self-pay hospital prices.',
      'The rate card remains STAGING and all generated mappings remain SUGGESTED.'
    ],
    procedureScopeBefore: scopeBefore
  };

  if (!RATE_CARD_ONLY) {
    if (APPLY && scopeBefore.unscoped > 0) {
      const result = await assignUnscopedProcedures(hospital._id);
      output.assignedExistingUnscopedProcedures = result.modifiedCount;
    } else {
      output.plannedExistingUnscopedProcedureAssignment = scopeBefore.unscoped;
    }

    if (APPLY && MIGRATE_INDEXES) {
      output.indexMigration = await migrateProcedureIndexes();
    } else if (MIGRATE_INDEXES) {
      output.indexMigration = { planned: true };
    } else {
      output.warnings.push('Procedure index migration was not requested. Use --migrate-indexes after reviewing duplicate codes.');
    }

    output.procedureSeed = await seedProcedures(payload, hospital._id, createdBy);
  }

  if (!PROCEDURES_ONLY) {
    const payer = await resolvePayer({ hospitalId: hospital._id, payerRef, createdBy });
    output.payer = payer
      ? {
          id: payer._id,
          code: payer.code,
          name: payer.name,
          empanelmentStatus: payer.empanelment?.status
        }
      : { code: payerRef, exists: false };
    if (payer?.empanelment?.status === 'active' && payload.source.networkCode === 'Non Network') {
      output.warnings.push('Existing payer empanelment is active, but the uploaded source says Non Network. The script does not change payer status; review this discrepancy manually.');
    }
    output.rateCard = await importRateCard({
      payload,
      hospital,
      payer,
      effectiveFrom,
      version,
      createdBy
    });
  }

  output.procedureScopeAfter = await previewProcedureScope(hospital._id);
  console.log(JSON.stringify(output, null, 2));

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply after reviewing the plan.');
  } else {
    console.log('\nImport completed in STAGING. Do not activate until procedure prices, mappings, payer/network status and the operator-supplied effective date are reviewed.');
  }
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
