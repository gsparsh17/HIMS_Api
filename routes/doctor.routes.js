const express = require('express');
const router = express.Router();
const doctorController = require('../controllers/doctor.controller');

// Create
router.post('/', doctorController.createDoctor);

// Read
router.get('/', doctorController.getAllDoctors);
router.get('/:id', doctorController.getDoctorById);

// Update
router.put('/:id', doctorController.updateDoctor);
router.get('/department/:departmentId', doctorController.getDoctorsByDepartmentId);
// Delete
router.delete('/:id', doctorController.deleteDoctor);

module.exports = router;
