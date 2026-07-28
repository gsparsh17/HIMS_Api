'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8090);
const ENGINE_URL = String(process.env.FIDELIUS_ENGINE_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');
const SERVICE_TOKEN = String(process.env.MEDIQLIQ_SERVICE_TOKEN || '');
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const ENGINE_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS || 15000);
const DEFAULT_KEY_TTL_SECONDS = Number(process.env.KEY_TTL_SECONDS || 1800);
const KEY_VERSION = String(process.env.KEY_HANDLE_VERSION || 'v1');

function appError(message, statusCode = 400, code = 'CRYPTO_ADAPTER_ERROR', details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function secretKey() {
  const encoded = process.env.KEY_HANDLE_SECRET_BASE64;
  if (!encoded) throw appError('KEY_HANDLE_SECRET_BASE64 is required', 503, 'KEY_HANDLE_SECRET_MISSING');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw appError('KEY_HANDLE_SECRET_BASE64 must decode to 32 bytes', 503, 'KEY_HANDLE_SECRET_INVALID');
  return key;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorize(req) {
  if (!SERVICE_TOKEN) return;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const internal = String(req.headers['x-mediqliq-service-token'] || '');
  if (!safeEqual(bearer || internal, SERVICE_TOKEN)) {
    throw appError('Unauthorized internal service request', 401, 'UNAUTHORIZED');
  }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw appError('Request body is too large', 413, 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_error) {
    throw appError('Request body must be valid JSON', 400, 'INVALID_JSON');
  }
}

function send(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

async function engine(path, options = {}) {
  const response = await fetch(`${ENGINE_URL}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    redirect: 'error'
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = {}; }
  if (!response.ok) {
    throw appError('Fidelius engine operation failed', 502, 'FIDELIUS_ENGINE_ERROR', { status: response.status });
  }
  return data;
}

function encodeHandle(material) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  cipher.setAAD(Buffer.from(`mediqliq-abdm-key-handle:${KEY_VERSION}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(material), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [KEY_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decodeHandle(handle) {
  const [version, ivValue, tagValue, ciphertextValue] = String(handle || '').split('.');
  if (!version || !ivValue || !tagValue || !ciphertextValue || version !== KEY_VERSION) {
    throw appError('Invalid or unsupported key handle', 422, 'KEY_HANDLE_INVALID');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivValue, 'base64url'));
    decipher.setAAD(Buffer.from(`mediqliq-abdm-key-handle:${version}`));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final()
    ]);
    const material = JSON.parse(plaintext.toString('utf8'));
    if (material.expiresAt && new Date(material.expiresAt).getTime() <= Date.now()) {
      throw appError('Key handle has expired', 410, 'KEY_HANDLE_EXPIRED');
    }
    return material;
  } catch (error) {
    if (error.code === 'KEY_HANDLE_EXPIRED') throw error;
    throw appError('Key handle integrity verification failed', 422, 'KEY_HANDLE_INTEGRITY_FAILED');
  }
}

function keyValue(material) {
  return material?.dhPublicKey?.keyValue || material?.publicKey || material?.keyValue;
}

function nonceValue(material) {
  return material?.nonce || material?.dhPublicKey?.nonce;
}

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.from(String(value))).digest('hex');
}

async function receiverKeyMaterial(body) {
  const generated = await engine('/keys/generate');
  const expiry = body.expiresAt && !Number.isNaN(new Date(body.expiresAt).getTime())
    ? new Date(body.expiresAt)
    : new Date(Date.now() + DEFAULT_KEY_TTL_SECONDS * 1000);
  const privateMaterial = {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    nonce: generated.nonce,
    expiresAt: expiry.toISOString(),
    requestId: body.requestId,
    consentId: body.consentId
  };
  return {
    publicKeyMaterial: {
      cryptoAlg: 'ECDH',
      curve: 'curve25519',
      dhPublicKey: {
        expiry: expiry.toISOString(),
        parameters: 'curve25519',
        keyValue: generated.publicKey
      },
      nonce: generated.nonce
    },
    keyHandle: encodeHandle(privateMaterial)
  };
}

async function encrypt(body) {
  const records = Array.isArray(body.records) ? body.records : [];
  if (!records.length) throw appError('records must contain at least one FHIR document', 422, 'RECORDS_REQUIRED');
  const receiverPublicKey = keyValue(body.peerKeyMaterial);
  const receiverNonce = nonceValue(body.peerKeyMaterial);
  if (!receiverPublicKey || !receiverNonce) throw appError('peerKeyMaterial is incomplete', 422, 'PEER_KEY_MATERIAL_INVALID');

  const sender = await engine('/keys/generate');
  const entries = [];
  let keyToShare = sender.publicKey;
  for (const record of records) {
    const plaintext = typeof record.content === 'string' ? record.content : JSON.stringify(record.content);
    const result = await engine('/encrypt', {
      method: 'POST',
      body: {
        receiverPublicKey,
        receiverNonce,
        senderPrivateKey: sender.privateKey,
        senderPublicKey: sender.publicKey,
        senderNonce: sender.nonce,
        plainTextData: plaintext
      }
    });
    keyToShare = result.keyToShare || keyToShare;
    entries.push({
      content: result.encryptedData,
      media: 'application/fhir+json',
      checksum: digest(plaintext),
      careContextReference: record.careContextReference,
      hiType: record.hiType,
      sourceHipId: record.sourceHipId
    });
  }

  return {
    entries,
    keyMaterial: {
      cryptoAlg: 'ECDH',
      curve: 'curve25519',
      dhPublicKey: {
        expiry: new Date(Date.now() + DEFAULT_KEY_TTL_SECONDS * 1000).toISOString(),
        parameters: 'curve25519',
        keyValue: keyToShare
      },
      nonce: sender.nonce
    }
  };
}

async function decrypt(body) {
  const material = body.keyHandle ? decodeHandle(body.keyHandle) : body.privateMaterial;
  if (!material?.privateKey || !material?.nonce) throw appError('Receiver private material is unavailable', 422, 'PRIVATE_MATERIAL_INVALID');
  const senderPublicKey = keyValue(body.keyMaterial);
  const senderNonce = nonceValue(body.keyMaterial);
  if (!senderPublicKey || !senderNonce) throw appError('Sender keyMaterial is incomplete', 422, 'SENDER_KEY_MATERIAL_INVALID');
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const records = [];
  try {
    for (const entry of entries) {
      const result = await engine('/decrypt', {
        method: 'POST',
        body: {
          receiverPrivateKey: material.privateKey,
          receiverNonce: material.nonce,
          senderPublicKey,
          senderNonce,
          encryptedData: entry.content
        }
      });
      records.push({
        content: result.decryptedData,
        careContextReference: entry.careContextReference,
        hiType: entry.hiType,
        sourceHipId: entry.sourceHipId,
        sourceName: entry.sourceName,
        provenance: entry.provenance
      });
    }
  } catch (_error) {
    throw appError('Authenticated decryption failed', 422, 'CRYPTO_INTEGRITY_FAILED');
  }
  return { records, integrityVerified: true };
}

async function route(req, res) {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const health = await engine('/health');
      return send(res, 200, {
        status: health.status === 'UP' ? 'UP' : 'DOWN',
        service: 'mediqliq-abdm-crypto-adapter',
        cryptoAlg: 'ECDH-HKDF-AES-256-GCM',
        curve: 'curve25519',
        integrityCapable: true,
        keyHandles: true
      });
    }
    authorize(req);
    if (req.method !== 'POST') throw appError('Route not found', 404, 'NOT_FOUND');
    const body = await readJson(req);
    if (req.url === '/v1/receiver-key-material') return send(res, 200, await receiverKeyMaterial(body));
    if (req.url === '/v1/encrypt') return send(res, 200, await encrypt(body));
    if (req.url === '/v1/decrypt') return send(res, 200, await decrypt(body));
    throw appError('Route not found', 404, 'NOT_FOUND');
  } catch (error) {
    return send(res, error.statusCode || 500, {
      success: false,
      code: error.code || 'CRYPTO_ADAPTER_ERROR',
      message: error.statusCode && error.statusCode < 500 ? error.message : 'Internal cryptography service error',
      details: error.details
    });
  }
}

const server = http.createServer(route);
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 10000);
server.listen(PORT, '0.0.0.0');
