#!/usr/bin/env node
'use strict';

/**
 * Reset hospital operational/history data while preserving hospital setup/master data.
 *
 * SAFE DEFAULT: DRY RUN. Nothing is changed unless BOTH are supplied:
 *   --execute --confirm RESET_OPERATIONAL_DATA
 *
 * Production additionally requires:
 *   --allow-production
 *
 * If the Hospital collection contains more than one document, execution aborts unless:
 *   --allow-multiple-hospital-records
 *
 * Optional pharmacy stock rollback:
 *   --restore-pharmacy-opening-stock
 * This restores MedicineBatch.quantity(_base_units) from opening_quantity_base_units.
 * It is intentionally OFF by default because the user asked to preserve pharmacy setup/stock.
 */

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env') });

const MODEL_DIR_CANDIDATES = [
  path.resolve(__dirname, '..', 'models'),
  path.resolve(process.cwd(), 'models')
];
const MODELS_DIR = MODEL_DIR_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || MODEL_DIR_CANDIDATES[0];
const CONFIRM_TEXT = 'RESET_OPERATIONAL_DATA';

// -----------------------------------------------------------------------------
// Classification is based on the final HIMS backend repository.
// Preserved = setup/master/reference/infrastructure/ABDM identity data.
// Purged    = encounter, clinical activity, billing, finance, pharmacy history,
//             payroll/attendance history, discharge, notes, operational logs, etc.
// -----------------------------------------------------------------------------

const PRESERVE_MODEL_FILES = [
  // ABDM / identity / interoperability: explicitly preserved.
  'AbdmAccessAudit', 'AbdmCareContext', 'AbdmConsent', 'AbdmCounterSequence',
  'AbdmCredential', 'AbdmDataTransfer', 'AbdmDisclosureLedger', 'AbdmFacility',
  'AbdmHiuDataPage', 'AbdmHiuRequest', 'AbdmHospitalConsent', 'AbdmHospitalJob',
  'AbdmIdentityTransaction', 'AbdmImportedRecord', 'AbdmInternalRequest', 'AbdmJob',
  'AbdmLinkAuthentication', 'AbdmPacket', 'AbdmPacketVersion', 'AbdmSubscription',
  'AbdmTransaction', 'AbdmWebhookEvent', 'EHRBundle', 'PatientIdentityAsset',
  'PatientPortalAbdmTransaction', 'PatientPortalOtp', 'PatientVerification',
  'TerminologyCode', 'icd11.model',

  // Users / people / staff masters.
  'Admin', 'User', 'Patient', 'Customer', 'Doctor', 'Nurse', 'Staff', 'HRStaffProfile',
  'LabStaff', 'OTStaff', 'PathologyStaff', 'RadiologyStaff',

  // Hospital / configuration / access / setup.
  'Hospital', 'HospitalGroup', 'License', 'LicenseSnapshot', 'Department', 'Shift',
  'Ward', 'Room', 'Bed', 'HospitalCharges', 'HospitalPharmacySetting',
  'AdmissionWorkflowPolicy', 'FinanceFeatureFlag', 'HRWorkflowRule', 'SafetyPolicy',
  'NabhSetting', 'SetupAssistantState', 'BiometricDevice', 'BiometricEmployeeMap',

  // Clinical/service masters and templates.
  'BillingServiceMaster', 'ClinicalAssessmentDefinition', 'ClinicalOrderSet',
  'ClinicalTemplate', 'LabTest', 'ImagingTest', 'Procedure', 'PatientExperienceSurvey',

  // Pharmacy / inventory masters and current stock records.
  'Pharmacy', 'Medicine', 'MedicineBatch', 'NLEMMedicine', 'Supplier',
  'StoreCategory', 'StoreItem', 'StoreLocation', 'InventoryLot', 'AssetRegister',

  // Insurance / tariff masters.
  'InsuranceProvider', 'Payer', 'RateCard', 'RateCardItem', 'SchemeRuleProfile',
  'VendorInvoiceRule',

  // Numbering that must not be blindly reset because preserved records (especially
  // Patients/assets) may already consume these identifiers.
  'HospitalSequence',

  // Reporting/config/reference/infrastructure masters.
  'MISMetricDefinition', 'MISSchedule', 'PrintTemplate', 'PrintIdentityAsset',
  'UserPrintIdentity', 'HelpArticle', 'ReleaseVersion', 'StoredFile',
  'PlatformInternalRequest', 'PlatformProvisioningReceipt',

  // Backup metadata is infrastructure, not hospital encounter history.
  'BackupChange', 'BackupRun', 'BackupState',

  // Non-model placeholders kept here so the classification stays explicit.
  'index', 'pharmacyInvoiceModel'
];

const PURGE_MODEL_FILES = [
  // OPD / encounter / appointment lifecycle.
  'Appointment', 'AppointmentSequence', 'Calendar', 'DeskCheckout', 'Episode',
  'EmergencyEncounter', 'EmergencyMedicationChecklist', 'Referral', 'Vital',
  'Immunization', 'OfflineSyncLog',

  // IPD lifecycle / bed movement / clinical charting.
  'IPDAdmission', 'IPDAccommodationSegment', 'IPDBedTransfer', 'BedTransfer',
  'IPDCharge', 'IPDConsent', 'IPDInitialAssessment', 'IPDNursingAdmissionAssessment',
  'IPDMedicationChart', 'IPDPatientMedicineStock', 'IPDRound', 'IPDVitals',
  'NursingNote', 'PatientDietOrder', 'ShiftHandover', 'DischargeSummary',

  // Clinical activity records (masters above remain untouched).
  'Prescription', 'PrescriptionItem', 'IssuedMedicine', 'LabRequest', 'LabReport',
  'RadiologyRequest', 'ProcedureRequest', 'ClinicalAssessmentRecord', 'ClinicalDocument',
  'EncounterDocument', 'DocumentSignature', 'RenderedDocument',

  // OT / surgery operational records.
  'OTRequest', 'OTSchedule', 'OTReadinessChecklist', 'OTSurgicalSafetyChecklist',
  'OTPreAnaesthesiaAssessment', 'OTAnesthesiaRecord', 'OTOperativeNote',
  'OTRecoveryRecord', 'OTClinicalForm', 'OTCaseInventoryUsage', 'OTSpecimen',

  // Blood-bank operational history.
  'BloodComponentRequest', 'BloodDonor', 'BloodUnit',

  // Finance / billing / claims / wallets / ledgers / transactions.
  'Bill', 'BillItem', 'Invoice', 'FinancialTransaction', 'FinancialReconciliationIssue',
  'FinancialSequence', 'DailySequence', 'AdmissionCoverage', 'CoverageUtilization',
  'ClaimCase', 'ClaimEvidence', 'SponsorLedgerEntry', 'PackageEpisode', 'RepricingBatch',
  'PatientAdvanceLedger', 'PatientSettlementCredit', 'Expense',

  // Pharmacy operational history (pharmacy/medicine/batch masters stay).
  'Sale', 'PharmacyReturn', 'PharmacyLedgerEntry', 'PharmacyLedgerSettlement',
  'InventoryLedger', 'PurchaseOrder', 'PurchaseReturn', 'StockAdjustment', 'StockCount',
  'StockReservation', 'StockTransfer', 'InventoryRecall',

  // Store/procurement operational history (store masters/current inventory stay).
  'GoodsReceiptNote', 'StoreInventoryTransaction', 'StoreIssue', 'StoreIssueReturn',
  'StorePurchaseOrder', 'StorePurchaseRequisition', 'StoreQuotation', 'StoreRFQ',
  'StoreRequisition', 'SupplierQualityIssue',

  // HR/payroll/attendance/history. HR staff/profile/shift masters stay.
  'EmployeePayroll', 'HRPayroll', 'Salary', 'AttendancePunch', 'StaffAttendance',
  'StaffAvailability', 'StaffLeaveRequest', 'HRLeaveBalance', 'HRAppraisal',
  'HRInduction', 'HRTrainingAttendance', 'HRTrainingEvent',

  // MRD / quality / patient-experience activity.
  'MRDBirthDeathRecord', 'MRDFileTracking', 'MRDMedicalCertificate',
  'MRDMedicoLegalRecord', 'MRDRecordReview', 'NabhRecord', 'SafetyIncident',
  'PatientExperienceResponse', 'PatientAnnouncement',

  // Operational/audit/job/outbox history.
  'ApprovalRequest', 'AuditLog', 'BulkImportJob', 'DomainEvent', 'MISExportJob',
  'MISSnapshot', 'NotificationDelivery', 'SetupAssistantUsage', 'SupportTicketOutbox'
];

// Known historical collections that may exist even though the current repo no longer
// exports an active model for them.
const LEGACY_OPERATIONAL_COLLECTIONS = [
  'pharmacyinvoices',
  'salaries',
  'hrpayrolls'
];


// Raw/legacy collections observed in the real database dry-run. These are
// operational/history data even though they are not represented by the current
// /models directory.
const RAW_OPERATIONAL_COLLECTIONS = [
  'accounting_sync_logs',
  'ai_activity_logs',
  'ai_consents',
  'assetlifecycles',
  'audit_events',
  'breakglassgrants',
  'caremessages',
  'caremessagethreads',
  'clinical_evidence',
  'clinical_notes',
  'consultantpayouts',
  'consultantvisitlogs',
  'controlledmedicineregisters',
  'devicetelemetries',
  'edisubmissions',
  'encounters',
  'financialreconciliations',
  'follow_ups',
  'hl7exchanges',
  'intelligencefeedbacks',
  'journal_entries',
  'loyaltyledgers',
  'measureevaluations',
  'patientcareteamassignments',
  'patientrecalls',
  'payments',
  'payrollarrears',
  'peerreviews',
  'privilegedaccessrequests',
  'rosterassignments',
  'stockledgers',
  'supporttickets',
  'telesessions',
  'transitioncoordinations'
];

// Raw/legacy setup/reference/infrastructure collections intentionally preserved.
const RAW_PRESERVE_COLLECTIONS = [
  'access_policies',
  'accreditationmeasures',
  'ai_model_cards',
  'apiapps',
  'billing_rule_configs',
  'carenetworkfacilities',
  'chart_of_accounts',
  'companies',
  'companymoduleentitlements',
  'companysubscriptions',
  'consultantcontracts',
  'counters',
  'empigoldenrecords',
  'engagementcampaigns',
  'engagementsurveys',
  'marketplaceapps',
  'mobileappconfigs',
  'patientflowmodels',
  'payrollstatutoryconfigs',
  'plans',
  'platformdeliveries',
  'platformrequests',
  'rostercoveragerules',
  'shiftdefinitions',
  'webhooksubscriptions'
];

// Infrastructure/migration collections are never deleted by this script.
const INFRA_COLLECTIONS_TO_IGNORE = new Set([
  'systemmigrations', 'migrations', 'migrationhistory', 'migrationlocks'
]);

function parseArgs(argv) {
  const options = {
    execute: false,
    confirm: '',
    allowProduction: false,
    allowMultipleHospitalRecords: false,
    allowUnclassifiedCollections: false,
    restorePharmacyOpeningStock: false,
    expectedDbName: '',
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--allow-production') options.allowProduction = true;
    else if (arg === '--allow-multiple-hospital-records') options.allowMultipleHospitalRecords = true;
    else if (arg === '--allow-unclassified-collections') options.allowUnclassifiedCollections = true;
    else if (arg === '--restore-pharmacy-opening-stock') options.restorePharmacyOpeningStock = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--confirm') options.confirm = argv[++i] || '';
    else if (arg.startsWith('--confirm=')) options.confirm = arg.slice('--confirm='.length);
    else if (arg === '--expected-db-name') options.expectedDbName = argv[++i] || '';
    else if (arg.startsWith('--expected-db-name=')) options.expectedDbName = arg.slice('--expected-db-name='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`\nHospital operational-data reset\n\n` +
`Dry run (default):\n` +
`  node scripts/reset-hospital-operational-data.js\n\n` +
`Execute:\n` +
`  node scripts/reset-hospital-operational-data.js --execute --confirm ${CONFIRM_TEXT}\n\n` +
`Production DB also requires:\n` +
`  --allow-production\n\n` +
`If Hospital collection has >1 record, execution also requires:\n` +
`  --allow-multiple-hospital-records\n\n` +
`If any collection remains unclassified, execution aborts by default. After\n` +
`manual review only, override with:\n` +
`  --allow-unclassified-collections\n\n` +
`Optional, only if you deliberately want pharmacy batch quantities returned to\n` +
`their stored opening quantities:\n` +
`  --restore-pharmacy-opening-stock\n\n` +
`Optional safety check:\n` +
`  --expected-db-name YOUR_DB_NAME\n`);
}

function redactMongoUri(uri) {
  try {
    return String(uri).replace(/(mongodb(?:\+srv)?:\/\/)([^@]+)@/i, '$1***:***@');
  } catch (_error) {
    return '<redacted>';
  }
}

function requireModelFile(baseName) {
  const filename = baseName.endsWith('.model')
    ? `${baseName}.js`
    : `${baseName}.js`;
  const fullPath = path.join(MODELS_DIR, filename);
  if (!fs.existsSync(fullPath)) return null;
  const exported = require(fullPath);
  return exported && exported.collection && exported.collection.name ? exported : null;
}

function resolveCollectionNames(modelFiles) {
  const names = new Set();
  const unresolved = [];
  for (const file of modelFiles) {
    try {
      const model = requireModelFile(file);
      if (model) names.add(model.collection.name);
      else unresolved.push(file);
    } catch (error) {
      throw new Error(`Could not load model file ${file}: ${error.message}`);
    }
  }
  return { names, unresolved };
}

async function countCollection(db, name) {
  try {
    return await db.collection(name).estimatedDocumentCount();
  } catch (_error) {
    return 0;
  }
}

async function resetPreservedEmbeddedOperationalState(db, collections, options) {
  const result = [];
  const get = (modelFile) => {
    const model = requireModelFile(modelFile);
    return model ? model.collection.name : null;
  };

  const runUpdate = async (label, collectionName, filter, update, updateOptions) => {
    if (!collectionName || !collections.has(collectionName)) {
      result.push({ label, skipped: true, reason: 'collection not present' });
      return;
    }
    const coll = db.collection(collectionName);
    const matched = await coll.countDocuments(filter || {});
    if (!options.execute) {
      result.push({ label, matched, dryRun: true });
      return;
    }
    const op = await coll.updateMany(filter || {}, update, updateOptions || {});
    result.push({ label, matched: op.matchedCount, modified: op.modifiedCount });
  };

  // Patients remain, but encounter/pharmacy cached state is cleared.
  await runUpdate(
    'patients: clear active admissions, pharmacy balances, last pharmacy timestamps, coverage cache',
    get('Patient'),
    {},
    {
      $set: {
        active_admissions: [],
        pharmacy_outstanding_balance: 0,
        pharmacy_advance_balance: 0
      },
      $unset: {
        last_pharmacy_visit: '',
        last_pharmacy_transaction: '',
        lastCoveragePreference: ''
      }
    }
  );

  // Pharmacy customer profiles remain, but historical spending/loyalty totals reset.
  await runUpdate(
    'customers: reset loyalty/spend history',
    get('Customer'),
    {},
    { $set: { loyalty_points: 0, total_spent: 0 } }
  );

  // Beds remain; clinical occupancy/reservation/cleaning state is reset.
  await runUpdate(
    'beds: clear admission/reservation/cleaning links',
    get('Bed'),
    {},
    {
      $unset: {
        currentAdmissionId: '',
        reservedTransferId: '',
        reservationExpiresAt: '',
        cleaningStartedAt: '',
        cleaningCompletedAt: '',
        cleaningNote: ''
      }
    }
  );
  await runUpdate(
    'beds: occupied/reserved/cleaning -> Available (Maintenance is preserved)',
    get('Bed'),
    { status: { $in: ['Occupied', 'Reserved', 'Cleaning'] } },
    { $set: { status: 'Available' } }
  );

  // Rooms remain; remove patient assignment and normalize availability from operationalStatus.
  await runUpdate(
    'rooms: clear assigned patient',
    get('Room'),
    {},
    { $unset: { assigned_patient_id: '' } }
  );
  await runUpdate(
    'rooms: open rooms -> Available',
    get('Room'),
    { operationalStatus: { $in: ['open', null] } },
    { $set: { status: 'Available' } }
  );
  await runUpdate(
    'rooms: maintenance rooms -> Maintenance',
    get('Room'),
    { operationalStatus: 'maintenance' },
    { $set: { status: 'Maintenance' } }
  );
  await runUpdate(
    'rooms: closed rooms -> Closed',
    get('Room'),
    { operationalStatus: 'closed' },
    { $set: { status: 'Closed' } }
  );

  // Stock reservations are purged, so preserved inventory lots must not retain reserved balances.
  await runUpdate(
    'inventory lots: clear reservations but preserve on-hand stock',
    get('InventoryLot'),
    {},
    [
      {
        $set: {
          totalReserved: 0,
          totalAvailable: { $ifNull: ['$totalOnHand', 0] },
          locationBalances: {
            $map: {
              input: { $ifNull: ['$locationBalances', []] },
              as: 'balance',
              in: {
                $mergeObjects: [
                  '$$balance',
                  {
                    reserved: 0,
                    available: { $ifNull: ['$$balance.onHand', 0] }
                  }
                ]
              }
            }
          }
        }
      },
      { $unset: 'grnId' }
    ]
  );

  // These preserved masters can otherwise point to deleted purchase/GRN history.
  await runUpdate(
    'medicines: remove deleted purchase-order provenance pointer',
    get('Medicine'),
    { created_from_purchase_order_id: { $exists: true } },
    { $unset: { created_from_purchase_order_id: '' } }
  );
  await runUpdate(
    'assets: remove deleted PO/GRN pointers',
    get('AssetRegister'),
    { $or: [{ purchaseOrderId: { $exists: true } }, { grnId: { $exists: true } }] },
    { $unset: { purchaseOrderId: '', grnId: '' } }
  );

  if (options.restorePharmacyOpeningStock) {
    await runUpdate(
      'medicine batches: restore current quantity from opening_quantity_base_units',
      get('MedicineBatch'),
      { opening_quantity_base_units: { $type: 'number' } },
      [
        {
          $set: {
            quantity_base_units: '$opening_quantity_base_units',
            quantity: '$opening_quantity_base_units'
          }
        }
      ]
    );
  }

  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required in the environment/.env');

  if (options.execute && options.confirm !== CONFIRM_TEXT) {
    throw new Error(`Execution requires --confirm ${CONFIRM_TEXT}`);
  }
  if (options.execute && String(process.env.NODE_ENV || '').toLowerCase() === 'production' && !options.allowProduction) {
    throw new Error('NODE_ENV=production: add --allow-production only after taking a verified backup');
  }

  console.log(`Mode: ${options.execute ? 'EXECUTE (DESTRUCTIVE)' : 'DRY RUN (no writes)'}`);
  console.log(`Mongo: ${redactMongoUri(mongoUri)}`);

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 15000
  });

  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  console.log(`Database: ${dbName}`);

  if (options.expectedDbName && options.expectedDbName !== dbName) {
    throw new Error(`Connected DB '${dbName}' does not match --expected-db-name '${options.expectedDbName}'`);
  }

  const collectionInfos = await db.listCollections({}, { nameOnly: false }).toArray();
  const existingCollections = new Set(
    collectionInfos
      .filter((row) => row.type === 'collection' && !String(row.name).startsWith('system.'))
      .map((row) => row.name)
  );

  const purgeResolved = resolveCollectionNames(PURGE_MODEL_FILES);
  const preserveResolved = resolveCollectionNames(PRESERVE_MODEL_FILES);
  const purgeCollections = new Set([
    ...purgeResolved.names,
    ...LEGACY_OPERATIONAL_COLLECTIONS,
    ...RAW_OPERATIONAL_COLLECTIONS
  ]);
  const preserveCollections = new Set([
    ...preserveResolved.names,
    ...INFRA_COLLECTIONS_TO_IGNORE,
    ...RAW_PRESERVE_COLLECTIONS
  ]);

  // User requirement: all ABDM/ABHA collections stay untouched.
  for (const name of existingCollections) {
    if (String(name).toLowerCase().startsWith('abdm')) preserveCollections.add(name);
  }

  // Never delete a collection that appears in both sets.
  for (const name of preserveCollections) purgeCollections.delete(name);

  const presentPurgeCollections = [...purgeCollections].filter((name) => existingCollections.has(name)).sort();
  const unknownCollections = [...existingCollections]
    .filter((name) => !purgeCollections.has(name) && !preserveCollections.has(name))
    .sort();

  const hospitalModel = requireModelFile('Hospital');
  const hospitalCollection = hospitalModel ? hospitalModel.collection.name : 'hospitals';
  let hospitals = [];
  if (existingCollections.has(hospitalCollection)) {
    hospitals = await db.collection(hospitalCollection)
      .find({}, { projection: { hospitalName: 1, hospitalID: 1, tenantCode: 1, 'deployment.databaseName': 1 } })
      .limit(20)
      .toArray();
  }

  console.log(`Hospital records found: ${hospitals.length}${hospitals.length >= 20 ? '+' : ''}`);
  for (const h of hospitals) {
    console.log(`  - ${h.hospitalName || '<unnamed>'} | ${h.hospitalID || h.tenantCode || h._id} | _id=${h._id}`);
  }

  if (hospitals.length > 1) {
    console.warn('\nWARNING: more than one Hospital document exists in this database.');
    console.warn('This reset deletes operational collections database-wide.');
    if (options.execute && !options.allowMultipleHospitalRecords) {
      throw new Error('Refusing execution. Re-run only after verification with --allow-multiple-hospital-records');
    }
  }

  console.log('\nCollections scheduled for complete purge:');
  let totalDocs = 0;
  const purgePlan = [];
  for (const name of presentPurgeCollections) {
    const count = await countCollection(db, name);
    totalDocs += count;
    purgePlan.push({ name, count });
    console.log(`  ${name.padEnd(40)} ${String(count).padStart(10)}`);
  }
  console.log(`Total documents scheduled for purge: ${totalDocs}`);

  if (unknownCollections.length) {
    console.log('\nUnclassified collections (NOT TOUCHED):');
    for (const name of unknownCollections) console.log(`  - ${name}`);
    console.log('Review these manually. The script intentionally never deletes an unknown collection.');
    if (options.execute && !options.allowUnclassifiedCollections) {
      throw new Error('Refusing execution because unclassified collections remain. Review them first or explicitly add --allow-unclassified-collections');
    }
  }

  console.log('\nPreserved-record cleanup plan:');
  const embeddedPlan = await resetPreservedEmbeddedOperationalState(db, existingCollections, { ...options, execute: false });
  for (const row of embeddedPlan) {
    const suffix = row.skipped ? `SKIP (${row.reason})` : `${row.matched || 0} record(s)`;
    console.log(`  - ${row.label}: ${suffix}`);
  }

  if (!options.execute) {
    console.log('\nDRY RUN COMPLETE. No data was changed.');
    console.log(`To execute: node scripts/reset-hospital-operational-data.js --execute --confirm ${CONFIRM_TEXT}`);
    console.log('Take a verified database backup first.');
    return;
  }

  console.log('\n=== EXECUTING RESET ===');
  const deletedSummary = [];
  for (const { name, count } of purgePlan) {
    if (!count) {
      deletedSummary.push({ name, deleted: 0 });
      continue;
    }
    const result = await db.collection(name).deleteMany({});
    deletedSummary.push({ name, deleted: result.deletedCount });
    console.log(`Deleted ${result.deletedCount} from ${name}`);
  }

  const resetSummary = await resetPreservedEmbeddedOperationalState(db, existingCollections, options);
  console.log('\nPreserved-record state resets:');
  for (const row of resetSummary) {
    if (row.skipped) console.log(`  - ${row.label}: SKIPPED (${row.reason})`);
    else console.log(`  - ${row.label}: matched=${row.matched || 0}, modified=${row.modified || 0}`);
  }

  const remaining = [];
  for (const name of presentPurgeCollections) {
    const count = await countCollection(db, name);
    if (count !== 0) remaining.push({ name, count });
  }

  console.log('\n=== RESET SUMMARY ===');
  console.log(`Purged collections: ${deletedSummary.length}`);
  console.log(`Deleted documents: ${deletedSummary.reduce((sum, row) => sum + row.deleted, 0)}`);
  console.log(`Remaining docs in purge collections: ${remaining.reduce((sum, row) => sum + row.count, 0)}`);

  if (remaining.length) {
    console.error('ERROR: Some purge collections are not empty:');
    for (const row of remaining) console.error(`  - ${row.name}: ${row.count}`);
    process.exitCode = 2;
  } else {
    console.log('Operational/history collections are empty.');
  }

  if (options.restorePharmacyOpeningStock) {
    console.log('Pharmacy batch stock was restored from opening_quantity_base_units where available.');
  } else {
    console.log('Pharmacy/current inventory quantities were PRESERVED. Use --restore-pharmacy-opening-stock only if that is intentionally desired.');
  }

  if (unknownCollections.length) {
    console.log(`Unclassified collections left untouched: ${unknownCollections.join(', ')}`);
  }
}

main()
  .catch((error) => {
    console.error(`\nRESET ABORTED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_error) {
      // no-op
    }
  });
