const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staff.controller');
const { protect, authorize, requireActionPermission } = require('../middlewares/auth');

// The Staff Login page is the only place that creates/updates a staff login
// and its high-level feature access. It is intentionally admin-only.
router.get('/:id/login-access', protect, authorize('admin', 'mediqliq_super_admin'), requireActionPermission('user_access_manage'), staffController.getStaffLoginAccess);
router.put('/:id/login-access', protect, authorize('admin', 'mediqliq_super_admin'), requireActionPermission('user_access_manage'), staffController.updateStaffLoginAccess);

// Existing staff CRUD routes remain unchanged for normal staff-record operations.
router.post('/', staffController.createStaff);
router.get('/', staffController.getAllStaff);
router.get('/:id', staffController.getStaffById);
router.put('/:id', staffController.updateStaff);
router.delete('/:id', staffController.deleteStaff);

module.exports = router;
