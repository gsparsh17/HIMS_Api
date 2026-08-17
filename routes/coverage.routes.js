const express = require('express');
const router = express.Router();
const controller = require('../controllers/coverage.controller');
const { requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

const manage = requireModuleAccess('billing_finance', 'manage');
router.post('/ipd/admissions/:admissionId/coverage', manage, controller.create);
router.get('/ipd/admissions/:admissionId/coverage', requireModuleAccess('ipd', 'view'), controller.get);
router.get('/ipd/admissions/:admissionId/coverage/history', manage, controller.history);
router.post('/ipd/admissions/:admissionId/coverage/verify', manage, controller.verify);
router.post('/ipd/admissions/:admissionId/preauth', manage, controller.preauth);

router.post('/opd/appointments/:appointmentId/coverage', manage, controller.create);
router.get('/opd/appointments/:appointmentId/coverage', requireModuleAccess('registration_opd', 'view'), controller.get);
router.get('/opd/appointments/:appointmentId/coverage/history', manage, controller.history);
router.post('/opd/appointments/:appointmentId/coverage/verify', manage, controller.verify);
router.post('/opd/appointments/:appointmentId/preauth', manage, controller.preauth);

router.patch('/preauth/:id/status', manage, requireActionPermission('preauth_decide'), controller.updatePreauthById);
router.get('/coverages/:id/utilization', requireModuleAccess('billing_finance', 'view'), controller.utilization);
router.patch('/coverages/:id/scheme-details', manage, requireActionPermission('claim_manage'), controller.updateSchemeDetails);
router.post('/coverages/:id/activate', manage, requireActionPermission('coverage_reprice_commit'), controller.activate);
module.exports = router;
