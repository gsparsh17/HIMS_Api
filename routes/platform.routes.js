const express = require('express');
const router = express.Router();
const { verifyPlatformInbound } = require('../middlewares/platformAuth');
const controller = require('../controllers/platform.controller');

router.use(verifyPlatformInbound);
router.get('/health', controller.health);
router.post('/provision', controller.provision);
router.post('/license-event', controller.licenseEvent);

module.exports = router;
