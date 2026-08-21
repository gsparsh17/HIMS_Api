const express = require('express');
const router = express.Router();
const controller = require('../controllers/licenseSnapshot.controller');

router.get('/status', controller.status);
router.post('/refresh', controller.refresh);

module.exports = router;
