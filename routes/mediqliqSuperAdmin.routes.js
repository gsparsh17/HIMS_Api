const express = require('express');
const router = express.Router();
const controller = require('../controllers/mediqliqSuperAdmin.controller');
const { protect, isMediQliqSuperAdmin } = require('../middlewares/auth');

const requireSuperAdmin = [protect, isMediQliqSuperAdmin];

// Public setup/auth routes
router.post('/auth/bootstrap', controller.bootstrapSuperAdmin);
router.post('/auth/login', controller.loginSuperAdmin);

// Profile
router.get('/me', requireSuperAdmin, controller.getMe);
router.patch('/me/password', requireSuperAdmin, controller.changePassword);

// Dashboard
router.get('/dashboard/stats', requireSuperAdmin, controller.getDashboardStats);

// User management
router.get('/users', requireSuperAdmin, controller.listUsers);
router.post('/users', requireSuperAdmin, controller.createUser);
router.patch('/users/:userId', requireSuperAdmin, controller.updateUser);
router.delete('/users/:userId', requireSuperAdmin, controller.deleteUser);

// Hospital management
router.get('/hospitals', requireSuperAdmin, controller.listHospitals);
router.post('/hospitals', requireSuperAdmin, controller.createHospital);
router.get('/hospitals/:hospitalId', requireSuperAdmin, controller.getHospital);
router.patch('/hospitals/:hospitalId', requireSuperAdmin, controller.updateHospital);
router.delete('/hospitals/:hospitalId', requireSuperAdmin, controller.deleteHospital);

// License management
router.get('/licenses', requireSuperAdmin, controller.listLicenses);
router.post('/licenses', requireSuperAdmin, controller.createLicense);
router.get('/licenses/:licenseId', requireSuperAdmin, controller.getLicense);
router.patch('/licenses/:licenseId', requireSuperAdmin, controller.updateLicense);
router.delete('/licenses/:licenseId', requireSuperAdmin, controller.deleteLicense);
router.patch('/licenses/:licenseId/reset-activations', requireSuperAdmin, controller.resetLicenseActivations);
router.delete('/licenses/:licenseId/activations/:activationId', requireSuperAdmin, controller.removeLicenseActivation);

// Audit logs
router.get('/audit-logs', requireSuperAdmin, controller.listAuditLogs);
router.get('/audit-logs/:auditLogId', requireSuperAdmin, controller.getAuditLog);
router.delete('/audit-logs/prune/old', requireSuperAdmin, controller.pruneAuditLogs);

module.exports = router;
