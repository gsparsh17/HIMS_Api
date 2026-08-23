'use strict';

const express = require('express');
const c = require('../controllers/clinicalOrderSet.controller');
const { requirePatientAccess } = require('../middlewares/patientAccess');

const router = express.Router();

// Catalogue and search
router.get('/catalogue', c.catalogue);

// Order set CRUD operations
router.post('/', c.create);
router.put('/:id', c.update);

// Apply order set to patient
router.post('/:id/apply', c.apply);

// Patient orders
router.get('/patient/:patientId/orders', requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), c.patientOrders);

module.exports = router;