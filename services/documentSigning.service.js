const crypto = require('crypto');
const { operationNow } = require('../utils/operationTimeContext');
const DocumentSignature = require('../models/DocumentSignature');
const PrintIdentityAsset = require('../models/PrintIdentityAsset');
const PatientIdentityAsset = require('../models/PatientIdentityAsset');
const UserPrintIdentity = require('../models/UserPrintIdentity');
const EncounterDocument = require('../models/EncounterDocument');
const { appendDomainEvent } = require('./auditEvent.service');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stable(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(stable(value)));
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function verificationCode() {
  return crypto.randomBytes(10).toString('hex').toUpperCase();
}

function validatePlacement(placement) {
  if (!placement?.assetId) {
    const error = new Error('A signature/seal asset is required for every placement');
    error.statusCode = 400;
    throw error;
  }
  const assetModel = placement.assetModel || 'PrintIdentityAsset';
  if (!['PrintIdentityAsset', 'PatientIdentityAsset'].includes(assetModel)) {
    const error = new Error('Unsupported signature/seal asset model');
    error.statusCode = 400;
    throw error;
  }
  for (const field of ['x', 'y', 'width', 'height']) {
    const value = Number(placement[field]);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      const error = new Error(`Invalid placement ${field}`);
      error.statusCode = 400;
      throw error;
    }
  }
  if (Number(placement.width) <= 0 || Number(placement.height) <= 0) {
    const error = new Error('Signature placement must have a positive size');
    error.statusCode = 400;
    throw error;
  }
}

async function signDocument({ req, hospitalId, patientId, admissionId, encounterDocumentId, documentType, sourceModel, sourceId, sourceRevision = 1, sourceSnapshot, templateId, templateVersion, placements, metadata, signatoryRole }) {
  const normalizedSourceModel = sourceModel || 'PrintJob';
  const normalizedSourceId = sourceId || new (require('mongoose').Types.ObjectId)();
  const normalizedDocumentType = documentType || 'HIMS Document';
  if (!Array.isArray(placements) || placements.length === 0) {
    const error = new Error('At least one signature, seal or patient acknowledgement placement is required');
    error.statusCode = 400;
    throw error;
  }
  placements.forEach(validatePlacement);

  const staffPlacements = placements.filter((placement) => (placement.assetModel || 'PrintIdentityAsset') === 'PrintIdentityAsset');
  const patientPlacements = placements.filter((placement) => placement.assetModel === 'PatientIdentityAsset');

  let identity = null;
  let staffAssets = [];
  if (staffPlacements.length) {
    identity = await UserPrintIdentity.findOne({ hospitalId, userId: req.user._id, isActive: true });
    if (!identity) {
      const error = new Error('Print identity is not configured for this user');
      error.statusCode = 409;
      throw error;
    }
    const staffAssetIds = [...new Set(staffPlacements.map((placement) => String(placement.assetId)))];
    staffAssets = await PrintIdentityAsset.find({ _id: { $in: staffAssetIds }, hospitalId, userId: req.user._id, status: 'verified' });
    if (staffAssets.length !== staffAssetIds.length) {
      const error = new Error('All selected staff signature/seal assets must be verified and belong to the logged-in user');
      error.statusCode = 409;
      throw error;
    }
  }

  let patientAssets = [];
  if (patientPlacements.length) {
    if (!patientId) {
      const error = new Error('Patient context is required when placing a patient signature or thumb impression');
      error.statusCode = 400;
      throw error;
    }
    const patientAssetIds = [...new Set(patientPlacements.map((placement) => String(placement.assetId)))];
    patientAssets = await PatientIdentityAsset.find({ _id: { $in: patientAssetIds }, hospitalId, patientId, status: 'active' });
    if (patientAssets.length !== patientAssetIds.length) {
      const error = new Error('All selected patient signature/thumb assets must belong to this patient and hospital');
      error.statusCode = 409;
      throw error;
    }
  }

  const assetMap = new Map();
  staffAssets.forEach((asset) => assetMap.set(`PrintIdentityAsset:${asset._id}`, asset));
  patientAssets.forEach((asset) => assetMap.set(`PatientIdentityAsset:${asset._id}`, asset));
  const normalizedPlacements = placements.map((placement) => {
    const assetModel = placement.assetModel || 'PrintIdentityAsset';
    const asset = assetMap.get(`${assetModel}:${placement.assetId}`);
    return {
      ...placement,
      assetModel,
      assetType: asset.assetType,
      page: Math.max(1, Number(placement.page || 1))
    };
  });
  const allAssets = [...staffAssets, ...patientAssets];
  const sourceHash = sha256({ sourceModel: normalizedSourceModel, sourceId: String(normalizedSourceId), sourceRevision, templateId, templateVersion, sourceSnapshot });
  const signedAt = operationNow();
  const signatureHash = sha256({
    sourceHash,
    signer: String(req.user._id),
    signedAt: signedAt.toISOString(),
    placements: normalizedPlacements,
    assets: allAssets.map((asset) => ({ id: String(asset._id), model: asset.constructor.modelName, version: asset.version, sha256: asset.sha256 }))
  });

  const normalizedSignatoryRole = String(signatoryRole || metadata?.signatoryRole || req.user.role || 'signer').trim().toLowerCase();
  await DocumentSignature.updateMany(
    { hospitalId, sourceModel: normalizedSourceModel, sourceId: normalizedSourceId, status: 'signed', signatoryRole: normalizedSignatoryRole },
    { $set: { status: 'superseded' } }
  );

  const signature = await DocumentSignature.create({
    hospitalId,
    patientId,
    admissionId,
    encounterDocumentId,
    documentType: normalizedDocumentType,
    sourceModel: normalizedSourceModel,
    sourceId: normalizedSourceId,
    sourceRevision,
    templateId,
    templateVersion,
    signerUserId: req.user._id,
    signerName: identity?.printedName || req.user.name,
    signerRole: req.user.role,
    signatoryRole: normalizedSignatoryRole,
    signerDesignation: identity?.designation,
    signerRegistrationNumber: identity?.registrationNumber,
    assetSnapshots: allAssets.map((asset) => ({
      assetId: asset._id,
      assetModel: asset.constructor.modelName,
      assetType: asset.assetType,
      version: asset.version,
      sha256: asset.sha256,
      storagePath: asset.storagePath,
      cloudinaryUrl: asset.cloudinaryUrl || asset.externalUrl,
      mimeType: asset.mimeType,
      originalName: asset.originalName
    })),
    placements: normalizedPlacements,
    sourceHash,
    signatureHash,
    verificationCode: verificationCode(),
    signedAt,
    metadata: {
      ...(metadata || {}),
      includesPatientAcknowledgement: patientPlacements.length > 0,
      patientAssetCount: patientPlacements.length
    }
  });

  if (encounterDocumentId) {
    await EncounterDocument.findOneAndUpdate(
      { _id: encounterDocumentId, hospitalId },
      { $set: { status: 'Final/Signed', signedDocumentId: signature._id, sourceRevision } }
    );
  }
  await appendDomainEvent({
    req,
    eventType: 'document.signed',
    entityType: 'DocumentSignature',
    entityId: signature._id,
    hospitalId,
    patientId,
    encounterId: admissionId,
    afterSummary: { documentType: normalizedDocumentType, sourceModel: normalizedSourceModel, sourceId: normalizedSourceId, sourceRevision, verificationCode: signature.verificationCode, patientAssetCount: patientPlacements.length }
  });
  return signature;
}

module.exports = { signDocument, sha256 };
