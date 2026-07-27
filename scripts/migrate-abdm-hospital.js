require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Patient = require('../models/Patient');
const AbdmCredential = require('../models/AbdmCredential');
const AbdmCareContext = require('../models/AbdmCareContext');
const AbdmCounterSequence = require('../models/AbdmCounterSequence');
const AbdmLinkAuthentication = require('../models/AbdmLinkAuthentication');
const AbdmIdentityTransaction = require('../models/AbdmIdentityTransaction');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const AbdmHiuRequest = require('../models/AbdmHiuRequest');
const AbdmImportedRecord = require('../models/AbdmImportedRecord');
const AbdmDataTransfer = require('../models/AbdmDataTransfer');
const AbdmAccessAudit = require('../models/AbdmAccessAudit');
const AbdmSubscription = require('../models/AbdmSubscription');
const AbdmHospitalJob = require('../models/AbdmHospitalJob');
const EHRBundle = require('../models/EHRBundle');
const { encryptJson } = require('../services/abdmVault.service');
const { normalizeSession } = require('../services/abdmCredential.service');
const { assessPatientIdentity } = require('../services/abdmIdentityMatch.service');
const {
  configuredHospitalId,
  clearConfiguredHospitalCache
} = require('../services/hospitalIdentity.service');

const apply = process.argv.includes('--apply');

async function duplicateValues(field) {
  return Patient.aggregate([
    { $match: { [field]: { $type: 'string', $ne: '' } } },
    {
      $group: {
        _id: { hospitalId: '$hospitalId', value: `$${field}` },
        count: { $sum: 1 },
        patientIds: { $push: '$_id' }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]);
}

async function migratePlaintextTokens() {
  const collection = mongoose.connection.collection('patients');
  const cursor = collection.find({
    $or: [
      { 'abha.session.xToken': { $type: 'string' } },
      { 'abha.session.refreshToken': { $type: 'string' } }
    ]
  });
  let migrated = 0;

  for await (const patient of cursor) {
    const session = patient.abha?.session || {};
    if (apply && (session.xToken || session.refreshToken)) {
      const normalized = normalizeSession({
        xToken: session.xToken,
        refreshToken: session.refreshToken,
        expiresIn: session.expiresIn,
        refreshExpiresIn: session.refreshExpiresIn
      });
      const encryptedSession = encryptJson(
        {
          accessToken: normalized.accessToken,
          refreshToken: normalized.refreshToken
        },
        `abdm-patient-session:${patient._id}`
      );
      const accessExpiresAt = session.expiresAt || normalized.accessExpiresAt;
      const refreshExpiresAt =
        session.refreshExpiresAt || normalized.refreshExpiresAt || accessExpiresAt;
      await AbdmCredential.findOneAndUpdate(
        { patientId: patient._id },
        {
          patientId: patient._id,
          hospitalId: patient.hospitalId,
          encryptedSession,
          accessExpiresAt,
          refreshExpiresAt,
          purgeAt: refreshExpiresAt,
          scopes: session.scopes || []
        },
        { upsert: true }
      );
    }
    migrated += 1;
  }

  if (apply) {
    await collection.updateMany(
      {},
      { $unset: { aadhaar_number: '', 'abha.session': '' } }
    );
  }
  return migrated;
}

async function reconcileVerifiedPatientIdentities() {
  const cursor = Patient.find({
    'abha.status': { $in: ['VERIFIED', 'verified', 'Verified'] },
    $or: [
      { 'abha.identityReconciliation.status': { $exists: false } },
      { 'abha.identityReconciliation.status': 'NOT_CHECKED' }
    ]
  }).cursor();
  const counts = { matched: 0, mismatched: 0, reviewRequired: 0 };

  for await (const patient of cursor) {
    const assessment = assessPatientIdentity(patient, patient.abha?.profile || {});
    const hasDefiniteMismatch = assessment.mismatchedFields.length > 0;
    const status = assessment.matched
      ? 'MATCHED'
      : hasDefiniteMismatch
        ? 'MISMATCH'
        : 'NOT_CHECKED';

    if (status === 'MATCHED') counts.matched += 1;
    else if (status === 'MISMATCH') counts.mismatched += 1;
    else counts.reviewRequired += 1;

    if (!apply) continue;
    const update = {
      'abha.identityReconciliation.status': status,
      'abha.identityReconciliation.checkedAt': new Date(),
      'abha.identityReconciliation.method': 'MIGRATION_STORED_PROFILE',
      'abha.identityReconciliation.score': assessment.score,
      'abha.identityReconciliation.matchedFields': assessment.matchedFields,
      'abha.identityReconciliation.mismatchedFields': assessment.mismatchedFields,
      'abha.identityReconciliation.unavailableFields': assessment.unavailableFields,
      'abha.identityReconciliation.profileFingerprint': assessment.profileFingerprint
    };
    if (status === 'MISMATCH') {
      update['abha.status'] = 'IDENTITY_MISMATCH';
      update['abha.kycVerified'] = false;
    }
    // eslint-disable-next-line no-await-in-loop
    await Patient.updateOne({ _id: patient._id }, { $set: update });
  }
  return counts;
}

async function collectionsMissingHospitalId() {
  const models = [
    AbdmCareContext,
    AbdmCounterSequence,
    AbdmLinkAuthentication,
    AbdmHospitalConsent,
    AbdmHiuRequest,
    AbdmImportedRecord,
    AbdmDataTransfer,
    AbdmAccessAudit,
    AbdmSubscription,
    AbdmHospitalJob,
    EHRBundle
  ];
  const result = {};
  for (const model of models) {
    // eslint-disable-next-line no-await-in-loop
    result[model.modelName] = await model.countDocuments({
      hospitalId: { $exists: false }
    });
  }
  return { models, result };
}

async function backfillHospitalScope(hospitalId, models) {
  for (const model of models) {
    // eslint-disable-next-line no-await-in-loop
    await model.updateMany(
      { hospitalId: { $exists: false } },
      { $set: { hospitalId } }
    );
  }
}

async function migratePlaintextClinicalArtifacts(hospitalId) {
  const consentCollection = mongoose.connection.collection('abdmhospitalconsents');
  const importedCollection = mongoose.connection.collection('abdmimportedrecords');
  let consents = 0;
  let importedRecords = 0;

  for await (const consent of consentCollection.find({
    artefact: { $exists: true }
  })) {
    consents += 1;
    if (!apply) continue;
    const identity = consent.consentId || consent.consentRequestId || consent._id;
    const encryptedArtefact = encryptJson(
      consent.artefact,
      `abdm-consent:${consent.hospitalId || hospitalId}:${consent.role || 'HIP'}:${identity}`
    );
    // eslint-disable-next-line no-await-in-loop
    await consentCollection.updateOne(
      { _id: consent._id },
      {
        $set: { encryptedArtefact },
        $unset: { artefact: '' }
      }
    );
  }

  for await (const record of importedCollection.find({
    fhirBundle: { $exists: true }
  })) {
    importedRecords += 1;
    if (!apply) continue;
    const encryptedFhirBundle = encryptJson(
      record.fhirBundle,
      `abdm-imported-record:${record.hospitalId || hospitalId}:${record.transactionId}:${record.bundleHash}`
    );
    // eslint-disable-next-line no-await-in-loop
    await importedCollection.updateOne(
      { _id: record._id },
      {
        $set: { encryptedFhirBundle },
        $unset: { fhirBundle: '' }
      }
    );
  }

  return { consents, importedRecords };
}

async function syncAbdmIndexes() {
  const models = [
    Patient,
    AbdmCredential,
    AbdmCareContext,
    AbdmCounterSequence,
    AbdmLinkAuthentication,
    AbdmIdentityTransaction,
    AbdmHospitalConsent,
    AbdmHiuRequest,
    AbdmImportedRecord,
    AbdmDataTransfer,
    AbdmAccessAudit,
    AbdmSubscription,
    AbdmHospitalJob,
    EHRBundle
  ];
  for (const model of models) {
    // eslint-disable-next-line no-await-in-loop
    await model.syncIndexes();
  }
}

async function run() {
  await connectDB();
  clearConfiguredHospitalCache();
  const hospitalId = await configuredHospitalId();
  const [numberDuplicates, addressDuplicates, missingScope] = await Promise.all([
    duplicateValues('abha.number'),
    duplicateValues('abha.address'),
    collectionsMissingHospitalId()
  ]);

  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Hospital scope: ${hospitalId}`);
  console.log(`Duplicate ABHA numbers: ${numberDuplicates.length}`);
  console.log(`Duplicate ABHA addresses: ${addressDuplicates.length}`);
  console.log('ABDM documents missing hospitalId:');
  console.log(JSON.stringify(missingScope.result, null, 2));

  if (numberDuplicates.length || addressDuplicates.length) {
    console.log(JSON.stringify({ numberDuplicates, addressDuplicates }, null, 2));
    if (apply) {
      throw new Error(
        'Resolve duplicate ABHA mappings before applying unique indexes'
      );
    }
  }

  const tokenPatients = await migratePlaintextTokens();
  console.log(`Patients with legacy plaintext ABHA sessions: ${tokenPatients}`);
  const identityReconciliation = await reconcileVerifiedPatientIdentities();
  console.log(`Verified patient identity reconciliation: ${JSON.stringify(identityReconciliation)}`);

  if (apply) {
    await backfillHospitalScope(hospitalId, missingScope.models);
  }

  const clinicalArtifacts = await migratePlaintextClinicalArtifacts(hospitalId);
  console.log(
    `Legacy plaintext consent artefacts: ${clinicalArtifacts.consents}; imported FHIR records: ${clinicalArtifacts.importedRecords}`
  );

  if (apply) {
    await syncAbdmIndexes();
    console.log(
      'Hospital scope and identity reconciliation were backfilled, sensitive ABDM artefacts were encrypted, and indexes were synchronized.'
    );
  } else {
    console.log(
      'No records were changed. Re-run with --apply after reviewing the output.'
    );
  }

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
