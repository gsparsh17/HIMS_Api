const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');
const controller = require('../controllers/radiology.controller');
const reportController = require('../controllers/radiologyReport.controller');
const radiologyStaffController = require('../controllers/radiologyStaff.controller');
const workflow = require('../controllers/departmentWorkflow.controller');

const view = [protect, requireModuleAccess('radiology', 'view')];
const manage = [
  protect,
  authorize('admin', 'mediqliq_super_admin', 'radiology_staff'),
  requireModuleAccess('radiology', 'manage')
];
const order = [
  protect,
  authorize('admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'radiology_staff'),
  requireModuleAccess('radiology', 'view')
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(
    null,
    `${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(file.originalname)}`
  )
});

const uploadReport = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    const isValid = allowedMimeTypes.includes(file.mimetype);
    cb(isValid ? null : new Error('Invalid report file type'), isValid);
  }
});

const uploadImages = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    const isValid = allowedMimeTypes.includes(file.mimetype);
    cb(isValid ? null : new Error('Only JPG and PNG images are allowed'), isValid);
  }
});

// Test management
router.post('/tests', ...manage, controller.createImagingTest);
router.get('/tests', ...view, controller.getImagingTests);
router.put('/tests/:id', ...manage, controller.updateImagingTest);
router.delete('/tests/:id', ...manage, controller.deleteImagingTest);

// Report templates
router.get('/templates', ...view, reportController.getTemplates);
router.get('/templates/match', ...view, reportController.matchTemplate);
router.get('/templates/:templateId', ...view, reportController.getTemplate);

// Radiology workflow
router.get('/worklist', ...view, workflow.radiologyWorklist);
router.post('/requests/:id/schedule', ...manage, workflow.scheduleRadiology);
router.post('/requests/:id/start', ...manage, workflow.startRadiology);
router.post('/requests/:id/results', ...manage, workflow.enterRadiologyResult);
router.post('/requests/:id/verify', ...manage, workflow.verifyRadiology);
router.post('/requests/:id/release', ...manage, workflow.releaseRadiology);
router.get('/dashboard/stats', ...view, workflow.radiologyStats);

// Request management
router.post('/requests', ...order, controller.createRadiologyRequest);
router.get('/requests', ...view, controller.getRadiologyRequests);
router.get('/requests/:id', ...view, controller.getRadiologyRequestById);
router.patch('/requests/:id/status', ...manage, controller.updateRequestStatus);
router.post('/requests/:id/manual-report', ...manage, uploadImages.array('images', 6), reportController.saveManualReport);
router.post('/requests/:id/upload', ...manage, uploadReport.single('report'), controller.uploadReport);
router.get('/requests/:id/report.pdf', ...view, reportController.downloadGeneratedReport);
router.get('/requests/:id/download', ...view, controller.downloadReport);
router.patch('/requests/:id/billed', ...manage, controller.markAsBilled);

// Admission/patient scoped requests
router.get('/admission/:admissionId/requests', ...view, controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', ...view, controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', ...view, controller.getRequestsByPatient);

// Radiology staff management
router.get('/staff', ...view, radiologyStaffController.getAllStaff);
router.get('/staff/available', ...view, radiologyStaffController.getAvailableStaff);
router.get('/staff/designation/:designation', ...view, radiologyStaffController.getStaffByDesignation);
router.get('/staff/:id', ...view, radiologyStaffController.getStaffById);
router.post('/staff', ...manage, radiologyStaffController.createStaff);
router.put('/staff/:id', ...manage, radiologyStaffController.updateStaff);
router.patch('/staff/:id/toggle-status', ...manage, radiologyStaffController.toggleStaffStatus);
router.delete('/staff/:id', ...manage, radiologyStaffController.deleteStaff);

module.exports = router;