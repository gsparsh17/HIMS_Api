const express = require('express');
const { protect, authorize, requireModuleAccess, requireActionPermission, requireAnyActionPermission, requireAnyModuleAccess } = require('../middlewares/auth');
const finance = require('../controllers/finance.controller');
const reconciliation = require('../controllers/reconciliation.controller');

const router = express.Router();
router.use(protect);
// Front Desk/admission users need the server policy contract even when they do
// not have Finance workspace access. This endpoint only resolves policy/quotes;
// it does not collect, invoice, refund or override accounting records.
router.post('/policy/resolve', requireAnyModuleAccess(['billing_finance', 'registration_opd', 'ipd']), finance.resolveFinancialPolicy);
router.use(requireModuleAccess('billing_finance'));

router.get('/dashboard', finance.getDashboard);
router.get('/kpis', finance.getCanonicalKpis);
router.get('/kpis/daily', finance.getCanonicalKpis);
router.get('/reports/:reportKey', finance.getCanonicalFinanceReport);
router.get('/pharmacy/projection', finance.getPharmacyFinanceProjection);
router.get('/pharmacy/integration-audit', requireActionPermission('billing_finalize'), finance.getPharmacyIntegrationAudit);
router.get('/reconciliation/issues', requireActionPermission('billing_finalize'), reconciliation.list);
router.post('/reconciliation/run', requireActionPermission('billing_finalize'), reconciliation.run);
router.patch('/reconciliation/issues/:issueId', requireActionPermission('billing_finalize'), reconciliation.update);
router.get('/feature-flags', requireActionPermission('billing_finalize'), reconciliation.getFlags);
router.put('/feature-flags', requireActionPermission('billing_finalize'), reconciliation.updateFlags);
router.get('/mis/overview', finance.getMISOverview);
router.get('/mis/reports/:reportKey', finance.getMISReport);
router.get('/mis/reports/:reportKey/export', finance.exportMISReport);
router.get('/patients/:patientId/workspace', finance.getPatientWorkspace);
router.get('/ipd/patients/:patientId/workspace', finance.getPatientIPDHistory);
router.post('/patients/:patientId/charges', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('billing_create'), finance.addOPDCharge);
router.post('/patients/:patientId/invoices', requireModuleAccess('billing_finance', 'manage'), requireAnyActionPermission(['billing_create', 'billing_finalize']), finance.issueOPDInvoice);
router.post('/patients/:patientId/payments/preview', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('settlement'), finance.previewOPDPayment);
router.post('/patients/:patientId/payments', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('settlement'), finance.recordOPDPayment);
router.post('/patients/:patientId/advances', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('settlement'), finance.recordOPDAdvance);
router.post('/patients/:patientId/advance-refunds', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('settlement'), finance.refundOPDAdvance);

router.get('/ipd/admissions', finance.listBillingAdmissions);
router.get('/ipd/:admissionId/workspace', finance.getIPDFinanceWorkspace);
router.get('/ipd/:admissionId/running-bill', finance.getRunningBill);
router.get('/ipd/:admissionId/ledger', finance.getFinancialLedger);
router.get('/ipd/:admissionId/clearance', finance.getFinancialClearance);

router.post('/ipd/:admissionId/charges', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('billing_create'), finance.addIPDCharge);
router.patch('/ipd/:admissionId/charges/:chargeId/void', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('pricing_override'), finance.voidIPDCharge);
router.post('/ipd/:admissionId/bed-charges', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('billing_create'), finance.generateBedCharge);
router.post('/ipd/:admissionId/discounts', requireModuleAccess('billing_finance', 'manage'), requireAnyActionPermission(['billing_apply_discount', 'discount_override']), finance.applyIPDDiscount);
router.post('/ipd/:admissionId/invoices', requireModuleAccess('billing_finance', 'manage'), requireAnyActionPermission(['billing_create', 'billing_finalize']), finance.issueIPDInvoice);
router.post('/ipd/:admissionId/payments', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('settlement'), finance.recordIPDPayment);
router.post('/ipd/:admissionId/advances', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('settlement'), finance.recordIPDAdvance);
router.post('/ipd/:admissionId/advance-refunds', requireModuleAccess('billing_finance', 'manage'), requireAnyActionPermission(['refund', 'settlement']), finance.refundIPDAdvance);
router.post('/ipd/:admissionId/final-clearance', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('final_clearance'), finance.finaliseIPDClearance);
router.post('/invoices/:invoiceId/credit-notes', requireModuleAccess('billing_finance', 'manage'), requireActionPermission('pricing_override'), finance.createCreditNote);
router.post('/invoices/:invoiceId/refunds', requireModuleAccess('billing_finance', 'manage'), requireAnyActionPermission(['refund', 'settlement']), finance.refundInvoice);

module.exports = router;
