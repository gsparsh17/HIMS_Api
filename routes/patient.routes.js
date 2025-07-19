const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patient.controller');

// --- Specific routes first ---

router.post('/', patientController.createPatient);

// Make sure this line exists and is in the correct place
router.post('/bulk-add', patientController.bulkCreatePatients); 

router.get('/', patientController.getAllPatients);


// --- General, parameterized routes last ---

router.get('/:id', patientController.getPatientById);
router.put('/:id', patientController.updatePatient);
router.delete('/:id', patientController.deletePatient);

module.exports = router;