const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const controller = require('../controllers/labRequest.controller');
const workflow = require('../controllers/departmentWorkflow.controller');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
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
router.post('/requests/:id/collect', ...collect, workflow.collectSpecimen);
router.post('/requests/:id/accession', ...manage, workflow.accessionSpecimen);
router.patch('/requests/:id/status', ...manage, workflow.updateLabStatus);
router.post('/requests/:id/results', ...manage, workflow.enterLabResults);
router.post('/requests/:id/verify', ...manage, workflow.verifyLab);
router.post('/requests/:id/critical-ack', ...view, workflow.criticalAck);
router.post('/requests/:id/release', ...manage, workflow.releaseLab);
router.get('/dashboard/stats', ...view, workflow.labStats);

// Backward-compatible protected endpoints
router.post('/requests', ...order, controller.createLabRequest);
router.get('/requests', ...view, controller.getLabRequests);
router.get('/requests/:id', ...view, controller.getLabRequestById);
router.post('/requests/:id/manual-report', ...manage, controller.saveManualReport);
router.post('/requests/:id/upload', ...manage, upload.single('report'), controller.uploadReport);
router.get('/requests/:id/report.pdf', ...view, controller.downloadGeneratedReport);
router.get('/requests/:id/download', ...view, controller.downloadReport);
router.patch('/requests/:id/billed', ...manage, controller.markAsBilled);
router.get('/admission/:admissionId/requests', ...view, controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', ...view, controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', ...view, controller.getRequestsByPatient);

module.exports = router;