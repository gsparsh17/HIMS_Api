const express = require('express');
const router = express.Router();
const controller = require('../controllers/pathologystaff.controller');
const { protect, authorize, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

router.use(protect, requireModuleAccess('laboratory', 'view'));
router.get('/profile/me', authorize('pathology_staff'), controller.getMyProfile);
router.put('/profile/me', authorize('pathology_staff'), controller.updateMyProfile);
router.put('/change-password', authorize('pathology_staff'), controller.changePassword);
router.get('/stats/overview', controller.getStaffStatistics);
router.get('/role/:role', controller.getStaffByRole);
router.get('/:id/login-access', requireModuleAccess('laboratory', 'manage'), requireActionPermission('user_access_manage'), controller.getPathologyStaffLoginAccess);
router.put('/:id/login-access', requireModuleAccess('laboratory', 'manage'), requireActionPermission('user_access_manage'), controller.updatePathologyStaffLoginAccess);
router.put('/:id/password', requireModuleAccess('laboratory', 'manage'), requireActionPermission('user_access_manage'), controller.updateStaffPassword);
router.route('/')
  .get(controller.getAllPathologyStaff)
  .post(requireModuleAccess('laboratory', 'manage'), controller.createPathologyStaff);
router.route('/:id')
  .get(controller.getPathologyStaffById)
  .put(requireModuleAccess('laboratory', 'manage'), controller.updatePathologyStaff)
  .delete(requireModuleAccess('laboratory', 'manage'), controller.deletePathologyStaff);
router.post('/:id/assign-tests', requireModuleAccess('laboratory', 'manage'), controller.assignLabTests);
router.put('/:id/performance', requireModuleAccess('laboratory', 'manage'), controller.updatePerformanceMetrics);
module.exports = router;
