const express = require('express');
const router = express.Router();
const controller = require('../controllers/claim.controller');
const { protect, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');

router.use(protect);
const financeManage = requireModuleAccess('billing_finance', 'manage');

router.post('/claims', financeManage, controller.create);
router.get('/claims', financeManage, controller.list);
router.get('/claims/:id', financeManage, controller.get);
router.post('/claims/:id/submit', financeManage, requireActionPermission('claim_submit'), controller.submit);
router.post('/claims/:id/query-response', financeManage, controller.queryResponse);
router.post('/claims/:id/settlement', financeManage, requireActionPermission('settlement'), controller.settlement);
router.get('/sponsor-ledger', financeManage, controller.ledger);

module.exports = router;
