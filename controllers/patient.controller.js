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

// Configure Multer for disk storage
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

// ========== CREATE SINGLE PATIENT ==========
exports.createPatient = async (req, res) => {
  try {
    // Check for duplicate by phone
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
    
    // Log successful sync if this came from offline
    if (req.body.localId) {
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
    // Handle duplicate key error
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
      // Check for duplicate by phone
      const existingPatient = await Patient.findOne({ phone: patientData.phone });
      
      // If duplicate exists and not forcing creation, treat as success (idempotent sync)
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
        
        // Still create sync log for tracking
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

      // Remove localId and other temp fields before saving
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
      
      // Create sync log
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
  
  // Bulk insert sync logs
  if (syncLogs.length > 0) {
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
    
    // Look for patient created from offline sync
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
    
    // Also check by localId in the sync log
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
    const { page = 1, limit = 1000, search, gender, sortBy = 'registered_at', sortOrder = 'desc' } = req.query;

    const matchStage = {};
    if (search) {
      matchStage.$or = [
        { first_name: { $regex: search, $options: 'i' } },
        { last_name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { patientId: { $regex: search, $options: 'i' } },
        { uhid: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (gender) matchStage.gender = gender;

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

// ========== GET PATIENT BY PHONE (FOR OFFLINE RESOLUTION) ==========
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

// ========== GET RECENT PATIENTS (FOR DASHBOARD) ==========
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