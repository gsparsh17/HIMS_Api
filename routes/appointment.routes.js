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

// Delete
router.delete('/:id', appointmentController.deleteAppointment);

module.exports = router;
