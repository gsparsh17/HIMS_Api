const fs = require('fs');
const { Readable } = require('stream');
const cloudinary = require('cloudinary').v2;

let configured = false;

function config() {
  return {
    cloudName: String(process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
    apiKey: String(process.env.CLOUDINARY_API_KEY || '').trim(),
    apiSecret: String(process.env.CLOUDINARY_API_SECRET || '').trim()
  };
}

function isConfigured() {
  const cfg = config();
  return Boolean(cfg.cloudName && cfg.apiKey && cfg.apiSecret);
}

function assertConfigured() {
  if (!isConfigured()) {
    const error = new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.');
    error.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw error;
  }
}

function ensureConfigured() {
  assertConfigured();
  if (configured) return;
  const cfg = config();
  cloudinary.config({
    cloud_name: cfg.cloudName,
    api_key: cfg.apiKey,
    api_secret: cfg.apiSecret,
    secure: true
  });
  configured = true;
}

async function uploadFile(filePath, storageKey, options = {}) {
  ensureConfigured();
  if (!fs.existsSync(filePath)) throw new Error(`Upload source does not exist: ${filePath}`);

  const resourceType = options.resourceType || options.resource_type || 'auto';
  const publicId = String(storageKey).replace(/\.[a-z0-9]{1,10}$/i, '');
  const result = await cloudinary.uploader.upload(filePath, {
    public_id: publicId,
    resource_type: resourceType,
    overwrite: false,
    unique_filename: false,
    use_filename: false,
    invalidate: false
  });

  return {
    fileId: result.asset_id || result.public_id,
    publicId: result.public_id,
    secureUrl: result.secure_url,
    resourceType: result.resource_type || resourceType,
    bytes: Number(result.bytes || 0),
    format: result.format || null
  };
}

async function downloadResponse(url) {
  if (!url) throw new Error('Cloudinary file URL is missing');
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Cloudinary download failed with HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return response;
}

async function readBuffer(record) {
  const response = await downloadResponse(record.providerUrl);
  return Buffer.from(await response.arrayBuffer());
}

async function openRead(record) {
  const response = await downloadResponse(record.providerUrl);
  if (!response.body) throw new Error('Cloudinary download returned an empty body');
  return {
    stream: Readable.fromWeb(response.body),
    size: Number(response.headers.get('content-length') || record.sizeBytes || 0) || null,
    contentType: response.headers.get('content-type') || record.mimeType || null
  };
}

async function deleteFile(record) {
  ensureConfigured();
  const publicId = record.providerPublicId || record.providerFileId || String(record.storageKey || '').replace(/\.[a-z0-9]{1,10}$/i, '');
  if (!publicId) return false;
  const resourceType = record.providerResourceType || 'image';
  await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
    invalidate: true
  });
  return true;
}

module.exports = {
  isConfigured,
  assertConfigured,
  uploadFile,
  readBuffer,
  openRead,
  deleteFile
};
