'use strict';

const express = require('express');
const c = require('../controllers/safety.controller');

const router = express.Router();

// Safety incident management
router.post('/incidents', c.createIncident);
router.patch('/incidents/:id', c.updateIncident);
router.get('/incidents', c.list);
router.get('/incidents/analytics/summary', c.analytics);

// Antimicrobial policies
router.post('/antimicrobial-policies', c.createPolicy);
router.get('/antimicrobial-policies', c.policies);

module.exports = router;