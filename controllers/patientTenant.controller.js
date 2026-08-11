const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const OfflineSyncLog = require('../models/OfflineSyncLog');
const IPDAdmission = require('../models/IPDAdmission');
const legacy = require('./patient.controller');
const { requireHospitalId } = require('../services/tenantScope.service');
const Appointment = require('../models/Appointment');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const Prescription = require('../models/Prescription');
const DischargeSummary = require('../models/DischargeSummary');
const NabhRecord = require('../models/NabhRecord');
const Doctor = require('../models/Doctor');
const Payer = require('../models/Payer');
const HospitalSequence = require('../models/HospitalSequence');
const {
  validateConfiguredRegistration,
  findDuplicateCandidates,
  requestMobileOtp,
  verifyMobileOtp,
  consumeMobileVerification,
  registrationConfig,
  normalizePhone,
  registerPatient,
  calculateRegistrationCompleteness
} = require('../services/patientRegistration.service');
const { getOrCreateNabhSetting } = require('../services/nabhSetting.service');
const { queueNotification } = require('../services/nabhNotification.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const { getPatientCoveragePreference } = require('../services/patientCoveragePreference.service');


async function nextShareRecordNumber(hospitalId) {
  const year = new Date().getFullYear();
  const sequence = await HospitalSequence.findOneAndUpdate(
    { hospitalId, key: `AAC_SHARE_${year}` },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `AAC-SHARE-${year}-${String(sequence.value).padStart(6, '0')}`;
}

function normalizeNabhPriority(value) {
  const normalized = String(value || 'routine').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'emergency') return 'critical';
  if (normalized === 'urgent' || normalized === 'high') return 'urgent';
  if (normalized === 'low') return 'low';
  return 'routine';
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(res, error, status = 500) {
  return res.status(error.statusCode || status).json({ error: error.message });
}

async function ensureOwned(req, res) {
  const hospitalId = requireHospitalId(req);
  const patient = await Patient.findOne({ _id: req.params.id, hospitalId });

  if (!patient) {
    res.status(404).json({ error: 'Patient not found' });
    return null;
  }

  return patient;
}

exports.uploadPatientImage = legacy.uploadPatientImage;
exports.searchPatientsForPharmacy = legacy.searchPatientsForPharmacy;
exports.createOrUpdateWalkinPatient = legacy.createOrUpdateWalkinPatient;
exports.getPatientPharmacyAccount = legacy.getPatientPharmacyAccount;
exports.updatePatientPharmacyBalance = legacy.updatePatientPharmacyBalance;

exports.getRegistrationPayers = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const payers = await Payer.find({
      hospitalId,
      isActive: true
    })
      .select('_id code name type networkStatus empanelment.status pricingPolicy tpaId isActive')
      .sort({ type: 1, name: 1 })
      .lean();

    return res.json({ success: true, data: payers });
  } catch (error) {
    return fail(res, error);
  }
};


exports.getCoveragePreference = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await getPatientCoveragePreference({ hospitalId, patientId: req.params.id });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};



exports.createPatient = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await registerPatient({
      hospitalId,
      input: req.body,
      userId: req.user?._id,
      defaultPatientType: 'opd'
    });

    if (result.created) {
      await appendDomainEvent({
        req,
        eventType: 'patient.registration.created',
        entityType: 'Patient',
        entityId: result.patient._id,
        hospitalId,
        patientId: result.patient._id,
        afterSummary: {
          uhid: result.patient.uhid,
          registrationStatus: result.patient.registrationStatus,
          registrationSource: result.patient.registrationSource?.channel
        },
        metadata: {
          duplicateScore: result.duplicateReview?.score || 0,
          duplicateOverride: result.duplicateReview?.status === 'override_approved'
        }
      });
    }

    return res.status(result.created ? 201 : 200).json({
      success: true,
      patient: result.patient,
      duplicateReview: result.duplicateReview,
      duplicate: Boolean(result.duplicateMatched),
      idempotent: Boolean(result.idempotent),
      synced: true
    });
  } catch (error) {
    return res.status(error.statusCode || (error.code === 11000 ? 409 : 400)).json({
      error: error.code || 'REGISTRATION_FAILED',
      message: error.message,
      ...(error.fields ? { fields: error.fields } : {}),
      ...(error.candidates ? { candidates: error.candidates } : {}),
      ...(error.overrideAllowed !== undefined ? { overrideAllowed: error.overrideAllowed } : {})
    });
  }
};

exports.bulkCreatePatients = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
    }
    if (req.body.length > 500) {
      return res.status(413).json({ error: 'Maximum 500 patients per offline sync batch' });
    }

    const successful = [];
    const failed = [];

    for (const row of req.body) {
      try {
        const result = await registerPatient({ // eslint-disable-line no-await-in-loop
          hospitalId,
          input: {
            ...row,
            localId: row.localId || row.tempPatientId,
            capturedOffline: true,
            offlineCapturedAt: row.offlineCapturedAt || row.registrationSource?.capturedAt
          },
          userId: req.user?._id,
          offlineReplay: true,
          defaultPatientType: 'opd'
        });

        successful.push({
          localId: row.localId || row.tempPatientId,
          serverId: result.patient._id,
          patientId: result.patient.patientId,
          uhid: result.patient.uhid,
          duplicate: Boolean(result.duplicateMatched),
          duplicateCandidates: result.candidates || []
        });

        if (result.created) {
          await appendDomainEvent({ // eslint-disable-line no-await-in-loop
            req,
            eventType: 'patient.registration.synced',
            entityType: 'Patient',
            entityId: result.patient._id,
            hospitalId,
            patientId: result.patient._id,
            afterSummary: {
              uhid: result.patient.uhid,
              registrationStatus: result.patient.registrationStatus
            },
            metadata: { localId: row.localId || row.tempPatientId }
          });
        }
      } catch (error) {
        const localId = row.localId || row.tempPatientId;
        const code = error.code || 'REGISTRATION_FAILED';
        const isConflict = [
          'DUPLICATE_PATIENT',
          'PROBABLE_DUPLICATE_PATIENT',
          'DUPLICATE_OVERRIDE_DISABLED'
        ].includes(code);

        if (localId) {
          await OfflineSyncLog.findOneAndUpdate( // eslint-disable-line no-await-in-loop
            { hospitalId, localId, entityType: 'PATIENT' },
            {
              $set: {
                hospitalId,
                localId,
                entityType: 'PATIENT',
                operationType: 'CREATE',
                data: row,
                status: isConflict ? 'CONFLICT' : 'FAILED',
                errorMessage: error.message
              },
              $inc: { retryCount: 1 }
            },
            { upsert: true, new: true }
          );
        }

        failed.push({
          localId,
          reason: error.message,
          code,
          conflict: isConflict,
          candidates: error.candidates || []
        });
      }
    }

    return res.status(201).json({
      message: 'Bulk patient sync completed',
      success: failed.length === 0,
      successfulCount: successful.length,
      failedCount: failed.length,
      successful,
      failed,
      summary: { total: req.body.length, synced: successful.length, failed: failed.length }
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.checkDuplicateByPhone = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const payload = {
      phone: req.query.phone,
      first_name: req.query.first_name,
      last_name: req.query.last_name,
      dob: req.query.dob,
      aadhaar_last4: req.query.aadhaar_last4,
      abha: { number: req.query.abha_number }
    };
    if (!payload.phone && !payload.first_name && !payload.abha.number && !payload.aadhaar_last4) {
      return res.status(400).json({
        error: 'At least one duplicate-search field is required'
      });
    }
    const candidates = await findDuplicateCandidates(hospitalId, payload);
    const topCandidate = candidates[0] || null;
    const matchedPatient = topCandidate
      ? await Patient.findOne({ _id: topCandidate.patientId, hospitalId }).lean()
      : null;
    return res.json({
      exists: candidates.some((candidate) => candidate.classification === 'exact'),
      probable: candidates.some((candidate) => candidate.classification === 'probable'),
      // Preserve the legacy response shape for existing admin/demo consumers.
      patient: matchedPatient,
      candidates
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getRegistrationConfig = async (req, res) => {
  try {
    const data = await registrationConfig(requireHospitalId(req), req.user?._id);
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error);
  }
};

exports.requestMobileOtp = async (req, res) => {
  try {
    const data = await requestMobileOtp({
      hospitalId: requireHospitalId(req),
      phone: req.body.phone,
      requestedBy: req.user?._id
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, error, 400);
  }
};

exports.verifyMobileOtp = async (req, res) => {
  try {
    const data = await verifyMobileOtp({
      hospitalId: requireHospitalId(req),
      verificationId: req.body.verificationId,
      phone: req.body.phone,
      otp: req.body.otp
    });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, 400);
  }
};

exports.getAllPatients = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const {
      page = 1,
      limit = 1000,
      search,
      gender,
      patient_type,
      sponsor_type,
      sortBy = 'registered_at',
      sortOrder = 'desc'
    } = req.query;
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeLimit = Math.min(2000, Math.max(1, Number.parseInt(limit, 10) || 1000));
    const allowedSortFields = new Set([
      'registered_at', 'createdAt', 'updatedAt', 'first_name', 'last_name',
      'patientId', 'uhid', 'dob', 'phone'
    ]);
    const safeSortBy = allowedSortFields.has(String(sortBy)) ? String(sortBy) : 'registered_at';

    const filter = { hospitalId };

    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { first_name: regex },
        { last_name: regex },
        { phone: regex },
        { patientId: regex },
        { uhid: regex },
        { 'abha.number': regex },
        { 'abha.address': regex }
      ];
    }

    if (gender) filter.gender = gender;
    if (patient_type) filter.patient_type = patient_type;
    if (sponsor_type) filter.sponsor_type = sponsor_type;

    const [patients, total] = await Promise.all([
      Patient.find(filter)
        .sort({ [safeSortBy]: sortOrder === 'asc' ? 1 : -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
      Patient.countDocuments(filter)
    ]);

    return res.json({
      patients,
      total,
      totalPages: Math.ceil(total / safeLimit),
      currentPage: safePage,
      pageSize: safeLimit
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getPatientById = async (req, res) => {
  try {
    const patient = await ensureOwned(req, res);
    if (patient) res.json(patient);
  } catch (error) {
    fail(res, error);
  }
};

exports.updatePatient = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const patient = await Patient.findOne({ _id: req.params.id, hospitalId });
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // Keep identifiers, tenant ownership, verification state and audit fields
    // server-controlled. This mirrors the fields exposed by the existing
    // update-profile screens while preventing arbitrary document replacement.
    const editableFields = [
      'salutation', 'first_name', 'middle_name', 'last_name', 'patient_image',
      'email', 'phone', 'dob', 'gender', 'blood_group', 'patient_type',
      'address', 'city', 'state', 'zipCode', 'village', 'district', 'tehsil',
      'emergency_contact', 'emergency_phone', 'medical_history', 'allergies',
      'medications', 'sponsor_type', 'sponsor_name', 'sponsor_policy_number',
      'sponsor_valid_until', 'insurance_provider_id',
      'insurance_coverage_percentage', 'paymentPreference', 'identityDocuments'
    ];
    const previousPhone = normalizePhone(patient.phone);
    for (const field of editableFields) {
      if (req.body[field] !== undefined) patient.set(field, req.body[field]);
    }

    const nextPhone = normalizePhone(patient.phone);
    if (nextPhone !== previousPhone) {
      patient.mobileVerification = { verified: false, phone: nextPhone };
      if (req.body.mobileVerification?.verificationId) {
        const verified = await verifyMobileOtp({
          hospitalId,
          verificationId: req.body.mobileVerification.verificationId,
          phone: patient.phone,
          otp: req.body.mobileVerification.otp
        });
        patient.mobileVerification = {
          verified: true,
          verifiedAt: verified.verifiedAt,
          verificationId: verified.verificationId,
          phone: verified.phone
        };
        await consumeMobileVerification({
          hospitalId,
          verificationId: verified.verificationId,
          phone: patient.phone
        });
      } else {
        const settings = await getOrCreateNabhSetting(hospitalId, req.user?._id);
        if (settings.patientRegistration?.requireMobileOtp) {
          return res.status(409).json({
            error: 'MOBILE_VERIFICATION_REQUIRED',
            message: 'The new mobile number must be verified before it can replace the registered number.'
          });
        }
      }
    }

    const settings = await getOrCreateNabhSetting(hospitalId, req.user?._id);
    patient.registrationCompleteness = calculateRegistrationCompleteness(patient, settings, 'OPD');
    if (patient.registrationStatus !== 'MERGED' && patient.registrationStatus !== 'INACTIVE') {
      patient.registrationStatus = settings.patientRegistration?.requireMobileOtp && !patient.mobileVerification?.verified
        ? 'PENDING_VERIFICATION'
        : 'REGISTERED';
    }
    patient.updated_at = new Date();
    await patient.save();

    await appendDomainEvent({
      req,
      eventType: 'patient.registration.updated',
      entityType: 'Patient',
      entityId: patient._id,
      hospitalId,
      patientId: patient._id,
      afterSummary: {
        uhid: patient.uhid,
        registrationStatus: patient.registrationStatus,
        completenessScore: patient.registrationCompleteness?.score
      }
    });

    return res.json(patient);
  } catch (error) {
    return fail(res, error, 400);
  }
};

exports.deletePatient = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const patientId = req.params.id;

    const patient = await Patient.findOne({
      _id: patientId,
      hospitalId
    }).select('_id');

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // Patient identity is a clinical master record. Once downstream clinical
    // or compliance records reference it, hard deletion would break record
    // integrity and longitudinal traceability.
    const [
      admission,
      appointment,
      labRequest,
      radiologyRequest,
      prescription,
      dischargeSummary,
      nabhRecord
    ] = await Promise.all([
      IPDAdmission.exists({ hospitalId, patientId }),
      Appointment.exists({ hospital_id: hospitalId, patient_id: patientId }),
      LabRequest.exists({ hospitalId, patientId }),
      RadiologyRequest.exists({ hospitalId, patientId }),
      Prescription.exists({ patient_id: patientId }),
      DischargeSummary.exists({ hospitalId, patientId }),
      NabhRecord.exists({ hospitalId, patientId })
    ]);

    const linkedRecordTypes = [];
    if (admission) linkedRecordTypes.push('admission');
    if (appointment) linkedRecordTypes.push('appointment');
    if (labRequest) linkedRecordTypes.push('laboratory request');
    if (radiologyRequest) linkedRecordTypes.push('radiology request');
    if (prescription) linkedRecordTypes.push('prescription');
    if (dischargeSummary) linkedRecordTypes.push('discharge summary');
    if (nabhRecord) linkedRecordTypes.push('NABH record');

    if (linkedRecordTypes.length) {
      return res.status(409).json({
        error: 'Patient has linked clinical records and cannot be deleted',
        code: 'PATIENT_HAS_LINKED_RECORDS',
        linkedRecordTypes
      });
    }

    await Patient.deleteOne({ _id: patientId, hospitalId });

    return res.json({ message: 'Patient deleted successfully' });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getPatientByPhone = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    return res.json({
      patient: await Patient.findOne({ hospitalId, phone: req.params.phone })
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getRecentPatients = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const patients = await Patient.find({ hospitalId })
      .sort({ registered_at: -1 })
      .limit(Number(req.query.limit || 10))
      .select('first_name last_name phone patientId uhid registered_at');

    return res.json({ patients });
  } catch (error) {
    return fail(res, error);
  }
};

exports.createOrUpdateWalkinPatient = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const result = await registerPatient({
      hospitalId,
      input: {
        ...req.body,
        // Walk-in describes today's service context, not the patient's identity.
        patient_type: req.body.patient_type === 'ipd' ? 'ipd' : 'opd',
        is_walkin: true,
        walkin_created_at: req.body.walkin_created_at || new Date(),
        registrationSource: {
          ...(req.body.registrationSource || {}),
          channel: req.body.registrationSource?.channel || 'internal'
        }
      },
      userId: req.user?._id,
      reuseExactMatch: true,
      defaultPatientType: 'opd'
    });

    await Patient.updateOne(
      { _id: result.patient._id, hospitalId },
      { $set: { last_pharmacy_visit: new Date() } }
    );
    const patient = await Patient.findOne({ _id: result.patient._id, hospitalId });

    if (result.created) {
      await appendDomainEvent({
        req,
        eventType: 'patient.registration.walkin_created',
        entityType: 'Patient',
        entityId: patient._id,
        hospitalId,
        patientId: patient._id,
        afterSummary: { uhid: patient.uhid, registrationStatus: patient.registrationStatus }
      });
    }

    return res.status(result.created ? 201 : 200).json({
      success: true,
      patient,
      duplicateMatched: Boolean(result.duplicateMatched),
      candidates: result.candidates || []
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({
      error: error.code || 'WALKIN_REGISTRATION_FAILED',
      message: error.message,
      ...(error.candidates ? { candidates: error.candidates } : {})
    });
  }
};

exports.searchPatientsForPharmacy = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const query = String(req.query.query || '').trim();

    if (query.length < 2) {
      return res.status(400).json({
        error: 'Search query must be at least 2 characters'
      });
    }

    const regex = new RegExp(escapeRegex(query), 'i');

    const patients = await Patient.find({
      hospitalId,
      $or: [
        { first_name: regex },
        { last_name: regex },
        { phone: regex },
        { uhid: regex },
        { patientId: regex },
        { 'active_admissions.ship_number': regex },
        { 'active_admissions.registration_number': regex }
      ]
    })
      .limit(Math.min(100, Number(req.query.limit || 20)))
      .lean();

    const ids = patients.map((patient) => patient._id);

    const admissions = await IPDAdmission.find({
      hospitalId,
      patientId: { $in: ids },
      status: { $nin: ['Discharged', 'Cancelled', 'LAMA', 'DAMA', 'Expired'] }
    })
      .populate('primaryDoctorId', 'firstName lastName')
      .populate('wardId roomId bedId')
      .lean();

    const byPatient = new Map(admissions.map((row) => [String(row.patientId), row]));

    return res.json(
      patients.map((patient) => ({
        ...patient,
        current_admission: byPatient.get(String(patient._id)) || null,
        has_active_admission: byPatient.has(String(patient._id)),
        full_name: [patient.first_name, patient.last_name].filter(Boolean).join(' ')
      }))
    );
  } catch (error) {
    return fail(res, error);
  }
};

exports.getPatientByTempId = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const log = await OfflineSyncLog.findOne({
      hospitalId,
      $or: [
        { tempPatientId: req.params.tempId },
        { localId: req.params.tempId }
      ],
      entityType: 'PATIENT',
      status: 'SYNCED'
    });

    const patient = log?.serverId
      ? await Patient.findOne({ _id: log.serverId, hospitalId })
      : null;

    return res.json({ patient });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getSyncStatus = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospitalId };

    const [stats, recentSyncs, pending, failed, conflict] = await Promise.all([
      OfflineSyncLog.aggregate([
        { $match: filter },
        {
          $group: {
            _id: { entity: '$entityType', status: '$status' },
            count: { $sum: 1 }
          }
        }
      ]),
      OfflineSyncLog.find({ ...filter, status: 'SYNCED' })
        .sort({ syncedAt: -1 })
        .limit(20),
      OfflineSyncLog.countDocuments({ ...filter, status: 'PENDING' }),
      OfflineSyncLog.countDocuments({ ...filter, status: 'FAILED' }),
      OfflineSyncLog.countDocuments({ ...filter, status: 'CONFLICT' })
    ]);

    return res.json({
      stats,
      recentSyncs,
      totalPending: pending,
      totalFailed: failed,
      totalConflict: conflict
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getLongitudinalRecord = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const patient = await Patient.findOne({ _id: req.params.id, hospitalId }).lean();
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const [
      appointments, admissions, laboratory, radiology,
      prescriptions, dischargeSummaries, complianceRecords
    ] = await Promise.all([
      Appointment.find({ hospital_id: hospitalId, patient_id: patient._id })
        .sort({ appointment_date: -1 }).lean(),
      IPDAdmission.find({ hospitalId, patientId: patient._id })
        .sort({ admissionDate: -1 }).lean(),
      LabRequest.find({ hospitalId, patientId: patient._id })
        .sort({ requestedDate: -1 }).lean(),
      RadiologyRequest.find({ hospitalId, patientId: patient._id })
        .sort({ requestedDate: -1 }).lean(),
      Prescription.find({
        $or: [
          { patient_id: patient._id },
          { patientId: patient._id }
        ]
      }).sort({ createdAt: -1 }).lean(),
      DischargeSummary.find({ hospitalId, patientId: patient._id })
        .sort({ createdAt: -1 }).lean(),
      NabhRecord.find({ hospitalId, patientId: patient._id })
        .sort({ createdAt: -1 }).lean()
    ]);

    return res.json({
      success: true,
      data: {
        patient,
        appointments,
        admissions,
        laboratory,
        radiology,
        prescriptions,
        dischargeSummaries,
        complianceRecords,
        generatedAt: new Date()
      }
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.sharePatientRecord = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const patient = await Patient.findOne({ _id: req.params.id, hospitalId });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    const facility = String(req.body.facility || '').trim();
    const purpose = String(req.body.purpose || '').trim();
    if (!facility || !purpose) {
      return res.status(400).json({ error: 'facility and purpose are required' });
    }
    let consent = patient.sharingConsents?.find((item) =>
      item.status === 'active'
      && item.facility === facility
      && item.purpose === purpose
      && (!item.expiresAt || item.expiresAt > new Date())
    );
    if (!consent && req.body.consent?.granted !== true) {
      return res.status(409).json({
        error: 'SHARING_CONSENT_REQUIRED',
        message: 'Explicit active patient consent is required before inter-facility sharing'
      });
    }
    const requestedDataCategories = Array.isArray(req.body.dataCategories)
      ? [...new Set(req.body.dataCategories.map((item) => String(item).trim()).filter(Boolean))]
      : [];
    if (!requestedDataCategories.length) {
      return res.status(400).json({
        error: 'INVALID_SHARING_CONSENT',
        message: 'At least one data category is required for sharing'
      });
    }
    if (!consent && req.body.consent?.granted === true) {
      const expiresAt = req.body.consent.expiresAt
        ? new Date(req.body.consent.expiresAt)
        : undefined;
      if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) {
        return res.status(400).json({
          error: 'INVALID_SHARING_CONSENT',
          message: 'Consent expiry must be a valid future date'
        });
      }
      patient.sharingConsents.push({
        purpose,
        facility,
        dataCategories: requestedDataCategories,
        expiresAt,
        reference: String(req.body.consent.reference || '').trim() || undefined,
        capturedBy: req.user?._id
      });
      consent = patient.sharingConsents[patient.sharingConsents.length - 1];
      await patient.save();
    }
    const allowedCategories = new Set((consent?.dataCategories || []).map(String));
    const disallowedCategories = requestedDataCategories.filter((item) => !allowedCategories.has(item));
    if (disallowedCategories.length) {
      return res.status(403).json({
        error: 'SHARING_OUTSIDE_CONSENT',
        message: `Data category is not covered by consent: ${disallowedCategories.join(', ')}`
      });
    }
    if (req.body.doctorId) {
      if (!mongoose.isValidObjectId(req.body.doctorId)
        || !await Doctor.exists({ _id: req.body.doctorId, hospitalId })) {
        return res.status(400).json({ error: 'doctorId was not found for this hospital' });
      }
    }

    const recordNumber = await nextShareRecordNumber(hospitalId);
    const normalizedPriority = normalizeNabhPriority(req.body.urgency);
    const record = await NabhRecord.create({
      hospitalId,
      recordNumber,
      testCaseIds: ['AAC.1.10.j', 'AAC.1.11.k'],
      domain: 'AAC',
      workflowType: 'referral_interfacility',
      title: `Patient record share to ${facility}`,
      description: req.body.reason || purpose,
      patientId: patient._id,
      doctorId: req.body.doctorId,
      priority: normalizedPriority,
      externalReference: req.body.externalReference,
      data: {
        facility,
        purpose,
        specialty: req.body.specialty,
        urgency: req.body.urgency || 'routine',
        dataCategories: requestedDataCategories,
        consentReference: req.body.consent?.reference || consent?.reference,
        deliveryContact: req.body.contact || {}
      },
      checklist: [
        { code: 'CONSENT', label: 'Confirm patient consent and permitted disclosure', status: 'done', completedAt: new Date(), completedBy: req.user?._id },
        { code: 'ATTACH', label: 'Attach relevant clinical records', status: 'done', completedAt: new Date(), completedBy: req.user?._id },
        { code: 'SEND', label: 'Securely send referral', status: 'pending' },
        { code: 'ACK', label: 'Capture recipient acknowledgement', status: 'pending' }
      ],
      timeline: [{ event: 'sharing_prepared', by: req.user?._id }],
      createdBy: req.user?._id,
      updatedBy: req.user?._id
    });

    const notification = await queueNotification({
      hospitalId,
      eventType: 'interfacility_referral',
      correlationId: String(record._id),
      recipientType: 'facility',
      recipientName: facility,
      contact: req.body.contact || {},
      requestedChannels: req.body.requestedChannels || ['portal', 'email'],
      subject: req.body.subject || `Clinical referral for ${patient.uhid || patient.patientId}`,
      body: req.body.message || `A consented clinical referral has been prepared for ${patient.uhid || patient.patientId}.`,
      payload: {
        recordId: record._id,
        patientReference: patient.uhid || patient.patientId,
        purpose,
        dataCategories: requestedDataCategories
      },
      priority: normalizedPriority === 'critical' ? 'critical' : normalizedPriority === 'urgent' ? 'high' : 'normal',
      requireAcknowledgement: true,
      createdBy: req.user?._id
    });

    record.data.notificationDeliveryId = notification._id;
    record.timeline.push({
      event: 'sharing_sent',
      notes: notification.status,
      data: { notificationId: notification._id },
      by: req.user?._id
    });
    const sendItem = record.checklist.find((item) => item.code === 'SEND');
    if (['sent', 'partially_sent'].includes(notification.status)) {
      sendItem.status = 'done';
      sendItem.completedAt = new Date();
      sendItem.completedBy = req.user?._id;
    }
    await record.save();

    return res.status(201).json({
      success: true,
      data: { record, notification }
    });
  } catch (error) {
    return fail(res, error, 400);
  }
};


exports.getPatientPharmacyAccount = async (req, res) => {
  const patient = await ensureOwned(req, res);
  if (patient) return legacy.getPatientPharmacyAccount(req, res);
};

exports.updatePatientPharmacyBalance = async (req, res) => {
  const patient = await ensureOwned(req, res);
  if (patient) return legacy.updatePatientPharmacyBalance(req, res);
};