const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const externalLabController = require('../controllers/externalLab.controller');

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

// ========== EXTERNAL LAB MANAGEMENT ==========

// Mark lab test as referred to external lab
router.post('/prescriptions/:prescription_id/lab-tests/:lab_test_id/refer-out', 
  externalLabController.markAsReferredOut
);

// Add sample handover log
router.post('/prescriptions/:prescription_id/lab-tests/:lab_test_id/handover-log',
  externalLabController.addSampleHandoverLog
);

// Get sample handover logs
router.get('/prescriptions/:prescription_id/lab-tests/:lab_test_id/handover-logs',
  externalLabController.getSampleHandoverLogs
);

// Upload external lab report (PDF/image)
router.post('/prescriptions/:prescription_id/lab-tests/:lab_test_id/upload-report',
  upload.single('report'),
  externalLabController.uploadExternalReport
);

// Get all referred out lab tests
router.get('/referred-out', externalLabController.getReferredOutLabTests);

// Get external report by ID
router.get('/reports/:report_id', externalLabController.getExternalReportById);

// Update external lab status
router.patch('/prescriptions/:prescription_id/lab-tests/:lab_test_id/status',
  externalLabController.updateExternalLabStatus
);

module.exports = router;