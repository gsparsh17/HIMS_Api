const express = require('express');
const controller = require('../controllers/document.controller');
const { protect, authorize, requireActionPermission } = require('../middlewares/auth');
const { requireResourcePatientAccess } = require('../middlewares/patientAccess');
const IPDAdmission = require('../models/IPDAdmission');

const router = express.Router();
router.get('/verify/:code', controller.verify);
router.use(protect);
router.post('/sign', controller.sign);
router.get('/signatures', controller.listSignatures);
router.post('/signatures/:id/revoke', authorize('admin', 'mediqliq_super_admin'), controller.revoke);
router.get('/patient-file/:admissionId/manifest', requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.getManifest);
router.get('/patient-file/:admissionId/completeness', requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.getCompleteness);
router.get('/patient-file/:admissionId/bundle-plan', requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.getBundlePlan);
router.get('/patient-file/:admissionId/packet-validation', requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.getPacketValidation);
router.post('/patient-file/:admissionId/bundles/preview', requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.previewPatientFileBundle);
router.post('/patient-file/:admissionId/bundles', requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), controller.finalizePatientFileBundle);
router.get('/patient-file/:admissionId/bundles/:renderedId', requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.streamPatientFileBundle);

module.exports = router;
