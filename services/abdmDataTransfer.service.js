const crypto = require('crypto');
const AbdmDataTransfer = require('../models/AbdmDataTransfer');
const abdmConfig = require('../config/abdm.config');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');
const { assertValidBundle } = require('./abdmFhirValidation.service');
const { encryptHealthInformation } = require('./abdmCryptoAdapter.service');
const { recordDisclosure } = require('./abdmPacket.service');
const { canonicalJson, sha256 } = require('../utils/abdmCanonical');
const { OUTBOUND_POLICIES } = require('../utils/safeOutboundUrl');
const {
  authorizeConsentOperation,
  commitConsentUsage,
  releaseConsentUsage
} = require('./abdmConsentValidation.service');

const fetchFn = (...args) => {
  if (typeof fetch === 'function') return fetch(...args);
  return import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));
};

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function chunkEntries(entries, pageSize) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += pageSize) {
    chunks.push(entries.slice(index, index + pageSize));
  }
  return chunks.length ? chunks : [[]];
}

async function postPage({ url, transactionId, entries, keyMaterial, pageNumber, pageCount, idempotencyKey }) {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MediQliq-Idempotency-Key': `${idempotencyKey}:${pageNumber}`
    },
    body: JSON.stringify({
      pageNumber,
      pageCount,
      transactionId,
      entries,
      keyMaterial
    }),
    signal: AbortSignal.timeout(
      Number(process.env.ABDM_DATA_PUSH_TIMEOUT_MS || 30000)
    ),
    redirect: 'error'
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      responseBody.message || `HIU data push page ${pageNumber + 1}/${pageCount} failed with HTTP ${response.status}`
    );
    error.statusCode = response.status;
    error.details = responseBody;
    throw error;
  }
  return responseBody;
}

async function pushHealthInformation({
  hospitalId,
  patientId,
  consentId,
  transactionId,
  dataPushUrl,
  peerKeyMaterial,
  records,
  consent
}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('No health-information records were supplied');
  }

  const idempotencyKey = checksum(
    `${consentId}:${transactionId}:${records
      .map((item) => `${item.careContextReference}:${item.bundleHash || ''}`)
      .sort()
      .join(',')}`
  );
  if (!hospitalId) throw new Error('hospitalId is required for ABDM transfer');
  const existing = await AbdmDataTransfer.findOne({ hospitalId, idempotencyKey });
  if (existing?.status === 'TRANSFERRED') {
    const pendingReservationId = existing.metadata?.consentAuthorization?.usage?.reservationId;
    if (pendingReservationId && existing.metadata?.consentAuthorization?.usageCommitPending) {
      await commitConsentUsage(pendingReservationId);
      existing.metadata = {
        ...(existing.metadata || {}),
        consentAuthorization: {
          ...(existing.metadata?.consentAuthorization || {}),
          usageCommitPending: false,
          usageCommitted: true,
          usageCommittedAt: new Date()
        }
      };
      await existing.save();
    }
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
        abdmConfig.allowPrivateDataPushUrls,
      policy: OUTBOUND_POLICIES.PUBLIC_DATA_PUSH
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
      careContextReferences: records.map((item) => item.careContextReference),
      packetIds: records.map((item) => item.packetId).filter(Boolean),
      packetVersionIds: records.map((item) => item.packetVersionId).filter(Boolean),
      bundleHashes: records.map((item) => item.bundleHash).filter(Boolean),
      sourceSnapshotHashes: records.map((item) => item.sourceSnapshotHash).filter(Boolean),
      consentScopeHash: records.find((item) => item.consentScopeHash)?.consentScopeHash,
      validationEvidence: records.map((item) => item.validationEvidence).filter(Boolean),
      approvalActorIds: records.flatMap((item) => item.approvalIds || []),
      status: 'PREPARING',
      recordCount: records.length,
      destinationHost: parsed.hostname,
      startedAt: new Date(),
      $inc: { attempts: 1 }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  let consentAuthorization = null;
  let sentPageCount = 0;
  try {
    for (const record of records) {
      const bundle = typeof record.content === 'string'
        ? JSON.parse(record.content)
        : record.content;
      const actualBundleHash = sha256(canonicalJson(bundle));
      if (record.bundleHash && record.bundleHash !== actualBundleHash) {
        const error = new Error(`Approved ABDM packet hash changed for ${record.careContextReference}`);
        error.code = 'ABDM_PACKET_INTEGRITY_FAILED';
        error.statusCode = 409;
        throw error;
      }
      if (abdmConfig.packetFeatureEnabled && abdmConfig.packetDefaultReviewPolicy !== 'PREVIEW_ONLY') {
        if (!record.packetVersionId || !record.packetId || !record.bundleHash) {
          const error = new Error(`Approved ABDM packet evidence is missing for ${record.careContextReference}`);
          error.code = 'ABDM_PACKET_APPROVAL_REQUIRED';
          error.statusCode = 409;
          throw error;
        }
      }
      // Revalidate immediately before encryption. This catches validator package
      // changes and protects against data mutation between approval and transfer.
      // eslint-disable-next-line no-await-in-loop
      record.validation = await assertValidBundle(bundle);
    }
    transfer.status = 'VALIDATED';
    await transfer.save();

    const recordRanges = records
      .map((item) => item.dateRange)
      .filter((range) => range?.from || range?.to);
    const rangeStarts = recordRanges
      .map((range) => range.from && new Date(range.from).getTime())
      .filter(Number.isFinite);
    const rangeEnds = recordRanges
      .map((range) => (range.to || range.from) && new Date(range.to || range.from).getTime())
      .filter(Number.isFinite);
    const requestedDateRange = rangeStarts.length && rangeEnds.length
      ? {
          from: new Date(Math.min(...rangeStarts)).toISOString(),
          to: new Date(Math.max(...rangeEnds)).toISOString()
        }
      : consent?.dateRange;

    consentAuthorization = await authorizeConsentOperation({
      consent,
      operation: {
        type: 'HIP_DISCLOSURE',
        operationId: transactionId,
        transactionId,
        hospitalId: String(hospitalId),
        patientId: consent?.abhaAddress || String(patientId),
        hipId: abdmConfig.hipId,
        hiuId: consent?.hiuId,
        purpose: consent?.purpose,
        hiTypes: Array.from(new Set(records.map((item) => item.hiType))),
        careContextIds: Array.from(new Set(records.map((item) => item.careContextReference))),
        dateRange: requestedDateRange,
        packetHash: sha256(canonicalJson(records.map((item) => ({
          careContextReference: item.careContextReference,
          hiType: item.hiType,
          bundleHash: item.bundleHash,
          sourceSnapshotHash: item.sourceSnapshotHash
        })).sort((left, right) => left.careContextReference.localeCompare(right.careContextReference)))),
        retentionUntil: consent?.expiresAt || consent?.permission?.dataEraseAt
      }
    });
    transfer.metadata = {
      ...(transfer.metadata || {}),
      consentAuthorization: {
        validationId: consentAuthorization.validationId,
        authorizedOperationHash: consentAuthorization.authorizedOperationHash,
        usage: consentAuthorization.usage,
        retentionUntil: consentAuthorization.retentionUntil
      }
    };
    await transfer.save();

    const encrypted = await encryptHealthInformation({
      transactionId,
      peerKeyMaterial,
      records
    });
    transfer.status = 'ENCRYPTED';
    transfer.payloadHash = checksum(JSON.stringify(encrypted));
    await transfer.save();

    const pages = chunkEntries(encrypted.entries, abdmConfig.dataPushPageSize);
    const acknowledgements = [];
    transfer.status = 'PUSHING';
    transfer.metadata = {
      ...(transfer.metadata || {}),
      pageCount: pages.length,
      pageSize: abdmConfig.dataPushPageSize
    };
    await transfer.save();

    for (let pageNumber = 0; pageNumber < pages.length; pageNumber += 1) {
      // eslint-disable-next-line no-await-in-loop
      const acknowledgement = await postPage({
        url: parsed.toString(),
        transactionId,
        entries: pages[pageNumber],
        keyMaterial: encrypted.keyMaterial,
        pageNumber,
        pageCount: pages.length,
        idempotencyKey
      });
      acknowledgements.push({ pageNumber, acknowledgement });
      sentPageCount += 1;
    }

    transfer.status = 'TRANSFERRED';
    transfer.completedAt = new Date();
    transfer.acknowledgement = { pages: acknowledgements };
    if (consentAuthorization?.usage?.reservationId) {
      transfer.metadata = {
        ...(transfer.metadata || {}),
        consentAuthorization: {
          ...(transfer.metadata?.consentAuthorization || {}),
          usageCommitPending: true
        }
      };
    }
    await transfer.save();
    if (consentAuthorization?.usage?.reservationId) {
      await commitConsentUsage(consentAuthorization.usage.reservationId);
      transfer.metadata = {
        ...(transfer.metadata || {}),
        consentAuthorization: {
          ...(transfer.metadata?.consentAuthorization || {}),
          usageCommitPending: false,
          usageCommitted: true,
          usageCommittedAt: new Date()
        }
      };
      await transfer.save();
    }
    await recordDisclosure({
      hospitalId,
      patientId,
      transfer,
      consent: consent || { consentId },
      records,
      outcome: 'SUCCESS'
    });
    return { transfer, acknowledgement: transfer.acknowledgement };
  } catch (error) {
    const reservationId = consentAuthorization?.usage?.reservationId;
    if (reservationId && sentPageCount === 0) {
      await releaseConsentUsage(reservationId).catch(() => {});
    } else if (reservationId && sentPageCount > 0) {
      await commitConsentUsage(reservationId).catch(() => {});
    }
    if (transfer.status !== 'TRANSFERRED') transfer.status = 'FAILED';
    transfer.error = { message: error.message, code: error.code, details: error.details, at: new Date() };
    await transfer.save();
    throw error;
  }
}

module.exports = { pushHealthInformation, chunkEntries };
