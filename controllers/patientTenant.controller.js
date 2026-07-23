const Patient = require('../models/Patient');
const OfflineSyncLog = require('../models/OfflineSyncLog');
const IPDAdmission = require('../models/IPDAdmission');
const legacy = require('./patient.controller');
const { requireHospitalId } = require('../services/tenantScope.service');

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

exports.createPatient = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const existing = await Patient.findOne({ hospitalId, phone: req.body.phone });

    if (existing && !req.body.force_create) {
      return res.status(409).json({
        error: 'DUPLICATE_PATIENT',
        message: 'Patient with this phone number already exists',
        existingPatient: existing
      });
    }

    const patient = await Patient.create({ ...req.body, hospitalId });

    if (req.body.localId) {
      await OfflineSyncLog.create({
        hospitalId,
        localId: req.body.localId,
        entityType: 'PATIENT',
        operationType: 'CREATE',
        data: req.body,
        status: 'SYNCED',
        serverId: patient._id,
        syncedAt: new Date()
      });
    }

    return res.status(201).json({ success: true, patient, synced: true });
  } catch (error) {
    const statusCode = error.code === 11000 ? 409 : 400;
    return fail(res, error, statusCode);
  }
};

exports.bulkCreatePatients = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    if (!Array.isArray(req.body)) {
      return res.status(400).json({
        error: 'Invalid data format. Expected an array.'
      });
    }

    const successful = [];
    const failed = [];

    for (const row of req.body) {
      try {
        let patient = await Patient.findOne({ hospitalId, phone: row.phone });
        const duplicate = Boolean(patient);

        if (!patient) {
          const { localId, tempPatientId, isSynced, force_create, ...clean } = row;
          patient = await Patient.create({ ...clean, hospitalId });
        }

        successful.push({
          localId: row.localId || row.tempPatientId,
          serverId: patient._id,
          patientId: patient.patientId,
          uhid: patient.uhid,
          duplicate
        });

        if (row.localId) {
          await OfflineSyncLog.findOneAndUpdate(
            {
              hospitalId,
              localId: row.localId,
              entityType: 'PATIENT'
            },
            {
              hospitalId,
              localId: row.localId,
              entityType: 'PATIENT',
              operationType: 'CREATE',
              data: row,
              status: 'SYNCED',
              serverId: patient._id,
              syncedAt: new Date()
            },
            { upsert: true }
          );
        }
      } catch (error) {
        failed.push({
          localId: row.localId,
          reason: error.message
        });
      }
    }

    return res.status(201).json({
      message: 'Bulk patient sync completed',
      successfulCount: successful.length,
      failedCount: failed.length,
      successful,
      failed
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.checkDuplicateByPhone = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const { phone } = req.query;

    if (!phone) {
      return res.status(400).json({
        error: 'Phone number is required'
      });
    }

    const patient = await Patient.findOne({ hospitalId, phone });

    return res.json({
      exists: Boolean(patient),
      patient: patient || null
    });
  } catch (error) {
    return fail(res, error);
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
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      Patient.countDocuments(filter)
    ]);

    return res.json({
      patients,
      total,
      totalPages: Math.ceil(total / Number(limit)),
      currentPage: Number(page)
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

    const patient = await Patient.findOneAndUpdate(
      { _id: req.params.id, hospitalId },
      { ...req.body, hospitalId, updated_at: new Date() },
      { new: true, runValidators: true }
    );

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    return res.json(patient);
  } catch (error) {
    return fail(res, error, 400);
  }
};

exports.deletePatient = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const active = await IPDAdmission.exists({
      hospitalId,
      patientId: req.params.id,
      status: { $nin: ['Discharged', 'Cancelled', 'LAMA', 'DAMA', 'Expired'] }
    });

    if (active) {
      return res.status(409).json({
        error: 'Patient has an active admission and cannot be deleted'
      });
    }

    const patient = await Patient.findOneAndDelete({
      _id: req.params.id,
      hospitalId
    });

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

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
    const phone = req.body.phone;

    let patient = phone
      ? await Patient.findOne({ hospitalId, phone })
      : null;

    if (patient) {
      Object.assign(patient, {
        ...req.body,
        hospitalId,
        is_walkin: true,
        patient_type: 'walkin',
        last_pharmacy_visit: new Date()
      });
    } else {
      patient = new Patient({
        ...req.body,
        hospitalId,
        is_walkin: true,
        patient_type: 'walkin',
        walkin_created_at: new Date(),
        last_pharmacy_visit: new Date()
      });
    }

    await patient.save();

    return res.status(patient.isNew ? 201 : 200).json({
      success: true,
      patient
    });
  } catch (error) {
    return fail(res, error, 400);
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

exports.getPatientPharmacyAccount = async (req, res) => {
  const patient = await ensureOwned(req, res);
  if (patient) return legacy.getPatientPharmacyAccount(req, res);
};

exports.updatePatientPharmacyBalance = async (req, res) => {
  const patient = await ensureOwned(req, res);
  if (patient) return legacy.updatePatientPharmacyBalance(req, res);
};