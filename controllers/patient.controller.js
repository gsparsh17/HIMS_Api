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

    const filter = {};
    if (search) {
      filter.$or = [
        { first_name: { $regex: search, $options: 'i' } },
        { last_name: { $regex: search, $options: 'i' } },
        // { email: { $regex: search, $options: 'i' } },
        // { phone: { $regex: search, $options: 'i' } }
      ];
    }
    console.log(search)
    if (gender) filter.gender = gender;

    const sortOptions = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const patients = await Patient.find(filter)
      .sort(sortOptions)
      .limit(parseInt(limit))
      .skip((page - 1) * parseInt(limit));

    const total = await Patient.countDocuments(filter);

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