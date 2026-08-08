const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointment.controller');

// Static collection routes must precede parameterized /:id routes.
router.get('/check-conflict', appointmentController.checkAppointmentConflict);
router.post('/bulk-add', appointmentController.bulkCreateAppointments);
router.get('/by-temp-id/:tempId', appointmentController.getAppointmentByTempId);
router.post('/external-sync', appointmentController.syncExternalAppointment);
router.get('/queue/current', appointmentController.getCurrentQueue);
router.post('/link-episode', appointmentController.linkAppointmentToEpisodeSuggestion);

router.get('/doctor/:doctorId/procedures/:date', appointmentController.getDoctorProceduresForDate);
router.get('/doctor/:doctorId/today', appointmentController.getTodaysAppointmentsByDoctorId);
router.get('/doctor/:doctorId', appointmentController.getAppointmentsByDoctorId);
router.get('/department/:departmentId', appointmentController.getAppointmentsByDepartmentId);
router.get('/hospital/:hospitalId', appointmentController.getAppointmentsByHospitalId);
router.get('/patient/:patientId', appointmentController.getAppointmentsByPatientId);

router.post('/', appointmentController.createAppointment);
router.get('/', appointmentController.getAllAppointments);

router.get('/:id/vitals', appointmentController.getVitalsByAppointmentId);
router.patch('/:id/check-in', appointmentController.checkInAppointment);
router.patch('/:id/start-consultation', appointmentController.startConsultation);
router.put('/:id/complete', appointmentController.completeAppointment);
router.patch('/:id/cancel', appointmentController.cancelAppointment);
router.put('/:id/vitals', appointmentController.updateVitals);
router.patch('/:id/status', appointmentController.updateAppointmentStatus);
router.put('/:id', appointmentController.updateAppointment);
router.delete('/:id', appointmentController.deleteAppointment);
router.get('/:id', appointmentController.getAppointmentById);

module.exports = router;
