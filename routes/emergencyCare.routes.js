'use strict';

const express = require('express');
const c = require('../controllers/emergencyCare.controller');
const EmergencyEncounter = require('../models/EmergencyEncounter');
const { requireResourcePatientAccess } = require('../middlewares/patientAccess');

const router = express.Router();
const encounterAccess = requireResourcePatientAccess(EmergencyEncounter, { patientField: 'patientId', hospitalField: 'hospitalId', purpose: 'AUTO', scope: 'clinical_read' });

// Emergency encounter management
router.post('/encounters', c.register);
router.get('/encounters/:id', encounterAccess, c.get);

// Medico-legal cases
router.put('/encounters/:id/mlc', encounterAccess, c.markMlc);

// Ambulance handoff
router.put('/encounters/:id/ambulance-handoff', encounterAccess, c.ambulanceHandoff);

// Emergency code activation and response
router.post('/encounters/:id/code-activation', encounterAccess, c.activateCode);
router.post('/encounters/:id/code-response', encounterAccess, c.respondCode);

module.exports = router;