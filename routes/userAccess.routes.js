const express = require('express');
const router = express.Router();
const { protect, authorize, requireActionPermission } = require('../middlewares/auth');
const controller = require('../controllers/userAccess.controller');

const requireAuth = [
  protect,
  authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager'),
  requireActionPermission('user_access_manage')
];

const requireTemplateAdmin = [
  protect,
  authorize('admin', 'mediqliq_super_admin'),
  requireActionPermission('user_access_manage')
];

// Hospital-wide role templates. HR may read templates for Staff Login, but only
// hospital/platform admins may change the defaults in Settings.
router.get('/access-control/templates', requireAuth, controller.getAccessControlTemplates);
router.put('/access-control/templates/:role', requireTemplateAdmin, controller.updateAccessControlTemplate);
router.delete('/access-control/templates/:role', requireTemplateAdmin, controller.resetAccessControlTemplate);

// Get all users
router.get('/users', requireAuth, controller.getUsers);

// Create new user
router.post('/users', requireAuth, controller.createUser);

// Update user permissions
router.put('/users/:userId/permissions', requireAuth, controller.updateUserPermissions);

// Reset user password
router.put('/users/:userId/password', requireAuth, controller.resetPassword);

module.exports = router;