const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patient.controller');

// --- Specific routes first (must be before parameterized routes) ---

// Image Upload
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); 
  }
});

const upload = multer({ storage: storage });

// Image upload endpoint
router.post('/upload', upload.single('image'), patientController.uploadPatientImage);

// ========== OFFLINE SYNC ENDPOINTS ==========
// Check duplicate patient by phone (for offline pre-check)
router.get('/check-duplicate', patientController.checkDuplicateByPhone);

// Bulk sync endpoint for offline patients (CRITICAL for offline-first)
router.post('/bulk-add', patientController.bulkCreatePatients);

// Get patient by temp ID (for offline resolution)
router.get('/by-temp-id/:tempId', patientController.getPatientByTempId);

// Get sync status (for admin monitoring)
router.get('/sync/status', patientController.getSyncStatus);

// ========== REGULAR CRUD ENDPOINTS ==========
// Create single patient
router.post('/', patientController.createPatient);

// Get all patients (with pagination and filters)
router.get('/', patientController.getAllPatients);

// ========== Parameterized routes (must be last) ==========
router.get('/:id', patientController.getPatientById);
router.put('/:id', patientController.updatePatient);
router.delete('/:id', patientController.deletePatient);

module.exports = router;