const express = require('express');
const { protect, authorize, requireModuleAccess, requireActionPermission } = require('../middlewares/auth');
const finance = require('../controllers/finance.controller');

const router = express.Router();
router.use(protect, requireModuleAccess('billing_finance'));

router.get('/dashboard', finance.getDashboard);
router.get('/mis/overview', finance.getMISOverview);
router.get('/mis/reports/:reportKey', finance.getMISReport);
router.get('/mis/reports/:reportKey/export', finance.exportMISReport);
router.get('/ipd/:admissionId/running-bill', finance.getRunningBill);
router.get('/ipd/:admissionId/ledger', finance.getFinancialLedger);
router.get('/ipd/:admissionId/clearance', finance.getFinancialClearance);

router.post('/ipd/:admissionId/charges', requireModuleAccess('billing_finance', 'manage'), finance.addIPDCharge);
router.patch('/ipd/:admissionId/charges/:chargeId/void', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('pricing_override'), finance.voidIPDCharge);
router.post('/ipd/:admissionId/bed-charges', requireModuleAccess('billing_finance', 'manage'), finance.generateBedCharge);
router.post('/ipd/:admissionId/discounts', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('pricing_override'), finance.applyIPDDiscount);
router.post('/ipd/:admissionId/invoices', requireModuleAccess('billing_finance', 'manage'), finance.issueIPDInvoice);
router.post('/ipd/:admissionId/payments', requireModuleAccess('billing_finance', 'manage'), finance.recordIPDPayment);
router.post('/ipd/:admissionId/advances', requireModuleAccess('billing_finance', 'manage'), finance.recordIPDAdvance);
router.post('/ipd/:admissionId/advance-refunds', requireModuleAccess('billing_finance', 'manage'), finance.refundIPDAdvance);
router.post('/ipd/:admissionId/final-clearance', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('final_clearance'), finance.finaliseIPDClearance);
router.post('/invoices/:invoiceId/credit-notes', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('pricing_override'), finance.createCreditNote);
router.post('/invoices/:invoiceId/refunds', requireModuleAccess('billing_finance', 'manage'), finance.refundInvoice);

module.exports = router;
