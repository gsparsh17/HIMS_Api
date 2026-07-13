const crypto = require('crypto');
const abdmConfig = require('../config/abdm.config');
const { notifyHealthInformation } = require('./abdmHip.service');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function checksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function externalCryptoAdapter({ transactionId, peerKeyMaterial, records }) {
  const rawUrl = process.env.ABDM_CRYPTO_ADAPTER_URL;
  if (!rawUrl) throw new Error('ABDM_CRYPTO_ADAPTER_URL is required when ABDM_DATA_PUSH_MODE=external');
  const url = await assertSafeOutboundUrl(rawUrl, {
    label: 'ABDM crypto adapter URL',
    allowedHosts: abdmConfig.cryptoAdapterAllowedHosts,
    requireHttps: process.env.NODE_ENV === 'production',
    allowPrivate: process.env.NODE_ENV !== 'production' && process.env.ABDM_ALLOW_PRIVATE_ADAPTER_URLS === 'true'
  });
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ABDM_CRYPTO_ADAPTER_TOKEN) headers.Authorization = `Bearer ${process.env.ABDM_CRYPTO_ADAPTER_TOKEN}`;
  const response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transactionId, peerKeyMaterial, records }),
    signal: AbortSignal.timeout(Number(process.env.ABDM_CRYPTO_ADAPTER_TIMEOUT_MS || 20000)),
    redirect: 'error'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.entries) || !data.keyMaterial) {
    const error = new Error(data?.message || 'ABDM crypto adapter returned an invalid response');
    error.details = data;
    throw error;
  }
  return data;
}

async function prepareEncryptedPackage(input) {
  const mode = String(process.env.ABDM_DATA_PUSH_MODE || 'disabled').toLowerCase();
  if (mode === 'external') return externalCryptoAdapter(input);

  // ABDM data-flow crypto is intentionally fail-closed. The repository includes the transport
  // orchestration but does not guess the certification-critical Curve25519 envelope. Connect the
  // official/validated NHA-compatible crypto implementation through ABDM_CRYPTO_ADAPTER_URL.
  throw new Error(
    `ABDM health-information data push is disabled (ABDM_DATA_PUSH_MODE=${mode}). Configure a validated ABDM crypto adapter before enabling M2 data exchange.`
  );
}

async function notifyTransfer({ facilityId, consentId, transactionId, sessionStatus, careContextReferences, error }) {
  const body = {
    notification: {
      consentId,
      transactionId,
      doneAt: new Date().toISOString(),
      notifier: { type: 'HIP', id: facilityId },
      statusNotification: {
        sessionStatus,
        hipId: facilityId,
        statusResponses: (careContextReferences || []).map((referenceNumber) => ({
          careContextReference: referenceNumber,
          hiStatus: sessionStatus === 'TRANSFERRED' ? 'DELIVERED' : 'ERRORED',
          description: error || undefined
        }))
      }
    }
  };
  return notifyHealthInformation(facilityId, body);
}

async function pushHealthInformation({ facilityId, consentId, transactionId, dataPushUrl, peerKeyMaterial, records }) {
  const careContextReferences = records.map((item) => item.careContextReference).filter(Boolean);
  try {
    const safeDataPushUrl = await assertSafeOutboundUrl(dataPushUrl, {
      label: 'ABDM data push URL',
      allowedHosts: abdmConfig.dataPushAllowedHosts,
      requireHttps: true,
      allowPrivate: false
    });
    const encrypted = await prepareEncryptedPackage({ transactionId, peerKeyMaterial, records });
    const entries = encrypted.entries.map((entry, index) => ({
      ...entry,
      media: entry.media || 'application/fhir+json',
      checksum:
        entry.checksum ||
        checksum(
          typeof records[index]?.content === 'string'
            ? records[index].content
            : JSON.stringify(records[index]?.content || {})
        )
    }));
    const response = await fetchFn(safeDataPushUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId, entries, keyMaterial: encrypted.keyMaterial }),
      signal: AbortSignal.timeout(Number(process.env.ABDM_DATA_PUSH_TIMEOUT_MS || 30000)),
      redirect: 'error'
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(responseBody?.message || `HIU data push failed: ${response.status}`);
      error.details = responseBody;
      throw error;
    }
    await notifyTransfer({ facilityId, consentId, transactionId, sessionStatus: 'TRANSFERRED', careContextReferences });
    return { success: true, response: responseBody, entries: entries.length };
  } catch (error) {
    try {
      await notifyTransfer({
        facilityId,
        consentId,
        transactionId,
        sessionStatus: 'FAILED',
        careContextReferences,
        error: error.message
      });
    } catch (notifyError) {
      error.notifyError = notifyError.message;
    }
    throw error;
  }
}

module.exports = { pushHealthInformation, prepareEncryptedPackage };
