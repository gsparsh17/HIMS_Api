const express = require('express');
const LabRequest = require('../models/LabRequest');
const { requirePatientAccess, requireResourcePatientAccess } = require('../middlewares/patientAccess');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { tempDir } = require('../config/upload.config');
const controller = require('../controllers/labRequest.controller');
const workflow = require('../controllers/departmentWorkflow.controller');
const governance = require('../controllers/diagnosticGovernance.controller');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    const isValid = allowedMimeTypes.includes(file.mimetype);
    cb(isValid ? null : new Error('Invalid file type. Only PDF, JPG, PNG are allowed.'), isValid);
  }
});

const view = [protect, requireModuleAccess('laboratory', 'view')];
const manage = [
  protect,
  authorize('admin', 'mediqliq_super_admin', 'pathology_staff'),
  requireModuleAccess('laboratory', 'manage')
];
const order = [
  protect,
  authorize('admin', 'mediqliq_super_admin', 'doctor', 'staff', 'registrar', 'receptionist', 'nurse', 'pathology_staff'),
  requireModuleAccess('laboratory', 'view')
];
const collect = [
  protect,
  authorize('admin', 'mediqliq_super_admin', 'pathology_staff', 'nurse'),
  requireModuleAccess('laboratory', 'view')
];

// Masters
router.post('/tests', ...manage, controller.createLabTest);
router.get('/tests', ...view, controller.getLabTests);
router.get('/tests/:id', ...view, controller.getLabTestById);
router.put('/tests/:id', ...manage, controller.updateLabTest);
router.delete('/tests/:id', ...manage, controller.deleteLabTest);
router.get('/templates', ...view, controller.getReportTemplates);
router.get('/templates/match', ...view, controller.matchReportTemplate);
router.get('/templates/:templateId', ...view, controller.getReportTemplate);

// Unified worklist and specimen lifecycle
router.get('/worklist', ...view, workflow.labWorklist);
router.post('/requests/:id/collect', ...collect, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.collectSpecimen);
router.post('/requests/:id/accession', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.accessionSpecimen);
router.patch('/requests/:id/status', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.updateLabStatus);
router.post('/requests/:id/results', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.enterLabResults);
router.post('/requests/:id/verify', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.verifyLab);
router.post('/requests/:id/critical-ack', ...view, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.criticalAck);
router.post('/requests/:id/release', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), workflow.releaseLab);
router.post('/requests/:id/amend', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), governance.amendLabReport);
router.post('/requests/:id/repeat', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), governance.repeatLabTest);
router.get('/dashboard/stats', ...view, workflow.labStats);
router.get('/reports/released', ...view, controller.getReleasedReports);

// Backward-compatible protected endpoints
router.post('/requests', ...order, controller.createLabRequest);
router.get('/requests', ...view, controller.getLabRequests);
router.get('/requests/:id', ...view, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.getLabRequestById);
router.post('/requests/:id/manual-report', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), controller.saveManualReport);
router.post('/requests/:id/upload', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), upload.single('report'), controller.uploadReport);
router.get('/requests/:id/report.pdf', ...view, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.downloadGeneratedReport);
router.get('/requests/:id/download', ...view, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.downloadReport);
router.patch('/requests/:id/billed', ...manage, requireResourcePatientAccess(LabRequest, { patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), controller.markAsBilled);
router.get('/admission/:admissionId/requests', ...view, controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', ...view, controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', ...view, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.getRequestsByPatient);

module.exports = router;
