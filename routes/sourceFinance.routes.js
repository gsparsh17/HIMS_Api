const express = require('express');
const { protect, requireActionPermission, requireAnyModuleAccess } = require('../middlewares/auth');
const sourceFinance = require('../controllers/sourceFinance.controller');
const router = express.Router();

// Clinical modules may create the canonical obligation when this explicit
// action is granted. Collection/discount override/finalisation remain separate
// Finance permissions.
const viewClinicalFinance = requireAnyModuleAccess(['billing_finance', 'laboratory', 'radiology', 'operation_theatre', 'ipd']);
router.get('/:sourceModule/:sourceId/status', protect, viewClinicalFinance, sourceFinance.getStatus);
router.post('/:sourceModule/:sourceId/policy', protect, viewClinicalFinance, sourceFinance.previewPolicy);
router.post('/:sourceModule/:sourceId/charge', protect, viewClinicalFinance, requireActionPermission('billing_create'), sourceFinance.postCharge);
router.post('/:sourceModule/:sourceId/reverse', protect, requireAnyModuleAccess(['billing_finance']), requireActionPermission('refund'), sourceFinance.reverseSource);

module.exports = router;
