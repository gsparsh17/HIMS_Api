'use strict';

const express = require('express');
const c = require('../controllers/emergencyCare.controller');

const router = express.Router();

// Emergency encounter management
router.post('/encounters', c.register);
router.get('/encounters/:id', c.get);

// Medico-legal cases
router.put('/encounters/:id/mlc', c.markMlc);

// Ambulance handoff
router.put('/encounters/:id/ambulance-handoff', c.ambulanceHandoff);

// Emergency code activation and response
router.post('/encounters/:id/code-activation', c.activateCode);
router.post('/encounters/:id/code-response', c.respondCode);

module.exports = router;