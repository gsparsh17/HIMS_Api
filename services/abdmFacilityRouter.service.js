const crypto = require('crypto');
const AbdmFacility = require('../models/AbdmFacility');
const AbdmTransaction = require('../models/AbdmTransaction');
const abdmConfig = require('../config/abdm.config');
const { decryptSecret } = require('../utils/secretVault');
const { signRequest, stableBody } = require('../utils/internalSignature');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function deepGet(object, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), object);
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return undefined;
}

async function resolveFacilityId({ headers = {}, body = {}, requestId, transactionId }) {
  const direct =
    headers['x-hip-id'] ||
    headers['X-HIP-ID'] ||
    headers['x-facility-id'] ||
    deepGet(body, [
      'metaData.hipId',
      'metadata.hipId',
      'hip.id',
      'hipId',
      'facilityId',
      'serviceId',
      'hiRequest.hip.id',
      'consentDetail.hip.id',
      'notification.consentDetail.hip.id'
    ]);
  if (direct) return direct;

  if (requestId || transactionId) {
    const tx = await AbdmTransaction.findOne({
      $or: [
        ...(requestId ? [{ requestId }] : []),
        ...(transactionId ? [{ transactionId }] : [])
      ]
    })
      .sort({ createdAt: -1 })
      .lean();
    if (tx?.facilityId) return tx.facilityId;
  }
  return undefined;
}

async function getFacility(facilityId, options = {}) {
  if (!facilityId) return null;
  let query = AbdmFacility.findOne({
    active: true,
    $or: [{ 'abdm.hipId': facilityId }, { facilityId }]
  });
  if (options.includeSecret) {
    query = query.select('+connector.secretEncrypted.ciphertext +connector.secretEncrypted.iv +connector.secretEncrypted.tag');
  }
  return query;
}

async function resolveFacility(input) {
  const facilityId = await resolveFacilityId(input);
  if (!facilityId) return null;
  return getFacility(facilityId);
}

async function forwardToHospital(facility, path, body, options = {}) {
  const hipId = facility.abdm?.hipId || facility.facilityId;
  const secretFacility = await getFacility(hipId, { includeSecret: true });
  if (!secretFacility) throw new Error(`HIP ${hipId} is not registered or active`);
  const allowedStatuses = options.allowPending ? ['ACTIVE', 'PENDING'] : ['ACTIVE'];
  if (!allowedStatuses.includes(secretFacility.connector?.status)) {
    throw new Error(`Facility connector is ${secretFacility.connector?.status || 'inactive'}`);
  }
  if (!secretFacility.connector?.baseUrl || !secretFacility.connector?.keyId || !secretFacility.connector?.secretEncrypted) {
    throw new Error('Facility connector is incomplete');
  }

  const method = String(options.method || 'POST').toUpperCase();
  const timestamp = new Date().toISOString();
  const requestId = options.requestId || crypto.randomUUID();
  const secret = decryptSecret(secretFacility.connector.secretEncrypted);
  const signature = signRequest(secret, { timestamp, requestId, method, path, body });
  const baseUrl = String(secretFacility.connector.baseUrl || '').replace(/\/+$/, '');

  const response = await fetchFn(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-MediQliq-Facility-ID': hipId,
      'X-MediQliq-Key-ID': secretFacility.connector.keyId,
      'X-MediQliq-Timestamp': timestamp,
      'X-MediQliq-Request-ID': requestId,
      'X-MediQliq-Signature': signature
    },
    body: body === undefined ? undefined : stableBody(body),
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs || abdmConfig.callbackTimeoutMs)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Hospital connector failed: ${response.status}`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

module.exports = {
  resolveFacilityId,
  resolveFacility,
  getFacility,
  forwardToHospital
};
