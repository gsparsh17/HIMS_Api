const AbdmPacket = require('../models/AbdmPacket');
const AbdmPacketVersion = require('../models/AbdmPacketVersion');
const AbdmDisclosureLedger = require('../models/AbdmDisclosureLedger');
const AbdmAccessAudit = require('../models/AbdmAccessAudit');
const AbdmCareContext = require('../models/AbdmCareContext');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const Patient = require('../models/Patient');
const abdmConfig = require('../config/abdm.config');
const { PROFILE_NAMES } = require('../config/abdm.profiles');
const {
  COLLECTIONS,
  generateAbdmHiBundle
} = require('./fhir/abdmHiBundle.service');
const { validateBundle } = require('./abdmFhirValidation.service');
const { assertContextAllowed } = require('./abdmConsentPolicy.service');
const { encryptJson, decryptJson } = require('./abdmVault.service');
const { canonicalJson, sha256 } = require('../utils/abdmCanonical');

function appError(message, statusCode = 400, code = 'ABDM_PACKET_ERROR', details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function normalizedRole(user) {
  return String(user?.role || '').trim().toLowerCase();
}

function fhirProfile(hiType) {
  const profile = PROFILE_NAMES[hiType];
  if (!profile) throw appError(`Unsupported ABDM HI type ${hiType}`, 422, 'ABDM_PACKET_HI_TYPE_UNSUPPORTED');
  return `${abdmConfig.fhirProfileBase}/${profile}`;
}

function packetAad(version) {
  return `abdm-packet:${version.packetId}:${version.version}:${version.bundleHash}`;
}

function safePacketVersion(version) {
  const value = version?.toObject ? version.toObject() : { ...(version || {}) };
  delete value.encryptedBundle;
  return value;
}

function bundleSummary(bundle) {
  const entries = Array.isArray(bundle?.entry) ? bundle.entry : [];
  const counts = {};
  for (const entry of entries) {
    const type = entry?.resource?.resourceType || 'Unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  const composition = entries[0]?.resource;
  return {
    profile: composition?.meta?.profile?.[0] || null,
    title: composition?.title || null,
    timestamp: bundle?.timestamp || null,
    resourceCount: entries.length,
    resourceCounts: counts,
    sections: (composition?.section || []).map((section) => ({
      title: section.title || null,
      code: section.code?.coding?.[0]?.code || null,
      entryCount: Array.isArray(section.entry) ? section.entry.length : 0
    }))
  };
}

function isExcludedSource(document) {
  const status = String(
    document?.status ||
      document?.document_stage ||
      document?.documentStage ||
      ''
  ).trim().toUpperCase();
  if (['DRAFT', 'PENDING', 'CANCELLED', 'CANCELED', 'VOID', 'DELETED'].includes(status)) {
    return `SOURCE_STATUS_${status}`;
  }
  return null;
}

async function contextForHospital(contextId, hospitalId) {
  const context = await AbdmCareContext.findOne({
    _id: contextId,
    hospitalId,
    active: { $ne: false }
  });
  if (!context) throw appError('Care context not found', 404, 'ABDM_CARE_CONTEXT_NOT_FOUND');
  const patient = await Patient.findOne({ _id: context.patientId, hospitalId });
  if (!patient) throw appError('Patient not found', 404, 'ABDM_PATIENT_NOT_FOUND');
  return { context, patient };
}

async function buildSourceManifest(context) {
  const references = Array.isArray(context.records) ? context.records : [];
  if (references.length > abdmConfig.packetMaxSources) {
    throw appError(
      `Care context contains ${references.length} sources; maximum is ${abdmConfig.packetMaxSources}`,
      413,
      'ABDM_PACKET_SOURCE_LIMIT'
    );
  }

  const manifest = [];
  for (const reference of references) {
    const collection = COLLECTIONS[reference.model];
    if (!collection) {
      manifest.push({
        model: reference.model || 'Unknown',
        recordId: reference.recordId,
        revision: 'unknown',
        sourceHash: sha256(canonicalJson({ model: reference.model, recordId: String(reference.recordId) })),
        included: false,
        reason: 'UNSUPPORTED_SOURCE_MODEL'
      });
      continue;
    }

    // Query by both source identifier and patient. This prevents a care-context
    // reference from being used to retrieve another patient's record.
    // eslint-disable-next-line no-await-in-loop
    const document = await collection.model
      .findOne({
        _id: reference.recordId,
        [collection.patientField]: context.patientId
      })
      .lean();
    if (!document) {
      manifest.push({
        model: reference.model,
        recordId: reference.recordId,
        revision: 'missing',
        sourceHash: sha256(canonicalJson({ model: reference.model, recordId: String(reference.recordId), missing: true })),
        included: false,
        reason: 'SOURCE_NOT_FOUND'
      });
      continue;
    }

    const excludedReason = isExcludedSource(document);
    const hashInput = { ...document };
    delete hashInput.__v;
    manifest.push({
      model: reference.model,
      recordId: reference.recordId,
      revision: String(document.__v ?? document.updatedAt?.getTime?.() ?? document.updatedAt ?? '1'),
      updatedAt: document.updatedAt || document.createdAt,
      sourceHash: sha256(canonicalJson(hashInput)),
      included: !excludedReason,
      reason: excludedReason || undefined
    });
  }

  const included = manifest.filter((item) => item.included);
  if (!included.length) {
    throw appError(
      'The care context has no finalized, supported source records to include',
      409,
      'ABDM_PACKET_NO_ELIGIBLE_SOURCES',
      { excluded: manifest.map(({ model, recordId, reason }) => ({ model, recordId, reason })) }
    );
  }

  return {
    manifest,
    includedReferences: included.map((item) => ({
      model: item.model,
      recordId: item.recordId,
      hospitalId: context.hospitalId
    })),
    snapshotHash: sha256(canonicalJson(included.map((item) => ({
      model: item.model,
      recordId: String(item.recordId),
      revision: item.revision,
      sourceHash: item.sourceHash
    }))))
  };
}

function safeConsentScope(consent, context) {
  if (!consent) return null;
  const value = {
    consentId: consent.consentId,
    status: consent.status,
    signatureValidated: consent.signatureValidated === true,
    integrityValidated: consent.integrityValidated === true,
    cryptographicallyValidated: consent.cryptographicallyValidated === true,
    validationId: consent.validationId || null,
    hiTypes: [...(consent.hiTypes || [])].sort(),
    careContextReferences: [...(consent.careContextReferences || [])].sort(),
    purpose: consent.purpose || null,
    dateRange: consent.dateRange || null,
    permission: {
      frequency: consent.permission?.frequency || null,
      dataEraseAt: consent.permission?.dataEraseAt || null,
      accessMode: consent.permission?.accessMode || null
    },
    hipIds: [...(consent.hipIds || [])].sort(),
    hiuId: consent.hiuId || null,
    expiresAt: consent.expiresAt || null,
    artefactHash: consent.artefactHash || null,
    context: {
      referenceNumber: context.referenceNumber,
      hiType: context.hiType,
      dateFrom: context.dateFrom || null,
      dateTo: context.dateTo || null
    }
  };
  return {
    ...value,
    consentScopeHash: sha256(canonicalJson(value))
  };
}

async function consentForContext({ hospitalId, consentId, context }) {
  if (!consentId) return null;
  const consent = await AbdmHospitalConsent.findOne({
    hospitalId,
    role: 'HIP',
    consentId
  });
  if (!consent) throw appError('HIP consent was not found', 404, 'ABDM_CONSENT_NOT_FOUND');
  assertContextAllowed(consent, context);
  return consent;
}

async function writeAudit({ hospitalId, patientId, packetId, packetVersionId, actorUserId, action, purpose, metadata }) {
  await AbdmAccessAudit.create({
    hospitalId,
    patientId,
    packetId,
    packetVersionId,
    actorUserId,
    action,
    purpose,
    metadata
  });
}

async function generateForContext({ context, patient, manifest, bundleVersion, createdBy }) {
  const generated = await generateAbdmHiBundle(patient._id, {
    hospitalId: context.hospitalId,
    hiTypes: [context.hiType],
    dateRange: { from: context.dateFrom, to: context.dateTo },
    recordReferences: manifest.includedReferences,
    careContextReference: context.referenceNumber,
    bundleVersion,
    createdBy,
    persist: false,
    validationMode: 'local'
  });
  const bundle = generated.bundles[context.hiType];
  if (!bundle) {
    throw appError(
      `No ${context.hiType} FHIR document could be generated from the selected sources`,
      422,
      'ABDM_PACKET_BUNDLE_EMPTY'
    );
  }
  const serialized = canonicalJson(bundle);
  const sizeBytes = Buffer.byteLength(serialized);
  if (sizeBytes > abdmConfig.packetMaxBundleBytes) {
    throw appError(
      `Generated bundle is ${sizeBytes} bytes; maximum is ${abdmConfig.packetMaxBundleBytes}`,
      413,
      'ABDM_PACKET_BUNDLE_LIMIT'
    );
  }
  return {
    bundle,
    bundleHash: sha256(serialized),
    sizeBytes,
    summary: bundleSummary(bundle)
  };
}

async function previewPacket({ contextId, hospitalId, consentId, actorUserId }) {
  if (!abdmConfig.packetFeatureEnabled) {
    throw appError('ABDM packet feature is disabled', 404, 'ABDM_PACKET_FEATURE_DISABLED');
  }
  const { context, patient } = await contextForHospital(contextId, hospitalId);
  const manifest = await buildSourceManifest(context);
  const consent = await consentForContext({ hospitalId, consentId, context });
  const consentScope = safeConsentScope(consent, context);
  const generated = await generateForContext({
    context,
    patient,
    manifest,
    bundleVersion: 'preview',
    createdBy: actorUserId
  });
  await writeAudit({
    hospitalId,
    patientId: patient._id,
    actorUserId,
    action: 'PACKET_PREVIEW',
    purpose: consent?.purpose?.text || consent?.purpose?.code || 'ABDM packet review',
    metadata: {
      careContextReference: context.referenceNumber,
      hiType: context.hiType,
      sourceSnapshotHash: manifest.snapshotHash,
      bundleHash: generated.bundleHash,
      consentScopeHash: consentScope?.consentScopeHash || null
    }
  });
  return {
    persisted: false,
    patient: {
      id: patient._id,
      uhid: patient.uhid,
      display: [patient.first_name, patient.middle_name, patient.last_name].filter(Boolean).join(' ')
    },
    careContext: {
      id: context._id,
      referenceNumber: context.referenceNumber,
      display: context.display,
      hiType: context.hiType,
      dateFrom: context.dateFrom,
      dateTo: context.dateTo
    },
    sourceManifest: manifest.manifest,
    sourceSnapshotHash: manifest.snapshotHash,
    consentScope,
    bundleHash: generated.bundleHash,
    bundleSizeBytes: generated.sizeBytes,
    summary: generated.summary,
    bundle: generated.bundle
  };
}

async function preparePacket({ contextId, hospitalId, consentId, actorUserId }) {
  if (!abdmConfig.packetFeatureEnabled) {
    throw appError('ABDM packet feature is disabled', 404, 'ABDM_PACKET_FEATURE_DISABLED');
  }
  const { context, patient } = await contextForHospital(contextId, hospitalId);
  const manifest = await buildSourceManifest(context);
  const consent = await consentForContext({ hospitalId, consentId, context });
  const consentScope = safeConsentScope(consent, context);

  let packet = await AbdmPacket.findOne({ hospitalId, careContextId: context._id });
  if (!packet) {
    packet = await AbdmPacket.create({
      hospitalId,
      patientId: patient._id,
      careContextId: context._id,
      careContextReference: context.referenceNumber,
      hiType: context.hiType,
      reviewPolicy: abdmConfig.packetDefaultReviewPolicy,
      createdBy: actorUserId,
      updatedBy: actorUserId
    });
  }

  const existing = await AbdmPacketVersion.findOne({
    packetId: packet._id,
    sourceSnapshotHash: manifest.snapshotHash,
    'consentBinding.consentScopeHash': consentScope?.consentScopeHash || null,
    status: { $in: ['PREPARED', 'VALIDATED', 'APPROVED'] }
  }).sort({ version: -1 });
  if (existing) {
    return { packet, version: safePacketVersion(existing), reused: true };
  }

  packet = await AbdmPacket.findOneAndUpdate(
    { _id: packet._id, hospitalId },
    {
      $inc: { latestVersion: 1 },
      $set: {
        status: 'PREPARED',
        lastPreparedAt: new Date(),
        updatedBy: actorUserId
      }
    },
    { new: true }
  );
  const generated = await generateForContext({
    context,
    patient,
    manifest,
    bundleVersion: String(packet.latestVersion),
    createdBy: actorUserId
  });

  const versionData = {
    packetId: packet._id,
    hospitalId,
    patientId: patient._id,
    careContextId: context._id,
    careContextReference: context.referenceNumber,
    hiType: context.hiType,
    version: packet.latestVersion,
    status: 'PREPARED',
    fhirPackage: abdmConfig.fhirPackage,
    fhirVersion: abdmConfig.fhirR4Version,
    expectedProfile: fhirProfile(context.hiType),
    bundleHash: generated.bundleHash,
    sourceSnapshotHash: manifest.snapshotHash,
    sourceManifest: manifest.manifest,
    bundleSizeBytes: generated.sizeBytes,
    consentBinding: consentScope
      ? {
          consentId: consentScope.consentId,
          consentScopeHash: consentScope.consentScopeHash,
          hiuId: consentScope.hiuId,
          purpose: consentScope.purpose,
          dateRange: consentScope.dateRange,
          expiresAt: consentScope.expiresAt
        }
      : undefined,
    preparedBy: actorUserId,
    supersedesVersionId: packet.activeVersionId || undefined
  };
  versionData.encryptedBundle = encryptJson(
    generated.bundle,
    `abdm-packet:${packet._id}:${packet.latestVersion}:${generated.bundleHash}`
  );

  const version = await AbdmPacketVersion.create(versionData);
  if (packet.activeVersionId) {
    await AbdmPacketVersion.updateOne(
      { _id: packet.activeVersionId, status: { $nin: ['TRANSFERRED'] } },
      { $set: { status: 'SUPERSEDED' } }
    );
  }
  packet.activeVersionId = version._id;
  await packet.save();

  return {
    packet,
    version: safePacketVersion(version),
    summary: generated.summary,
    reused: false
  };
}

async function packetVersionForHospital({ packetId, versionNumber, hospitalId, includeBundle = false }) {
  const packet = await AbdmPacket.findOne({ _id: packetId, hospitalId });
  if (!packet) throw appError('ABDM packet not found', 404, 'ABDM_PACKET_NOT_FOUND');
  const query = { packetId: packet._id, hospitalId };
  if (versionNumber !== undefined && versionNumber !== null) query.version = Number(versionNumber);
  else query._id = packet.activeVersionId;
  let lookup = AbdmPacketVersion.findOne(query);
  if (includeBundle) lookup = lookup.select('+encryptedBundle.ciphertext +encryptedBundle.iv +encryptedBundle.tag +encryptedBundle.keyVersion');
  const version = await lookup;
  if (!version) throw appError('ABDM packet version not found', 404, 'ABDM_PACKET_VERSION_NOT_FOUND');
  return { packet, version };
}

async function readBundle(version) {
  return decryptJson(version.encryptedBundle, packetAad(version));
}

async function validatePacket({ packetId, versionNumber, hospitalId, actorUserId }) {
  const { packet, version } = await packetVersionForHospital({
    packetId,
    versionNumber,
    hospitalId,
    includeBundle: true
  });
  const bundle = await readBundle(version);
  const actualHash = sha256(canonicalJson(bundle));
  if (actualHash !== version.bundleHash) {
    throw appError('Stored packet integrity verification failed', 409, 'ABDM_PACKET_INTEGRITY_FAILED');
  }
  let validation;
  try {
    validation = await validateBundle(bundle, { external: true, expectedProfile: version.expectedProfile });
  } catch (error) {
    validation = {
      valid: false,
      errors: error.details?.errors || [{ code: error.code || 'VALIDATOR_ERROR', message: error.message }],
      warnings: error.details?.warnings || []
    };
  }
  version.validation = {
    valid: validation.valid === true,
    validator: validation.validator || 'mediqliq-fhir-validator',
    package: validation.package || abdmConfig.fhirPackage,
    fhirVersion: validation.fhirVersion || abdmConfig.fhirR4Version,
    validatedBundleHash: validation.bundleHash || version.bundleHash,
    errors: validation.errors || [],
    warnings: validation.warnings || [],
    validatedAt: new Date()
  };
  version.status = validation.valid === true ? 'VALIDATED' : 'VALIDATION_FAILED';
  await version.save();
  packet.status = validation.valid === true ? 'VALIDATED' : 'FAILED';
  packet.lastValidatedAt = new Date();
  await packet.save();
  await writeAudit({
    hospitalId,
    patientId: version.patientId,
    packetId: packet._id,
    packetVersionId: version._id,
    actorUserId,
    action: 'PACKET_VALIDATE',
    metadata: { valid: validation.valid === true, bundleHash: version.bundleHash }
  });
  return { packet, version: safePacketVersion(version), validation };
}

async function approvePacket({ packetId, versionNumber, hospitalId, actorUser, expectedBundleHash, note }) {
  const role = normalizedRole(actorUser);
  const allowed = new Set(abdmConfig.packetApproverRoles.length
    ? abdmConfig.packetApproverRoles
    : ['admin', 'doctor']);
  if (!allowed.has(role) && role !== 'mediqliq_super_admin') {
    throw appError('The current role cannot approve ABDM packets', 403, 'ABDM_PACKET_APPROVAL_FORBIDDEN');
  }
  const { packet, version } = await packetVersionForHospital({ packetId, versionNumber, hospitalId });
  if (version.status !== 'VALIDATED' && version.status !== 'APPROVED') {
    throw appError('Only an externally validated packet can be approved', 409, 'ABDM_PACKET_NOT_VALIDATED');
  }
  if (!expectedBundleHash || expectedBundleHash !== version.bundleHash) {
    throw appError('The reviewed bundle hash does not match this packet version', 409, 'ABDM_PACKET_HASH_CHANGED');
  }
  const duplicateApproval = (version.approvals || []).some(
    (item) => String(item.actorUserId) === String(actorUser._id)
  );
  if (!duplicateApproval) {
    version.approvals.push({
      actorUserId: actorUser._id,
      role,
      bundleHash: version.bundleHash,
      note
    });
  }
  const distinctApprovers = new Set((version.approvals || []).map((item) => String(item.actorUserId)));
  const requiredApprovals = packet.reviewPolicy === 'DUAL_APPROVAL' ? 2 : 1;
  if (distinctApprovers.size >= requiredApprovals) {
    version.status = 'APPROVED';
    packet.status = 'APPROVED';
    packet.lastApprovedAt = new Date();
  }
  await version.save();
  await packet.save();
  await writeAudit({
    hospitalId,
    patientId: version.patientId,
    packetId: packet._id,
    packetVersionId: version._id,
    actorUserId: actorUser._id,
    action: 'PACKET_APPROVE',
    purpose: version.consentBinding?.purpose?.text || version.consentBinding?.purpose?.code,
    metadata: {
      bundleHash: version.bundleHash,
      approvalCount: distinctApprovers.size,
      requiredApprovals,
      fullyApproved: version.status === 'APPROVED'
    }
  });
  return { packet, version: safePacketVersion(version), requiredApprovals };
}

async function listPatientPackets({ hospitalId, patientId }) {
  return AbdmPacket.find({ hospitalId, patientId })
    .populate({
      path: 'activeVersionId',
      select: '-encryptedBundle'
    })
    .sort({ updatedAt: -1 })
    .lean();
}

async function packetSummary({ packetId, versionNumber, hospitalId, actorUserId }) {
  const { packet, version } = await packetVersionForHospital({ packetId, versionNumber, hospitalId });
  await writeAudit({
    hospitalId,
    patientId: version.patientId,
    packetId: packet._id,
    packetVersionId: version._id,
    actorUserId,
    action: 'PACKET_VIEW'
  });
  return { packet, version: safePacketVersion(version) };
}

async function packetFhir({ packetId, versionNumber, hospitalId, actorUser }) {
  const role = normalizedRole(actorUser);
  const allowed = new Set(abdmConfig.packetRawFhirRoles.length
    ? abdmConfig.packetRawFhirRoles
    : ['admin', 'doctor']);
  if (!allowed.has(role) && role !== 'mediqliq_super_admin') {
    throw appError('Raw FHIR packet access is not permitted for this role', 403, 'ABDM_PACKET_FHIR_FORBIDDEN');
  }
  const { packet, version } = await packetVersionForHospital({
    packetId,
    versionNumber,
    hospitalId,
    includeBundle: true
  });
  const bundle = await readBundle(version);
  if (sha256(canonicalJson(bundle)) !== version.bundleHash) {
    throw appError('Stored packet integrity verification failed', 409, 'ABDM_PACKET_INTEGRITY_FAILED');
  }
  await writeAudit({
    hospitalId,
    patientId: version.patientId,
    packetId: packet._id,
    packetVersionId: version._id,
    actorUserId: actorUser._id,
    action: 'PACKET_FHIR_VIEW',
    metadata: { bundleHash: version.bundleHash }
  });
  return { packet, version: safePacketVersion(version), bundle };
}

async function approvedRecordsForTransfer({ hospitalId, patientId, consent, contexts }) {
  const records = [];
  for (const context of contexts) {
    const manifest = await buildSourceManifest(context); // eslint-disable-line no-await-in-loop
    const consentScope = safeConsentScope(consent, context);
    const version = await AbdmPacketVersion.findOne({
      hospitalId,
      patientId,
      careContextId: context._id,
      status: 'APPROVED',
      sourceSnapshotHash: manifest.snapshotHash,
      'consentBinding.consentId': consent.consentId,
      'consentBinding.consentScopeHash': consentScope.consentScopeHash
    })
      .select('+encryptedBundle.ciphertext +encryptedBundle.iv +encryptedBundle.tag +encryptedBundle.keyVersion')
      .sort({ version: -1 });
    if (!version) {
      throw appError(
        `An approved, current ABDM packet is required for care context ${context.referenceNumber}`,
        409,
        'ABDM_PACKET_APPROVAL_REQUIRED',
        {
          careContextId: context._id,
          careContextReference: context.referenceNumber,
          hiType: context.hiType,
          sourceSnapshotHash: manifest.snapshotHash,
          consentScopeHash: consentScope.consentScopeHash
        }
      );
    }
    const bundle = await readBundle(version); // eslint-disable-line no-await-in-loop
    const actualHash = sha256(canonicalJson(bundle));
    if (actualHash !== version.bundleHash) {
      throw appError('Approved packet integrity verification failed', 409, 'ABDM_PACKET_INTEGRITY_FAILED');
    }
    records.push({
      hiType: context.hiType,
      careContextReference: context.referenceNumber,
      dateRange: { from: context.dateFrom, to: context.dateTo || context.dateFrom },
      content: bundle,
      bundleHash: version.bundleHash,
      sourceSnapshotHash: version.sourceSnapshotHash,
      packetId: version.packetId,
      packetVersionId: version._id,
      validationEvidence: version.validation,
      approvalIds: (version.approvals || []).map((item) => item.actorUserId),
      consentScopeHash: version.consentBinding?.consentScopeHash
    });
  }
  return records;
}

async function recordDisclosure({ hospitalId, patientId, transfer, consent, records, outcome = 'SUCCESS' }) {
  for (const record of records) {
    if (!record.packetVersionId || !record.packetId) continue;
    // eslint-disable-next-line no-await-in-loop
    await AbdmDisclosureLedger.findOneAndUpdate(
      {
        hospitalId,
        transactionId: transfer.transactionId,
        packetVersionId: record.packetVersionId
      },
      {
        hospitalId,
        patientId,
        packetId: record.packetId,
        packetVersionId: record.packetVersionId,
        transferId: transfer._id,
        consentId: transfer.consentId,
        transactionId: transfer.transactionId,
        hiuId: consent?.hiuId,
        purpose: consent?.purpose,
        careContextReference: record.careContextReference,
        hiType: record.hiType,
        bundleHash: record.bundleHash,
        sourceSnapshotHash: record.sourceSnapshotHash,
        outcome,
        disclosedAt: new Date()
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (outcome === 'SUCCESS') {
      // eslint-disable-next-line no-await-in-loop
      await AbdmPacketVersion.updateOne(
        { _id: record.packetVersionId, status: 'APPROVED' },
        { $set: { status: 'TRANSFERRED', transferredAt: new Date() } }
      );
    }
  }
}

async function listDisclosures({ hospitalId, patientId, actorUserId, limit = 100 }) {
  await writeAudit({
    hospitalId,
    patientId,
    actorUserId,
    action: 'DISCLOSURE_VIEW'
  });
  return AbdmDisclosureLedger.find({ hospitalId, patientId })
    .sort({ disclosedAt: -1 })
    .limit(Math.max(1, Math.min(200, Number(limit) || 100)))
    .lean();
}

module.exports = {
  previewPacket,
  preparePacket,
  validatePacket,
  approvePacket,
  listPatientPackets,
  packetSummary,
  packetFhir,
  approvedRecordsForTransfer,
  recordDisclosure,
  listDisclosures,
  safeConsentScope,
  buildSourceManifest,
  bundleSummary
};
