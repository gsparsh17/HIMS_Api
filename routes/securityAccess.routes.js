const express = require('express');
const controller = require('../controllers/securityAccess.controller');
const { protect, authorize, requireActionPermission, requirePrivilegedAction } = require('../middlewares/auth');

const router = express.Router();
router.use(protect);

router.get('/devices', controller.listTrustedDevices);
router.post('/devices/trust-current', controller.trustCurrentDevice);
router.delete('/devices/:deviceId', controller.revokeTrustedDevice);

router.get('/break-glass/patient-lookup', requirePrivilegedAction('break_glass_initiate'), controller.lookupBreakGlassPatient);
router.post('/break-glass', requirePrivilegedAction('break_glass_initiate'), controller.createBreakGlass);
router.get('/break-glass/mine', controller.myBreakGlass);
router.get('/break-glass/review', requirePrivilegedAction('break_glass_review'), controller.breakGlassReviewQueue);
router.post('/break-glass/:grantId/review', requirePrivilegedAction('break_glass_review'), controller.reviewBreakGlass);

router.post('/care-team/assignments', authorize('admin', 'mediqliq_super_admin', 'hr_manager'), requireActionPermission('user_access_manage'), controller.createCareTeamAssignment);
router.delete('/care-team/assignments/:assignmentId', authorize('admin', 'mediqliq_super_admin', 'hr_manager'), requireActionPermission('user_access_manage'), controller.revokeCareTeamAssignment);

router.get('/abdm-operations/reconciliation', requirePrivilegedAction('abdm_reconciliation_view'), controller.listAbdmReconciliation);
router.post('/abdm-operations/:operationId/reconcile', requirePrivilegedAction('abdm_reconciliation_manage'), controller.resolveAbdmReconciliation);

router.post('/privileged-access/requests', authorize('admin', 'mediqliq_super_admin', 'hr_manager'), requireActionPermission('user_access_manage'), controller.createPrivilegedRequest);
router.get('/privileged-access/requests', requirePrivilegedAction('privileged_access_approve'), controller.listPrivilegedRequests);
router.post('/privileged-access/requests/:requestId/decision', requirePrivilegedAction('privileged_access_approve'), controller.decidePrivilegedRequest);

module.exports = router;
