const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointment.controller');
const Appointment = require('../models/Appointment');
const { requirePatientAccess, requireResourcePatientAccess } = require('../middlewares/patientAccess');

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
router.get('/patient/:patientId', requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), appointmentController.getAppointmentsByPatientId);

router.post('/', appointmentController.createAppointment);
router.get('/', appointmentController.getAllAppointments);

router.get('/:id/vitals', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_read' }), appointmentController.getVitalsByAppointmentId);
router.patch('/:id/check-in', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.checkInAppointment);
router.patch('/:id/start-consultation', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.startConsultation);
router.put('/:id/complete', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.completeAppointment);
router.patch('/:id/cancel', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.cancelAppointment);
router.put('/:id/vitals', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.updateVitals);
router.patch('/:id/status', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.updateAppointmentStatus);
router.patch('/:id/homecare/delivery', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.updateHomecareDelivery);
router.post('/:id/homecare/feedback', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.submitHomecareFeedback);
router.put('/:id', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.updateAppointment);
router.delete('/:id', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_write' }), appointmentController.deleteAppointment);
router.get('/:id', requireResourcePatientAccess(Appointment, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_read' }), appointmentController.getAppointmentById);

module.exports = router;
