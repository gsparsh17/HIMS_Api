const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmHiu.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
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
router.post('/subscriptions', clinician, controller.createSubscription);

module.exports = router;
