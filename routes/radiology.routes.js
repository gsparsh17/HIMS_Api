const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const controller = require('../controllers/radiology.controller');

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
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'image/dicom'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, JPG, PNG, and DICOM are allowed.'));
    }
  }
});

// ============== IMAGING TEST MASTER ROUTES ==============
router.post('/tests', controller.createImagingTest);
router.get('/tests', controller.getImagingTests);
router.put('/tests/:id', controller.updateImagingTest);
router.delete('/tests/:id', controller.deleteImagingTest);

// ============== RADIOLOGY REQUEST ROUTES ==============
router.post('/requests', controller.createRadiologyRequest);
router.get('/requests', controller.getRadiologyRequests);
router.get('/requests/:id', controller.getRadiologyRequestById);
router.patch('/requests/:id/status', controller.updateRequestStatus);
router.post('/requests/:id/upload', upload.single('report'), controller.uploadReport);
router.get('/requests/:id/download', controller.downloadReport);
router.patch('/requests/:id/billed', controller.markAsBilled);

// ============== SPECIALIZED QUERIES ==============
router.get('/admission/:admissionId/requests', controller.getRequestsByAdmission);
router.get('/patient/:patientId/requests', controller.getRequestsByPatient);
router.get('/dashboard/stats', controller.getDashboardStats);

module.exports = router;