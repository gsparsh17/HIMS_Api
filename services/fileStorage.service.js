const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const StoredFile = require('../models/StoredFile');
const { hospitalIdFromUser, idString } = require('./tenantScope.service');

const defaultUploadRoot = process.env.NODE_ENV === 'production'
  ? '/srv/mediqliq/uploads'
  : path.join(process.cwd(), 'uploads', 'storage');
const uploadRoot = path.resolve(process.env.UPLOAD_DIR || defaultUploadRoot);

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
  if (!resolved.startsWith(expectedPrefix)) {
    const error = new Error('Invalid storage key');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
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
  const tenant = hospitalId ? safeSegment(idString(hospitalId), 'unknown-hospital') : 'public';
  const idPart = safeSegment(options.public_id, crypto.randomUUID());
  const filename = `${Date.now()}-${idPart}-${crypto.randomBytes(6).toString('hex')}${extensionFor(file)}`;
  const storageKey = path.posix.join('hospitals', tenant, category, filename);
  const destination = absolutePath(storageKey);

  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(file.path, destination, fs.constants.COPYFILE_EXCL);

  try {
    const stat = await fsp.stat(destination);
    const record = await StoredFile.create({
      hospitalId,
      uploadedBy: req?.user?._id,
      storageDriver: 'local',
      storageKey,
      originalName: file.originalname || filename,
      mimeType: file.mimetype || 'application/octet-stream',
      sizeBytes: Number(file.size || stat.size),
      sha256: await checksum(destination),
      category,
      visibility
    });

    return {
      secure_url: `/api/files/${record._id}`,
      public_id: String(record._id),
      file_id: String(record._id),
      storage_key: storageKey,
      storage_path: destination,
      mime_type: record.mimeType,
      size: record.sizeBytes
    };
  } catch (error) {
    await fsp.unlink(destination).catch(() => {});
    throw error;
  }
}

async function findByUrl(url) {
  const match = String(url || '').match(/\/api\/files\/([a-fA-F0-9]{24})(?:[/?#]|$)/);
  if (!match) return null;
  return StoredFile.findOne({ _id: match[1], status: 'active' });
}

function canAccess(record, user) {
  if (!record || record.status !== 'active') return false;
  if (record.visibility === 'public') return true;
  if (!user) return false;
  if (user.role === 'mediqliq_super_admin') return true;
  return idString(record.hospitalId) && idString(record.hospitalId) === idString(hospitalIdFromUser(user));
}

module.exports = {
  uploadRoot,
  absolutePath,
  upload,
  findByUrl,
  canAccess
};
