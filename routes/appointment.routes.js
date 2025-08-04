const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointment.controller');

// Create
router.post('/', appointmentController.createAppointment);

// Read
router.get('/', appointmentController.getAllAppointments);
router.get('/:id', appointmentController.getAppointmentById);

// Update
router.put('/:id', appointmentController.updateAppointment);

router.put('/:id', appointmentController.updateAppointmentStatus);

// Delete
router.delete('/:id', appointmentController.deleteAppointment);

// Get appointments by doctor
router.get('/doctor/:doctorId', appointmentController.getAppointmentsByDoctorId);

// Get appointments by department
router.get('/department/:departmentId', appointmentController.getAppointmentsByDepartmentId);


module.exports = router;
