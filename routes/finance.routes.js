const express = require('express');
const { protect, authorize } = require('../middlewares/auth');
const finance = require('../controllers/finance.controller');

const router = express.Router();
const financeUsers = ['admin', 'accountant', 'registrar', 'staff'];
const reportUsers = ['admin', 'accountant'];
const approvers = ['admin', 'accountant'];

router.use(protect);

// Dashboard / MIS (admin and accountant can view/export all financial reports)
router.get('/dashboard', finance.getDashboard);
router.get('/mis/overview', finance.getMISOverview);
router.get('/mis/reports/:reportKey', finance.getMISReport);
router.get('/mis/reports/:reportKey/export', finance.exportMISReport);

// IPD billing workspace
router.get('/ipd/:admissionId/running-bill', finance.getRunningBill);
router.get('/ipd/:admissionId/ledger', finance.getFinancialLedger);
router.get('/ipd/:admissionId/clearance', finance.getFinancialClearance);
router.post('/ipd/:admissionId/charges', finance.addIPDCharge);
router.patch('/ipd/:admissionId/charges/:chargeId/void', finance.voidIPDCharge);
router.post('/ipd/:admissionId/bed-charges', finance.generateBedCharge);
router.post('/ipd/:admissionId/discounts', finance.applyIPDDiscount);
router.post('/ipd/:admissionId/invoices', finance.issueIPDInvoice);
router.post('/ipd/:admissionId/payments', finance.recordIPDPayment);
router.post('/ipd/:admissionId/advances', finance.recordIPDAdvance);
router.post('/ipd/:admissionId/advance-refunds', finance.refundIPDAdvance);
router.post('/ipd/:admissionId/final-clearance', finance.finaliseIPDClearance);

// Controlled post-issue corrections
router.post('/invoices/:invoiceId/credit-notes', finance.createCreditNote);
router.post('/invoices/:invoiceId/refunds', finance.refundInvoice);

module.exports = router;
