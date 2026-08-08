'use strict';

const express = require('express');
const controller = require('../controllers/nabh.controller');
const {
  authorize,
  requireModuleAccess,
  requireActionPermission
} = require('../middlewares/auth');

const router = express.Router();

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const view = requireModuleAccess('mis', 'view');
const manage = requireModuleAccess('mis', 'manage');
const clinicalManage = requireModuleAccess('opd', 'manage');

router.get('/coverage', view, asyncRoute(controller.getCoverage));
router.get('/dashboard', view, asyncRoute(controller.dashboard));
router.get('/master-data', view, asyncRoute(controller.masterData));

router.get('/settings', view, asyncRoute(controller.getSettings));
router.put(
  '/settings',
  authorize('admin', 'mediqliq_super_admin'),
  asyncRoute(controller.updateSettings)
);

router.get('/records', view, asyncRoute(controller.listRecords));
router.post('/records', manage, asyncRoute(controller.createRecord));
router.get('/records/:id', view, asyncRoute(controller.getRecord));
router.put('/records/:id', manage, asyncRoute(controller.updateRecord));
router.patch('/records/:id/status', manage, asyncRoute(controller.transitionRecord));
router.patch(
  '/records/:id/checklist/:itemId',
  manage,
  asyncRoute(controller.updateChecklist)
);
router.post('/records/:id/finalise', manage, asyncRoute(controller.finaliseRecord));
router.post('/records/:id/amend', manage, asyncRoute(controller.amendRecord));

router.get('/notifications', view, asyncRoute(controller.listNotifications));
router.post('/notifications', manage, asyncRoute(controller.createNotification));
router.post(
  '/notifications/:id/retry',
  manage,
  asyncRoute(controller.retryNotification)
);
router.post(
  '/notifications/:id/acknowledge',
  view,
  asyncRoute(controller.acknowledgeNotification)
);

router.get('/terminology', view, asyncRoute(controller.listTerminology));
router.put('/terminology', manage, asyncRoute(controller.upsertTerminology));
router.post('/terminology/import', manage, asyncRoute(controller.importTerminology));

router.post('/clinical/risk-scores', clinicalManage, asyncRoute(controller.calculateRisk));
router.post('/clinical/medication-check', clinicalManage, asyncRoute(controller.medicationCheck));
router.post('/clinical/cdss', clinicalManage, asyncRoute(controller.cdss));
router.post('/workforce/forecast', manage, asyncRoute(controller.workforceForecast));

router.get('/kpis', view, asyncRoute(controller.kpiSummary));
router.get('/kpis/export', view, asyncRoute(controller.kpiExport));
router.post('/devices/capture', manage, asyncRoute(controller.deviceCapture));

router.get(
  '/migration/export',
  manage,
  requireActionPermission('mis_export'),
  asyncRoute(controller.migrationExport)
);
router.post(
  '/migration/import',
  manage,
  requireActionPermission('bulk_import_commit'),
  asyncRoute(controller.migrationImport)
);

module.exports = router;
