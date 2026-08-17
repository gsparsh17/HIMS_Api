const express = require('express');
const router = express.Router();
const controller = require('../controllers/claim.controller');
const readinessController = require('../controllers/claimReadiness.controller');
const { protect, authorize, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

router.use(protect);
const financeView = requireModuleAccess('billing_finance', 'view');
const financeManage = requireModuleAccess('billing_finance', 'manage');


router.get('/scheme-rule-profiles', financeView, readinessController.listRuleProfiles);
router.put('/scheme-rule-profiles', financeManage, authorize('admin', 'mediqliq_super_admin'), readinessController.upsertRuleProfile);
router.get('/claims/:id/readiness', financeView, readinessController.getReadiness);
router.post('/claims/:id/readiness/override', financeManage, requireActionPermission('claim_manage'), readinessController.overrideReadiness);
router.delete('/claims/:id/readiness/override', financeManage, requireActionPermission('claim_manage'), readinessController.clearReadinessOverride);
router.get('/claims/:id/evidence', financeView, readinessController.listEvidence);
router.post('/claims/:id/evidence', financeManage, requireActionPermission('claim_manage'), readinessController.addEvidence);
router.patch('/claims/:id/evidence/:evidenceId', financeManage, requireActionPermission('claim_manage'), readinessController.updateEvidence);

router.post('/claims', financeManage, requireActionPermission('claim_manage'), controller.create);
router.get('/claims', financeView, controller.list);
router.get('/claims/reports/mis', financeView, controller.report);
router.get('/claims/reports/export', financeView, requireActionPermission('claim_export'), controller.exportReport);
router.get('/claims/:id', financeView, controller.get);
router.patch('/claims/:id', financeManage, requireActionPermission('claim_manage'), controller.updateDraft);
router.post('/claims/:id/rebuild-lines', financeManage, requireActionPermission('claim_manage'), controller.refresh);
router.post('/claims/:id/submit', financeManage, requireActionPermission('claim_submit'), controller.submit);
router.post('/claims/:id/adjudicate', financeManage, requireActionPermission('claim_manage'), controller.adjudicate);
router.post('/claims/:id/query-response', financeManage, requireActionPermission('claim_manage'), controller.queryResponse);
router.post('/claims/:id/settlement', financeManage, requireActionPermission('settlement'), controller.settlement);
router.post('/claims/:id/cancel', financeManage, requireActionPermission('claim_manage'), controller.cancel);
router.get('/sponsor-ledger', financeView, controller.ledger);
router.get('/sponsor-ledger/export', financeView, requireActionPermission('claim_export'), controller.exportLedger);

module.exports = router;
