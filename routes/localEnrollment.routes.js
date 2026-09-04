const express = require('express');
const router = express.Router();
const controller = require('../controllers/localEnrollment.controller');

// ============================================
// Local Enrollment Routes
// ============================================

router.get('/status', controller.status);
router.post('/activate', controller.activate);

module.exports = router;