const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmHiu.controller');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');

router.use(protect, requireModuleAccess('abdm', 'view'));
router.use((req, res, next) => req.method === 'GET' ? next() : requireModuleAccess('abdm', 'manage')(req, res, next));
const clinician = authorize('admin', 'doctor');
const clinicalReader = authorize('admin', 'doctor', 'nurse');

router.get('/summary', clinicalReader, controller.summary);
router.post('/consents', clinician, controller.createConsentRequest);
router.get('/consents', clinicalReader, controller.listConsents);
router.get('/consents/:consentId', clinicalReader, controller.getConsent);
router.post('/consents/:consentId/status', clinician, controller.refreshConsentStatus);
router.post('/consents/:consentId/fetch', clinician, controller.fetchConsent);
router.post(
  '/consents/:consentId/health-information',
  clinician,
  controller.requestHealthInformation
);
router.get('/requests', clinicalReader, controller.listRequests);
router.get('/patients/:patientId/records', clinicalReader, controller.listImportedRecords);
router.get('/records/:recordId', clinicalReader, controller.getImportedRecord);
router.get('/subscriptions/health-lockers', clinicalReader, controller.listHealthLockers);
router.post('/subscriptions', clinician, controller.createSubscription);
router.get('/subscriptions', clinicalReader, controller.listSubscriptions);
router.post('/subscriptions/requests/:subscriptionRequestId/approve', clinician, controller.approveSubscription);
router.post('/subscriptions/requests/:subscriptionRequestId/deny', clinician, controller.denySubscription);
router.get('/subscriptions/remote/requests', clinicalReader, controller.listRemoteSubscriptionRequests);
router.get('/subscriptions/remote/requests/:subscriptionRequestId', clinicalReader, controller.getRemoteSubscriptionRequest);
router.get('/subscriptions/remote/:subscriptionId', clinicalReader, controller.getRemoteSubscription);
router.put('/subscriptions/remote/:subscriptionId', clinician, controller.editSubscription);
router.post('/subscriptions/remote/:subscriptionId/disable', clinician, controller.disableSubscription);
router.post('/subscriptions/remote/:subscriptionId/enable', clinician, controller.enableSubscription);
router.get('/subscriptions/patient/requests', clinicalReader, controller.patientSubscriptionRequests);
router.post('/subscriptions/lockers/setup', clinician, controller.setupHealthLocker);
router.get('/subscriptions/lockers', clinicalReader, controller.listPatientLockers);
router.get('/subscriptions/lockers/:lockerId', clinicalReader, controller.getPatientLocker);

module.exports = router;
