const fs = require('fs');
const crypto = require('crypto');
const fileStorage = require('../services/fileStorage.service');
const UserPrintIdentity = require('../models/UserPrintIdentity');
const PrintIdentityAsset = require('../models/PrintIdentityAsset');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');



function isExternalAssetUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function assetContentUrl(assetId) {
  return `/api/print-identities/assets/${assetId}/content`;
}


function assetResponse(asset) {
  const data = typeof asset?.toObject === 'function' ? asset.toObject() : { ...asset };
  if (!isExternalAssetUrl(data.cloudinaryUrl)) delete data.cloudinaryUrl;
  return {
    ...data,
    contentAvailable: true,
    contentUrl: assetContentUrl(data._id)
  };
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
    await PrintIdentityAsset.updateMany(
      { identityId: identity._id, status: 'pending' },
      { $set: { status: 'verified', verifiedAt: new Date() } }
    );

    const allAssets = await PrintIdentityAsset.find({
      identityId: identity._id,
      status: { $ne: 'retired' }
    }).sort({ assetType: 1, version: -1 });

    // Hide retired/broken legacy assets, while supporting both local and B2-backed files.
    const availability = await Promise.all(allAssets.map(async (asset) => (
      isExternalAssetUrl(asset.cloudinaryUrl) ||
      Boolean(asset.storagePath && await fileStorage.storagePathExists(asset.storagePath, { hospitalId: identity.hospitalId }))
    )));
    const assets = allAssets.filter((asset, index) => availability[index]);

    const usableIds = new Set(assets.map((asset) => String(asset._id)));
    const latestSig = assets.find((asset) =>
      asset.assetType === 'signature' && asset.status === 'verified'
    );
    const latestSeal = assets.find((asset) =>
      asset.assetType === 'seal' && asset.status === 'verified'
    );

    let dirty = false;
    const currentSignatureId = identity.defaultSignatureAssetId
      ? String(identity.defaultSignatureAssetId)
      : '';
    const currentSealId = identity.defaultSealAssetId
      ? String(identity.defaultSealAssetId)
      : '';

    if (!currentSignatureId || !usableIds.has(currentSignatureId)) {
      identity.defaultSignatureAssetId = latestSig?._id || undefined;
      dirty = true;
    }
    if (!currentSealId || !usableIds.has(currentSealId)) {
      identity.defaultSealAssetId = latestSeal?._id || undefined;
      dirty = true;
    }

    const nextVerificationStatus = assets.some((asset) => asset.status === 'verified')
      ? 'verified'
      : 'unverified';
    if (identity.verificationStatus !== nextVerificationStatus) {
      identity.verificationStatus = nextVerificationStatus;
      dirty = true;
    }

    if (dirty) await identity.save();

    res.json({
      success: true,
      data: {
        identity,
        assets: assets.map(assetResponse)
      }
    });
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
    if (identity.verificationStatus !== 'verified') identity.verificationStatus = 'verified';
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

    const stored = await fileStorage.upload(req.file, req, {
      folder: 'print-identities',
      hospitalId: identity.hospitalId
    });
    // fileStorage returns a private local API URL for the local driver. Do not
    // store that relative route in the legacy cloudinaryUrl field: consumers
    // may treat it as a directly renderable public URL. Keep cloudinaryUrl only
    // for genuine external HTTP(S) assets.
    const cloudinaryUrl = isExternalAssetUrl(stored.secure_url)
      ? stored.secure_url
      : undefined;

    const asset = await PrintIdentityAsset.create({
      hospitalId: identity.hospitalId,
      userId: req.user._id,
      identityId: identity._id,
      assetType,
      label: req.body.label || `${assetType} v${version}`,
      version,
      storagePath: stored.storage_key,
      cloudinaryUrl,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      sha256,
      status: 'verified',
      verifiedBy: req.user._id,
      verifiedAt: new Date(),
      createdBy: req.user._id
    });
    fs.unlink(req.file.path, () => {});
    if (assetType === 'signature') identity.defaultSignatureAssetId = asset._id;
    if (assetType === 'seal') identity.defaultSealAssetId = asset._id;
    identity.verificationStatus = 'verified';
    await identity.save();
    await appendDomainEvent({ req, eventType: 'print_identity.asset_uploaded', entityType: 'PrintIdentityAsset', entityId: asset._id, hospitalId: identity.hospitalId, afterSummary: { assetType, version, status: asset.status, cloudinaryUrl } });
    res.status(201).json({
      success: true,
      message: 'Asset uploaded and verified',
      data: assetResponse(asset)
    });
  } catch (error) { next(error); }
};

exports.setDefaults = async (req, res, next) => {
  try {
    const identity = await ensureIdentity(req);
    const { signatureAssetId, sealAssetId } = req.body;
    if (signatureAssetId) {
      const asset = await PrintIdentityAsset.findOne({ _id: signatureAssetId, identityId: identity._id, assetType: 'signature', status: 'verified' });
      if (!asset) return res.status(400).json({ error: 'Signature asset not found or not verified' });
      identity.defaultSignatureAssetId = asset._id;
    }
    if (sealAssetId) {
      const asset = await PrintIdentityAsset.findOne({ _id: sealAssetId, identityId: identity._id, assetType: 'seal', status: 'verified' });
      if (!asset) return res.status(400).json({ error: 'Seal asset not found or not verified' });
      identity.defaultSealAssetId = asset._id;
    }
    await identity.save();
    res.json({ success: true, message: 'Defaults updated', data: identity });
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
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    // Only redirect genuine external/CDN URLs. Historical local assets contain
    // values such as /api/files/<id> in cloudinaryUrl; redirecting to that path
    // loses the Authorization header and produces a broken <img> preview.
    if (isExternalAssetUrl(asset.cloudinaryUrl)) {
      return res.redirect(asset.cloudinaryUrl);
    }

    let opened;
    try {
      opened = await fileStorage.openStoragePath(asset.storagePath, { hospitalId });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.b2Code === 'not_found' || error?.statusCode === 404) {
        return res.status(404).json({ error: 'Asset file not found' });
      }
      throw error;
    }

    res.setHeader('Content-Type', opened.contentType || asset.mimeType || 'application/octet-stream');
    if (opened.size || asset.sizeBytes) res.setHeader('Content-Length', String(opened.size || asset.sizeBytes));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    opened.stream.on('error', next);
    opened.stream.pipe(res);
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
