const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmInternal.controller');
const { verifyMasterInbound } = require('../middlewares/internalAbdmAuth');

router.use(verifyMasterInbound);
router.get('/health', controller.health);
router.post('/proxy/abha', controller.proxyAbha);
router.post('/hip/action', controller.hipAction);

module.exports = router;
