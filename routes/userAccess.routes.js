const express = require('express');
const router = express.Router();
const { protect, authorize, requireActionPermission } = require('../middlewares/auth');
const controller = require('../controllers/userAccess.controller');

const requireAuth = [
  protect,
  authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager'),
  requireActionPermission('user_access_manage')
];

// Get all users
router.get('/users', requireAuth, controller.getUsers);

// Create new user
router.post('/users', requireAuth, controller.createUser);

// Update user permissions
router.put('/users/:userId/permissions', requireAuth, controller.updateUserPermissions);

// Reset user password
router.put('/users/:userId/password', requireAuth, controller.resetPassword);

module.exports = router;