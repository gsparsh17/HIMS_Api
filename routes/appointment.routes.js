const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointment.controller');
const calendarController = require('../controllers/calendarController');

// Create
router.post('/', appointmentController.createAppointment);

// Read
router.get('/', appointmentController.getAllAppointments);
router.get('/:id', appointmentController.getAppointmentById);

router.put('/:id/complete', appointmentController.completeAppointment)
// Update
router.put('/:id', appointmentController.updateAppointment);
router.patch('/:id/status', calendarController.updateAppointmentStatus);

// Delete
router.delete('/:id', appointmentController.deleteAppointment);

// Filters
router.get('/doctor/:doctorId', appointmentController.getAppointmentsByDoctorId);
router.get('/doctor/:doctorId/today', appointmentController.getTodaysAppointmentsByDoctorId);
router.get('/department/:departmentId', appointmentController.getAppointmentsByDepartmentId);
router.get('/hospital/:hospitalId', appointmentController.getAppointmentsByHospitalId);

module.exports = router;
