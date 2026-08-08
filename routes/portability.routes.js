'use strict';
const express = require('express');
const c = require('../controllers/portability.controller');
const router = express.Router();
router.get('/export', c.exportCore);
router.post('/validate-import', c.validateImport);
router.post('/validate-current', c.validateCurrent);
router.post('/import', c.importData);
module.exports = router;
