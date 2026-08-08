'use strict';

const express = require('express');
const c = require('../controllers/admissionWorkflow.controller');

const router = express.Router();

// Policy routes
router.post('/policies', c.createPolicy);
router.get('/policies', c.listPolicies);
router.post('/policies/:id/evaluate', c.evaluatePolicy);

// Care team and notifications
router.put('/admissions/:admissionId/care-team', c.updateCareTeam);
router.post('/admissions/:admissionId/stakeholder-notifications', c.notifyStakeholders);

// Bed management and discharge planning
router.get('/bed-forecast', c.bedForecast);
router.put('/admissions/:admissionId/planned-discharge', c.planDischarge);
router.get('/due-discharges', c.dueDischarges);

module.exports = router;