const express = require('express');
const auth = require('../controllers/patientPortalAuth.controller');
const portal = require('../controllers/patientPortal.controller');
const { requirePatientPortal } = require('../middlewares/patientPortalAuth');
const router = express.Router();

// Public patient authentication endpoints. They are mounted before staff auth.
router.post('/auth/mobile/request-otp', auth.requestMobileOtp);
router.post('/auth/mobile/verify-otp', auth.verifyMobileOtp);
router.post('/auth/mobile/select-patient', auth.selectPatient);
router.post('/auth/abha-number/request-otp', auth.abhaNumberRequestOtp);
router.post('/auth/abha-number/verify-otp', auth.abhaNumberVerifyOtp);
router.post('/auth/abha-number/select-user', auth.abhaNumberSelectUser);
router.post('/auth/abha-address/request-otp', auth.addressRequestOtp);
router.post('/auth/abha-address/verify-otp', auth.addressVerifyOtp);
router.post('/auth/face/search', auth.faceSearch);
router.post('/auth/face/init', auth.faceInit);
router.get('/auth/face/:txnId/status', auth.faceStatus);
router.post('/auth/face/complete', auth.faceComplete);

router.use(requirePatientPortal);
router.get('/me', auth.me);
router.get('/dashboard', portal.dashboard);
router.get('/appointments', portal.appointments);
router.get('/prescriptions', portal.prescriptions);
router.get('/medications', portal.medications);
router.get('/admissions', portal.admissions);
router.get('/reports', portal.reports);
router.get('/documents', portal.documents);
router.get('/bills', portal.bills);
router.get('/consents', portal.consents);
router.patch('/consents/:consentId/responses', portal.updateConsentResponses);
router.post('/consents/:consentId/sign', portal.signConsent);
router.post('/feedback', portal.submitFeedback);
router.get('/abdm', portal.abdmOverview);
router.get('/abdm/records/:recordId', portal.abdmRecord);

// Patient-authenticated ABDM PHR consent request inbox. These routes use the
// encrypted server-side PHR_APP session; patient tokens are never returned.
router.get('/abdm/consent-requests', portal.abdmConsentRequests);
router.get('/abdm/consent-requests/:requestId', portal.abdmConsentRequest);
router.post('/abdm/consent-requests/:requestId/deny', portal.denyAbdmConsentRequest);
router.get('/abdm/consent-requests/:requestId/artefacts', portal.abdmConsentArtefactsByRequest);
router.get('/abdm/consent-artefacts', portal.abdmConsentArtefacts);
router.get('/abdm/consent-artefacts/:consentId', portal.abdmConsentArtefact);
router.post('/abdm/consents/revoke', portal.revokeAbdmConsent);
router.post('/abdm/consent-auto-approve', portal.createAbdmConsentAutoApprove);
router.post('/abdm/consent-auto-approve/:policyId/disable', portal.disableAbdmConsentAutoApprove);
router.post('/abdm/consent-auto-approve/:policyId/enable', portal.enableAbdmConsentAutoApprove);

router.get('/abdm/subscription-requests', portal.subscriptionRequests);
router.post('/abdm/subscription-requests/:id/approve', portal.approveSubscription);
router.post('/abdm/subscription-requests/:id/deny', portal.denySubscription);
router.get('/abdm/health-lockers', portal.healthLockers);
module.exports = router;
