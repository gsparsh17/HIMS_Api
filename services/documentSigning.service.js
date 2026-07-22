const crypto = require('crypto');
const DocumentSignature = require('../models/DocumentSignature');
const PrintIdentityAsset = require('../models/PrintIdentityAsset');
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
    const error = new Error('At least one signature or seal placement is required');
    error.statusCode = 400;
    throw error;
  }
  placements.forEach(validatePlacement);

  const identity = await UserPrintIdentity.findOne({ hospitalId, userId: req.user._id, isActive: true });
  if (!identity) {
    const error = new Error('Print identity is not configured for this user');
    error.statusCode = 409;
    throw error;
  }
  const assetIds = [...new Set(placements.map((placement) => String(placement.assetId)))];
  const assets = await PrintIdentityAsset.find({ _id: { $in: assetIds }, hospitalId, userId: req.user._id, status: 'verified' });
  if (assets.length !== assetIds.length) {
    const error = new Error('All selected signature/seal assets must be verified and belong to the logged-in user');
    error.statusCode = 409;
    throw error;
  }
  const assetMap = new Map(assets.map((asset) => [String(asset._id), asset]));
  const normalizedPlacements = placements.map((placement) => ({
    ...placement,
    assetType: assetMap.get(String(placement.assetId)).assetType,
    page: Math.max(1, Number(placement.page || 1))
  }));
  const sourceHash = sha256({ sourceModel: normalizedSourceModel, sourceId: String(normalizedSourceId), sourceRevision, templateId, templateVersion, sourceSnapshot });
  const signedAt = new Date();
  const signatureHash = sha256({
    sourceHash,
    signer: String(req.user._id),
    signedAt: signedAt.toISOString(),
    placements: normalizedPlacements,
    assets: assets.map((asset) => ({ id: String(asset._id), version: asset.version, sha256: asset.sha256 }))
  });

  const normalizedSignatoryRole = String(signatoryRole || metadata?.signatoryRole || req.user.role || 'signer').trim().toLowerCase();
  // Supersede only the previous signature for the same signatory slot. Other required
  // participants (surgeon, anaesthetist, nurses, witness) remain active.
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
    signerName: identity.printedName || req.user.name,
    signerRole: req.user.role,
    signatoryRole: normalizedSignatoryRole,
    signerDesignation: identity.designation,
    signerRegistrationNumber: identity.registrationNumber,
    assetSnapshots: assets.map((asset) => ({
      assetId: asset._id,
      assetType: asset.assetType,
      version: asset.version,
      sha256: asset.sha256,
      storagePath: asset.storagePath,
      mimeType: asset.mimeType,
      originalName: asset.originalName
    })),
    placements: normalizedPlacements,
    sourceHash,
    signatureHash,
    verificationCode: verificationCode(),
    signedAt,
    metadata
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
    afterSummary: { documentType: normalizedDocumentType, sourceModel: normalizedSourceModel, sourceId: normalizedSourceId, sourceRevision, verificationCode: signature.verificationCode }
  });
  return signature;
}

module.exports = { signDocument, sha256 };
