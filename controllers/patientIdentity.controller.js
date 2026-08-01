const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Patient = require('../models/Patient');
const PatientIdentityAsset = require('../models/PatientIdentityAsset');
const fileStorage = require('../services/fileStorage.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const { tempDir } = require('../config/upload.config');

const ALLOWED_TYPES = ['patient_signature', 'thumb_impression'];
const ALLOWED_METHODS = ['drawn', 'typed_acknowledgement', 'uploaded', 'biometric'];

function absoluteAssetPath(storagePath) {
  if (!storagePath) return null;
  return path.isAbsolute(storagePath) ? storagePath : fileStorage.absolutePath(storagePath);
}

function contentUrl(id) {
  return `/api/patient-identities/assets/${id}/content`;
}

function responseAsset(asset) {
  const data = typeof asset?.toObject === 'function' ? asset.toObject() : { ...asset };
  return { ...data, assetModel: 'PatientIdentityAsset', contentUrl: contentUrl(data._id) };
}

function checksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function scopedPatient(req, patientId) {
  const hospitalId = requireHospitalId(req);
  const patient = await Patient.findOne({ _id: patientId, hospitalId }).select('_id hospitalId first_name middle_name last_name patientId uhid').lean();
  if (!patient) {
    const error = new Error('Patient not found');
    error.statusCode = 404;
    throw error;
  }
  return { hospitalId, patient };
}

async function persistFile({ req, patient, hospitalId, file, assetType, captureMethod, label, capturedName, acknowledgementText, typedFontFamily, biometricDevice, admissionId, consentId, witnessName }) {
  if (!ALLOWED_TYPES.includes(assetType)) {
    const error = new Error('assetType must be patient_signature or thumb_impression');
    error.statusCode = 400;
    throw error;
  }
  if (!ALLOWED_METHODS.includes(captureMethod)) {
    const error = new Error('Unsupported capture method');
    error.statusCode = 400;
    throw error;
  }
  const latest = await PatientIdentityAsset.findOne({ hospitalId, patientId: patient._id, assetType }).sort({ version: -1 }).select('version').lean();
  const version = Number(latest?.version || 0) + 1;
  const sha256 = await checksum(file.path);
  const stored = await fileStorage.upload(file, req, { folder: 'patient-identities', hospitalId });
  const existingDefault = await PatientIdentityAsset.exists({ hospitalId, patientId: patient._id, assetType, status: 'active', isDefault: true });
  const asset = await PatientIdentityAsset.create({
    hospitalId,
    patientId: patient._id,
    assetType,
    captureMethod,
    label: label || `${assetType === 'patient_signature' ? 'Patient signature' : 'Thumb impression'} v${version}`,
    version,
    storagePath: stored.storage_key,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    sha256,
    capturedName,
    acknowledgementText,
    typedFontFamily,
    legalLabel: captureMethod === 'typed_acknowledgement' ? 'Typed acknowledgement' : (assetType === 'thumb_impression' ? 'Thumb impression' : 'Patient signature'),
    evidence: {
      capturedAt: new Date(),
      ipAddress: req.ip || req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
      admissionId: admissionId || undefined,
      consentId: consentId || undefined,
      witnessName: witnessName || undefined
    },
    biometricDevice,
    isDefault: !existingDefault,
    capturedBy: req.user._id
  });
  await appendDomainEvent({
    req,
    eventType: 'patient_identity.asset_captured',
    entityType: 'PatientIdentityAsset',
    entityId: asset._id,
    hospitalId,
    patientId: patient._id,
    afterSummary: { assetType, captureMethod, version, sha256 }
  });
  return asset;
}

exports.listPatientAssets = async (req, res, next) => {
  try {
    const { hospitalId, patient } = await scopedPatient(req, req.params.patientId);
    const assets = await PatientIdentityAsset.find({ hospitalId, patientId: patient._id, status: 'active' })
      .sort({ assetType: 1, isDefault: -1, version: -1 });
    res.json({ success: true, data: { patient, assets: assets.map(responseAsset) } });
  } catch (error) { next(error); }
};

exports.uploadAsset = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Patient signature or thumb image is required' });
    const { hospitalId, patient } = await scopedPatient(req, req.params.patientId);
    const asset = await persistFile({
      req,
      patient,
      hospitalId,
      file: req.file,
      assetType: req.body.assetType,
      captureMethod: req.body.captureMethod || 'uploaded',
      label: req.body.label,
      capturedName: req.body.capturedName,
      acknowledgementText: req.body.acknowledgementText,
      typedFontFamily: req.body.typedFontFamily,
      biometricDevice: req.body.biometricDevice,
      admissionId: req.body.admissionId,
      consentId: req.body.consentId,
      witnessName: req.body.witnessName
    });
    fs.unlink(req.file.path, () => {});
    res.status(201).json({ success: true, message: 'Patient identity mark saved', data: responseAsset(asset) });
  } catch (error) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    next(error);
  }
};

exports.captureAsset = async (req, res, next) => {
  let filePath;
  try {
    const { hospitalId, patient } = await scopedPatient(req, req.params.patientId);
    const { dataUrl, assetType, captureMethod = 'drawn' } = req.body;
    const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) return res.status(400).json({ error: 'A PNG, JPEG or WebP data URL is required' });
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length || buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'Captured image is empty or exceeds 10MB' });
    const extension = match[1].toLowerCase().includes('jpeg') ? '.jpg' : match[1].toLowerCase().includes('webp') ? '.webp' : '.png';
    const directory = path.join(tempDir, 'patient-identities');
    await fs.promises.mkdir(directory, { recursive: true });
    filePath = path.join(directory, `${patient._id}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}${extension}`);
    await fs.promises.writeFile(filePath, buffer, { flag: 'wx' });
    const file = { path: filePath, originalname: `${assetType || 'patient-signature'}${extension}`, mimetype: match[1], size: buffer.length };
    const asset = await persistFile({
      req,
      patient,
      hospitalId,
      file,
      assetType,
      captureMethod,
      label: req.body.label,
      capturedName: req.body.capturedName,
      acknowledgementText: req.body.acknowledgementText,
      typedFontFamily: req.body.typedFontFamily,
      biometricDevice: req.body.biometricDevice,
      admissionId: req.body.admissionId,
      consentId: req.body.consentId,
      witnessName: req.body.witnessName
    });
    await fs.promises.unlink(filePath).catch(() => {});
    res.status(201).json({ success: true, message: 'Patient identity mark captured', data: responseAsset(asset) });
  } catch (error) {
    if (filePath) await fs.promises.unlink(filePath).catch(() => {});
    next(error);
  }
};

exports.setDefault = async (req, res, next) => {
  try {
    const { hospitalId, patient } = await scopedPatient(req, req.params.patientId);
    const asset = await PatientIdentityAsset.findOne({ _id: req.params.assetId, hospitalId, patientId: patient._id, status: 'active' });
    if (!asset) return res.status(404).json({ error: 'Patient identity asset not found' });
    await PatientIdentityAsset.updateMany({ hospitalId, patientId: patient._id, assetType: asset.assetType }, { $set: { isDefault: false } });
    asset.isDefault = true;
    await asset.save();
    res.json({ success: true, message: 'Default patient identity mark updated', data: responseAsset(asset) });
  } catch (error) { next(error); }
};

exports.revokeAsset = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const asset = await PatientIdentityAsset.findOne({ _id: req.params.assetId, hospitalId, status: 'active' });
    if (!asset) return res.status(404).json({ error: 'Patient identity asset not found' });
    asset.status = 'revoked';
    asset.isDefault = false;
    asset.revokedAt = new Date();
    asset.revokedBy = req.user._id;
    asset.revokeReason = req.body.reason;
    await asset.save();
    res.json({ success: true, message: 'Patient identity mark revoked' });
  } catch (error) { next(error); }
};

exports.streamAsset = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const asset = await PatientIdentityAsset.findOne({ _id: req.params.assetId, hospitalId, status: 'active' });
    if (!asset) return res.status(404).json({ error: 'Patient identity asset not found' });
    const filePath = absoluteAssetPath(asset.storagePath);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Patient identity image not found' });
    const stat = await fs.promises.stat(filePath);
    res.setHeader('Content-Type', asset.mimeType || 'image/png');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = fs.createReadStream(filePath);
    stream.on('error', next);
    stream.pipe(res);
  } catch (error) { next(error); }
};
