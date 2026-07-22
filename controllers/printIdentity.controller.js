const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const UserPrintIdentity = require('../models/UserPrintIdentity');
const PrintIdentityAsset = require('../models/PrintIdentityAsset');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

function checksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensureIdentity(req) {
  const hospitalId = requireHospitalId(req);
  let identity = await UserPrintIdentity.findOne({ hospitalId, userId: req.user._id });
  if (!identity) {
    identity = await UserPrintIdentity.create({
      hospitalId,
      userId: req.user._id,
      printedName: req.user.name,
      verificationStatus: 'unverified',
      updatedBy: req.user._id
    });
  }
  return identity;
}

exports.getMyIdentity = async (req, res, next) => {
  try {
    const identity = await ensureIdentity(req);
    const assets = await PrintIdentityAsset.find({ identityId: identity._id, status: { $ne: 'retired' } })
      .sort({ assetType: 1, version: -1 });
    res.json({ success: true, data: { identity, assets } });
  } catch (error) { next(error); }
};

exports.updateMyIdentity = async (req, res, next) => {
  try {
    const identity = await ensureIdentity(req);
    const allowed = ['printedName', 'designation', 'department', 'qualification', 'registrationNumber', 'registrationCouncil'];
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) identity[key] = req.body[key];
    });
    identity.updatedBy = req.user._id;
    if (identity.verificationStatus === 'verified') identity.verificationStatus = 'pending';
    await identity.save();
    res.json({ success: true, message: 'Print identity updated', data: identity });
  } catch (error) { next(error); }
};

exports.uploadAsset = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Signature or seal image is required' });
    const assetType = req.body.assetType;
    if (!['signature', 'seal', 'initials'].includes(assetType)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'assetType must be signature, seal or initials' });
    }
    const identity = await ensureIdentity(req);
    const version = (await PrintIdentityAsset.countDocuments({ identityId: identity._id, assetType })) + 1;
    const sha256 = await checksum(req.file.path);
    const asset = await PrintIdentityAsset.create({
      hospitalId: identity.hospitalId,
      userId: req.user._id,
      identityId: identity._id,
      assetType,
      label: req.body.label || `${assetType} v${version}`,
      version,
      storagePath: path.resolve(req.file.path),
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      sha256,
      status: req.user.role === 'admin' || req.user.role === 'mediqliq_super_admin' ? 'verified' : 'pending',
      verifiedBy: ['admin', 'mediqliq_super_admin'].includes(req.user.role) ? req.user._id : undefined,
      verifiedAt: ['admin', 'mediqliq_super_admin'].includes(req.user.role) ? new Date() : undefined,
      createdBy: req.user._id
    });
    if (asset.status === 'verified') {
      if (assetType === 'signature') identity.defaultSignatureAssetId = asset._id;
      if (assetType === 'seal') identity.defaultSealAssetId = asset._id;
      identity.verificationStatus = 'verified';
    } else {
      identity.verificationStatus = 'pending';
    }
    await identity.save();
    await appendDomainEvent({ req, eventType: 'print_identity.asset_uploaded', entityType: 'PrintIdentityAsset', entityId: asset._id, hospitalId: identity.hospitalId, afterSummary: { assetType, version, status: asset.status } });
    res.status(201).json({ success: true, message: 'Asset uploaded', data: asset });
  } catch (error) { next(error); }
};

exports.setDefaults = async (req, res, next) => {
  try {
    const identity = await ensureIdentity(req);
    const updates = {};
    for (const [bodyKey, identityKey, type] of [
      ['signatureAssetId', 'defaultSignatureAssetId', 'signature'],
      ['sealAssetId', 'defaultSealAssetId', 'seal']
    ]) {
      if (!req.body[bodyKey]) continue;
      const asset = await PrintIdentityAsset.findOne({ _id: req.body[bodyKey], identityId: identity._id, assetType: type, status: 'verified' });
      if (!asset) return res.status(400).json({ error: `Verified ${type} asset not found` });
      updates[identityKey] = asset._id;
    }
    Object.assign(identity, updates);
    await identity.save();
    res.json({ success: true, message: 'Default print assets updated', data: identity });
  } catch (error) { next(error); }
};

exports.retireAsset = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const asset = await PrintIdentityAsset.findOne({ _id: req.params.assetId, hospitalId, userId: req.user._id });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    asset.status = 'retired';
    asset.retiredAt = new Date();
    await asset.save();
    res.json({ success: true, message: 'Asset retired' });
  } catch (error) { next(error); }
};

exports.streamAsset = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const canReview = ['admin', 'mediqliq_super_admin'].includes(req.user.role);
    const filter = { _id: req.params.assetId, hospitalId };
    if (!canReview) filter.userId = req.user._id;
    const asset = await PrintIdentityAsset.findOne(filter);
    if (!asset || !fs.existsSync(asset.storagePath)) return res.status(404).json({ error: 'Asset not found' });
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(asset.storagePath).pipe(res);
  } catch (error) { next(error); }
};

exports.listPending = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const assets = await PrintIdentityAsset.find({ hospitalId, status: 'pending' }).populate('userId', 'name email role').sort({ createdAt: 1 });
    res.json({ success: true, data: assets });
  } catch (error) { next(error); }
};

exports.verifyAsset = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const asset = await PrintIdentityAsset.findOne({ _id: req.params.assetId, hospitalId });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const approved = req.body.approved !== false;
    asset.status = approved ? 'verified' : 'rejected';
    asset.verifiedBy = req.user._id;
    asset.verifiedAt = new Date();
    asset.rejectionReason = approved ? undefined : req.body.reason;
    await asset.save();
    const identity = await UserPrintIdentity.findById(asset.identityId);
    if (approved) {
      if (asset.assetType === 'signature' && !identity.defaultSignatureAssetId) identity.defaultSignatureAssetId = asset._id;
      if (asset.assetType === 'seal' && !identity.defaultSealAssetId) identity.defaultSealAssetId = asset._id;
      identity.verificationStatus = 'verified';
    }
    await identity.save();
    res.json({ success: true, message: approved ? 'Asset verified' : 'Asset rejected', data: asset });
  } catch (error) { next(error); }
};
