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
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, JPG, PNG are allowed.'));
    }
  }
});

// Routes
router.get('/patient/:patientId', controller.getReportsByPatient);
router.get('/prescription/:prescriptionId', controller.getReportsByPrescription);
router.post('/upload', upload.single('report'), controller.uploadReport);
router.get('/download/:report_id', controller.downloadReport);
router.get('/download-stream/:report_id', controller.downloadReportStream);
router.get('/external/:prescription_id/:lab_test_id/download', controller.downloadExternalReport);
router.get('/external/:prescription_id/:lab_test_id/stream', controller.downloadExternalReportStream);
router.post('/', controller.createLabReport);
router.get('/', controller.getAllLabReports);
router.get('/:id', controller.getReportById);
router.delete('/:id', controller.deleteReport);

module.exports = router;