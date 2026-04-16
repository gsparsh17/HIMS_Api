const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointment.controller');
const calendarController = require('../controllers/calendarController');

// ========== OFFLINE SYNC ENDPOINTS (must be first) ==========
// Check appointment conflict (for offline pre-check)
router.get('/check-conflict', appointmentController.checkAppointmentConflict);

// Bulk sync endpoint for offline appointments (CRITICAL for offline-first)
router.post('/bulk-add', appointmentController.bulkCreateAppointments);

// Get appointment by temp ID (for offline resolution)
router.get('/by-temp-id/:tempId', appointmentController.getAppointmentByTempId);

// ========== CREATE ENDPOINTS ==========
// Create single appointment
router.post('/', appointmentController.createAppointment);

// ========== READ ENDPOINTS ==========
// Get all appointments
router.get('/', appointmentController.getAllAppointments);

// Get appointment by ID
router.get('/:id', appointmentController.getAppointmentById);

// Get vitals by appointment ID
router.get('/:id/vitals', appointmentController.getVitalsByAppointmentId);

// ========== DOCTOR SPECIFIC ENDPOINTS ==========
// Get doctor's procedures for a specific date
router.get('/doctor/:doctorId/procedures/:date', appointmentController.getDoctorProceduresForDate);

// Get all appointments by doctor ID
router.get('/doctor/:doctorId', appointmentController.getAppointmentsByDoctorId);

// Get today's appointments by doctor ID
router.get('/doctor/:doctorId/today', appointmentController.getTodaysAppointmentsByDoctorId);

// ========== DEPARTMENT/HOSPITAL/PATIENT SPECIFIC ENDPOINTS ==========
router.get('/department/:departmentId', appointmentController.getAppointmentsByDepartmentId);
router.get('/hospital/:hospitalId', appointmentController.getAppointmentsByHospitalId);
router.get('/patient/:patientId', appointmentController.getAppointmentsByPatientId);

// ========== UPDATE ENDPOINTS ==========
// Update appointment
router.put('/:id', appointmentController.updateAppointment);

// Complete appointment
router.put('/:id/complete', appointmentController.completeAppointment);

// Update vitals
router.put('/:id/vitals', appointmentController.updateVitals);

// Update appointment status (from calendar controller)
router.patch('/:id/status', calendarController.updateAppointmentStatus);

// ========== DELETE ENDPOINTS ==========
router.delete('/:id', appointmentController.deleteAppointment);

module.exports = router;