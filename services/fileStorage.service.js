const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const StoredFile = require('../models/StoredFile');
const b2Storage = require('./b2Storage.service');
const cloudinaryStorage = require('./cloudinaryStorage.service');
const { hospitalIdFromUser, idString } = require('./tenantScope.service');

const defaultUploadRoot = process.env.NODE_ENV === 'production'
  ? '/srv/mediqliq/uploads'
  : path.join(process.cwd(), 'uploads', 'storage');
const uploadRoot = path.resolve(process.env.UPLOAD_DIR || defaultUploadRoot);

function configuredDriver() {
  const requested = String(
    process.env.MEDIA_STORAGE_PROVIDER ||
    process.env.FILE_STORAGE_DRIVER ||
    'local'
  ).trim().toLowerCase();

  if (requested === 'b2') {
    b2Storage.assertConfigured();
    return 'b2';
  }
  if (requested === 'cloudinary') {
    cloudinaryStorage.assertConfigured();
    return 'cloudinary';
  }
  if (requested !== 'local') {
    const error = new Error(`Unsupported MEDIA_STORAGE_PROVIDER: ${requested}`);
    error.code = 'UNSUPPORTED_MEDIA_STORAGE_PROVIDER';
    throw error;
  }
  return 'local';
}

function mediaStoragePrefix() {
  const raw = String(process.env.MEDIA_STORAGE_PREFIX || 'media')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const segments = raw.split('/').filter(Boolean).map((segment) => safeSegment(segment, 'media'));
  return segments.join('/') || 'media';
}

function safeSegment(value, fallback = 'documents') {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cleaned || fallback;
}

function extensionFor(file) {
  const originalExtension = path.extname(file.originalname || file.path || '').toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(originalExtension)) return originalExtension;
  const byMime = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
  };
  return byMime[file.mimetype] || '';
}

async function checksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function absolutePath(storageKey) {
  const resolved = path.resolve(uploadRoot, storageKey);
  const expectedPrefix = `${uploadRoot}${path.sep}`;
  if (resolved !== uploadRoot && !resolved.startsWith(expectedPrefix)) {
    const error = new Error('Invalid storage key');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

async function createRecord({ file, req, hospitalId, visibility, category, storageKey, sha256, driver, provider = {} }) {
  const record = await StoredFile.create({
    hospitalId,
    uploadedBy: req?.user?._id,
    storageDriver: driver,
    storageKey,
    providerFileId: provider.fileId,
    providerPublicId: provider.publicId,
    providerUrl: provider.secureUrl,
    providerResourceType: provider.resourceType,
    originalName: file.originalname || path.basename(storageKey),
    mimeType: file.mimetype || provider.contentType || 'application/octet-stream',
    sizeBytes: Number(file.size || provider.bytes || provider.contentLength || 0),
    sha256,
    category,
    visibility
  });

  return {
    secure_url: `/api/files/${record._id}`,
    public_id: String(record._id),
    file_id: String(record._id),
    storage_key: storageKey,
    storage_path: driver === 'local' ? absolutePath(storageKey) : storageKey,
    storage_driver: driver,
    mime_type: record.mimeType,
    size: record.sizeBytes
  };
}

async function upload(file, req, options = {}) {
  if (!file?.path) {
    const error = new Error('Uploaded file is missing');
    error.statusCode = 400;
    throw error;
  }

  const hospitalId = options.hospitalId || hospitalIdFromUser(req?.user) || null;
  const visibility = options.visibility === 'public' ? 'public' : 'private';
  if (!hospitalId && visibility !== 'public') {
    const error = new Error('A hospital-scoped authenticated user is required for private file uploads');
    error.statusCode = 403;
    throw error;
  }

  const category = safeSegment(options.folder || options.category);
  // Object names deliberately use opaque IDs/random values, not patient names or PHI.
  const tenant = hospitalId ? safeSegment(idString(hospitalId), 'unknown-hospital') : 'public';
  const idPart = safeSegment(options.public_id, crypto.randomUUID());
  const filename = `${Date.now()}-${idPart}-${crypto.randomBytes(6).toString('hex')}${extensionFor(file)}`;
  const storageKey = path.posix.join(mediaStoragePrefix(), tenant, category, filename);
  const sha256 = await checksum(file.path);
  const driver = configuredDriver();

  if (driver === 'b2') {
    const uploaded = await b2Storage.uploadFile(file.path, storageKey, {
      contentType: file.mimetype || 'application/octet-stream',
      fileInfo: { sha256, category, visibility }
    });
    try {
      return await createRecord({
        file, req, hospitalId, visibility, category, storageKey, sha256, driver,
        provider: { fileId: uploaded.fileId, contentType: uploaded.contentType, contentLength: uploaded.contentLength }
      });
    } catch (error) {
      if (uploaded.fileId) await b2Storage.deleteFileVersion(storageKey, uploaded.fileId).catch(() => {});
      throw error;
    }
  }

  if (driver === 'cloudinary') {
    const uploaded = await cloudinaryStorage.uploadFile(file.path, storageKey, {
      resourceType: options.resource_type || options.resourceType || 'auto'
    });
    try {
      return await createRecord({
        file, req, hospitalId, visibility, category, storageKey, sha256, driver,
        provider: uploaded
      });
    } catch (error) {
      await cloudinaryStorage.deleteFile({
        storageKey,
        providerPublicId: uploaded.publicId,
        providerFileId: uploaded.fileId,
        providerResourceType: uploaded.resourceType
      }).catch(() => {});
      throw error;
    }
  }

  const destination = absolutePath(storageKey);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(file.path, destination, fs.constants.COPYFILE_EXCL);
  try {
    const stat = await fsp.stat(destination);
    if (!file.size) file.size = stat.size;
    return await createRecord({ file, req, hospitalId, visibility, category, storageKey, sha256, driver: 'local' });
  } catch (error) {
    await fsp.unlink(destination).catch(() => {});
    throw error;
  }
}

async function uploadBuffer(buffer, req, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    const error = new Error('A Buffer is required');
    error.statusCode = 400;
    throw error;
  }
  const extension = String(options.extension || '').match(/^\.[a-z0-9]{1,10}$/i)?.[0] || '';
  const tempPath = path.join(os.tmpdir(), `hims-upload-${crypto.randomUUID()}${extension}`);
  await fsp.writeFile(tempPath, buffer, { flag: 'wx' });
  const file = {
    path: tempPath,
    originalname: options.originalName || `generated${extension}`,
    mimetype: options.mimeType || 'application/octet-stream',
    size: buffer.length
  };
  try {
    return await upload(file, req, options);
  } finally {
    await fsp.unlink(tempPath).catch(() => {});
  }
}

async function findByUrl(url) {
  const match = String(url || '').match(/\/api\/files\/([a-fA-F0-9]{24})(?:[/?#]|$)/);
  if (!match) return null;
  return StoredFile.findOne({ _id: match[1], status: 'active' });
}

async function findByStorageKey(storageKey, hospitalId = null) {
  const query = { storageKey: String(storageKey || ''), status: 'active' };
  if (hospitalId) query.hospitalId = hospitalId;
  return StoredFile.findOne(query);
}

function canAccess(record, user) {
  if (!record || record.status !== 'active') return false;
  if (record.visibility === 'public') return true;
  if (!user) return false;
  if (user.role === 'mediqliq_super_admin') return true;
  return idString(record.hospitalId) && idString(record.hospitalId) === idString(hospitalIdFromUser(user));
}

async function openRead(record) {
  if (!record) throw new Error('Stored file record is required');
  if (record.storageDriver === 'b2') return b2Storage.openRead(record.storageKey);
  if (record.storageDriver === 'cloudinary') return cloudinaryStorage.openRead(record);

  const filePath = absolutePath(record.storageKey);
  await fsp.access(filePath, fs.constants.R_OK);
  return {
    stream: fs.createReadStream(filePath),
    size: Number(record.sizeBytes || (await fsp.stat(filePath)).size),
    contentType: record.mimeType || null
  };
}

async function readBuffer(record) {
  if (!record) throw new Error('Stored file record is required');
  if (record.storageDriver === 'b2') return b2Storage.readBuffer(record.storageKey);
  if (record.storageDriver === 'cloudinary') return cloudinaryStorage.readBuffer(record);
  return fsp.readFile(absolutePath(record.storageKey));
}

async function resolveRecordForStoragePath(storagePath, hospitalId = null) {
  if (!storagePath) return null;
  const raw = String(storagePath);
  if (raw.includes('/api/files/')) return findByUrl(raw);
  if (!path.isAbsolute(raw)) return findByStorageKey(raw.replace(/\\/g, '/'), hospitalId);
  return null;
}

async function readStoragePath(storagePath, options = {}) {
  const record = await resolveRecordForStoragePath(storagePath, options.hospitalId || null);
  if (record) return readBuffer(record);

  const raw = String(storagePath || '');
  const localPath = path.isAbsolute(raw) ? path.resolve(raw) : absolutePath(raw);
  const expectedPrefix = `${uploadRoot}${path.sep}`;
  if (localPath !== uploadRoot && !localPath.startsWith(expectedPrefix)) {
    const error = new Error('Invalid local storage path');
    error.statusCode = 400;
    throw error;
  }
  return fsp.readFile(localPath);
}

async function openStoragePath(storagePath, options = {}) {
  const record = await resolveRecordForStoragePath(storagePath, options.hospitalId || null);
  if (record) return openRead(record);

  const raw = String(storagePath || '');
  const localPath = path.isAbsolute(raw) ? path.resolve(raw) : absolutePath(raw);
  const expectedPrefix = `${uploadRoot}${path.sep}`;
  if (localPath !== uploadRoot && !localPath.startsWith(expectedPrefix)) {
    const error = new Error('Invalid local storage path');
    error.statusCode = 400;
    throw error;
  }
  await fsp.access(localPath, fs.constants.R_OK);
  const stat = await fsp.stat(localPath);
  return { stream: fs.createReadStream(localPath), size: stat.size, contentType: null };
}

async function storagePathExists(storagePath, options = {}) {
  try {
    const record = await resolveRecordForStoragePath(storagePath, options.hospitalId || null);
    if (record) {
      if (record.storageDriver === 'b2') return Boolean(await b2Storage.findFile(record.storageKey));
      if (record.storageDriver === 'cloudinary') {
        await cloudinaryStorage.readBuffer(record);
        return true;
      }
      await fsp.access(absolutePath(record.storageKey), fs.constants.R_OK);
      return true;
    }
    const raw = String(storagePath || '');
    const localPath = path.isAbsolute(raw) ? path.resolve(raw) : absolutePath(raw);
    await fsp.access(localPath, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function deleteStoredFile(record) {
  if (!record) return false;
  if (record.storageDriver === 'b2') {
    if (record.providerFileId) await b2Storage.deleteFileVersion(record.storageKey, record.providerFileId);
    else await b2Storage.deleteAllVersions(record.storageKey);
    return true;
  }
  if (record.storageDriver === 'cloudinary') return cloudinaryStorage.deleteFile(record);

  const filePath = absolutePath(record.storageKey);
  await fsp.unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}

async function removeByUrl(url) {
  const record = await findByUrl(url);
  if (!record) return false;
  await deleteStoredFile(record);
  record.status = 'deleted';
  record.deletedAt = new Date();
  await record.save();
  return true;
}

module.exports = {
  uploadRoot,
  configuredDriver,
  absolutePath,
  upload,
  uploadBuffer,
  findByUrl,
  findByStorageKey,
  canAccess,
  openRead,
  readBuffer,
  readStoragePath,
  openStoragePath,
  storagePathExists,
  deleteStoredFile,
  removeByUrl
};
