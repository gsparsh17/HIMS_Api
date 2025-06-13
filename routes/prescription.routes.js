const express = require('express');
const router = express.Router();
const prescriptionController = require('../controllers/prescription.controller');

// Create
router.post('/', prescriptionController.createPrescription);

// Read
router.get('/', prescriptionController.getAllPrescriptions);
router.get('/:id', prescriptionController.getPrescriptionById);

// Update
router.put('/:id', prescriptionController.updatePrescription);

// Delete
router.delete('/:id', prescriptionController.deletePrescription);

module.exports = router;
