const crypto = require('crypto');
const Patient = require('../models/Patient');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const AbdmHiuRequest = require('../models/AbdmHiuRequest');
const AbdmImportedRecord = require('../models/AbdmImportedRecord');
const AbdmDataTransfer = require('../models/AbdmDataTransfer');
const AbdmHiuDataPage = require('../models/AbdmHiuDataPage');
const abdmConfig = require('../config/abdm.config');
const { masterRequest } = require('./abdmMasterClient.service');
const {
  generateReceiverKeyMaterial,
  decryptHealthInformation,
  assertDecryptionIntegrity
} = require('./abdmCryptoAdapter.service');
const { encryptJson, decryptJson } = require('./abdmVault.service');
const {
  upsertConsent,
  assertConsentUsable,
  hashArtifact,
  normalizedStatus
} = require('./abdmConsentPolicy.service');
const { assertValidBundle } = require('./abdmFhirValidation.service');
const {
  normalizeInternalHiTypes,
  toAbdmHiType,
  toInternalHiType
} = require('../utils/abdmHiTypes');
const { configuredHospitalId } = require('./hospitalIdentity.service');
const { assertSameHospital } = require('../utils/hospitalScope');
const { validateConsentArtefact } = require('./abdmConsentValidation.service');
const { assertAbdmExchangeEligible } = require('./abdmExchangeEligibility.service');

function newId() {
  return crypto.randomUUID();
}

function dateValue(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function consentRequestBody({ patient, payload, requestId }) {
  const hiTypes = normalizeInternalHiTypes(payload.hiTypes || []);
  if (!hiTypes.length) throw new Error('At least one HI type is required');
  const from = dateValue(payload.dateRange?.from);
  const to = dateValue(payload.dateRange?.to);
  if (!from || !to || from > to) throw new Error('A valid consent date range is required');
  const expiry = dateValue(payload.consentExpiry);
  if (!expiry || expiry.getTime() <= Date.now()) {
    throw new Error('Consent expiry must be in the future');
  }
  const abhaAddress = payload.abhaAddress || patient.abha?.address;
  if (!abhaAddress) throw new Error('A verified ABHA address is required');

  return {
    consent: {
      purpose: payload.purpose || {
        text: 'Care Management',
        code: 'CAREMGT',
        refUri: 'https://terminology.hl7.org/CodeSystem/v3-ActReason'
      },
      patient: { id: String(abhaAddress).toLowerCase() },
      hiu: payload.hiu || undefined,
      requester: payload.requester,
      hiTypes: hiTypes.map(toAbdmHiType),
      permission: {
        accessMode: payload.accessMode || 'VIEW',
        dateRange: { from: from.toISOString(), to: to.toISOString() },
        dataEraseAt: expiry.toISOString(),
        frequency: payload.frequency || {
          unit: 'HOUR',
          value: 1,
          repeats: 0
        }
      }
    }
  };
}

async function initiateConsent({ patientId, payload, user }) {
  const patient = await Patient.findById(patientId);
  if (!patient) throw new Error('Patient not found');
  assertSameHospital(patient.hospitalId, user);
  assertAbdmExchangeEligible(patient);

  const requestId = newId();
  const body = consentRequestBody({ patient, payload, requestId });
  const local = await AbdmHospitalConsent.create({
    hospitalId: patient.hospitalId,
    role: 'HIU',
    consentRequestId: requestId,
    patientId: patient._id,
    abhaAddress: patient.abha.address,
    status: 'REQUESTED',
    purpose: body.consent.purpose,
    hiTypes: normalizeInternalHiTypes(payload.hiTypes || []),
    dateRange: body.consent.permission.dateRange,
    permission: body.consent.permission,
    requester: {
      userId: user?._id,
      name: payload.requester?.name,
      identifier: payload.requester?.identifier
    },
    expiresAt: body.consent.permission.dataEraseAt,
    metadata: { localRequestId: requestId }
  });

  try {
    const master = await masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: { action: 'INIT_CONSENT_REQUEST', body }
    });
    local.metadata = { ...(local.metadata || {}), masterRequestId: master.requestId };
    await local.save();
    return { consent: local, masterRequestId: master.requestId };
  } catch (error) {
    local.status = 'FAILED';
    local.error = { message: error.message, details: error.details };
    await local.save();
    throw error;
  }
}

async function requestConsentStatus(consent) {
  const result = await masterRequest('/internal/abdm/m3/action', {
    method: 'POST',
    body: { action: 'GET_CONSENT_STATUS', body: { consentRequestId: consent.consentRequestId } }
  });
  consent.lastStatusCheckedAt = new Date();
  consent.metadata = { ...(consent.metadata || {}), statusRequestId: result.requestId };
  await consent.save();
  return result;
}

async function fetchConsentArtefact(consent) {
  if (!consent.consentId) throw new Error('Consent ID is not available yet');
  const result = await masterRequest('/internal/abdm/m3/action', {
    method: 'POST',
    body: { action: 'FETCH_CONSENT', body: { consentId: consent.consentId } }
  });
  consent.metadata = { ...(consent.metadata || {}), fetchRequestId: result.requestId };
  await consent.save();
  return result;
}

async function initiateHealthInformationRequest({ consent, user }) {
  assertConsentUsable(consent);
  if (!consent.patientId) throw new Error('Consent is not associated with a local patient');
  const patient = await Patient.findOne({ _id: consent.patientId, hospitalId: consent.hospitalId });
  if (!patient) throw new Error('Consented patient was not found');
  assertAbdmExchangeEligible(patient);

  const requestId = newId();
  const receiver = await generateReceiverKeyMaterial({
    requestId,
    consentId: consent.consentId,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  });
  const relay = await masterRequest('/internal/abdm/m3/data-relay-token', {
    method: 'POST',
    body: {
      consentId: consent.consentId,
      requestReference: requestId,
      ttlSeconds: 3600,
      maxPushes: 100
    }
  });

  const privateBlob = encryptJson(
    receiver.privateMaterial,
    `abdm-hiu-private:${requestId}`
  );
  const request = await AbdmHiuRequest.create({
    requestId,
    hospitalId: consent.hospitalId,
    patientId: consent.patientId,
    consentId: consent.consentId,
    consentRecordId: consent._id,
    status: 'REQUESTED',
    hiTypes: consent.hiTypes,
    dateRange: consent.dateRange,
    relayId: relay.relayId,
    dataPushUrlHash: hashArtifact(relay.dataPushUrl),
    keyMaterial: receiver.publicKeyMaterial,
    encryptedPrivateMaterial: privateBlob,
    keyExpiresAt: relay.expiresAt,
    requestedBy: user?._id,
    requestedAt: new Date()
  });

  const body = {
    hiRequest: {
      consent: { id: consent.consentId },
      dateRange: {
        from: new Date(consent.dateRange.from).toISOString(),
        to: new Date(consent.dateRange.to).toISOString()
      },
      dataPushUrl: relay.dataPushUrl,
      keyMaterial: receiver.publicKeyMaterial
    }
  };

  try {
    const master = await masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: { action: 'REQUEST_HEALTH_INFORMATION', body }
    });
    request.masterRequestId = master.requestId;
    await request.save();
    return { request, masterRequestId: master.requestId };
  } catch (error) {
    request.status = 'FAILED';
    request.error = { message: error.message, details: error.details };
    await request.save();
    throw error;
  }
}

async function onConsentCallback(eventType, payload) {
  const role = 'HIU';
  const hospitalId = await configuredHospitalId();
  const validation = await validateConsentArtefact(payload);
  const value = await upsertConsent(payload, role, {
    hospitalId,
    signatureValidated: validation.valid === true,
    metadata: { consentValidation: validation }
  });
  const requestId =
    payload.response?.requestId ||
    payload.request?.id ||
    payload.requestId;

  if (requestId) {
    const existing = await AbdmHospitalConsent.findOne({
      hospitalId,
      role,
      $or: [
        { consentRequestId: requestId },
        { 'metadata.masterRequestId': requestId },
        { 'metadata.statusRequestId': requestId },
        { 'metadata.fetchRequestId': requestId }
      ]
    });
    if (existing && String(existing._id) !== String(value._id)) {
      existing.consentRequestId = value.consentRequestId || existing.consentRequestId;
      existing.consentId = value.consentId || existing.consentId;
      existing.artefactId = value.artefactId || existing.artefactId;
      existing.status = value.status;
      existing.permission = value.permission || existing.permission;
      existing.hiTypes = value.hiTypes?.length ? value.hiTypes : existing.hiTypes;
      existing.dateRange = value.dateRange || existing.dateRange;
      existing.encryptedArtefact = encryptJson(
        payload,
        `abdm-consent:${hospitalId}:${role}:${
          value.consentId || value.consentRequestId || requestId
        }`
      );
      existing.artefactHash = value.artefactHash || existing.artefactHash;
      existing.expiresAt = value.expiresAt || existing.expiresAt;
      existing.lastCallbackAt = new Date();
      await existing.save();
      await AbdmHospitalConsent.deleteOne({ _id: value._id });
      return existing;
    }
  }
  return value;
}

async function onHealthInformationRequestCallback(payload) {
  const hospitalId = await configuredHospitalId();
  const requestId = payload.response?.requestId || payload.requestId;
  const transactionId = payload.hiRequest?.transactionId || payload.transactionId;
  const request = await AbdmHiuRequest.findOne({
    hospitalId,
    $or: [
      ...(requestId ? [{ requestId }, { masterRequestId: requestId }] : []),
      ...(transactionId ? [{ transactionId }] : [])
    ]
  });
  if (!request) return null;
  request.transactionId = transactionId || request.transactionId;
  request.status = payload.error ? 'FAILED' : 'ACKNOWLEDGED';
  request.acknowledgedAt = new Date();
  request.error = payload.error;
  await request.save();
  return request;
}

function assertImportedRecordWithinConsent(consent, metadata, record, payload) {
  const normalizedType = normalizeInternalHiTypes([metadata.hiType])[0];
  const allowedTypes = normalizeInternalHiTypes(consent.hiTypes || []);
  if (allowedTypes.length && !allowedTypes.includes(normalizedType)) {
    throw new Error(`${metadata.hiType} is outside the granted consent HI types`);
  }

  const recordTime = metadata.recordDate
    ? new Date(metadata.recordDate).getTime()
    : null;
  if (metadata.recordDate && !Number.isFinite(recordTime)) {
    throw new Error('Imported FHIR record contains an invalid record date');
  }
  const from = consent.dateRange?.from
    ? new Date(consent.dateRange.from).getTime()
    : null;
  const to = consent.dateRange?.to
    ? new Date(consent.dateRange.to).getTime()
    : null;
  if (from && recordTime && recordTime < from) {
    throw new Error('Imported FHIR record is before the consent date range');
  }
  if (to && recordTime && recordTime > to) {
    throw new Error('Imported FHIR record is after the consent date range');
  }

  const sourceHipId = record.sourceHipId || payload.hipId;
  if (
    consent.hipIds?.length &&
    sourceHipId &&
    !consent.hipIds.map(String).includes(String(sourceHipId))
  ) {
    throw new Error('Imported FHIR record came from a HIP outside consent scope');
  }

  return normalizedType || metadata.hiType;
}

const PROFILE_TO_HI_TYPE = [
  ['PRESCRIPTIONRECORD', 'PRESCRIPTION'],
  ['DIAGNOSTICREPORTRECORD', 'DIAGNOSTIC_REPORT'],
  ['OPCONSULTRECORD', 'OP_CONSULTATION'],
  ['OPCONSULTATION', 'OP_CONSULTATION'],
  ['DISCHARGESUMMARYRECORD', 'DISCHARGE_SUMMARY'],
  ['IMMUNIZATIONRECORD', 'IMMUNIZATION_RECORD'],
  ['HEALTHDOCUMENTRECORD', 'HEALTH_DOCUMENT_RECORD'],
  ['WELLNESSRECORD', 'WELLNESS_RECORD'],
  ['INVOICERECORD', 'INVOICE']
];

function inferHiType(bundle, composition, fallback = {}) {
  const candidates = [
    fallback.hiType,
    ...(bundle.meta?.profile || []),
    ...(composition?.meta?.profile || []),
    composition?.type?.coding?.[0]?.code,
    composition?.type?.coding?.[0]?.display,
    composition?.type?.text,
    composition?.title
  ].filter(Boolean);

  for (const candidate of candidates) {
    const direct = toInternalHiType(candidate);
    if (direct) return direct;
    const normalized = String(candidate)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    const match = PROFILE_TO_HI_TYPE.find(([needle]) =>
      normalized.includes(needle)
    );
    if (match) return match[1];
  }
  return 'HEALTH_DOCUMENT_RECORD';
}

function extractBundleMetadata(bundle, fallback = {}) {
  const composition = (bundle.entry || [])
    .map((entry) => entry.resource)
    .find((resource) => resource?.resourceType === 'Composition');
  return {
    hiType: inferHiType(bundle, composition, fallback),
    title: composition?.title || fallback.title,
    recordDate: composition?.date || bundle.timestamp,
    bundleIdentifier: bundle.identifier?.value
  };
}

function inboundPageAad(request, pageNumber) {
  return `abdm-hiu-page:${request.hospitalId}:${request.transactionId}:${pageNumber}`;
}

function pageShape(payload) {
  const pageNumber = Number(payload.pageNumber ?? 0);
  const pageCount = Number(payload.pageCount ?? 1);
  if (!Number.isInteger(pageNumber) || pageNumber < 0) throw new Error('pageNumber must be a non-negative integer');
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('pageCount must be a positive integer');
  if (pageNumber >= pageCount) throw new Error('pageNumber must be less than pageCount');
  return { pageNumber, pageCount };
}

async function notifyHiuDataFlow({ request, consent, hipId, status, contexts = [], error }) {
  const statusResponses = (contexts.length ? contexts : [{ referenceNumber: 'UNKNOWN' }]).map((context) => ({
    careContextReference: context.referenceNumber || context.careContextReference || 'UNKNOWN',
    hiStatus: status === 'TRANSFERRED' ? 'DELIVERED' : 'ERRORED',
    description: error || undefined
  }));
  return masterRequest('/internal/abdm/m3/action', {
    method: 'POST',
    body: {
      action: 'NOTIFY_HEALTH_INFORMATION',
      body: {
        notification: {
          consentId: consent.consentId,
          transactionId: request.transactionId,
          doneAt: new Date().toISOString(),
          notifier: { type: 'HIU', id: abdmConfig.hiuId },
          statusNotification: {
            hipId: hipId || consent.hipIds?.[0],
            sessionStatus: status,
            statusResponses
          }
        }
      }
    }
  });
}

async function storeInboundPage(request, payload) {
  const { pageNumber, pageCount } = pageShape(payload);
  const hash = hashArtifact({
    transactionId: payload.transactionId,
    pageNumber,
    pageCount,
    entries: (payload.entries || []).map((entry) => entry.checksum || entry.content),
    keyMaterial: payload.keyMaterial
  });
  const existing = await AbdmHiuDataPage.findOne({
    hospitalId: request.hospitalId,
    transactionId: request.transactionId,
    pageNumber
  });
  if (existing) {
    if (existing.payloadHash !== hash || existing.pageCount !== pageCount) {
      const error = new Error('Conflicting duplicate ABDM data page received');
      error.code = 'ABDM_PAGE_CONFLICT';
      throw error;
    }
    return existing;
  }
  return AbdmHiuDataPage.create({
    hospitalId: request.hospitalId,
    hiuRequestId: request._id,
    transactionId: request.transactionId,
    pageNumber,
    pageCount,
    entryCount: payload.entries.length,
    payloadHash: hash,
    encryptedPayload: encryptJson(
      { entries: payload.entries, keyMaterial: payload.keyMaterial, hipId: payload.hipId },
      inboundPageAad(request, pageNumber)
    ),
    purgeAt: new Date(Date.now() + Number(process.env.ABDM_HIU_PAGE_RETENTION_HOURS || 24) * 60 * 60 * 1000)
  });
}

async function assembledInboundPayload(request, expectedPageCount) {
  const pages = await AbdmHiuDataPage.find({
    hospitalId: request.hospitalId,
    transactionId: request.transactionId
  })
    .select('+encryptedPayload +encryptedPayload.ciphertext +encryptedPayload.iv +encryptedPayload.tag')
    .sort({ pageNumber: 1 });
  if (pages.length < expectedPageCount) return null;
  if (pages.length !== expectedPageCount || pages.some((page, index) => page.pageNumber !== index || page.pageCount !== expectedPageCount)) {
    throw new Error('ABDM data pages are incomplete or inconsistent');
  }
  const decoded = pages.map((page) => decryptJson(page.encryptedPayload, inboundPageAad(request, page.pageNumber)));
  const keyHash = hashArtifact(decoded[0].keyMaterial);
  if (decoded.some((page) => hashArtifact(page.keyMaterial) !== keyHash)) {
    throw new Error('ABDM data pages contain inconsistent key material');
  }
  return {
    entries: decoded.flatMap((page) => page.entries || []),
    keyMaterial: decoded[0].keyMaterial,
    hipId: decoded.find((page) => page.hipId)?.hipId
  };
}

async function receiveEncryptedData(payload) {
  const hospitalId = await configuredHospitalId();
  const transactionId = payload.transactionId;
  if (!transactionId || !Array.isArray(payload.entries) || !payload.keyMaterial) {
    throw new Error('Encrypted data payload is incomplete');
  }

  const request = await AbdmHiuRequest.findOne({ hospitalId, transactionId }).select(
    '+encryptedPrivateMaterial +encryptedPrivateMaterial.ciphertext +encryptedPrivateMaterial.iv +encryptedPrivateMaterial.tag'
  );
  if (!request) throw new Error('Unknown HIU transaction ID');
  const consent = await AbdmHospitalConsent.findOne({ _id: request.consentRecordId, hospitalId: request.hospitalId });
  assertConsentUsable(consent);
  const patient = await Patient.findOne({ _id: request.patientId, hospitalId });
  if (!patient) throw new Error('HIU patient was not found');
  assertAbdmExchangeEligible(patient);

  const { pageCount } = pageShape(payload);
  await storeInboundPage(request, payload);
  const pageStats = await AbdmHiuDataPage.aggregate([
    { $match: { hospitalId: request.hospitalId, transactionId } },
    { $group: { _id: null, pages: { $sum: 1 }, entries: { $sum: '$entryCount' } } }
  ]);
  request.expectedPageCount = pageCount;
  request.receivedPageCount = pageStats[0]?.pages || 0;
  request.receivedEntryCount = pageStats[0]?.entries || 0;
  request.dataReceivedAt = new Date();
  request.status = request.receivedPageCount < pageCount ? 'DATA_RECEIVED' : 'DECRYPTING';
  await request.save();
  if (request.receivedPageCount < pageCount) {
    return { pending: true, receivedPages: request.receivedPageCount, pageCount };
  }

  const assembled = await assembledInboundPayload(request, pageCount);
  const idempotencyKey = hashArtifact({ transactionId, entries: assembled.entries.map((entry) => entry.checksum || entry.content) });
  const previous = await AbdmDataTransfer.findOne({ hospitalId, idempotencyKey });
  if (previous?.status === 'IMPORTED') return { duplicate: true, imported: previous.recordCount };

  const transfer = await AbdmDataTransfer.findOneAndUpdate(
    { hospitalId, idempotencyKey },
    {
      hospitalId,
      direction: 'INBOUND_HIU',
      transactionId,
      consentId: request.consentId,
      patientId: request.patientId,
      status: 'RECEIVED',
      recordCount: assembled.entries.length,
      payloadHash: idempotencyKey,
      startedAt: new Date(),
      metadata: { pageCount },
      $inc: { attempts: 1 }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const contexts = assembled.entries.map((entry) => ({ careContextReference: entry.careContextReference }));
  try {
    const privateMaterial = decryptJson(request.encryptedPrivateMaterial, `abdm-hiu-private:${request.requestId}`);
    const decrypted = await decryptHealthInformation({
      transactionId,
      privateMaterial,
      keyMaterial: assembled.keyMaterial,
      entries: assembled.entries
    });
    assertDecryptionIntegrity({ encryptedEntries: assembled.entries, decrypted });
    transfer.status = 'DECRYPTED';
    await transfer.save();

    let imported = 0;
    for (const record of decrypted.records) {
      const bundle = typeof record.content === 'string' ? JSON.parse(record.content) : record.content;
      // eslint-disable-next-line no-await-in-loop
      const validation = await assertValidBundle(bundle);
      const bundleHash = hashArtifact(bundle);
      const metadata = extractBundleMetadata(bundle, record);
      const normalizedHiType = assertImportedRecordWithinConsent(consent, metadata, record, { ...payload, hipId: assembled.hipId });
      // eslint-disable-next-line no-await-in-loop
      await AbdmImportedRecord.findOneAndUpdate(
        { hospitalId: request.hospitalId, transactionId, bundleHash },
        {
          hospitalId: request.hospitalId,
          patientId: request.patientId,
          hiuRequestId: request._id,
          consentId: request.consentId,
          transactionId,
          sourceHipId: record.sourceHipId || assembled.hipId,
          sourceName: record.sourceName,
          careContextReference: record.careContextReference,
          hiType: normalizedHiType,
          recordDate: metadata.recordDate,
          title: metadata.title,
          bundleIdentifier: metadata.bundleIdentifier,
          fhirVersion: 'R4',
          encryptedFhirBundle: encryptJson(bundle, `abdm-imported-record:${request.hospitalId}:${transactionId}:${bundleHash}`),
          bundleHash,
          provenance: record.provenance,
          consentSnapshot: { status: consent.status, hiTypes: consent.hiTypes, dateRange: consent.dateRange, expiresAt: consent.expiresAt },
          status: 'ACTIVE',
          validation,
          receivedAt: new Date(),
          importedAt: new Date(),
          purgeAt: consent.expiresAt || consent.permission?.dataEraseAt
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      imported += 1;
    }

    request.status = 'IMPORTED';
    request.importedRecordCount = imported;
    request.completedAt = new Date();
    await request.save();
    transfer.status = 'IMPORTED';
    transfer.recordCount = imported;
    transfer.completedAt = new Date();
    await transfer.save();
    await notifyHiuDataFlow({ request, consent, hipId: assembled.hipId, status: 'TRANSFERRED', contexts });
    await AbdmHiuDataPage.deleteMany({ hospitalId, transactionId });
    return { imported, requestId: request._id };
  } catch (error) {
    request.status = 'FAILED';
    request.error = { message: error.message, code: error.code, details: error.details, at: new Date() };
    await request.save();
    transfer.status = 'FAILED';
    transfer.error = { message: error.message, code: error.code, details: error.details, at: new Date() };
    await transfer.save();
    await notifyHiuDataFlow({ request, consent, hipId: assembled?.hipId || payload.hipId, status: 'FAILED', contexts, error: error.message }).catch(() => {});
    throw error;
  }
}

async function markConsentStatus(payload) {
  const consentId = payload.consent?.id || payload.consentId;
  const consentRequestId = payload.consentRequest?.id || payload.consentRequestId;
  const hospitalId = await configuredHospitalId();
  const query = consentId
    ? { hospitalId, role: 'HIU', consentId }
    : { hospitalId, role: 'HIU', consentRequestId };
  const consent = await AbdmHospitalConsent.findOne(query);
  if (!consent) return onConsentCallback('STATUS', payload);
  consent.status = normalizedStatus(
    payload.status || payload.consentRequest?.status || payload.notification?.status
  );
  consent.lastCallbackAt = new Date();
  if (consent.status === 'REVOKED') consent.revokedAt = new Date();
  await consent.save();
  if (['REVOKED', 'EXPIRED'].includes(consent.status)) {
    await AbdmImportedRecord.updateMany(
      { hospitalId: consent.hospitalId, consentId: consent.consentId, status: 'ACTIVE' },
      { status: consent.status, purgeAt: consent.expiresAt || consent.permission?.dataEraseAt || new Date() }
    );
  }
  return consent;
}

module.exports = {
  initiateConsent,
  requestConsentStatus,
  fetchConsentArtefact,
  initiateHealthInformationRequest,
  onConsentCallback,
  onHealthInformationRequestCallback,
  receiveEncryptedData,
  markConsentStatus,
  consentRequestBody
};
