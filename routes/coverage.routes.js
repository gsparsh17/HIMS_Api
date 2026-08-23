const express = require('express');
const router = express.Router();
const controller = require('../controllers/coverage.controller');
const IPDAdmission = require('../models/IPDAdmission');
const Appointment = require('../models/Appointment');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const { requireResourcePatientAccess } = require('../middlewares/patientAccess');
const { requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

const manage = requireModuleAccess('billing_finance', 'manage');
const ipdPaymentAccess = requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', hospitalField: 'hospitalId', purpose: 'PAYMENT', scope: 'financial_read' });
const opdPaymentAccess = requireResourcePatientAccess(Appointment, { idParam: 'appointmentId', patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'PAYMENT', scope: 'financial_read' });
const coveragePaymentAccess = requireResourcePatientAccess(AdmissionCoverage, { idParam: 'id', patientField: 'patientId', hospitalField: 'hospitalId', purpose: 'PAYMENT', scope: 'financial_read' });
router.post('/ipd/admissions/:admissionId/coverage', manage, ipdPaymentAccess, controller.create);
router.get('/ipd/admissions/:admissionId/coverage', requireModuleAccess('ipd', 'view'), ipdPaymentAccess, controller.get);
router.get('/ipd/admissions/:admissionId/coverage/history', manage, ipdPaymentAccess, controller.history);
router.post('/ipd/admissions/:admissionId/coverage/verify', manage, ipdPaymentAccess, controller.verify);
router.post('/ipd/admissions/:admissionId/preauth', manage, ipdPaymentAccess, controller.preauth);

router.post('/opd/appointments/:appointmentId/coverage', manage, opdPaymentAccess, controller.create);
router.get('/opd/appointments/:appointmentId/coverage', requireModuleAccess('registration_opd', 'view'), opdPaymentAccess, controller.get);
router.get('/opd/appointments/:appointmentId/coverage/history', manage, opdPaymentAccess, controller.history);
router.post('/opd/appointments/:appointmentId/coverage/verify', manage, opdPaymentAccess, controller.verify);
router.post('/opd/appointments/:appointmentId/preauth', manage, opdPaymentAccess, controller.preauth);

router.patch('/preauth/:id/status', manage, requireActionPermission('preauth_decide'), coveragePaymentAccess, controller.updatePreauthById);
router.get('/coverages/:id/utilization', requireModuleAccess('billing_finance', 'view'), coveragePaymentAccess, controller.utilization);
router.patch('/coverages/:id/scheme-details', manage, requireActionPermission('claim_manage'), coveragePaymentAccess, controller.updateSchemeDetails);
router.post('/coverages/:id/activate', manage, requireActionPermission('coverage_reprice_commit'), coveragePaymentAccess, controller.activate);
module.exports = router;
