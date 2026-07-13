const crypto = require('crypto');
const Patient = require('../models/Patient');
const AbdmCareContext = require('../models/AbdmCareContext');
const AbdmCounterSequence = require('../models/AbdmCounterSequence');
const AbdmLinkAuthentication = require('../models/AbdmLinkAuthentication');
const { buildPatientCareContexts, groupedForAbdm } = require('../services/abdmCareContext.service');
const { generateAbdmHiBundle } = require('../services/fhir/abdmHiBundle.service');
const { toAbdmHiType, normalizeInternalHiTypes } = require('../utils/abdmHiTypes');
const { createOtp, hashOtp, verifyOtp, sendLinkOtp } = require('../services/abdmLinkOtp.service');
const abdmConfig = require('../config/abdm.config');

function unmaskDigits(value) {
  const string = String(value || '');
  return /^\d+$/.test(string) ? string : null;
}

function normalizeGender(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'M' || v === 'MALE') return 'male';
  if (v === 'F' || v === 'FEMALE') return 'female';
  return 'other';
}

function parseDob(patient = {}) {
  const year = Number(patient.yearOfBirth);
  const month = Number(patient.monthOfBirth || 1);
  const day = Number(patient.dayOfBirth || 1);
  if (!year || year < 1900 || year > new Date().getFullYear()) return null;
  const value = new Date(Date.UTC(year, Math.max(month - 1, 0), Math.max(day, 1)));
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

async function nextToken(counterId) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const sequence = await AbdmCounterSequence.findOneAndUpdate(
    { counterId, dateKey },
    { $inc: { sequence: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return sequence.sequence;
}

function requestIdFromEnvelope(req) {
  return req.body?.headers?.['request-id'] || req.body?.headers?.requestId || crypto.randomUUID();
}

exports.health = async (req, res) => {
  res.json({
    success: true,
    hfrFacilityId: abdmConfig.hfrFacilityId,
    hipId: abdmConfig.hipId,
    facilityId: abdmConfig.hipId,
    tenantCode: abdmConfig.tenantCode,
    timestamp: new Date().toISOString()
  });
};

exports.profileShare = async (req, res) => {
  try {
    const payload = req.body?.body || {};
    const shared = payload.profile?.patient || {};
    const abhaNumber = shared.abhaNumber ? String(shared.abhaNumber) : undefined;
    const abhaAddress = shared.abhaAddress ? String(shared.abhaAddress).toLowerCase() : undefined;
    const phone = unmaskDigits(shared.phoneNumber);
    const requestId = requestIdFromEnvelope(req);

    let patient = null;
    const abhaMatches = [];
    if (abhaAddress) abhaMatches.push({ 'abha.address': abhaAddress });
    if (abhaNumber) abhaMatches.push({ 'abha.number': abhaNumber });
    if (abhaMatches.length) patient = await Patient.findOne({ $or: abhaMatches });

    if (!patient && phone?.length === 10) {
      const phoneMatches = await Patient.find({ phone }).limit(2);
      if (phoneMatches.length === 1) {
        const candidate = phoneMatches[0];
        const conflictingAbha =
          (candidate.abha?.number && abhaNumber && candidate.abha.number !== abhaNumber) ||
          (candidate.abha?.address && abhaAddress && candidate.abha.address !== abhaAddress);
        if (conflictingAbha) {
          return res.json({
            success: false,
            summary: 'Profile share requires manual reconciliation because the mobile belongs to a different ABHA-linked patient.',
            outbound: [{
              action: 'ACK_PROFILE_SHARE',
              body: {
                error: { code: 'ABDM-1010', message: 'Patient identity could not be reconciled safely at HIP' },
                response: { requestId }
              }
            }]
          });
        }
        patient = candidate;
      } else if (phoneMatches.length > 1) {
        return res.json({
          success: false,
          summary: 'Multiple local patients share the verified mobile number.',
          outbound: [{
            action: 'ACK_PROFILE_SHARE',
            body: {
              error: { code: 'ABDM-1010', message: 'Multiple patient matches require manual reconciliation' },
              response: { requestId }
            }
          }]
        });
      }
    }

    if (!patient) {
      const dob = parseDob(shared);
      if (!phone || phone.length !== 10 || !dob || (!abhaNumber && !abhaAddress)) {
        return res.json({
          success: false,
          summary: 'Profile received but patient could not be created because verified ABHA, phone or DOB data was incomplete.',
          outbound: [{
            action: 'ACK_PROFILE_SHARE',
            body: {
              error: { code: 'ABDM-1010', message: 'Patient profile did not contain enough verified data to register patient' },
              response: { requestId }
            }
          }]
        });
      }
      patient = new Patient({
        ...splitName(shared.name),
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
            firstName: splitName(shared.name).first_name,
            lastName: splitName(shared.name).last_name,
            dob: dob.toISOString().slice(0, 10),
            gender: shared.gender,
            mobileMasked: shared.phoneNumber,
            districtName: shared.address?.district,
            stateName: shared.address?.state,
            pinCode: shared.address?.pincode
          }
        }
      });
      await patient.save();
    } else {
      patient.abha = patient.abha || {};
      if (abhaNumber) patient.abha.number = abhaNumber;
      if (abhaAddress) patient.abha.address = abhaAddress;
      patient.abha.status = 'VERIFIED';
      patient.abha.kycVerified = true;
      patient.abha.registrationMode = 'profile_share';
      patient.abha.verificationMethod = 'ABDM_PROFILE_SHARE';
      patient.abha.verifiedAt = new Date();
      await patient.save();
    }

    const context = String(payload.metaData?.context || 'GENERAL');
    const tokenNumber = await nextToken(context);
    return res.json({
      success: true,
      summary: { patientId: patient._id, tokenNumber, context },
      outbound: [{
        action: 'ACK_PROFILE_SHARE',
        body: {
          acknowledgement: {
            abhaAddress: abhaAddress || patient.abha?.address,
            status: 'SUCCESS',
            profile: { context, tokenNumber: String(tokenNumber), expiry: '180' }
          },
          response: { requestId }
        }
      }]
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.discover = async (req, res) => {
  try {
    const payload = req.body?.body || {};
    const patientRequest = payload.patient || {};
    const requestId = requestIdFromEnvelope(req);
    const verifiedMobile = (patientRequest.verifiedIdentifiers || []).find((item) => item.type === 'MOBILE')?.value;
    const cleanMobile = unmaskDigits(verifiedMobile);

    let patient = null;
    if (patientRequest.id) {
      patient = await Patient.findOne({ 'abha.address': String(patientRequest.id).toLowerCase() });
    } else if (cleanMobile?.length === 10) {
      const matches = await Patient.find({ phone: cleanMobile }).limit(2);
      if (matches.length === 1) patient = matches[0];
      if (matches.length > 1) {
        return res.json({
          success: true,
          summary: 'Ambiguous patient match',
          outbound: [{
            action: 'RESPOND_DISCOVERY',
            body: {
              transactionId: payload.transactionId,
              error: { code: 'ABDM-1010', message: 'Multiple patients match the verified identifier' },
              response: { requestId }
            }
          }]
        });
      }
    }

    if (!patient) {
      return res.json({
        success: true,
        summary: 'No matching patient',
        outbound: [{
          action: 'RESPOND_DISCOVERY',
          body: {
            transactionId: payload.transactionId,
            error: { code: 'ABDM-1010', message: 'Patient not found' },
            response: { requestId }
          }
        }]
      });
    }

    await buildPatientCareContexts(patient._id);
    const { patientGroups } = await groupedForAbdm(patient._id);
    return res.json({
      success: true,
      summary: { patientId: patient._id, careContextGroups: patientGroups.length },
      outbound: [{
        action: 'RESPOND_DISCOVERY',
        body: { transactionId: payload.transactionId, patient: patientGroups, response: { requestId } }
      }]
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

function collectReferenceCandidates(value, bucket = new Set()) {
  if (!value) return bucket;
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferenceCandidates(item, bucket));
    return bucket;
  }
  if (typeof value !== 'object') return bucket;
  for (const [key, item] of Object.entries(value)) {
    if (
      ['referenceNumber', 'patientReference', 'careContextReference', 'careContextReferenceNumber'].includes(key) &&
      typeof item === 'string'
    ) {
      bucket.add(item);
    }
    collectReferenceCandidates(item, bucket);
  }
  return bucket;
}

exports.linkInit = async (req, res) => {
  try {
    const payload = req.body?.body || {};
    const requestId = requestIdFromEnvelope(req);
    const candidates = Array.from(collectReferenceCandidates(payload));
    const context = candidates.length
      ? await AbdmCareContext.findOne({
          $or: [
            { referenceNumber: { $in: candidates } },
            { patientReference: { $in: candidates } }
          ]
        })
      : null;

    if (!context) {
      return res.json({
        success: true,
        summary: { linkInitiated: false, reason: 'No matching care context' },
        outbound: [
          {
            action: 'RESPOND_LINK_INIT',
            body: {
              transactionId: payload.transactionId,
              error: { code: 'ABDM-1010', message: 'Patient or care context not found' },
              response: { requestId }
            }
          }
        ]
      });
    }

    const patient = await Patient.findById(context.patientId);
    if (!patient?.phone) {
      return res.json({
        success: true,
        summary: { linkInitiated: false, reason: 'Patient mobile unavailable' },
        outbound: [
          {
            action: 'RESPOND_LINK_INIT',
            body: {
              transactionId: payload.transactionId,
              error: { code: 'ABDM-1010', message: 'Patient mobile number is not available at HIP' },
              response: { requestId }
            }
          }
        ]
      });
    }

    const allActiveContexts = await AbdmCareContext.find({
      patientId: patient._id,
      active: { $ne: false }
    }).select('referenceNumber patientReference hiType');
    const explicitlySelected = allActiveContexts.filter((item) => candidates.includes(item.referenceNumber));
    const patientReferenceSelected = candidates.includes(context.patientReference);
    const related = explicitlySelected.length
      ? explicitlySelected
      : patientReferenceSelected
      ? allActiveContexts
      : [context];
    const linkRefNumber = crypto.randomUUID();
    const otp = createOtp();
    const { salt, hash } = hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await AbdmLinkAuthentication.create({
      linkRefNumber,
      transactionId: payload.transactionId,
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
        facilityId: process.env.ABDM_FACILITY_ID,
        patientReference: context.patientReference,
        linkRefNumber
      });
    } catch (smsError) {
      await AbdmLinkAuthentication.updateOne(
        { linkRefNumber },
        { status: 'FAILED', metadata: { requestId, smsError: smsError.message } }
      );
      return res.json({
        success: true,
        summary: { linkInitiated: false, reason: smsError.message },
        outbound: [
          {
            action: 'RESPOND_LINK_INIT',
            body: {
              transactionId: payload.transactionId,
              error: { code: 'ABDM-9999', message: 'Unable to deliver linking OTP' },
              response: { requestId }
            }
          }
        ]
      });
    }

    res.json({
      success: true,
      summary: { linkRefNumber, expiresAt },
      outbound: [
        {
          action: 'RESPOND_LINK_INIT',
          body: {
            transactionId: payload.transactionId,
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
    res.status(500).json({ error: error.message });
  }
};

exports.linkConfirm = async (req, res) => {
  try {
    const payload = req.body?.body || {};
    const requestId = requestIdFromEnvelope(req);
    const confirmation = payload.confirmation || {};
    const linkRefNumber = confirmation.linkRefNumber || payload.linkRefNumber;
    const token = String(confirmation.token ?? payload.token ?? '');

    const auth = await AbdmLinkAuthentication.findOne({ linkRefNumber }).select('+otpHash +otpSalt');
    if (!auth) {
      return res.json({
        success: true,
        summary: { confirmed: false },
        outbound: [
          {
            action: 'RESPOND_LINK_CONFIRM',
            body: {
              error: { code: 'ABDM-9999', message: 'Invalid link reference number' },
              response: { requestId }
            }
          }
        ]
      });
    }

    if (auth.status !== 'PENDING' || auth.expiresAt.getTime() < Date.now()) {
      auth.status = auth.expiresAt.getTime() < Date.now() ? 'EXPIRED' : auth.status;
      await auth.save();
      return res.json({
        success: true,
        summary: { confirmed: false, status: auth.status },
        outbound: [
          {
            action: 'RESPOND_LINK_CONFIRM',
            body: {
              error: { code: 'ABDM-9999', message: 'Link authentication is expired or no longer active' },
              response: { requestId }
            }
          }
        ]
      });
    }

    const isValid = verifyOtp(token, auth.otpSalt, auth.otpHash);
    auth.attempts += 1;
    if (!isValid) {
      if (auth.attempts >= auth.maxAttempts) auth.status = 'LOCKED';
      await auth.save();
      return res.json({
        success: true,
        summary: { confirmed: false, attempts: auth.attempts },
        outbound: [
          {
            action: 'RESPOND_LINK_CONFIRM',
            body: {
              error: { code: 'ABDM-9999', message: 'Invalid OTP' },
              response: { requestId }
            }
          }
        ]
      });
    }

    auth.status = 'VERIFIED';
    auth.verifiedAt = new Date();
    await auth.save();

    const { patientGroups: allPatientGroups } = await groupedForAbdm(auth.patientId);
    const selectedReferences = new Set((auth.careContextReferences || []).map(String));
    const patientGroups = allPatientGroups
      .map((group) => ({
        ...group,
        careContexts: group.careContexts.filter((item) => selectedReferences.has(String(item.referenceNumber)))
      }))
      .filter((group) => group.careContexts.length)
      .map((group) => ({ ...group, count: group.careContexts.length }));
    await AbdmCareContext.updateMany(
      { patientId: auth.patientId, referenceNumber: { $in: auth.careContextReferences }, active: { $ne: false } },
      { linkStatus: 'ABDM_LINKED', linkedAt: new Date() }
    );

    res.json({
      success: true,
      summary: { confirmed: true, patientId: auth.patientId, careContextGroups: patientGroups.length },
      outbound: [
        {
          action: 'RESPOND_LINK_CONFIRM',
          body: {
            patient: patientGroups,
            response: { requestId }
          }
        }
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.linkToken = async (req, res) => {
  const payload = req.body?.body || {};
  const requestId = requestIdFromEnvelope(req);
  const linkToken = payload.linkToken || payload.token || payload.link?.token;
  const pending = await AbdmCareContext.find({ linkRequestId: payload.response?.requestId || requestId, linkStatus: 'ABDM_LINK_PENDING' });
  if (!linkToken || !pending.length) {
    return res.json({ success: true, summary: 'No pending care contexts found for link token callback', outbound: [] });
  }
  const patient = await Patient.findById(pending[0].patientId);
  const groups = new Map();
  for (const item of pending) {
    if (!groups.has(item.hiType)) groups.set(item.hiType, []);
    groups.get(item.hiType).push(item);
  }
  const patientGroups = Array.from(groups.entries()).map(([hiType, items]) => ({
    referenceNumber: items[0].patientReference,
    display: [patient.first_name, patient.last_name].filter(Boolean).join(' '),
    careContexts: items.map((item) => ({ referenceNumber: item.referenceNumber, display: item.display })),
    hiType: toAbdmHiType(hiType),
    count: items.length
  }));
  res.json({
    success: true,
    summary: { pending: pending.length },
    outbound: [
      {
        action: 'LINK_CARE_CONTEXT',
        linkToken,
        body: {
          abhaNumber: patient.abha?.number,
          abhaAddress: patient.abha?.address,
          patient: patientGroups
        }
      }
    ]
  });
};

exports.linkCareContext = async (req, res) => {
  const payload = req.body?.body || {};
  const requestId = payload.response?.requestId || requestIdFromEnvelope(req);
  const failed = Boolean(payload.error);
  await AbdmCareContext.updateMany(
    { linkRequestId: requestId, linkStatus: 'ABDM_LINK_PENDING' },
    {
      linkStatus: failed ? 'ABDM_LINK_FAILED' : 'ABDM_LINKED',
      linkedAt: failed ? undefined : new Date(),
      metadata: { callback: payload }
    }
  );
  res.json({ success: true, summary: { failed }, outbound: [] });
};

exports.careContextUpdate = async (req, res) => {
  res.json({ success: true, summary: { received: true }, outbound: [] });
};

exports.smsNotify = async (req, res) => {
  res.json({ success: true, summary: { received: true }, outbound: [] });
};

exports.consentNotify = async (req, res) => {
  const payload = req.body?.body || {};
  const requestId = requestIdFromEnvelope(req);
  const consentId = payload.notification?.consentId || payload.consentId || payload.consentDetail?.consentId;
  res.json({
    success: true,
    summary: { consentId },
    outbound: [
      {
        action: 'ACK_CONSENT',
        body: {
          acknowledgement: { status: 'OK', consentId },
          response: { requestId }
        }
      }
    ]
  });
};

function hiRequestError(requestId, code, message, transactionId) {
  return {
    success: true,
    summary: { transactionId, localBundlePrepared: false, reason: message },
    outbound: [{
      action: 'ACK_HEALTH_INFORMATION',
      body: { error: { code, message }, response: { requestId } }
    }]
  };
}

function contextWithinDateRange(context, dateRange = {}) {
  const from = dateRange?.from ? new Date(dateRange.from).getTime() : null;
  const to = dateRange?.to ? new Date(dateRange.to).getTime() : null;
  const contextFrom = context.dateFrom ? new Date(context.dateFrom).getTime() : null;
  const contextTo = context.dateTo ? new Date(context.dateTo).getTime() : contextFrom;
  if (from && contextTo && contextTo < from) return false;
  if (to && contextFrom && contextFrom > to) return false;
  return true;
}

exports.healthInformationRequest = async (req, res) => {
  try {
    const payload = req.body?.body || {};
    const consent = req.body?.consent || null;
    const requestId = requestIdFromEnvelope(req);
    const transactionId = payload.transactionId || payload.hiRequest?.transactionId || crypto.randomUUID();
    const consentId = payload.hiRequest?.consent?.id;

    if (!consent || !consentId || String(consent.consentId) !== String(consentId)) {
      return res.json(hiRequestError(requestId, 'ABDM-1001', 'A matching consent artifact was not found at HIP', transactionId));
    }
    if (consent.status !== 'GRANTED') {
      return res.json(hiRequestError(requestId, 'ABDM-1001', `Consent is ${consent.status || 'not granted'}`, transactionId));
    }
    if (consent.expiresAt && new Date(consent.expiresAt).getTime() <= Date.now()) {
      return res.json(hiRequestError(requestId, 'ABDM-1001', 'Consent has expired', transactionId));
    }

    const requestRefs = Array.isArray(payload.hiRequest?.careContextReference)
      ? payload.hiRequest.careContextReference
      : payload.hiRequest?.careContextReference
      ? [payload.hiRequest.careContextReference]
      : [];
    const consentRefs = Array.from(new Set((consent.careContextReferences || []).map(String)));
    const requestedRefs = Array.from(new Set((requestRefs.length ? requestRefs : consentRefs).map(String)));
    if (!requestedRefs.length || requestedRefs.some((ref) => !consentRefs.includes(ref))) {
      return res.json(hiRequestError(requestId, 'ABDM-1001', 'Requested care contexts are outside the granted consent', transactionId));
    }

    const contexts = await AbdmCareContext.find({
      referenceNumber: { $in: requestedRefs },
      active: { $ne: false },
      linkStatus: 'ABDM_LINKED'
    }).lean();
    if (contexts.length !== requestedRefs.length) {
      return res.json(hiRequestError(requestId, 'ABDM-1010', 'One or more consented care contexts were not found or linked at HIP', transactionId));
    }

    const patientIds = Array.from(new Set(contexts.map((item) => String(item.patientId))));
    if (patientIds.length !== 1) {
      return res.json(hiRequestError(requestId, 'ABDM-1001', 'Consent mapping is ambiguous at HIP', transactionId));
    }

    const allowedHiTypes = normalizeInternalHiTypes(consent.hiTypes || []);
    if (allowedHiTypes.length && contexts.some((context) => !allowedHiTypes.includes(context.hiType))) {
      return res.json(hiRequestError(requestId, 'ABDM-1001', 'Requested health information type is outside the granted consent', transactionId));
    }
    const grantedDateRange = consent.dateRange || {};
    if (contexts.some((context) => !contextWithinDateRange(context, grantedDateRange))) {
      return res.json(hiRequestError(requestId, 'ABDM-1001', 'Requested care context is outside the granted date range', transactionId));
    }

    const records = [];
    for (const context of contexts) {
      // Generate each care context independently so a bundle can never contain records
      // belonging to another consented or non-consented context.
      // eslint-disable-next-line no-await-in-loop
      const generated = await generateAbdmHiBundle(patientIds[0], {
        hiTypes: [context.hiType],
        recordReferences: context.records || [],
        careContextReference: context.referenceNumber,
        persist: false
      });
      const bundle = generated.bundles?.[context.hiType];
      if (!bundle) {
        return res.json(hiRequestError(requestId, 'ABDM-1010', `No FHIR data could be generated for ${context.referenceNumber}`, transactionId));
      }
      records.push({
        hiType: toAbdmHiType(context.hiType),
        careContextReference: context.referenceNumber,
        content: JSON.stringify(bundle)
      });
    }

    if (!payload.hiRequest?.dataPushUrl || !payload.hiRequest?.keyMaterial) {
      return res.json(hiRequestError(requestId, 'ABDM-1001', 'Health information request is missing dataPushUrl or keyMaterial', transactionId));
    }

    return res.json({
      success: true,
      summary: { transactionId, localBundlePrepared: true, recordCount: records.length },
      outbound: [{
        action: 'ACK_HEALTH_INFORMATION',
        body: {
          hiRequest: { transactionId, sessionStatus: 'ACKNOWLEDGED' },
          response: { requestId }
        }
      }],
      healthDataRequest: {
        consentId,
        transactionId,
        dataPushUrl: payload.hiRequest.dataPushUrl,
        peerKeyMaterial: payload.hiRequest.keyMaterial,
        records
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

exports.hiuPatientOnShare = async (req, res) => {
  res.json({ success: true, summary: { received: true }, outbound: [] });
};
