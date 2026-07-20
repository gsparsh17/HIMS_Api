const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { protect, authorize } = require('../middlewares/auth');
const controller = require('../controllers/radiology.controller');
const reportController = require('../controllers/radiologyReport.controller');
const radiologyStaffController = require('../controllers/radiologyStaff.controller');

const reportAccess = [
  protect,
  authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'radiology_staff')
];
const manageAccess = [protect, authorize('admin', 'staff', 'registrar', 'radiology_staff')];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(file.originalname)}`)
});

const uploadReport = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    cb(allowedTypes.includes(file.mimetype) ? null : new Error('Invalid file type. Only PDF, JPG, and PNG are allowed.'), allowedTypes.includes(file.mimetype));
  }
});

const uploadImages = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    cb(allowedTypes.includes(file.mimetype) ? null : new Error('Only JPG and PNG images can be embedded in a structured report.'), allowedTypes.includes(file.mimetype));
  }
});

// Imaging test master
router.post('/tests', ...manageAccess, controller.createImagingTest);
router.get('/tests', ...reportAccess, controller.getImagingTests);
router.put('/tests/:id', ...manageAccess, controller.updateImagingTest);
router.delete('/tests/:id', ...manageAccess, controller.deleteImagingTest);

// Structured radiology report templates
router.get('/templates', ...reportAccess, reportController.getTemplates);
router.get('/templates/match', ...reportAccess, reportController.matchTemplate);
router.get('/templates/:templateId', ...reportAccess, reportController.getTemplate);

// Requests and reports
router.post('/requests', ...reportAccess, controller.createRadiologyRequest);
router.get('/requests', ...reportAccess, controller.getRadiologyRequests);
router.get('/requests/:id', ...reportAccess, controller.getRadiologyRequestById);
router.patch('/requests/:id/status', ...manageAccess, controller.updateRequestStatus);
router.post('/requests/:id/manual-report', ...manageAccess, uploadImages.array('images', 6), reportController.saveManualReport);
router.post('/requests/:id/upload', ...manageAccess, uploadReport.single('report'), controller.uploadReport);
router.get('/requests/:id/report.pdf', ...reportAccess, reportController.downloadGeneratedReport);
router.get('/requests/:id/download', ...reportAccess, controller.downloadReport);
router.patch('/requests/:id/billed', ...manageAccess, controller.markAsBilled);

router.get('/admission/:admissionId/requests', ...reportAccess, controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', ...reportAccess, controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', ...reportAccess, controller.getRequestsByPatient);
router.get('/dashboard/stats', ...reportAccess, controller.getDashboardStats);

router.get('/staff', ...reportAccess, radiologyStaffController.getAllStaff);
router.get('/staff/available', ...reportAccess, radiologyStaffController.getAvailableStaff);
router.get('/staff/designation/:designation', ...reportAccess, radiologyStaffController.getStaffByDesignation);
router.get('/staff/:id', ...reportAccess, radiologyStaffController.getStaffById);
router.post('/staff', ...manageAccess, radiologyStaffController.createStaff);
router.put('/staff/:id', ...manageAccess, radiologyStaffController.updateStaff);
router.patch('/staff/:id/toggle-status', ...manageAccess, radiologyStaffController.toggleStaffStatus);
router.delete('/staff/:id', ...manageAccess, radiologyStaffController.deleteStaff);

module.exports = router;
