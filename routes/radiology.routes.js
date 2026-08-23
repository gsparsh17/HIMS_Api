const express = require('express');
const RadiologyRequest = require('../models/RadiologyRequest');
const { requirePatientAccess, requireResourcePatientAccess } = require('../middlewares/patientAccess');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { tempDir } = require('../config/upload.config');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');
const controller = require('../controllers/radiology.controller');
const reportController = require('../controllers/radiologyReport.controller');
const radiologyStaffController = require('../controllers/radiologyStaff.controller');
const workflow = require('../controllers/departmentWorkflow.controller');
const governance = require('../controllers/diagnosticGovernance.controller');

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
  destination: (req, file, cb) => cb(null, tempDir),
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
router.post('/requests/:id/schedule', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.scheduleRadiology);
router.post('/requests/:id/start', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.startRadiology);
router.post('/requests/:id/results', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.enterRadiologyResult);
router.post('/requests/:id/verify', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.verifyRadiology);
router.post('/requests/:id/release', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.releaseRadiology);
router.post('/requests/:id/refer-out', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), controller.referOut);
router.post('/requests/:id/external-result', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), controller.receiveExternalResult);
router.post('/requests/:id/amend', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), governance.amendRadiologyReport);
router.post('/requests/:id/repeat', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), governance.repeatRadiologyStudy);
router.post('/requests/:id/contraindications', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), governance.assessRadiologyContraindications);
router.post('/requests/:id/contraindications/ack', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), governance.acknowledgeRadiologyContraindications);
router.post('/requests/:id/dicom-metadata', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), governance.importDicomMetadata);
router.get('/dashboard/stats', ...view, workflow.radiologyStats);

// Request management
router.post('/requests', ...order, controller.createRadiologyRequest);
router.get('/requests', ...view, controller.getRadiologyRequests);
router.get('/requests/:id', ...view, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.getRadiologyRequestById);
router.patch('/requests/:id/status', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), controller.updateRequestStatus);
router.post('/requests/:id/manual-report', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), uploadImages.array('images', 6), reportController.saveManualReport);
router.post('/requests/:id/upload', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), uploadReport.single('report'), controller.uploadReport);
router.get('/requests/:id/report.pdf', ...view, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), reportController.downloadGeneratedReport);
router.get('/requests/:id/download', ...view, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.downloadReport);
router.patch('/requests/:id/billed', ...manage, requireResourcePatientAccess(RadiologyRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), controller.markAsBilled);

// Admission/patient scoped requests
router.get('/admission/:admissionId/requests', ...view, controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', ...view, controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', ...view, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.getRequestsByPatient);

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
