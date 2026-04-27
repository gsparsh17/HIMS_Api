const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const controller = require('../controllers/labRequest.controller');

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

// ============== LAB TEST MASTER ROUTES ==============
router.post('/tests', controller.createLabTest);
router.get('/tests', controller.getLabTests);
router.get('/tests/:id', controller.getLabTestById);
router.put('/tests/:id', controller.updateLabTest);
router.delete('/tests/:id', controller.deleteLabTest);

// ============== LAB REQUEST ROUTES ==============
router.post('/requests', controller.createLabRequest);
router.get('/requests', controller.getLabRequests);
router.get('/requests/:id', controller.getLabRequestById);
router.patch('/requests/:id/status', controller.updateRequestStatus);
router.post('/requests/:id/results', controller.addTestResults);
router.post('/requests/:id/upload', upload.single('report'), controller.uploadReport);
router.get('/requests/:id/download', controller.downloadReport);
router.patch('/requests/:id/billed', controller.markAsBilled);

// ============== SPECIALIZED QUERIES ==============
router.get('/admission/:admissionId/requests', controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', controller.getRequestsByPatient);
router.get('/dashboard/stats', controller.getDashboardStats);

module.exports = router;