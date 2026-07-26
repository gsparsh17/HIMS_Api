const crypto = require('crypto');
const Patient = require('../models/Patient');
const AbdmCareContext = require('../models/AbdmCareContext');
const AbdmCounterSequence = require('../models/AbdmCounterSequence');
const AbdmLinkAuthentication = require('../models/AbdmLinkAuthentication');
const AbdmHospitalConsent = require('../models/AbdmHospitalConsent');
const {
  buildPatientCareContexts,
  groupedForAbdm
} = require('../services/abdmCareContext.service');
const {
  toAbdmHiType,
  normalizeInternalHiTypes
} = require('../utils/abdmHiTypes');
const {
  createOtp,
  hashOtp,
  verifyOtp,
  sendLinkOtp
} = require('../services/abdmLinkOtp.service');
const {
  upsertConsent,
  assertConsentUsable,
  hashArtifact
} = require('../services/abdmConsentPolicy.service');
const { encryptJson } = require('../services/abdmVault.service');
const { enqueueHipDataRequest } = require('../services/abdmHospitalJob.service');
const { masterRequest } = require('../services/abdmMasterClient.service');
const { configuredHospitalId } = require('../services/hospitalIdentity.service');
const abdmConfig = require('../config/abdm.config');
const {
  validateConsentArtefact
} = require('../services/abdmConsentValidation.service');

function digits(value) {
  const text = String(value || '');
  return /^\d+$/.test(text) ? text : null;
}

function canonicalAbhaNumber(value) {
  const valueDigits = String(value || '').replace(/\D/g, '');
  if (valueDigits.length !== 14) return value ? String(value) : undefined;
  return `${valueDigits.slice(0, 2)}-${valueDigits.slice(2, 6)}-${valueDigits.slice(
    6,
    10
  )}-${valueDigits.slice(10)}`;
}

function normalizeGender(value) {
  const normalized = String(value || '').toUpperCase();
  if (['M', 'MALE'].includes(normalized)) return 'male';
  if (['F', 'FEMALE'].includes(normalized)) return 'female';
  return 'other';
}

function parseDob(patient = {}) {
  const year = Number(patient.yearOfBirth);
  const month = Number(patient.monthOfBirth || 1);
  const day = Number(patient.dayOfBirth || 1);
  if (!year || year < 1900 || year > new Date().getFullYear()) return null;
  const value = new Date(
    Date.UTC(year, Math.max(month - 1, 0), Math.max(day, 1))
  );
  return Number.isNaN(value.getTime()) ? null : value;
}

function splitName(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || 'ABDM',
    middle_name: parts.length > 2 ? parts.slice(1, -1).join(' ') : undefined,
    last_name: parts.length > 1 ? parts[parts.length - 1] : undefined
  };
}

function normalizedName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function demographicCompatible(patient, request = {}) {
  const requestedName = normalizedName(request.name);
  const localName = normalizedName(
    [patient.first_name, patient.middle_name, patient.last_name]
      .filter(Boolean)
      .join(' ')
  );
  if (requestedName && localName && requestedName !== localName) return false;

  const requestedGender = normalizeGender(request.gender);
  if (request.gender && patient.gender && patient.gender !== requestedGender) {
    return false;
  }

  const requestedYear = Number(request.yearOfBirth);
  const localYear = patient.dob ? new Date(patient.dob).getFullYear() : null;
  if (requestedYear && localYear && requestedYear !== localYear) return false;
  return true;
}

async function nextToken(counterId) {
  const hospitalId = await configuredHospitalId();
  const dateKey = new Date().toISOString().slice(0, 10);
  const sequence = await AbdmCounterSequence.findOneAndUpdate(
    { hospitalId, counterId, dateKey },
    { $inc: { sequence: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return sequence.sequence;
}

function requestIdFromEnvelope(req) {
  return (
    req.body?.headers?.['request-id'] ||
    req.body?.headers?.requestId ||
    req.body?.body?.request?.id ||
    req.body?.body?.response?.requestId ||
    crypto.randomUUID()
  );
}

function collectReferenceCandidates(value, bucket = new Set()) {
  if (!value) return bucket;
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferenceCandidates(item, bucket));
    return bucket;
  }
  if (typeof value !== 'object') return bucket;

  for (const [key, item] of Object.entries(value)) {
    if (
      [
        'referenceNumber',
        'patientReference',
        'careContextReference',
        'careContextReferenceNumber'
      ].includes(key) &&
      typeof item === 'string'
    ) {
      bucket.add(item);
    }
    collectReferenceCandidates(item, bucket);
  }
  return bucket;
}

function errorOutbound(action, requestId, code, message, extra = {}) {
  return {
    success: true,
    summary: { accepted: false, reason: message },
    outbound: [
      {
        action,
        body: {
          ...extra,
          error: { code, message },
          response: { requestId }
        }
      }
    ]
  };
}

exports.health = async (_req, res) => {
  const hospitalId = await configuredHospitalId();
  return res.json({
    success: true,
    hospitalId,
    hfrFacilityId: abdmConfig.hfrFacilityId,
    hipId: abdmConfig.hipId,
    hiuId: abdmConfig.hiuId,
    tenantCode: abdmConfig.tenantCode,
    timestamp: new Date().toISOString()
  });
};

exports.profileShare = async (req, res) => {
  try {
    const hospitalId = await configuredHospitalId();
    const body = req.body?.body || {};
    const shared = body.profile?.patient || {};
    const abhaNumber = canonicalAbhaNumber(shared.abhaNumber);
    const abhaAddress = shared.abhaAddress
      ? String(shared.abhaAddress).toLowerCase()
      : undefined;
    const phone = digits(shared.phoneNumber);
    const requestId = requestIdFromEnvelope(req);

    let patient = null;
    const abhaMatches = [];
    if (abhaAddress) abhaMatches.push({ 'abha.address': abhaAddress });
    if (abhaNumber) abhaMatches.push({ 'abha.number': abhaNumber });
    if (abhaMatches.length) {
      patient = await Patient.findOne({ hospitalId, $or: abhaMatches });
    }

    if (!patient && phone?.length === 10) {
      const matches = await Patient.find({ hospitalId, phone }).limit(3);
      const compatible = matches.filter((item) =>
        demographicCompatible(item, shared)
      );
      if (compatible.length === 1) patient = compatible[0];
      if (compatible.length > 1 || (matches.length > 1 && !compatible.length)) {
        return res.json(
          errorOutbound(
            'ACK_PROFILE_SHARE',
            requestId,
            'ABDM-1010',
            'Patient identity is ambiguous and requires manual reconciliation'
          )
        );
      }
    }

    if (!patient) {
      const dob = parseDob(shared);
      if (!phone || phone.length !== 10 || !dob || (!abhaNumber && !abhaAddress)) {
        return res.json(
          errorOutbound(
            'ACK_PROFILE_SHARE',
            requestId,
            'ABDM-1010',
            'Profile does not contain enough verified data to register the patient'
          )
        );
      }

      const names = splitName(shared.name);
      patient = await Patient.create({
        hospitalId,
        ...names,
        phone,
        gender: normalizeGender(shared.gender),
        dob,
        address: shared.address?.line,
        district: shared.address?.district,
        state: shared.address?.state,
        zipCode: shared.address?.pincode,
        abha: {
          number: abhaNumber,
          address: abhaAddress,
          status: 'VERIFIED',
          kycVerified: true,
          registrationMode: 'profile_share',
          verificationMethod: 'ABDM_PROFILE_SHARE',
          verifiedAt: new Date(),
          linkedAt: new Date(),
          profile: {
            firstName: names.first_name,
            middleName: names.middle_name,
            lastName: names.last_name,
            dob: dob.toISOString().slice(0, 10),
            gender: shared.gender,
            mobileMasked: shared.phoneNumber,
            districtName: shared.address?.district,
            stateName: shared.address?.state,
            pinCode: shared.address?.pincode
          }
        }
      });
    } else {
      const conflictingAbha =
        (patient.abha?.number &&
          abhaNumber &&
          patient.abha.number !== abhaNumber) ||
        (patient.abha?.address &&
          abhaAddress &&
          patient.abha.address !== abhaAddress);
      if (conflictingAbha) {
        return res.json(
          errorOutbound(
            'ACK_PROFILE_SHARE',
            requestId,
            'ABDM-1010',
            'The local patient is already linked to a different ABHA identity'
          )
        );
      }

      if (abhaNumber) patient.abha.number = abhaNumber;
      if (abhaAddress) patient.abha.address = abhaAddress;
      patient.abha.status = 'VERIFIED';
      patient.abha.kycVerified = true;
      patient.abha.registrationMode = 'profile_share';
      patient.abha.verificationMethod = 'ABDM_PROFILE_SHARE';
      patient.abha.verifiedAt = new Date();
      patient.abha.linkedAt = patient.abha.linkedAt || new Date();
      await patient.save();
    }

    const counterId = String(body.metaData?.context || 'GENERAL');
    const tokenNumber = await nextToken(counterId);
    return res.json({
      success: true,
      summary: { patientId: patient._id, tokenNumber, counterId },
      outbound: [
        {
          action: 'ACK_PROFILE_SHARE',
          body: {
            acknowledgement: {
              abhaAddress: abhaAddress || patient.abha?.address,
              status: 'SUCCESS',
              profile: {
                context: counterId,
                tokenNumber: String(tokenNumber),
                expiry: '180'
              }
            },
            response: { requestId }
          }
        }
      ]
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.discover = async (req, res) => {
  try {
    const hospitalId = await configuredHospitalId();
    const body = req.body?.body || {};
    const requestedPatient = body.patient || {};
    const requestId = requestIdFromEnvelope(req);
    const verifiedMobile = (requestedPatient.verifiedIdentifiers || []).find(
      (item) => String(item.type).toUpperCase() === 'MOBILE'
    )?.value;
    const mobile = digits(verifiedMobile);

    let matches = [];
    if (requestedPatient.id) {
      matches = await Patient.find({
        hospitalId,
        'abha.address': String(requestedPatient.id).toLowerCase()
      }).limit(2);
    } else if (mobile?.length === 10) {
      matches = await Patient.find({ hospitalId, phone: mobile }).limit(5);
      matches = matches.filter((patient) =>
        demographicCompatible(patient, requestedPatient)
      );
    }

    if (matches.length !== 1) {
      const message = matches.length
        ? 'Multiple patients match the supplied identifiers'
        : 'Patient not found';
      return res.json(
        errorOutbound('RESPOND_DISCOVERY', requestId, 'ABDM-1010', message, {
          transactionId: body.transactionId
        })
      );
    }

    const patient = matches[0];
    await buildPatientCareContexts(patient._id);
    const { patientGroups } = await groupedForAbdm(patient._id);
    return res.json({
      success: true,
      summary: {
        patientId: patient._id,
        careContextGroups: patientGroups.length
      },
      outbound: [
        {
          action: 'RESPOND_DISCOVERY',
          body: {
            transactionId: body.transactionId,
            patient: patientGroups,
            response: { requestId }
          }
        }
      ]
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.linkInit = async (req, res) => {
  try {
    const hospitalId = await configuredHospitalId();
    const body = req.body?.body || {};
    const requestId = requestIdFromEnvelope(req);
    const candidates = Array.from(collectReferenceCandidates(body));
    const context = candidates.length
      ? await AbdmCareContext.findOne({
          hospitalId,
          active: { $ne: false },
          $or: [
            { referenceNumber: { $in: candidates } },
            { patientReference: { $in: candidates } }
          ]
        })
      : null;

    if (!context) {
      return res.json(
        errorOutbound(
          'RESPOND_LINK_INIT',
          requestId,
          'ABDM-1010',
          'Patient or care context not found',
          { transactionId: body.transactionId }
        )
      );
    }

    const patient = await Patient.findOne({
      _id: context.patientId,
      hospitalId
    });
    if (!patient?.phone) {
      return res.json(
        errorOutbound(
          'RESPOND_LINK_INIT',
          requestId,
          'ABDM-1010',
          'Patient mobile number is not available at HIP',
          { transactionId: body.transactionId }
        )
      );
    }

    const allContexts = await AbdmCareContext.find({
      hospitalId,
      patientId: patient._id,
      active: { $ne: false }
    }).select('referenceNumber patientReference hiType');
    const explicitlySelected = allContexts.filter((item) =>
      candidates.includes(item.referenceNumber)
    );
    const related = explicitlySelected.length
      ? explicitlySelected
      : candidates.includes(context.patientReference)
        ? allContexts
        : [context];

    const linkRefNumber = crypto.randomUUID();
    const otp = createOtp();
    const { salt, hash } = hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await AbdmLinkAuthentication.create({
      hospitalId,
      linkRefNumber,
      transactionId: body.transactionId,
      patientId: patient._id,
      patientReference: context.patientReference,
      careContextReferences: related.map((item) => item.referenceNumber),
      otpHash: hash,
      otpSalt: salt,
      expiresAt,
      metadata: { requestId, referenceCandidates: candidates }
    });

    try {
      await sendLinkOtp({
        phone: patient.phone,
        otp,
        facilityId: abdmConfig.hipId,
        patientReference: context.patientReference,
        linkRefNumber
      });
    } catch (error) {
      await AbdmLinkAuthentication.updateOne(
        { hospitalId, linkRefNumber },
        {
          status: 'FAILED',
          metadata: { requestId, smsError: error.message }
        }
      );
      return res.json(
        errorOutbound(
          'RESPOND_LINK_INIT',
          requestId,
          'ABDM-9999',
          'Unable to deliver linking OTP',
          { transactionId: body.transactionId }
        )
      );
    }

    return res.json({
      success: true,
      summary: { linkRefNumber, expiresAt },
      outbound: [
        {
          action: 'RESPOND_LINK_INIT',
          body: {
            transactionId: body.transactionId,
            link: {
              referenceNumber: linkRefNumber,
              authenticationType: 'MEDIATE',
              meta: {
                communicationMedium: 'MOBILE',
                communicationHint: 'OTP',
                communicationExpiry: expiresAt.toISOString()
              }
            },
            response: { requestId }
          }
        }
      ]
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.linkConfirm = async (req, res) => {
  try {
    const hospitalId = await configuredHospitalId();
    const body = req.body?.body || {};
    const requestId = requestIdFromEnvelope(req);
    const confirmation = body.confirmation || {};
    const linkRefNumber = confirmation.linkRefNumber || body.linkRefNumber;
    const token = String(confirmation.token ?? body.token ?? '');
    const auth = await AbdmLinkAuthentication.findOne({
      hospitalId,
      linkRefNumber
    }).select('+otpHash +otpSalt');

    if (!auth) {
      return res.json(
        errorOutbound(
          'RESPOND_LINK_CONFIRM',
          requestId,
          'ABDM-9999',
          'Invalid link reference number'
        )
      );
    }
    if (auth.status !== 'PENDING' || auth.expiresAt.getTime() <= Date.now()) {
      auth.status =
        auth.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : auth.status;
      await auth.save();
      return res.json(
        errorOutbound(
          'RESPOND_LINK_CONFIRM',
          requestId,
          'ABDM-9999',
          'Link authentication is expired or inactive'
        )
      );
    }

    auth.attempts += 1;
    if (!verifyOtp(token, auth.otpSalt, auth.otpHash)) {
      if (auth.attempts >= auth.maxAttempts) auth.status = 'LOCKED';
      await auth.save();
      return res.json(
        errorOutbound(
          'RESPOND_LINK_CONFIRM',
          requestId,
          'ABDM-9999',
          'Invalid OTP'
        )
      );
    }

    const { patientGroups: allGroups } = await groupedForAbdm(auth.patientId);
    const selected = new Set((auth.careContextReferences || []).map(String));
    const patientGroups = allGroups
      .map((group) => ({
        ...group,
        careContexts: group.careContexts.filter((item) =>
          selected.has(String(item.referenceNumber))
        )
      }))
      .filter((group) => group.careContexts.length)
      .map((group) => ({ ...group, count: group.careContexts.length }));

    const contextFilter = {
      hospitalId,
      patientId: auth.patientId,
      referenceNumber: { $in: auth.careContextReferences }
    };
    await AbdmCareContext.updateMany(contextFilter, {
      linkStatus: 'ABDM_LINK_PENDING',
      linkTransactionId: body.transactionId,
      metadata: { userInitiated: true, confirmedLocallyAt: new Date() }
    });

    try {
      await masterRequest('/internal/abdm/m2/action', {
        method: 'POST',
        body: {
          action: 'RESPOND_LINK_CONFIRM',
          body: {
            transactionId: body.transactionId,
            patient: patientGroups,
            response: { requestId }
          }
        }
      });
    } catch (error) {
      await AbdmCareContext.updateMany(contextFilter, {
        linkStatus: 'ABDM_LINK_FAILED',
        metadata: { userInitiated: true, error: error.message }
      });
      throw error;
    }

    auth.status = 'VERIFIED';
    auth.verifiedAt = new Date();
    await auth.save();
    await AbdmCareContext.updateMany(contextFilter, {
      linkStatus: 'ABDM_LINKED',
      linkedAt: new Date()
    });

    return res.json({
      success: true,
      summary: {
        confirmed: true,
        patientId: auth.patientId,
        careContextGroups: patientGroups.length
      },
      outbound: []
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.linkToken = async (req, res) => {
  try {
    const hospitalId = await configuredHospitalId();
    const body = req.body?.body || {};
    const callbackRequestId = body.response?.requestId || requestIdFromEnvelope(req);
    const linkToken = body.linkToken || body.token || body.link?.token;
    const pending = await AbdmCareContext.find({
      hospitalId,
      linkRequestId: callbackRequestId,
      linkStatus: 'ABDM_LINK_PENDING'
    });

    if (body.error) {
      await AbdmCareContext.updateMany(
        {
          hospitalId,
          linkRequestId: callbackRequestId,
          linkStatus: 'ABDM_LINK_PENDING'
        },
        {
          linkStatus: 'ABDM_LINK_FAILED',
          metadata: { callbackError: body.error }
        }
      );
      return res.json({
        success: true,
        summary: { failed: true, error: body.error },
        outbound: []
      });
    }

    if (!linkToken || !pending.length) {
      return res.json({
        success: true,
        summary: 'No pending care contexts found for link-token callback',
        outbound: []
      });
    }

    const patient = await Patient.findOne({
      _id: pending[0].patientId,
      hospitalId
    });
    if (!patient) throw new Error('Patient for pending care contexts was not found');

    const groups = new Map();
    for (const item of pending) {
      if (!groups.has(item.hiType)) groups.set(item.hiType, []);
      groups.get(item.hiType).push(item);
    }
    const patientGroups = Array.from(groups.entries()).map(([hiType, items]) => ({
      referenceNumber: items[0].patientReference,
      display: [patient.first_name, patient.last_name].filter(Boolean).join(' '),
      careContexts: items.map((item) => ({
        referenceNumber: item.referenceNumber,
        display: item.display
      })),
      hiType: toAbdmHiType(hiType),
      count: items.length
    }));

    const careContextLinkRequestId = crypto.randomUUID();
    await AbdmCareContext.updateMany(
      {
        hospitalId,
        _id: { $in: pending.map((item) => item._id) },
        linkStatus: 'ABDM_LINK_PENDING'
      },
      {
        $set: {
          linkRequestId: careContextLinkRequestId,
          'metadata.linkTokenCallbackRequestId': callbackRequestId,
          'metadata.careContextLinkRequestId': careContextLinkRequestId
        }
      }
    );

    return res.json({
      success: true,
      summary: {
        pending: pending.length,
        careContextLinkRequestId
      },
      outbound: [
        {
          action: 'LINK_CARE_CONTEXT',
          requestId: careContextLinkRequestId,
          linkToken,
          body: {
            abhaNumber: patient.abha?.number,
            abhaAddress: patient.abha?.address,
            patient: patientGroups
          }
        }
      ]
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.linkCareContext = async (req, res) => {
  const hospitalId = await configuredHospitalId();
  const body = req.body?.body || {};
  const callbackRequestId = body.response?.requestId || requestIdFromEnvelope(req);
  const failed = Boolean(body.error);
  await AbdmCareContext.updateMany(
    {
      hospitalId,
      linkRequestId: callbackRequestId,
      linkStatus: 'ABDM_LINK_PENDING'
    },
    {
      linkStatus: failed ? 'ABDM_LINK_FAILED' : 'ABDM_LINKED',
      linkedAt: failed ? undefined : new Date(),
      metadata: { callback: body }
    }
  );
  return res.json({ success: true, summary: { failed }, outbound: [] });
};

exports.careContextUpdate = async (req, res) => {
  const hospitalId = await configuredHospitalId();
  const body = req.body?.body || {};
  const references = Array.from(collectReferenceCandidates(body));
  if (references.length) {
    await AbdmCareContext.updateMany(
      {
        hospitalId,
        $or: [
          { referenceNumber: { $in: references } },
          { patientReference: { $in: references } }
        ]
      },
      {
        linkStatus: body.error ? 'ABDM_LINK_FAILED' : 'ABDM_LINKED',
        linkedAt: body.error ? undefined : new Date(),
        metadata: { callback: body }
      }
    );
  }
  return res.json({
    success: true,
    summary: { received: true, updatedReferences: references.length },
    outbound: []
  });
};

exports.smsNotify = async (_req, res) => {
  return res.json({ success: true, summary: { received: true }, outbound: [] });
};

async function storeHipConsentEnvelope(envelope) {
  const hospitalId = await configuredHospitalId();
  const body = envelope.body || {};
  const central = envelope.consent || null;
  if (!central) {
    const validation = await validateConsentArtefact(body);
    return upsertConsent(body, 'HIP', {
      hospitalId,
      signatureValidated: validation.valid === true,
      metadata: { consentValidation: validation }
    });
  }

  const consentId =
    central.consentId ||
    body.notification?.consentId ||
    body.hiRequest?.consent?.id;
  if (!consentId) throw new Error('Consent identifier is missing');

  const contextRefs = (central.careContextReferences || []).map(String);
  const contexts = contextRefs.length
    ? await AbdmCareContext.find({
        hospitalId,
        referenceNumber: { $in: contextRefs }
      }).select('patientId')
    : [];
  const patientIds = Array.from(
    new Set(contexts.map((context) => String(context.patientId)))
  );
  if (patientIds.length > 1) {
    throw new Error('Consent care contexts map to multiple patients');
  }

  const validation = central.signatureVerified
    ? { valid: true, source: 'MEDIQLIQ_MASTER' }
    : await validateConsentArtefact(body);
  const encryptedArtefact = encryptJson(
    body,
    `abdm-consent:${hospitalId}:HIP:${consentId}`
  );

  return AbdmHospitalConsent.findOneAndUpdate(
    { hospitalId, role: 'HIP', consentId },
    {
      hospitalId,
      role: 'HIP',
      consentId,
      status: String(central.status || 'PENDING').toUpperCase(),
      patientId: patientIds[0],
      abhaAddress: central.abhaAddress,
      purpose: central.purpose,
      hiTypes: normalizeInternalHiTypes(central.hiTypes || []),
      dateRange: central.dateRange,
      permission: central.permission,
      careContextReferences: contextRefs,
      expiresAt: central.expiresAt,
      encryptedArtefact,
      artefactHash: central.artefactHash || hashArtifact(body),
      signatureValidated:
        validation.valid === true ||
        central.signatureValidated === true ||
        central.signatureVerified === true,
      lastCallbackAt: new Date(),
      metadata: {
        centralConsentReference: central._id,
        consentValidation: validation
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

exports.consentNotify = async (req, res) => {
  try {
    const requestId = requestIdFromEnvelope(req);
    const consent = await storeHipConsentEnvelope(req.body || {});
    return res.json({
      success: true,
      summary: { consentId: consent.consentId, status: consent.status },
      outbound: [
        {
          action: 'ACK_CONSENT',
          body: {
            acknowledgement: {
              status: 'OK',
              consentId: consent.consentId
            },
            response: { requestId }
          }
        }
      ]
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

function healthRequestError(requestId, code, message, transactionId) {
  return {
    success: true,
    summary: { transactionId, accepted: false, reason: message },
    outbound: [
      {
        action: 'ACK_HEALTH_INFORMATION',
        body: {
          error: { code, message },
          response: { requestId }
        }
      }
    ]
  };
}

exports.healthInformationRequest = async (req, res) => {
  try {
    const hospitalId = await configuredHospitalId();
    const body = req.body?.body || {};
    const requestId = requestIdFromEnvelope(req);
    const transactionId =
      body.hiRequest?.transactionId || body.transactionId || crypto.randomUUID();
    const consentId = body.hiRequest?.consent?.id;

    if (!consentId) {
      return res.json(
        healthRequestError(
          requestId,
          'ABDM-1001',
          'Health-information request is missing consent ID',
          transactionId
        )
      );
    }

    if (req.body?.consent) await storeHipConsentEnvelope(req.body);
    const consent = await AbdmHospitalConsent.findOne({
      hospitalId,
      role: 'HIP',
      consentId
    });
    try {
      assertConsentUsable(consent);
    } catch (error) {
      return res.json(
        healthRequestError(requestId, 'ABDM-1001', error.message, transactionId)
      );
    }

    if (!body.hiRequest?.dataPushUrl || !body.hiRequest?.keyMaterial) {
      return res.json(
        healthRequestError(
          requestId,
          'ABDM-1001',
          'Health-information request is missing dataPushUrl or keyMaterial',
          transactionId
        )
      );
    }

    body.hiRequest.transactionId = transactionId;
    const job = await enqueueHipDataRequest(body, hospitalId);
    return res.status(202).json({
      success: true,
      summary: { transactionId, accepted: true, jobId: job._id },
      outbound: [
        {
          action: 'ACK_HEALTH_INFORMATION',
          body: {
            hiRequest: {
              transactionId,
              sessionStatus: 'ACKNOWLEDGED'
            },
            response: { requestId }
          }
        }
      ]
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
};

exports.hiuPatientOnShare = async (_req, res) => {
  return res.json({ success: true, summary: { received: true }, outbound: [] });
};
