const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmConnector.controller');
const hiuController = require('../controllers/abdmHiuConnector.controller');
const { verifyHospitalInbound } = require('../middlewares/internalAbdmAuth');

router.use(verifyHospitalInbound);
router.get('/health', controller.health);

// M2: Scan-and-Share, discovery, linking, consent and HIP data flow.
router.post('/profile-share', controller.profileShare);
router.post('/discover', controller.discover);
router.post('/link/init', controller.linkInit);
router.post('/link/confirm', controller.linkConfirm);
router.post('/link-token', controller.linkToken);
router.post('/link-care-context', controller.linkCareContext);
router.post('/care-context-update', controller.careContextUpdate);
router.post('/sms-notify', controller.smsNotify);
router.post('/consent/notify', controller.consentNotify);
router.post('/health-information/request', controller.healthInformationRequest);
router.post('/hiu/patient/on-share', controller.hiuPatientOnShare);

// M3: HIU consent and encrypted health-information receive flow.
router.post('/hiu/consent/on-init', hiuController.consentOnInit);
router.post('/hiu/consent/notify', hiuController.consentNotify);
router.post('/hiu/consent/on-status', hiuController.consentOnStatus);
router.post('/hiu/consent/on-fetch', hiuController.consentOnFetch);
router.post(
  '/hiu/health-information/on-request',
  hiuController.healthInformationOnRequest
);
router.post('/hiu/data', hiuController.data);
router.post('/hiu/subscription/on-init', hiuController.subscriptionOnInit);
router.post('/hiu/subscription/notify', hiuController.subscriptionNotify);
router.post(
  '/hiu/subscription/care-context/notify',
  hiuController.subscriptionCareContextNotify
);

module.exports = router;
