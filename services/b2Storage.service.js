const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const { Readable } = require('stream');

const DEFAULT_API_BASE = 'https://api.backblazeb2.com';
const AUTH_CACHE_MS = 20 * 60 * 1000;

let authCache = null;
let authCacheAt = 0;
let bucketCache = null;

function config() {
  return {
    keyId: String(process.env.B2_KEY_ID || '').trim(),
    applicationKey: String(process.env.B2_APPLICATION_KEY || '').trim(),
    bucketName: String(process.env.B2_BUCKET_NAME || '').trim(),
    bucketId: String(process.env.B2_BUCKET_ID || '').trim(),
    apiBase: String(process.env.B2_API_BASE || DEFAULT_API_BASE).replace(/\/$/, '')
  };
}

function isConfigured() {
  const cfg = config();
  return Boolean(cfg.keyId && cfg.applicationKey && cfg.bucketName);
}

function assertConfigured() {
  if (!isConfigured()) {
    const error = new Error('Backblaze B2 is not configured. Set B2_KEY_ID, B2_APPLICATION_KEY and B2_BUCKET_NAME.');
    error.code = 'B2_NOT_CONFIGURED';
    throw error;
  }
}

async function parseResponse(response, operation) {
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch (_) { payload = { raw: text }; }
  }
  if (response.ok) return payload || {};

  const message = payload?.message || payload?.code || `${operation} failed with HTTP ${response.status}`;
  const error = new Error(`Backblaze B2 ${operation}: ${message}`);
  error.statusCode = response.status;
  error.b2Code = payload?.code;
  error.b2Response = payload;
  throw error;
}

function storageApiFrom(auth) {
  return auth?.apiInfo?.storageApi || auth?.storageApi || {};
}

function allowedFrom(auth) {
  const storageApi = storageApiFrom(auth);
  return storageApi.allowed || auth?.allowed || {};
}

async function authorize({ force = false } = {}) {
  assertConfigured();
  if (!force && authCache && (Date.now() - authCacheAt) < AUTH_CACHE_MS) return authCache;

  const cfg = config();
  const basic = Buffer.from(`${cfg.keyId}:${cfg.applicationKey}`).toString('base64');
  const response = await fetch(`${cfg.apiBase}/b2api/v4/b2_authorize_account`, {
    method: 'GET',
    headers: { Authorization: `Basic ${basic}` }
  });
  const auth = await parseResponse(response, 'authorize_account');
  authCache = auth;
  authCacheAt = Date.now();
  bucketCache = null;
  return auth;
}

async function apiCall(operation, body = {}, { retry = true } = {}) {
  let auth = await authorize();
  let storageApi = storageApiFrom(auth);
  const apiUrl = storageApi.apiUrl || auth.apiUrl;
  const authorizationToken = auth.authorizationToken;
  if (!apiUrl || !authorizationToken) throw new Error('Backblaze B2 authorization response is missing API URL/token');

  const response = await fetch(`${apiUrl}/b2api/v4/${operation}`, {
    method: 'POST',
    headers: {
      Authorization: authorizationToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (retry && (response.status === 401 || response.status === 403)) {
    await authorize({ force: true });
    return apiCall(operation, body, { retry: false });
  }
  return parseResponse(response, operation);
}

async function resolveBucket() {
  const cfg = config();
  if (bucketCache) return bucketCache;

  const auth = await authorize();
  const allowed = allowedFrom(auth);
  const allowedBuckets = Array.isArray(allowed.buckets) ? allowed.buckets : [];
  const legacyRestrictedBucketId = allowed.bucketId || storageApiFrom(auth).bucketId;
  const legacyRestrictedBucketName = allowed.bucketName || storageApiFrom(auth).bucketName;

  if (cfg.bucketId) {
    bucketCache = { bucketId: cfg.bucketId, bucketName: cfg.bucketName };
    return bucketCache;
  }

  // Native API v4 returns bucket restrictions in apiInfo.storageApi.allowed.buckets.
  // A single-bucket application key therefore does not need listBuckets access.
  const exactAllowed = allowedBuckets.find((item) => item?.name === cfg.bucketName);
  const soleAllowed = allowedBuckets.length === 1 ? allowedBuckets[0] : null;
  const restricted = exactAllowed || (soleAllowed && !soleAllowed.name ? soleAllowed : null);
  if (restricted?.id) {
    bucketCache = { bucketId: restricted.id, bucketName: cfg.bucketName || restricted.name };
    return bucketCache;
  }

  // Compatibility with v3 authorization responses.
  if (legacyRestrictedBucketId && (!legacyRestrictedBucketName || legacyRestrictedBucketName === cfg.bucketName)) {
    bucketCache = { bucketId: legacyRestrictedBucketId, bucketName: cfg.bucketName || legacyRestrictedBucketName };
    return bucketCache;
  }

  // This fallback requires the List Buckets capability. Supplying B2_BUCKET_ID avoids that requirement.
  const accountId = auth.accountId;
  const result = await apiCall('b2_list_buckets', {
    accountId,
    bucketName: cfg.bucketName
  });
  const bucket = (result.buckets || []).find((item) => item.bucketName === cfg.bucketName);
  if (!bucket) throw new Error(`Backblaze B2 bucket not found: ${cfg.bucketName}`);
  bucketCache = { bucketId: bucket.bucketId, bucketName: bucket.bucketName };
  return bucketCache;
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function encodeFileName(fileName) {
  return encodeURIComponent(String(fileName)).replace(/%2F/gi, '/');
}

function safeInfoHeaders(fileInfo = {}) {
  const headers = {};
  for (const [rawKey, rawValue] of Object.entries(fileInfo || {})) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const key = String(rawKey).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    const value = encodeURIComponent(String(rawValue).slice(0, 1000));
    if (key) headers[`X-Bz-Info-${key}`] = value;
  }
  return headers;
}

async function getUploadUrl(bucketId) {
  return apiCall('b2_get_upload_url', { bucketId });
}

async function uploadFile(filePath, fileName, options = {}) {
  assertConfigured();
  const stat = await fsp.stat(filePath);
  const sha1 = await sha1File(filePath);
  const { bucketId } = await resolveBucket();

  async function attempt(forceAuth = false) {
    if (forceAuth) await authorize({ force: true });
    const uploadTarget = await getUploadUrl(bucketId);
    const stream = fs.createReadStream(filePath);
    const response = await fetch(uploadTarget.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: uploadTarget.authorizationToken,
        'X-Bz-File-Name': encodeFileName(fileName),
        'Content-Type': options.contentType || 'b2/x-auto',
        'Content-Length': String(stat.size),
        'X-Bz-Content-Sha1': sha1,
        ...(String(process.env.B2_SERVER_SIDE_ENCRYPTION || 'AES256').toUpperCase() === 'AES256'
          ? { 'X-Bz-Server-Side-Encryption': 'AES256' }
          : {}),
        ...safeInfoHeaders(options.fileInfo)
      },
      body: stream,
      duplex: 'half'
    });
    if (response.status === 401 || response.status === 503) {
      await response.arrayBuffer().catch(() => {});
      return null;
    }
    return parseResponse(response, 'upload_file');
  }

  let uploaded = await attempt(false);
  if (!uploaded) uploaded = await attempt(true);
  if (!uploaded) throw new Error('Backblaze B2 upload failed after retry');
  return uploaded;
}

async function findFile(fileName) {
  const { bucketId } = await resolveBucket();
  const result = await apiCall('b2_list_file_names', {
    bucketId,
    startFileName: fileName,
    prefix: fileName,
    maxFileCount: 1
  });
  return (result.files || []).find((file) => file.fileName === fileName) || null;
}

async function downloadResponse(fileName, { retry = true } = {}) {
  const cfg = config();
  const auth = await authorize();
  const storageApi = storageApiFrom(auth);
  const downloadUrl = storageApi.downloadUrl || auth.downloadUrl;
  if (!downloadUrl) throw new Error('Backblaze B2 authorization response is missing download URL');

  const pathName = String(fileName).split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${downloadUrl}/file/${encodeURIComponent(cfg.bucketName)}/${pathName}`, {
    headers: { Authorization: auth.authorizationToken }
  });
  if (retry && (response.status === 401 || response.status === 403)) {
    await response.arrayBuffer().catch(() => {});
    await authorize({ force: true });
    return downloadResponse(fileName, { retry: false });
  }
  if (!response.ok) await parseResponse(response, 'download_file_by_name');
  return response;
}

async function readBuffer(fileName) {
  const response = await downloadResponse(fileName);
  return Buffer.from(await response.arrayBuffer());
}

async function openRead(fileName) {
  const response = await downloadResponse(fileName);
  if (!response.body) throw new Error('Backblaze B2 download returned an empty body');
  return {
    stream: Readable.fromWeb(response.body),
    size: Number(response.headers.get('content-length') || 0) || null,
    contentType: response.headers.get('content-type') || null
  };
}

async function deleteFileVersion(fileName, fileId) {
  if (!fileName || !fileId) return false;
  await apiCall('b2_delete_file_version', { fileName, fileId });
  return true;
}

async function deleteAllVersions(fileName) {
  const { bucketId } = await resolveBucket();
  let startFileName = fileName;
  let startFileId = null;
  let deleted = 0;

  do {
    const body = {
      bucketId,
      startFileName,
      prefix: fileName,
      maxFileCount: 1000
    };
    if (startFileId) body.startFileId = startFileId;
    const result = await apiCall('b2_list_file_versions', body);
    const exact = (result.files || []).filter((file) => file.fileName === fileName);
    for (const file of exact) {
      await deleteFileVersion(file.fileName, file.fileId);
      deleted += 1;
    }
    startFileName = result.nextFileName || null;
    startFileId = result.nextFileId || null;
  } while (startFileName && startFileName === fileName);

  return deleted;
}

async function testConnection() {
  const auth = await authorize();
  const bucket = await resolveBucket();
  const capabilities = allowedFrom(auth).capabilities || storageApiFrom(auth).capabilities || [];
  const requiredCapabilities = ['readFiles', 'writeFiles', 'listFiles', 'deleteFiles'];
  const missingCapabilities = requiredCapabilities.filter((name) => !capabilities.includes(name));
  if (capabilities.length && missingCapabilities.length) {
    const error = new Error(`Backblaze B2 application key is missing capabilities: ${missingCapabilities.join(', ')}`);
    error.code = 'B2_MISSING_CAPABILITIES';
    throw error;
  }
  return {
    configured: true,
    bucketName: bucket.bucketName,
    bucketId: bucket.bucketId,
    serverSideEncryption: String(process.env.B2_SERVER_SIDE_ENCRYPTION || 'AES256').toUpperCase(),
    capabilities
  };
}

module.exports = {
  config,
  isConfigured,
  assertConfigured,
  authorize,
  resolveBucket,
  uploadFile,
  findFile,
  downloadResponse,
  readBuffer,
  openRead,
  deleteFileVersion,
  deleteAllVersions,
  testConnection
};
