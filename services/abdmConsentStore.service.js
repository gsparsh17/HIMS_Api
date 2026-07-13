const AbdmConsent = require('../models/AbdmConsent');

function deepFind(object, keys = []) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  for (const value of Object.values(object)) {
    const result = deepFind(value, keys);
    if (result !== undefined) return result;
  }
  return undefined;
}

function collectCareContextReferences(object, set = new Set()) {
  if (!object || typeof object !== 'object') return set;
  if (Array.isArray(object)) {
    object.forEach((value) => collectCareContextReferences(value, set));
    return set;
  }
  for (const [key, value] of Object.entries(object)) {
    if (
      ['careContextReference', 'careContextReferenceNumber'].includes(key) &&
      typeof value === 'string'
    ) {
      set.add(value);
    }
    if (key === 'careContexts' && Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === 'string') set.add(item);
        if (item?.referenceNumber) set.add(String(item.referenceNumber));
        if (item?.id) set.add(String(item.id));
      });
    }
    collectCareContextReferences(value, set);
  }
  return set;
}

function normalizeStatus(value) {
  const status = String(value || 'GRANTED').toUpperCase();
  if (status.includes('REVOK')) return 'REVOKED';
  if (status.includes('DEN')) return 'DENIED';
  if (status.includes('EXPIR')) return 'EXPIRED';
  if (status.includes('GRANT') || status.includes('APPROV')) return 'GRANTED';
  return 'REQUESTED';
}

async function upsertConsentFromCallback(facilityId, payload = {}) {
  const consentId =
    payload.notification?.consentId ||
    payload.consentId ||
    payload.consentDetail?.consentId ||
    deepFind(payload, ['consentId']);
  if (!consentId) return null;

  const status = normalizeStatus(
    payload.notification?.status || payload.status || payload.consentDetail?.status || deepFind(payload, ['status'])
  );
  const hiTypes = deepFind(payload, ['hiTypes']) || [];
  const dateRange = deepFind(payload, ['dateRange']) || {};
  const abhaAddress = deepFind(payload, ['abhaAddress', 'patientId']);
  const patientReference = deepFind(payload, ['patientReference']);
  const careContextReferences = Array.from(collectCareContextReferences(payload));

  return AbdmConsent.findOneAndUpdate(
    { consentId: String(consentId) },
    {
      consentId: String(consentId),
      facilityId,
      patientReference,
      abhaAddress,
      status,
      hiTypes: Array.isArray(hiTypes) ? hiTypes : [],
      purpose: deepFind(payload, ['purpose']),
      dateRange: {
        from: dateRange?.from ? new Date(dateRange.from) : undefined,
        to: dateRange?.to ? new Date(dateRange.to) : undefined
      },
      careContextReferences,
      permission: deepFind(payload, ['permission']),
      rawReference: {
        notification: payload.notification,
        consentDetail: payload.consentDetail
      },
      expiresAt: deepFind(payload, ['expiry', 'expiresAt']) ? new Date(deepFind(payload, ['expiry', 'expiresAt'])) : undefined
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

module.exports = { upsertConsentFromCallback };
