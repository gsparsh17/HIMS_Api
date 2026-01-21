const express = require('express');
const router = express.Router();
const doctorController = require('../controllers/doctor.controller');

// --- Specific routes first ---

// Create a single doctor
router.post('/', doctorController.createDoctor);

// Bulk create doctors
router.post('/bulk-add', doctorController.bulkCreateDoctors);

// Get all doctors
router.get('/', doctorController.getAllDoctors);

// Get doctors by department (also more specific than just /:id)
router.get('/department/:departmentId', doctorController.getDoctorsByDepartmentId);

// Get a single doctor by ID
router.get('/:id', doctorController.getDoctorById);

// Update a single doctor by ID
router.put('/:id', doctorController.updateDoctor);

// Delete a single doctor by ID
router.delete('/:id', doctorController.deleteDoctor);

module.exports = router;