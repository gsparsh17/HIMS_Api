const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoice.controller');
const Invoice = require('../models/Invoice');
const { requireResourcePatientAccess } = require('../middlewares/patientAccess');
const { protect, requireModuleAccess, requireActionPermission, requireAnyActionPermission } = require('../middlewares/auth');

const viewBilling = requireModuleAccess('billing_finance', 'view');
const manageBilling = requireModuleAccess('billing_finance', 'manage');
const invoicePatientView = requireResourcePatientAccess(Invoice, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'PAYMENT', scope: 'financial_read' });
const invoicePatientWrite = requireResourcePatientAccess(Invoice, { patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'PAYMENT', scope: 'financial_write' });

router.use(protect);

// Procedure invoices
router.post('/procedure', manageBilling, requireAnyActionPermission(['billing_create', 'billing_edit']), invoiceController.generateProcedureInvoice);
router.get('/procedures', viewBilling, invoiceController.getProcedureInvoices);
router.get('/with-procedures', viewBilling, invoiceController.getInvoicesWithProcedures);
router.put('/:invoiceId/procedures/:procedureIndex/status', manageBilling, invoiceController.updateInvoiceProcedureStatus);

// Laboratory invoices
router.post('/labtest', manageBilling, requireAnyActionPermission(['billing_create', 'billing_edit']), invoiceController.generateLabTestInvoice);
router.get('/labtests', viewBilling, invoiceController.getLabTestInvoices);
router.get('/with-labtests', viewBilling, invoiceController.getInvoicesWithLabTests);
router.put('/:invoiceId/labtests/:labTestIndex/status', manageBilling, invoiceController.updateInvoiceLabTestStatus);

// Radiology invoices
router.post('/radiology', manageBilling, requireAnyActionPermission(['billing_create', 'billing_edit']), invoiceController.generateRadiologyInvoice);
router.get('/radiology', viewBilling, invoiceController.getRadiologyInvoices);
router.get('/with-radiology', viewBilling, invoiceController.getInvoicesWithRadiology);
router.put('/:invoiceId/radiology/:radiologyIndex/status', manageBilling, invoiceController.updateInvoiceRadiologyStatus);

router.post('/appointment', manageBilling, requireAnyActionPermission(['billing_create', 'billing_edit']), invoiceController.generateAppointmentInvoice);
router.post('/pharmacy', manageBilling, requireAnyActionPermission(['billing_create', 'billing_edit']), invoiceController.generatePharmacyInvoice);
router.post('/purchase', manageBilling, requireAnyActionPermission(['billing_create', 'billing_edit']), invoiceController.generatePurchaseInvoice);

router.get('/', viewBilling, invoiceController.getAllInvoices);
router.get('/pharmacy', viewBilling, invoiceController.getPharmacyInvoices);
router.get('/stats', viewBilling, invoiceController.getInvoiceStatistics);
router.get('/stats/pharmacy-monthly', viewBilling, invoiceController.getPharmacyMonthlyRevenue);
router.get('/stats/pharmacy-daily', viewBilling, invoiceController.getPharmacyDailyRevenue);
router.get('/export', viewBilling, invoiceController.exportInvoices);
router.get('/type/:type', viewBilling, invoiceController.getInvoicesByType);

router.get('/:id/download', viewBilling, invoicePatientView, invoiceController.downloadInvoicePDF);
router.get('/:id', viewBilling, invoicePatientView, invoiceController.getInvoiceById);
router.put('/:id/payment', manageBilling, requireAnyActionPermission(['billing_edit', 'settlement']), invoicePatientWrite, invoiceController.updateInvoicePayment);

module.exports = router;
