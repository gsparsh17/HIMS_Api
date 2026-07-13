const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmMasterAdmin.controller');
const masterAdminAuth = require('../middlewares/masterAdminAuth');

router.use(masterAdminAuth);
router.get('/gateway/health', controller.gatewayHealth);
router.patch('/gateway/bridge-url', controller.updateBridge);
router.get('/gateway/services', controller.bridgeServices);

router.post('/facilities', controller.createFacility);
router.get('/facilities', controller.listFacilities);
router.get('/facilities/:facilityId', controller.getFacility);
router.patch('/facilities/:facilityId', controller.updateFacility);
router.post('/facilities/:facilityId/rotate-connector-secret', controller.rotateConnectorSecret);
router.post('/facilities/:facilityId/check-connector', controller.checkFacilityConnector);
router.post('/facilities/:facilityId/verify-hfr', controller.verifyHfrFacility);
router.post('/facilities/:facilityId/verify-linkage', controller.verifyFacilityLinkage);
router.post('/facilities/:facilityId/tests/:testType', controller.recordRolloutTest);
router.post('/facilities/:facilityId/activate', controller.activateFacility);

router.get('/transactions', controller.transactions);
router.get('/webhook-events', controller.webhookEvents);

module.exports = router;
