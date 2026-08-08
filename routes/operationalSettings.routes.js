'use strict';

const express = require('express');
const c = require('../controllers/operationalSettings.controller');

const router = express.Router();

// Operational settings management
router.get('/', c.get);
router.put('/', c.update);

// Data access classification
router.post('/data-access/evaluate', c.evaluateClassification);

// Client support settings
router.get('/client-support', c.clientSupport);

module.exports = router;