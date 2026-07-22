const express = require('express');
const controller = require('../controllers/document.controller');
const { protect, authorize, requireActionPermission } = require('../middlewares/auth');

const router = express.Router();
router.get('/verify/:code', controller.verify);
router.use(protect);
router.post('/sign', controller.sign);
router.get('/signatures', controller.listSignatures);
router.post('/signatures/:id/revoke', authorize('admin', 'mediqliq_super_admin'), controller.revoke);
router.get('/patient-file/:admissionId/manifest', controller.getManifest);
router.get('/patient-file/:admissionId/completeness', controller.getCompleteness);
router.get('/patient-file/:admissionId/bundle-plan', controller.getBundlePlan);
router.post('/patient-file/:admissionId/bundles/preview', controller.previewPatientFileBundle);
router.post('/patient-file/:admissionId/bundles', controller.finalizePatientFileBundle);
router.get('/patient-file/:admissionId/bundles/:renderedId', controller.streamPatientFileBundle);

module.exports = router;
