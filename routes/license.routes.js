const express = require('express');
const router = express.Router();

const {
  activateLicense,
  validateLicense,
  blockLicense,
} = require('../controllers/license.controller');
const { verifyToken1 } = require('../middlewares/auth');


router.post('/activate', activateLicense);
router.post('/validate', verifyToken1, validateLicense);

// admin
router.patch('/block/:licenseId', blockLicense);

module.exports = router;