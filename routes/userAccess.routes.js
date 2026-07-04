const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const controller = require('../controllers/userAccess.controller');

// All routes require authentication and user access management permission
router.use(protect);
router.use(authorize('admin', 'mediqliq_super_admin'));

// Get all users
router.get('/users', controller.getUsers);

// Create new user
router.post('/users', controller.createUser);

// Update user permissions
router.put('/users/:userId/permissions', controller.updateUserPermissions);

// Reset user password
router.put('/users/:userId/password', controller.resetPassword);

module.exports = router;