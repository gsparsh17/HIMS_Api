const express = require('express');
const router = express.Router();
const controller = require('../controllers/mediqliqSuperAdmin.controller');
const { protect, isMediQliqSuperAdmin } = require('../middlewares/auth');
const abdmConfig = require('../config/abdm.config');
const abdmMasterController = require('../controllers/abdmMasterAdmin.controller');
const mediqliqAbdmController = require('../controllers/mediqliqAbdmAdmin.controller');

const requireSuperAdmin = [protect, isMediQliqSuperAdmin];

// Public setup/auth routes
router.post('/auth/bootstrap', controller.bootstrapSuperAdmin);
router.post('/auth/login', controller.loginSuperAdmin);

// Profile
router.get('/me', requireSuperAdmin, controller.getMe);
router.patch('/me/password', requireSuperAdmin, controller.changePassword);

// Dashboard
router.get('/dashboard/stats', requireSuperAdmin, controller.getDashboardStats);


// ABDM master control plane. These routes reuse the logged-in MediQliq super-admin
// session so the static ABDM master admin key is never exposed to the browser.
if (abdmConfig.isMaster) {
  router.get('/abdm/overview', requireSuperAdmin, mediqliqAbdmController.getOverview);

  router.get('/abdm/gateway/health', requireSuperAdmin, abdmMasterController.gatewayHealth);
  router.patch('/abdm/gateway/bridge-url', requireSuperAdmin, abdmMasterController.updateBridge);
  router.get('/abdm/gateway/services', requireSuperAdmin, abdmMasterController.bridgeServices);

  router.post('/abdm/facilities', requireSuperAdmin, abdmMasterController.createFacility);
  router.get('/abdm/facilities', requireSuperAdmin, abdmMasterController.listFacilities);
  router.get('/abdm/facilities/:facilityId', requireSuperAdmin, abdmMasterController.getFacility);
  router.patch('/abdm/facilities/:facilityId', requireSuperAdmin, abdmMasterController.updateFacility);
  router.post(
    '/abdm/facilities/:facilityId/rotate-connector-secret',
    requireSuperAdmin,
    abdmMasterController.rotateConnectorSecret
  );
  router.post(
    '/abdm/facilities/:facilityId/check-connector',
    requireSuperAdmin,
    abdmMasterController.checkFacilityConnector
  );

  router.get('/abdm/consents', requireSuperAdmin, mediqliqAbdmController.listConsents);
  router.get('/abdm/consents/:consentRecordId', requireSuperAdmin, mediqliqAbdmController.getConsent);
  router.get('/abdm/jobs', requireSuperAdmin, mediqliqAbdmController.listJobs);
  router.get('/abdm/jobs/:jobId', requireSuperAdmin, mediqliqAbdmController.getJob);

  router.get('/abdm/transactions', requireSuperAdmin, abdmMasterController.transactions);
  router.get('/abdm/transactions/:transactionId', requireSuperAdmin, mediqliqAbdmController.getTransaction);
  router.get('/abdm/webhook-events', requireSuperAdmin, abdmMasterController.webhookEvents);
  router.get('/abdm/webhook-events/:eventId', requireSuperAdmin, mediqliqAbdmController.getWebhookEvent);
}

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
