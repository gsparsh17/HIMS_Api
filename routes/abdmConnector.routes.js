const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmConnector.controller');
const { verifyHospitalInbound } = require('../middlewares/internalAbdmAuth');

router.use(verifyHospitalInbound);
router.get('/health', controller.health);
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

module.exports = router;
