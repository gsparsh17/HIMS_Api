const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmHospital.controller');
const packetController = require('../controllers/abdmPacket.controller');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');
const { requirePatientAccess } = require('../middlewares/patientAccess');

router.use(protect, requireModuleAccess('abdm', 'view'));
router.use((req, res, next) => req.method === 'GET' ? next() : requireModuleAccess('abdm', 'manage')(req, res, next));
const reader = authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist');
const clinician = authorize('admin', 'doctor', 'nurse', 'registrar');
const administrator = authorize('admin');

router.get('/integration/status', reader, controller.integrationStatus);
router.post('/care-contexts/build/:patientId', clinician, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.buildCareContexts);
router.get('/care-contexts/patient/:patientId', reader, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.listPatientCareContexts);
router.get('/care-contexts/patient/:patientId/grouped', reader, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.groupedCareContexts);
router.post('/care-contexts/:contextId/notify-update', clinician, controller.notifyCareContextUpdate);
router.post('/linking/hip/initiate/:patientId', clinician, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.initiateHipLinking);
router.post('/linking/hip/retry-pending/:contextId', clinician, controller.retryPendingHipLinking);
router.post('/linking/hip/sms/:patientId', clinician, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.sendHipLinkSms);
router.post('/running-token/status/:patientId', reader, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), controller.requestRunningTokenStatus);
router.post('/fhir/generate', authorize('admin', 'doctor'), controller.generateFhir);
router.post('/fhir/validate', authorize('admin', 'doctor'), controller.validateFhir);

// Hospital-facing ABDM Packet Center. A packet version is immutable and binds
// the exact care-context sources, consent scope, FHIR profile and reviewed hash.
router.get('/patients/:patientId/packets', reader, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), packetController.listPatientPackets);
router.post('/care-contexts/:contextId/packet/preview', clinician, packetController.preview);
router.post('/care-contexts/:contextId/packet/prepare', clinician, packetController.prepare);
router.get('/packets/:packetId/versions/:version/summary', reader, packetController.summary);
router.get('/packets/:packetId/versions/:version/fhir', authorize('admin', 'doctor'), packetController.fhir);
router.post('/packets/:packetId/versions/:version/validate', authorize('admin', 'doctor'), packetController.validate);
router.post('/packets/:packetId/versions/:version/approve', authorize('admin', 'doctor'), packetController.approve);
router.post('/packets/:packetId/rebuild', clinician, packetController.rebuild);
router.get('/patients/:patientId/disclosures', reader, requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), packetController.disclosures);

router.get('/transfers', administrator, controller.listTransfers);
router.get('/jobs', administrator, controller.listJobs);
router.post('/jobs/:jobId/retry', administrator, controller.retryJob);

module.exports = router;
