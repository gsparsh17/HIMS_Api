const Patient = require('../models/Patient');
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

// The upload endpoint with Multer middleware
exports.uploadPatientImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    const result = await cloudinary.uploader.upload(req.file.path, {
        folder: 'patients', // Separate folder for patients
        resource_type: 'image'
    });
    const fs = require('fs');
    fs.unlinkSync(req.file.path);

    res.json({ imageUrl: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Create a new patient
exports.createPatient = async (req, res) => {
  try {
    const patient = new Patient(req.body);
    await patient.save();
    res.status(201).json(patient);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Get all patients
exports.getAllPatients = async (req, res) => {
  try {
    const { page = 1, limit = 1000, search, gender, sortBy = 'registered_at', sortOrder = 'desc' } = req.query;

    const matchStage = {};
    if (search) {
      matchStage.$or = [
        { first_name: { $regex: search, $options: 'i' } },
        { last_name: { $regex: search, $options: 'i' } },
        // { email: { $regex: search, $options: 'i' } },
        // { phone: { $regex: search, $options: 'i' } }
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
            { $project: { appointment_date: 1, department_id: 1, doctor_id: 1 } }
          ],
          as: 'appointmentData'
        }
      },
      {
        $lookup: {
          from: 'bills',
          let: { pid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$patient_id', '$$pid'] } } },
            { $project: { total_amount: 1 } }
          ],
          as: 'billData'
        }
      },
      {
        $addFields: {
          totalAppointments: { $size: "$appointmentData" },
          totalCollection: { $sum: "$billData.total_amount" },
          lastVisitDate: { $max: "$appointmentData.appointment_date" },
          latestAppointment: { $arrayElemAt: ["$appointmentData", 0] }
        }
      },
      {
        $lookup: {
          from: 'departments',
          localField: 'latestAppointment.department_id',
          foreignField: '_id',
          as: 'deptData'
        }
      },
      {
        $lookup: {
          from: 'doctors',
          localField: 'latestAppointment.doctor_id',
          foreignField: '_id',
          as: 'docData'
        }
      },
      {
        $addFields: {
          lastVisitedDepartment: { $arrayElemAt: ["$deptData.name", 0] },
          lastVisitedDoctor: {
            $let: {
              vars: {
                fName: { $arrayElemAt: ["$docData.firstName", 0] },
                lName: { $arrayElemAt: ["$docData.lastName", 0] }
              },
              in: { $concat: [ { $ifNull: ["$$fName", ""] }, " ", { $ifNull: ["$$lName", ""] } ] }
            }
          }
        }
      },
      {
         $project: {
             appointmentData: 0,
             billData: 0,
             latestAppointment: 0,
             deptData: 0,
             docData: 0
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

// Get a single patient by ID
exports.getPatientById = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    res.json(patient);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update patient by ID
exports.updatePatient = async (req, res) => {
  try {
    const patient = await Patient.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    res.json(patient);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// Delete patient by ID
exports.deletePatient = async (req, res) => {
  try {
    const patient = await Patient.findByIdAndDelete(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    res.json({ message: 'Patient deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
// Add this function to your existing patient.controller.js file

// Bulk create patients from CSV
exports.bulkCreatePatients = async (req, res) => {
  const patientsData = req.body; // Array of patients from the parsed CSV

  if (!patientsData || !Array.isArray(patientsData)) {
    return res.status(400).json({ error: 'Invalid data format. Expected an array.' });
  }

  const successfulImports = [];
  const failedImports = [];

  // We use a for...of loop here instead of insertMany() to ensure
  // the pre('save') hook in your Patient model is triggered for each patient,
  // which generates the custom patientId.
  for (const patient of patientsData) {
    try {
      // Check if a patient with the same email already exists to prevent duplicates
      const patientExists = await Patient.findOne({ email: patient.email });
      if (patientExists) {
        throw new Error('Patient with this email already exists.');
      }

      const newPatient = await Patient.create(patient);
      successfulImports.push(newPatient);

    } catch (err) {
      // If any record fails, we add it to the failed list and continue
      failedImports.push({
        email: patient.email,
        reason: err.message,
      });
    }
  }

  // Send a detailed summary back to the frontend
  res.status(201).json({
    message: 'Bulk import process completed.',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    failedImports: failedImports,
  });
};