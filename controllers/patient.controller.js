const Patient = require('../models/Patient');
const OfflineSyncLog = require('../models/OfflineSyncLog');
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

// ========== IMAGE UPLOAD ==========
exports.uploadPatientImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'patients',
      resource_type: 'image'
    });
    fs.unlinkSync(req.file.path);
    res.json({ imageUrl: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== ENHANCED PATIENT SEARCH FOR PHARMACY POS ==========
exports.searchPatientsForPharmacy = async (req, res) => {
  try {
    const {
      query,
      searchType = 'all',
      includeWalkins = true,
      includeActiveIPD = true,
      limit = 20
    } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const searchRegex = new RegExp(query, 'i');
    const conditions = [];

    // Search by different fields based on searchType
    if (searchType === 'all' || searchType === 'name') {
      conditions.push(
        { first_name: searchRegex },
        { last_name: searchRegex },
        {
          $expr: {
            $regexMatch: {
              input: { $concat: ['$first_name', ' ', { $ifNull: ['$last_name', ''] }] },
              regex: query,
              options: 'i'
            }
          }
        }
      );
    }

    if (searchType === 'all' || searchType === 'phone') {
      conditions.push({ phone: searchRegex });
    }

    if (searchType === 'all' || searchType === 'uhid') {
      conditions.push({ uhid: searchRegex });
    }

    if (searchType === 'all' || searchType === 'patientId') {
      conditions.push({ patientId: searchRegex });
    }

    if (searchType === 'all' || searchType === 'ship') {
      conditions.push({ 'active_admissions.ship_number': searchRegex });
    }

    if (searchType === 'all' || searchType === 'registration') {
      conditions.push({ 'active_admissions.registration_number': searchRegex });
    }

    // ========== FIX: Define all active admission statuses ==========
    const activeStatuses = [
      'Admitted',
      'Under Treatment',
      'Discharge Initiated',
      'Discharge Summary Pending',
      'Billing Pending',
      'Payment Pending',
      'Ready for Discharge'
    ];

    const pipeline = [
      {
        $match: {
          $or: conditions,
          ...(!includeWalkins ? { is_walkin: false } : {})
        }
      },
      {
        $lookup: {
          from: 'ipdadmissions',
          let: { patientId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$patientId', '$$patientId'] },
                    { $in: ['$status', activeStatuses] }  // <-- FIX: Use all active statuses
                  ]
                }
              }
            },
            {
              $project: {
                admissionNumber: 1,
                primaryDoctorId: 1,
                wardId: 1,
                bedId: 1,
                roomId: 1,
                status: 1,
                shipNumber: 1  // <-- FIX: Include shipNumber
              }
            },
            {
              $lookup: {
                from: 'doctors',
                localField: 'primaryDoctorId',
                foreignField: '_id',
                as: 'doctor'
              }
            },
            {
              $lookup: {
                from: 'wards',
                localField: 'wardId',
                foreignField: '_id',
                as: 'ward'
              }
            },
            {
              $lookup: {
                from: 'beds',
                localField: 'bedId',
                foreignField: '_id',
                as: 'bed'
              }
            },
            {
              $addFields: {
                doctor_name: { $arrayElemAt: ['$doctor.name', 0] },
                ward_name: { $arrayElemAt: ['$ward.name', 0] },
                bed_number: { $arrayElemAt: ['$bed.bedNumber', 0] },
                ship_number: '$shipNumber'  // <-- FIX: Use shipNumber field
              }
            }
          ],
          as: 'activeAdmissions'
        }
      },
      {
        $addFields: {
          pharmacy_account_summary: {
            outstanding: { $ifNull: ['$pharmacy_outstanding_balance', 0] },
            advance: { $ifNull: ['$pharmacy_advance_balance', 0] }
          },
          current_admission: { $arrayElemAt: ['$activeAdmissions', 0] },
          has_active_admission: { $gt: [{ $size: '$activeAdmissions' }, 0] }
        }
      },
      {
        $project: {
          _id: 1,
          uhid: 1,
          patientId: 1,
          first_name: 1,
          middle_name: 1,
          last_name: 1,
          full_name: { $concat: ['$first_name', ' ', { $ifNull: ['$last_name', ''] }] },
          salutation: 1,
          phone: 1,
          gender: 1,
          age: 1,
          dob: 1,
          sponsor_type: 1,
          sponsor_name: 1,
          patient_type: 1,
          is_walkin: 1,
          pharmacy_outstanding_balance: 1,
          pharmacy_advance_balance: 1,
          pharmacy_account_summary: 1,
          current_admission: {
            _id: 1,
            admissionNumber: 1,
            ship_number: '$current_admission.ship_number',
            doctor_name: 1,
            ward_name: 1,
            bed_number: 1,
            status: 1
          },
          has_active_admission: 1,
          patient_image: 1,
          registered_at: 1,
          last_pharmacy_visit: 1
        }
      }
    ];

    const patients = await Patient.aggregate(pipeline).limit(parseInt(limit));

    // Enhance with SHIP number from active admissions
    const enhancedPatients = patients.map(patient => ({
      ...patient,
      ship_number: patient.current_admission?.ship_number || null,
      doctor_name: patient.current_admission?.doctor_name || null,
      ward_bed: patient.current_admission?.ward_name && patient.current_admission?.bed_number
        ? `${patient.current_admission.ward_name} - ${patient.current_admission.bed_number}`
        : null
    }));

    res.json({
      success: true,
      patients: enhancedPatients,
      count: enhancedPatients.length,
      searchParams: { query, searchType, includeWalkins, includeActiveIPD }
    });
  } catch (err) {
    console.error('Patient search error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== GET PATIENT PHARMACY ACCOUNT SUMMARY ==========
exports.getPatientPharmacyAccount = async (req, res) => {
  try {
    const { id } = req.params;

    const patient = await Patient.findById(id)
      .select('first_name last_name uhid patientId phone pharmacy_outstanding_balance pharmacy_advance_balance sponsor_type sponsor_name patient_type is_walkin');

    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // Get active admission details if any
    const activeAdmission = await mongoose.model('IPDAdmission').findOne({
      patientId: patient._id,
      status: { $in: ['Admitted', 'Under Treatment'] }
    }).populate('primaryDoctorId', 'name')
      .populate('wardId', 'name')
      .lean();

    res.json({
      success: true,
      patient: {
        _id: patient._id,
        name: `${patient.first_name} ${patient.last_name || ''}`.trim(),
        uhid: patient.uhid,
        patientId: patient.patientId,
        phone: patient.phone,
        pharmacy_outstanding: patient.pharmacy_outstanding_balance || 0,
        pharmacy_advance: patient.pharmacy_advance_balance || 0,
        sponsor_type: patient.sponsor_type,
        sponsor_name: patient.sponsor_name,
        patient_type: patient.patient_type,
        is_walkin: patient.is_walkin,
        active_admission: activeAdmission ? {
          admissionId: activeAdmission._id,
          ship_number: activeAdmission.admissionNumber,
          doctor_name: activeAdmission.primaryDoctorId?.name,
          ward_name: activeAdmission.wardId?.name,
          status: activeAdmission.status
        } : null
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== UPDATE PATIENT PHARMACY BALANCE ==========
exports.updatePatientPharmacyBalance = async (req, res) => {
  try {
    const { id } = req.params;
    const { outstanding_delta, advance_delta, transaction_type, reference_id } = req.body;

    const patient = await Patient.findById(id);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const updateFields = {};
    if (outstanding_delta !== undefined) {
      updateFields.$inc = { pharmacy_outstanding_balance: outstanding_delta };
    }
    if (advance_delta !== undefined) {
      updateFields.$inc = { ...(updateFields.$inc || {}), pharmacy_advance_balance: advance_delta };
    }
    updateFields.last_pharmacy_transaction = new Date();

    const updatedPatient = await Patient.findByIdAndUpdate(id, updateFields, { new: true });

    // Log the balance change for audit
    await mongoose.model('PharmacyAuditLog').create({
      user_id: req.user?._id,
      patient_id: id,
      action: 'BALANCE_UPDATE',
      details: {
        outstanding_delta,
        advance_delta,
        transaction_type,
        reference_id,
        before: {
          outstanding: patient.pharmacy_outstanding_balance,
          advance: patient.pharmacy_advance_balance
        },
        after: {
          outstanding: updatedPatient.pharmacy_outstanding_balance,
          advance: updatedPatient.pharmacy_advance_balance
        }
      },
      timestamp: new Date()
    });

    res.json({
      success: true,
      patient: {
        _id: updatedPatient._id,
        pharmacy_outstanding: updatedPatient.pharmacy_outstanding_balance,
        pharmacy_advance: updatedPatient.pharmacy_advance_balance
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== CREATE OR UPDATE WALK-IN PATIENT ==========
exports.createOrUpdateWalkinPatient = async (req, res) => {
  try {
    const { phone, name, first_name, last_name, ...otherData } = req.body;

    // Parse name if provided as single field
    let firstName = first_name;
    let lastName = last_name;

    if (name && !firstName) {
      const nameParts = name.trim().split(/\s+/);
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(' ') || '';
    }

    // Check if walkin patient already exists with this phone
    let walkinPatient = await Patient.findOne({
      phone: phone,
      is_walkin: true
    });

    if (walkinPatient) {
      // Update last visit
      walkinPatient.last_pharmacy_visit = new Date();
      walkinPatient.first_name = firstName || walkinPatient.first_name;
      walkinPatient.last_name = lastName || walkinPatient.last_name;
      await walkinPatient.save();

      return res.json({
        success: true,
        isNew: false,
        patient: {
          _id: walkinPatient._id,
          name: `${walkinPatient.first_name} ${walkinPatient.last_name || ''}`.trim(),
          phone: walkinPatient.phone,
          uhid: walkinPatient.uhid,
          is_walkin: true,
          pharmacy_outstanding: walkinPatient.pharmacy_outstanding_balance,
          pharmacy_advance: walkinPatient.pharmacy_advance_balance
        }
      });
    }

    // Create new walkin patient
    walkinPatient = new Patient({
      first_name: firstName || 'Walkin',
      last_name: lastName || 'Patient',
      phone: phone || `W${Date.now()}`,
      gender: otherData.gender || 'other',
      dob: otherData.dob || new Date('1970-01-01'),
      is_walkin: true,
      walkin_created_at: new Date(),
      last_pharmacy_visit: new Date(),
      patient_type: 'walkin',
      ...otherData
    });

    await walkinPatient.save();

    res.status(201).json({
      success: true,
      isNew: true,
      patient: {
        _id: walkinPatient._id,
        name: `${walkinPatient.first_name} ${walkinPatient.last_name}`.trim(),
        phone: walkinPatient.phone,
        uhid: walkinPatient.uhid,
        is_walkin: true,
        pharmacy_outstanding: 0,
        pharmacy_advance: 0
      }
    });
  } catch (err) {
    console.error('Walkin patient creation error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== CREATE SINGLE PATIENT ==========
exports.createPatient = async (req, res) => {
  try {
    const existingPatient = await Patient.findOne({ phone: req.body.phone });
    if (existingPatient && !req.body.force_create) {
      return res.status(409).json({
        error: 'DUPLICATE_PATIENT',
        message: 'Patient with this phone number already exists',
        existingPatient: {
          _id: existingPatient._id,
          patientId: existingPatient.patientId,
          first_name: existingPatient.first_name,
          last_name: existingPatient.last_name,
          phone: existingPatient.phone
        }
      });
    }

    const patient = new Patient(req.body);
    await patient.save();

    if (req.body.localId) {
      const OfflineSyncLog = require('../models/OfflineSyncLog');
      await OfflineSyncLog.create({
        localId: req.body.localId,
        entityType: 'PATIENT',
        operationType: 'CREATE',
        data: req.body,
        status: 'SYNCED',
        serverId: patient._id,
        syncedAt: new Date()
      });
    }

    res.status(201).json({ success: true, patient, synced: true });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'DUPLICATE_PATIENT',
        message: 'Patient with this phone or Aadhaar already exists'
      });
    }
    res.status(400).json({ error: err.message });
  }
};

// ========== BULK CREATE PATIENTS (FOR OFFLINE SYNC) ==========
exports.bulkCreatePatients = async (req, res) => {
  const patientsData = req.body;
  console.log('📦 Received bulk patient data:', patientsData.length, 'patients');

  if (!patientsData || !Array.isArray(patientsData)) {
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  }

  const successfulImports = [];
  const failedImports = [];
  const syncLogs = [];

  for (const patientData of patientsData) {
    try {
      const existingPatient = await Patient.findOne({ phone: patientData.phone });

      if (existingPatient) {
        console.log(`🔄 Duplicate patient found for phone: ${patientData.phone}, treating as success`);
        successfulImports.push({
          localId: patientData.localId,
          serverId: existingPatient._id,
          patientId: existingPatient.patientId,
          uhid: existingPatient.uhid,
          duplicate: true,
          message: 'Patient already exists, synced successfully'
        });

        if (patientData.localId) {
          syncLogs.push({
            localId: patientData.localId,
            entityType: 'PATIENT',
            operationType: 'CREATE',
            data: patientData,
            status: 'SYNCED',
            serverId: existingPatient._id,
            syncedAt: new Date(),
            isDuplicate: true
          });
        }
        continue;
      }

      const { localId, isSynced, tempPatientId, force_create, ...cleanData } = patientData;

      const patient = new Patient(cleanData);
      await patient.save();

      console.log(`✅ New patient saved: ${patient.first_name} ${patient.last_name} (${patient.patientId})`);

      successfulImports.push({
        localId: localId || tempPatientId,
        serverId: patient._id,
        patientId: patient.patientId,
        uhid: patient.uhid,
        duplicate: false,
        message: 'New patient created'
      });

      if (localId) {
        syncLogs.push({
          localId: localId,
          entityType: 'PATIENT',
          operationType: 'CREATE',
          data: patientData,
          status: 'SYNCED',
          serverId: patient._id,
          syncedAt: new Date()
        });
      }

    } catch (err) {
      console.error(`❌ Failed to sync patient: ${err.message}`);
      failedImports.push({
        localId: patientData.localId,
        reason: err.message,
        patientData: {
          name: `${patientData.first_name} ${patientData.last_name}`,
          phone: patientData.phone
        }
      });
    }
  }

  if (syncLogs.length > 0) {
    const OfflineSyncLog = require('../models/OfflineSyncLog');
    await OfflineSyncLog.insertMany(syncLogs);
  }

  console.log(`📊 Bulk sync completed: ${successfulImports.length} successful, ${failedImports.length} failed`);

  res.status(201).json({
    message: 'Bulk patient sync completed',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    successful: successfulImports,
    failed: failedImports
  });
};

// ========== CHECK DUPLICATE BY PHONE (FOR OFFLINE PRE-CHECK) ==========
exports.checkDuplicateByPhone = async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const existingPatient = await Patient.findOne({ phone: phone });

    if (existingPatient) {
      return res.json({
        exists: true,
        patient: {
          _id: existingPatient._id,
          patientId: existingPatient.patientId,
          uhid: existingPatient.uhid,
          first_name: existingPatient.first_name,
          last_name: existingPatient.last_name,
          salutation: existingPatient.salutation,
          phone: existingPatient.phone,
          email: existingPatient.email,
          address: existingPatient.address,
          gender: existingPatient.gender,
          dob: existingPatient.dob
        }
      });
    }

    res.json({ exists: false, patient: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== GET PATIENT BY TEMP ID ==========
exports.getPatientByTempId = async (req, res) => {
  try {
    const { tempId } = req.params;

    const queueItem = await OfflineSyncLog.findOne({
      tempPatientId: tempId,
      entityType: 'PATIENT',
      status: 'SYNCED'
    });

    if (queueItem && queueItem.serverId) {
      const patient = await Patient.findById(queueItem.serverId);
      if (patient) {
        return res.json({ patient });
      }
    }

    const syncLog = await OfflineSyncLog.findOne({
      localId: tempId,
      entityType: 'PATIENT',
      status: 'SYNCED'
    });

    if (syncLog && syncLog.serverId) {
      const patient = await Patient.findById(syncLog.serverId);
      if (patient) {
        return res.json({ patient });
      }
    }

    res.json({ patient: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== GET SYNC STATUS (FOR ADMIN) ==========
exports.getSyncStatus = async (req, res) => {
  try {
    const stats = await OfflineSyncLog.aggregate([
      {
        $group: {
          _id: { entity: '$entityType', status: '$status' },
          count: { $sum: 1 }
        }
      }
    ]);

    const recentSyncs = await OfflineSyncLog.find({ status: 'SYNCED' })
      .sort({ syncedAt: -1 })
      .limit(20);

    const pendingCount = await OfflineSyncLog.countDocuments({ status: 'PENDING' });
    const failedCount = await OfflineSyncLog.countDocuments({ status: 'FAILED' });
    const conflictCount = await OfflineSyncLog.countDocuments({ status: 'CONFLICT' });

    res.json({
      stats,
      recentSyncs,
      totalPending: pendingCount,
      totalFailed: failedCount,
      totalConflict: conflictCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== GET ALL PATIENTS ==========
exports.getAllPatients = async (req, res) => {
  try {
    const { page = 1, limit = 1000, search, gender, patient_type, sponsor_type, sortBy = 'registered_at', sortOrder = 'desc' } = req.query;

    const matchStage = {};
    if (search) {
      matchStage.$or = [
        { first_name: { $regex: search, $options: 'i' } },
        { last_name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { patientId: { $regex: search, $options: 'i' } },
        { uhid: { $regex: search, $options: 'i' } },
        { 'abha.number': { $regex: search, $options: 'i' } },
        { 'abha.address': { $regex: search, $options: 'i' } }
      ];
    }

    if (gender) matchStage.gender = gender;
    if (patient_type) matchStage.patient_type = patient_type;
    if (sponsor_type) matchStage.sponsor_type = sponsor_type;

    const sortStage = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const patients = await Patient.aggregate([
      { $match: matchStage },
      { $sort: sortStage },
      { $skip: (page - 1) * parseInt(limit) },
      { $limit: parseInt(limit) },
      {
        $lookup: {
          from: 'appointments',
          let: { pid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$patient_id', '$$pid'] } } },
            { $sort: { appointment_date: -1 } },
            { $limit: 1 },
            { $project: { appointment_date: 1, department_id: 1, doctor_id: 1, status: 1 } }
          ],
          as: 'latestAppointment'
        }
      },
      {
        $addFields: {
          lastVisitDate: { $arrayElemAt: ['$latestAppointment.appointment_date', 0] },
          lastVisitStatus: { $arrayElemAt: ['$latestAppointment.status', 0] }
        }
      },
      {
        $project: {
          latestAppointment: 0
        }
      }
    ]);

    const total = await Patient.countDocuments(matchStage);

    res.json({
      patients,
      total,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== GET PATIENT BY ID ==========
exports.getPatientById = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    res.json(patient);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== UPDATE PATIENT ==========
exports.updatePatient = async (req, res) => {
  try {
    const patient = await Patient.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    res.json(patient);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ========== DELETE PATIENT ==========
exports.deletePatient = async (req, res) => {
  try {
    const patient = await Patient.findByIdAndDelete(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    res.json({ message: 'Patient deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== GET PATIENT BY PHONE ==========
exports.getPatientByPhone = async (req, res) => {
  try {
    const { phone } = req.params;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const patient = await Patient.findOne({ phone: phone });

    if (patient) {
      return res.json({ patient });
    }

    res.json({ patient: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== GET RECENT PATIENTS ==========
exports.getRecentPatients = async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const patients = await Patient.find()
      .sort({ registered_at: -1 })
      .limit(parseInt(limit))
      .select('first_name last_name phone patient_id registered_at');

    res.json({ patients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};