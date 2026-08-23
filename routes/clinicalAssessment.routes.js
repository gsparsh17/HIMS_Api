'use strict';

const express = require('express');
const c = require('../controllers/clinicalAssessment.controller');
const { requirePatientAccess } = require('../middlewares/patientAccess');

const router = express.Router();

// Assessment definitions
router.post('/definitions', c.createDefinition);
router.get('/definitions', c.listDefinitions);

// Clinical assessments
router.post('/icu-eligibility', c.evaluateIcu);
router.post('/mortality', c.mortality);
router.post('/rehabilitation', c.rehabilitation);

// Patient assessments
router.get('/patients/:patientId', requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), c.patientAssessments);

// Diet management
router.post('/diets', c.createDiet);
router.get('/diets', c.activeDiets);
router.get('/diets/:patientId', requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), c.dietHistory);

module.exports = router;