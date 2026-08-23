'use strict';

const express = require('express');
const c = require('../controllers/admissionWorkflow.controller');
const IPDAdmission = require('../models/IPDAdmission');
const { requireResourcePatientAccess } = require('../middlewares/patientAccess');

const router = express.Router();
const admissionAccess = requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', hospitalField: 'hospitalId', purpose: 'AUTO', scope: 'clinical_read' });

// Policy routes
router.post('/policies', c.createPolicy);
router.get('/policies', c.listPolicies);
router.post('/policies/:id/evaluate', c.evaluatePolicy);

// Care team and notifications
router.put('/admissions/:admissionId/care-team', admissionAccess, c.updateCareTeam);
router.post('/admissions/:admissionId/stakeholder-notifications', admissionAccess, c.notifyStakeholders);

// Bed management and discharge planning
router.get('/bed-forecast', c.bedForecast);
router.put('/admissions/:admissionId/planned-discharge', admissionAccess, c.planDischarge);
router.get('/due-discharges', c.dueDischarges);

module.exports = router;