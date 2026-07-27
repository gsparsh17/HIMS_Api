const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmHospital.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
const reader = authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist');
const clinician = authorize('admin', 'doctor', 'nurse', 'registrar');
const administrator = authorize('admin');

router.get('/integration/status', reader, controller.integrationStatus);
router.post('/care-contexts/build/:patientId', clinician, controller.buildCareContexts);
router.get('/care-contexts/patient/:patientId', reader, controller.listPatientCareContexts);
router.get('/care-contexts/patient/:patientId/grouped', reader, controller.groupedCareContexts);
router.post('/care-contexts/:contextId/notify-update', clinician, controller.notifyCareContextUpdate);
router.post('/linking/hip/initiate/:patientId', clinician, controller.initiateHipLinking);
router.post('/linking/hip/sms/:patientId', clinician, controller.sendHipLinkSms);
router.post('/running-token/status/:patientId', reader, controller.requestRunningTokenStatus);
router.post('/fhir/generate', authorize('admin', 'doctor'), controller.generateFhir);
router.post('/fhir/validate', authorize('admin', 'doctor'), controller.validateFhir);
router.get('/transfers', administrator, controller.listTransfers);
router.get('/jobs', administrator, controller.listJobs);
router.post('/jobs/:jobId/retry', administrator, controller.retryJob);

module.exports = router;
