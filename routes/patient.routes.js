const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patient.controller');

// Create
router.post('/', patientController.createPatient);

// Read
router.get('/', patientController.getAllPatients);
router.get('/:id', patientController.getPatientById);

// Update
router.put('/:id', patientController.updatePatient);

// Delete
router.delete('/:id', patientController.deletePatient);

module.exports = router;
