const express = require('express');
const router = express.Router();
const pathologyStaffController = require('../controllers/pathologystaff.controller');
const { protect, authorize } = require('../middlewares/auth');

// Existing personal profile routes retain their role protection.
router.get('/profile/me', protect, authorize('pathology_staff'), pathologyStaffController.getMyProfile);
router.put('/profile/me', protect, authorize('pathology_staff'), pathologyStaffController.updateMyProfile);
router.put('/change-password', protect, authorize('pathology_staff'), pathologyStaffController.changePassword);

router.get('/stats/overview', pathologyStaffController.getStaffStatistics);
router.get('/role/:role', pathologyStaffController.getStaffByRole);

// Admin-only credential and main-feature access endpoints. These must appear
// before the generic /:id route.
router.get('/:id/login-access', protect, authorize('admin', 'mediqliq_super_admin'), pathologyStaffController.getPathologyStaffLoginAccess);
router.put('/:id/login-access', protect, authorize('admin', 'mediqliq_super_admin'), pathologyStaffController.updatePathologyStaffLoginAccess);
router.put('/:id/password', protect, authorize('admin', 'mediqliq_super_admin'), pathologyStaffController.updateStaffPassword);

router.route('/')
  .get(pathologyStaffController.getAllPathologyStaff)
  .post(pathologyStaffController.createPathologyStaff);

router.route('/:id')
  .get(pathologyStaffController.getPathologyStaffById)
  .put(pathologyStaffController.updatePathologyStaff)
  .delete(pathologyStaffController.deletePathologyStaff);

router.post('/:id/assign-tests', pathologyStaffController.assignLabTests);
router.put('/:id/performance', pathologyStaffController.updatePerformanceMetrics);

module.exports = router;
