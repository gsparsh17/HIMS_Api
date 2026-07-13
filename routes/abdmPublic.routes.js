const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmPublic.controller');
const verifyAbdmCallback = require('../middlewares/verifyAbdmCallback');
const abdmConfig = require('../config/abdm.config');

router.use(verifyAbdmCallback);

// ABDM M2 HIP callbacks (current V3 callback paths from the supplied sandbox documentation)
router.post('/hip/patient/share', controller.profileShare);
router.post('/hip/token/on-generate-token', controller.linkTokenCallback);
router.post('/hip/token/ongeneratetoken', controller.linkTokenCallback); // compatibility alias used by some docs
router.post('/link/on_carecontext', controller.linkCareContextCallback);
router.post('/links/context/on-notify', controller.careContextUpdateCallback);
router.post('/links/context/onnotify', controller.careContextUpdateCallback);
router.post('/patients/sms/on-notify', controller.smsNotifyCallback);
router.post('/patients/sms/onnotify', controller.smsNotifyCallback);

router.post('/hip/patient/care-context/discover', controller.userDiscovery);
router.post('/hip/patient/carecontext/discover', controller.userDiscovery);
router.post('/hip/link/care-context/init', controller.userLinkInit);
router.post('/hip/link/carecontext/init', controller.userLinkInit);
router.post('/hip/link/care-context/confirm', controller.userLinkConfirm);
router.post('/hip/link/carecontext/confirm', controller.userLinkConfirm);

router.post('/consent/request/hip/notify', controller.consentNotify);
router.post('/hip/health-information/request', controller.healthInformationRequest);

// Reserved for a future HIU/M3 deployment. The route is mounted only when M3 is enabled by app.js.
if (abdmConfig.featureM3) router.post('/hiu/patient/on-share', controller.hiuPatientOnShare);

module.exports = router;
