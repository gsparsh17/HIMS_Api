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
const {
  validateConsentArtefact,
  authorizeConsentOperation,
  commitConsentUsage,
  releaseConsentUsage,
  recordConsentStatusEvent
} = require('./abdmConsentValidation.service');
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

const CONSENT_PURPOSES = Object.freeze({
  CAREMGT: 'Care Management',
  BTG: 'Break the Glass',
  PUBHLTH: 'Public Health',
  HPAYMT: 'Healthcare Payment',
  DSRCH: 'Disease Specific Healthcare Research',
  PATRQT: 'Self Requested'
});

function normalizeConsentPurpose(purpose = {}) {
  const code = String(purpose.code || 'CAREMGT').trim().toUpperCase();
  if (!CONSENT_PURPOSES[code]) {
    const error = new Error(`Unsupported ABDM consent purpose code: ${code}`);
    error.statusCode = 400;
    error.code = 'ABDM_CONSENT_PURPOSE_INVALID';
    throw error;
  }
  return {
    code,
    text: CONSENT_PURPOSES[code],
    refUri: String(
      purpose.refUri || 'https://terminology.hl7.org/CodeSystem/v3-ActReason'
    ).trim()
  };
}

function normalizeRequester(payload = {}, user = {}) {
  const raw = payload.requester || {};
  const rawIdentifier = raw.identifier;
  const objectIdentifier = rawIdentifier && typeof rawIdentifier === 'object'
    ? rawIdentifier
    : {};
  const fallbackValue =
    (typeof rawIdentifier === 'string' ? rawIdentifier : undefined) ||
    payload.requesterIdentifier ||
    user.hprId ||
    user.employeeId ||
    abdmConfig.hiuId;
  const identifierValue = String(objectIdentifier.value || fallbackValue || '').trim();
  const identifierType = String(
    objectIdentifier.type ||
    payload.requesterIdentifierType ||
    (user.hprId ? 'REGNO' : 'HFR')
  ).trim();
  const identifierSystem = String(
    objectIdentifier.system ||
    payload.requesterIdentifierSystem ||
    (user.hprId ? 'https://www.mciindia.org' : 'https://facility.abdm.gov.in')
  ).trim();
  const name = String(
    raw.name || user.name || user.fullName || user.email || 'MediQliq HIU'
  ).trim();

  if (!name || !identifierType || !identifierValue || !identifierSystem) {
    const error = new Error('ABDM requester name and identifier type/value/system are required');
    error.statusCode = 400;
    error.code = 'ABDM_CONSENT_REQUESTER_INVALID';
    throw error;
  }

  return {
    name,
    identifier: {
      type: identifierType,
      value: identifierValue,
      system: identifierSystem
    }
  };
}

function consentRequestBody({ patient, payload, user }) {
  const hiTypes = normalizeInternalHiTypes(payload.hiTypes || []);
  if (!hiTypes.length) throw new Error('At least one HI type is required');

  const from = dateValue(payload.dateRange?.from);
  let to = dateValue(payload.dateRange?.to);
  if (!from || !to || from > to) throw new Error('A valid consent date range is required');

  // ABDM M3 rejects permission ranges in the future. A date-only UI commonly
  // turns "today" into 23:59:59Z, which is still future for most of the day.
  // Cap a same-day end value to the current instant instead of emitting an
  // invalid HIE-CM request.
  const now = new Date();
  if (from.getTime() > now.getTime()) {
    const error = new Error('Consent dateRange.from must be present or past');
    error.statusCode = 400;
    error.code = 'ABDM_CONSENT_DATE_RANGE_FUTURE';
    throw error;
  }
  if (to.getTime() > now.getTime()) to = new Date(now.getTime() - 1000);
  if (from > to) {
    const error = new Error('Consent date range becomes invalid after removing future time');
    error.statusCode = 400;
    error.code = 'ABDM_CONSENT_DATE_RANGE_INVALID';
    throw error;
  }

  const expiry = dateValue(payload.consentExpiry);
  if (!expiry || expiry.getTime() <= Date.now()) {
    throw new Error('Consent expiry must be in the future');
  }
  const abhaAddress = payload.abhaAddress || patient.abha?.address;
  if (!abhaAddress) throw new Error('A verified ABHA address is required');

  const hiuId = String(
    (typeof payload.hiu === 'string' ? payload.hiu : payload.hiu?.id) ||
    abdmConfig.hiuId ||
    ''
  ).trim();
  if (!hiuId) {
    const error = new Error('HIU service ID is required for an ABDM consent request');
    error.statusCode = 500;
    error.code = 'ABDM_HIU_ID_MISSING';
    throw error;
  }

  const careContexts = Array.isArray(payload.careContexts)
    ? payload.careContexts.filter(Boolean)
    : [];
  const hipId = String(
    (typeof payload.hip === 'string' ? payload.hip : payload.hip?.id) || ''
  ).trim();
  if (careContexts.length && !hipId) {
    const error = new Error('HIP is mandatory when care contexts are specified');
    error.statusCode = 400;
    error.code = 'ABDM_CONSENT_HIP_REQUIRED_WITH_CARE_CONTEXTS';
    throw error;
  }

  const consent = {
    purpose: normalizeConsentPurpose(payload.purpose),
    patient: { id: String(abhaAddress).toLowerCase() },
    hiu: { id: hiuId },
    requester: normalizeRequester(payload, user),
    hiTypes: hiTypes.map(toAbdmHiType),
    permission: {
      accessMode: String(payload.accessMode || 'VIEW').toUpperCase(),
      dateRange: { from: from.toISOString(), to: to.toISOString() },
      dataEraseAt: expiry.toISOString(),
      frequency: payload.frequency || {
        unit: 'HOUR',
        value: 1,
        repeats: 0
      }
    }
  };

  if (hipId) consent.hip = { id: hipId };
  if (careContexts.length) consent.careContexts = careContexts;

  return { consent };
}

async function initiateConsent({ patientId, payload, user }) {
  const patient = await Patient.findById(patientId);
  if (!patient) throw new Error('Patient not found');
  assertSameHospital(patient.hospitalId, user);
  assertAbdmExchangeEligible(patient);

  const requestId = newId();
  const body = consentRequestBody({ patient, payload, user });
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
      name: body.consent.requester.name,
      identifier: body.consent.requester.identifier
    },
    expiresAt: body.consent.permission.dataEraseAt,
    metadata: { localRequestId: requestId }
  });

  try {
    const master = await masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: { action: 'INIT_CONSENT_REQUEST', body }
    });
    const officialConsentRequestId =
      master.data?.consentRequestId ||
      master.data?.consentRequest?.id;
    if (officialConsentRequestId) local.consentRequestId = officialConsentRequestId;
    local.hiuId = body.consent.hiu.id;
    local.metadata = {
      ...(local.metadata || {}),
      masterRequestId: master.requestId,
      localRequestId: requestId,
      ...(officialConsentRequestId ? { officialConsentRequestId } : {})
    };
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
  if (!consent.consentRequestId || consent.consentRequestId === consent.metadata?.localRequestId) {
    const error = new Error('Official ABDM consent request ID is not available yet; wait for the on-init callback');
    error.statusCode = 409;
    error.code = 'ABDM_CONSENT_ON_INIT_PENDING';
    throw error;
  }
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
  const consentAuthorization = await authorizeConsentOperation({
    consent,
    operation: {
      type: 'HIU_DATA_REQUEST',
      operationId: requestId,
      transactionId: requestId,
      hospitalId: String(consent.hospitalId),
      patientId: consent.abhaAddress || String(consent.patientId),
      hipIds: consent.hipIds || [],
      hiuId: consent.hiuId || abdmConfig.hiuId,
      purpose: consent.purpose,
      hiTypes: (consent.hiTypes || []).map(toAbdmHiType),
      dateRange: {
        from: new Date(consent.dateRange.from).toISOString(),
        to: new Date(consent.dateRange.to).toISOString()
      },
      retentionUntil: consent.expiresAt || consent.permission?.dataEraseAt
    }
  });

  let request = null;
  let masterAccepted = false;
  try {
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
      receiver.keyHandle
        ? { provider: receiver.provider, keyHandle: receiver.keyHandle }
        : { provider: receiver.provider, privateMaterial: receiver.privateMaterial },
      `abdm-hiu-private:${requestId}`
    );
    request = await AbdmHiuRequest.create({
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
      requestedAt: new Date(),
      metadata: {
        consentAuthorization: {
          validationId: consentAuthorization.validationId,
          authorizedOperationHash: consentAuthorization.authorizedOperationHash,
          usage: consentAuthorization.usage,
          retentionUntil: consentAuthorization.retentionUntil
        }
      }
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

    const master = await masterRequest('/internal/abdm/m3/action', {
      method: 'POST',
      body: { action: 'REQUEST_HEALTH_INFORMATION', body }
    });
    masterAccepted = true;
    request.masterRequestId = master.requestId;
    if (consentAuthorization.usage?.reservationId) {
      try {
        await commitConsentUsage(consentAuthorization.usage);
        request.metadata = {
          ...(request.metadata || {}),
          consentAuthorization: {
            ...(request.metadata?.consentAuthorization || {}),
            usageCommitted: true,
            usageCommittedAt: new Date()
          }
        };
      } catch (commitError) {
        request.metadata = {
          ...(request.metadata || {}),
          consentAuthorization: {
            ...(request.metadata?.consentAuthorization || {}),
            usageCommitPending: true,
            usageCommitError: { code: commitError.code, message: commitError.message }
          }
        };
      }
    }
    await request.save();
    return { request, masterRequestId: master.requestId };
  } catch (error) {
    if (!masterAccepted && consentAuthorization.usage?.reservationId) {
      await releaseConsentUsage(consentAuthorization.usage).catch(() => {});
    }
    if (request) {
      request.status = 'FAILED';
      request.error = { message: error.message, details: error.details };
      await request.save().catch(() => {});
    }
    throw error;
  }
}

async function onConsentCallback(eventType, payload) {
  const role = 'HIU';
  const hospitalId = await configuredHospitalId();
  // Only the fetched artefact can make a consent usable. Init/status/notify
  // callbacks are lifecycle signals authenticated by the Master connector and
  // are retained as unvalidated until ON_FETCH supplies the signed artefact.
  const validation = eventType === 'HIU_CONSENT_ON_FETCH'
    ? await validateConsentArtefact(payload, { role: 'HIU' })
    : null;
  const value = await upsertConsent(payload, role, {
    hospitalId,
    storeArtefact: Boolean(validation),
    ...(validation
      ? {
          signatureValidated: validation.signatureVerified === true,
          integrityValidated: validation.integrityVerified === true,
          cryptographicallyValidated: validation.cryptographicallyValidated === true,
          validationId: validation.validationId,
          validatedAt: validation.validatedAt ? new Date(validation.validatedAt) : new Date(),
          validFrom: validation.verifiedScope?.validFrom,
          verifiedScope: validation.verifiedScope,
          trustEvidence: validation.trust,
          retentionUntil: validation.retentionUntil,
          artefactHash: validation.artefactHash
        }
      : {}),
    metadata: {
      callbackEventType: eventType,
      ...(validation ? { consentValidation: validation } : {})
    }
  });
  await recordConsentStatusEvent(value, {
    eventId: payload.requestId || payload.response?.requestId || `${value.consentId || value.consentRequestId}:${value.status}:${value.lastCallbackAt}`
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
      existing.consentArtefactIds = value.consentArtefactIds?.length
        ? value.consentArtefactIds
        : existing.consentArtefactIds;
      existing.status = value.status;
      existing.permission = value.permission || existing.permission;
      existing.hiTypes = value.hiTypes?.length ? value.hiTypes : existing.hiTypes;
      existing.dateRange = value.dateRange || existing.dateRange;
      existing.careContextReferences = value.careContextReferences?.length
        ? value.careContextReferences
        : existing.careContextReferences;
      existing.hipIds = value.hipIds?.length ? value.hipIds : existing.hipIds;
      existing.hiuId = value.hiuId || existing.hiuId;
      existing.expiresAt = value.expiresAt || existing.expiresAt;
      if (validation) {
        existing.encryptedArtefact = encryptJson(
          payload,
          `abdm-consent:${hospitalId}:${role}:${
            value.consentId || value.consentRequestId || requestId
          }`
        );
        existing.artefactHash = value.artefactHash || validation.artefactHash || existing.artefactHash;
        existing.sourceEnvelopeHash = value.sourceEnvelopeHash || hashArtifact(payload);
        existing.signatureValidated = value.signatureValidated === true;
        existing.integrityValidated = value.integrityValidated === true;
        existing.cryptographicallyValidated = value.cryptographicallyValidated === true;
        existing.validationId = value.validationId || existing.validationId;
        existing.validatedAt = value.validatedAt || existing.validatedAt;
        existing.validFrom = value.validFrom || existing.validFrom;
        existing.verifiedScope = value.verifiedScope || existing.verifiedScope;
        existing.trustEvidence = value.trustEvidence || existing.trustEvidence;
        existing.retentionUntil = value.retentionUntil || existing.retentionUntil;
      }
      existing.lastCallbackAt = new Date();
      existing.metadata = {
        ...(existing.metadata || {}),
        ...(value.metadata || {})
      };
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
  const pendingUsage = request.metadata?.consentAuthorization?.usage;
  if (!payload.error && pendingUsage?.reservationId && request.metadata?.consentAuthorization?.usageCommitPending) {
    try {
      await commitConsentUsage(pendingUsage);
      request.metadata = {
        ...(request.metadata || {}),
        consentAuthorization: {
          ...(request.metadata?.consentAuthorization || {}),
          usageCommitPending: false,
          usageCommitted: true,
          usageCommittedAt: new Date()
        }
      };
    } catch (commitError) {
      request.metadata = {
        ...(request.metadata || {}),
        consentAuthorization: {
          ...(request.metadata?.consentAuthorization || {}),
          usageCommitError: { code: commitError.code, message: commitError.message }
        }
      };
    }
  }
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
    hiStatus: status === 'RECEIVED' ? 'OK' : 'ERRORED',
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
      provider: privateMaterial?.provider,
      ...(privateMaterial?.keyHandle
        ? { keyHandle: privateMaterial.keyHandle }
        : { privateMaterial: privateMaterial?.privateMaterial || privateMaterial }),
      keyMaterial: assembled.keyMaterial,
      entries: assembled.entries
    });
    assertDecryptionIntegrity({ encryptedEntries: assembled.entries, decrypted });
    transfer.status = 'DECRYPTED';
    await transfer.save();

    const validatedRecords = [];
    for (const record of decrypted.records) {
      const bundle = typeof record.content === 'string' ? JSON.parse(record.content) : record.content;
      // eslint-disable-next-line no-await-in-loop
      const validation = await assertValidBundle(bundle);
      const bundleHash = hashArtifact(bundle);
      const metadata = extractBundleMetadata(bundle, record);
      const normalizedHiType = assertImportedRecordWithinConsent(
        consent,
        metadata,
        record,
        { ...payload, hipId: assembled.hipId }
      );
      validatedRecords.push({ record, bundle, validation, bundleHash, metadata, normalizedHiType });
    }

    const recordDates = validatedRecords
      .map((item) => item.metadata.recordDate && new Date(item.metadata.recordDate))
      .filter((item) => item && !Number.isNaN(item.getTime()));
    const importAuthorization = await authorizeConsentOperation({
      consent,
      operation: {
        type: 'HIU_IMPORT',
        operationId: transactionId,
        transactionId,
        hospitalId: String(request.hospitalId),
        patientId: consent.abhaAddress || String(request.patientId),
        hipId: assembled.hipId || validatedRecords.find((item) => item.record.sourceHipId)?.record.sourceHipId,
        hiuId: consent.hiuId || abdmConfig.hiuId,
        purpose: consent.purpose,
        hiTypes: Array.from(new Set(validatedRecords.map((item) => toAbdmHiType(item.normalizedHiType)))),
        careContextIds: Array.from(new Set(validatedRecords.map((item) => item.record.careContextReference).filter(Boolean))),
        dateRange: recordDates.length
          ? {
              from: new Date(Math.min(...recordDates.map((item) => item.getTime()))).toISOString(),
              to: new Date(Math.max(...recordDates.map((item) => item.getTime()))).toISOString()
            }
          : consent.dateRange,
        payloadHash: idempotencyKey,
        retentionUntil: consent.expiresAt || consent.permission?.dataEraseAt
      }
    });
    transfer.metadata = {
      ...(transfer.metadata || {}),
      consentAuthorization: {
        validationId: importAuthorization.validationId,
        authorizedOperationHash: importAuthorization.authorizedOperationHash,
        retentionUntil: importAuthorization.retentionUntil
      }
    };
    await transfer.save();

    let imported = 0;
    for (const item of validatedRecords) {
      const { record, bundle, validation, bundleHash, metadata, normalizedHiType } = item;
      // eslint-disable-next-line no-await-in-loop
      await AbdmImportedRecord.findOneAndUpdate(
        { hospitalId: request.hospitalId, transactionId, bundleHash },
        {
          $set: {
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
            consentSnapshot: {
              status: consent.status,
              hiTypes: consent.hiTypes,
              dateRange: consent.dateRange,
              expiresAt: consent.expiresAt,
              validationId: importAuthorization.validationId,
              authorizedOperationHash: importAuthorization.authorizedOperationHash
            },
            status: 'ACTIVE',
            validation,
            receivedAt: new Date(),
            importedAt: new Date(),
            purgeAt: importAuthorization.retentionUntil || consent.retentionUntil || consent.expiresAt || consent.permission?.dataEraseAt
          }
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
    await notifyHiuDataFlow({ request, consent, hipId: assembled.hipId, status: 'RECEIVED', contexts });
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
  let consent = await AbdmHospitalConsent.findOne(query);
  if (!consent) {
    consent = await upsertConsent(payload, 'HIU', {
      hospitalId,
      storeArtefact: false,
      cryptographicallyValidated: false,
      metadata: { callbackEventType: 'STATUS' }
    });
  }
  consent.status = normalizedStatus(
    payload.status || payload.consentRequest?.status || payload.notification?.status
  );
  consent.lastCallbackAt = new Date();
  if (consent.status === 'REVOKED') consent.revokedAt = new Date();
  await consent.save();
  await recordConsentStatusEvent(consent, {
    eventId: payload.requestId || payload.response?.requestId || `${consent.consentId || consent.consentRequestId}:${consent.status}:${consent.lastCallbackAt}`
  });
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
