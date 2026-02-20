// routes/labreport.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/labreport.controller');
const multer = require('multer');
const path = require('path');

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOC, DOCX, JPG, PNG are allowed.'));
    }
  }
});

// Get reports by patient
router.get('/patient/:patientId', controller.getReportsByPatient);

// Get reports by prescription
router.get('/prescription/:prescriptionId', controller.getReportsByPrescription);

// Upload report file
router.post('/upload', upload.single('report'), controller.uploadReport);

// CRUD routes
router.post('/', controller.createLabReport);
router.get('/', controller.getAllLabReports);
router.get('/:id', controller.getReportById);
router.delete('/:id', controller.deleteReport);

module.exports = router;