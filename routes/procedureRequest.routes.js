const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const controller = require('../controllers/procedureRequest.controller');

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

// ============== PROCEDURE REQUEST ROUTES ==============
router.post('/requests', controller.createProcedureRequest);
router.get('/requests', controller.getProcedureRequests);
router.get('/requests/:id', controller.getProcedureRequestById);
router.patch('/requests/:id/status', controller.updateRequestStatus);
router.post('/requests/:id/findings', controller.addProcedureFindings);
router.post('/requests/:id/upload', upload.single('file'), controller.uploadAttachment);
router.patch('/requests/:id/billed', controller.markAsBilled);

// ============== SPECIALIZED QUERIES ==============
router.get('/admission/:admissionId/requests', controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', controller.getRequestsByPatient);
router.get('/dashboard/stats', controller.getDashboardStats);

module.exports = router;