const express = require('express');
const router = express.Router();
const controller = require('../controllers/pathologystaff.controller');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');

router.use(protect, requireModuleAccess('laboratory', 'view'));
router.get('/profile/me', authorize('pathology_staff'), controller.getMyProfile);
router.put('/profile/me', authorize('pathology_staff'), controller.updateMyProfile);
router.put('/change-password', authorize('pathology_staff'), controller.changePassword);
router.get('/stats/overview', controller.getStaffStatistics);
router.get('/role/:role', controller.getStaffByRole);
router.get('/:id/login-access', authorize('admin', 'mediqliq_super_admin'), requireModuleAccess('laboratory', 'manage'), controller.getPathologyStaffLoginAccess);
router.put('/:id/login-access', authorize('admin', 'mediqliq_super_admin'), requireModuleAccess('laboratory', 'manage'), controller.updatePathologyStaffLoginAccess);
router.put('/:id/password', authorize('admin', 'mediqliq_super_admin'), requireModuleAccess('laboratory', 'manage'), controller.updateStaffPassword);
router.route('/')
  .get(controller.getAllPathologyStaff)
  .post(authorize('admin', 'mediqliq_super_admin'), requireModuleAccess('laboratory', 'manage'), controller.createPathologyStaff);
router.route('/:id')
  .get(controller.getPathologyStaffById)
  .put(authorize('admin', 'mediqliq_super_admin'), requireModuleAccess('laboratory', 'manage'), controller.updatePathologyStaff)
  .delete(authorize('admin', 'mediqliq_super_admin'), requireModuleAccess('laboratory', 'manage'), controller.deletePathologyStaff);
router.post('/:id/assign-tests', authorize('admin', 'mediqliq_super_admin'), requireModuleAccess('laboratory', 'manage'), controller.assignLabTests);
router.put('/:id/performance', authorize('admin', 'mediqliq_super_admin', 'pathology_staff'), requireModuleAccess('laboratory', 'manage'), controller.updatePerformanceMetrics);
module.exports = router;
