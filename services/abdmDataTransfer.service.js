const crypto = require('crypto');
const AbdmDataTransfer = require('../models/AbdmDataTransfer');
const abdmConfig = require('../config/abdm.config');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');
const { assertValidBundle } = require('./abdmFhirValidation.service');
const { encryptHealthInformation } = require('./abdmCryptoAdapter.service');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function pushHealthInformation({
  hospitalId,
  patientId,
  consentId,
  transactionId,
  dataPushUrl,
  peerKeyMaterial,
  records
}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('No health-information records were supplied');
  }

  const idempotencyKey = checksum(
    `${consentId}:${transactionId}:${records
      .map((item) => item.careContextReference)
      .sort()
      .join(',')}`
  );
  if (!hospitalId) throw new Error('hospitalId is required for ABDM transfer');
  const existing = await AbdmDataTransfer.findOne({ hospitalId, idempotencyKey });
  if (existing?.status === 'TRANSFERRED') {
    return {
      duplicate: true,
      transfer: existing,
      acknowledgement: existing.acknowledgement
    };
  }

  const parsed = new URL(
    await assertSafeOutboundUrl(dataPushUrl, {
      label: 'ABDM HIU data-push URL',
      allowedHosts: abdmConfig.dataPushAllowedHosts,
      requireHttps: process.env.NODE_ENV === 'production',
      allowPrivate:
        process.env.NODE_ENV !== 'production' &&
        abdmConfig.allowPrivateDataPushUrls
    })
  );

  const transfer = await AbdmDataTransfer.findOneAndUpdate(
    { hospitalId, idempotencyKey },
    {
      hospitalId,
      direction: 'OUTBOUND_HIP',
      transactionId,
      consentId,
      patientId,
      hiTypes: records.map((item) => item.hiType),
      careContextReferences: records.map(
        (item) => item.careContextReference
      ),
      status: 'PREPARING',
      recordCount: records.length,
      destinationHost: parsed.hostname,
      startedAt: new Date(),
      $inc: { attempts: 1 }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    for (const record of records) {
      const bundle =
        typeof record.content === 'string'
          ? JSON.parse(record.content)
          : record.content;
      // eslint-disable-next-line no-await-in-loop
      record.validation = await assertValidBundle(bundle);
    }
    transfer.status = 'VALIDATED';
    await transfer.save();

    const encrypted = await encryptHealthInformation({
      transactionId,
      peerKeyMaterial,
      records
    });
    transfer.status = 'ENCRYPTED';
    transfer.payloadHash = checksum(JSON.stringify(encrypted));
    await transfer.save();

    const response = await fetchFn(parsed.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MediQliq-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        transactionId,
        entries: encrypted.entries,
        keyMaterial: encrypted.keyMaterial
      }),
      signal: AbortSignal.timeout(
        Number(process.env.ABDM_DATA_PUSH_TIMEOUT_MS || 30000)
      ),
      redirect: 'error'
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        responseBody.message || `HIU data push failed with HTTP ${response.status}`
      );
      error.details = responseBody;
      throw error;
    }

    transfer.status = 'TRANSFERRED';
    transfer.completedAt = new Date();
    transfer.acknowledgement = responseBody;
    await transfer.save();
    return { transfer, acknowledgement: responseBody };
  } catch (error) {
    transfer.status = 'FAILED';
    transfer.error = { message: error.message, details: error.details, at: new Date() };
    await transfer.save();
    throw error;
  }
}

module.exports = { pushHealthInformation };
