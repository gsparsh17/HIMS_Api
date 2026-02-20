const express = require('express');
const router = express.Router();
const {
  generateAppointmentInvoice,
  generatePharmacyInvoice,
  generatePurchaseInvoice,
  getAllInvoices,
  getInvoiceById,
  updateInvoicePayment,
  getInvoicesByType,
  getInvoiceStatistics,
  exportInvoices,
  downloadInvoicePDF,
  getPharmacyInvoices,
  getPharmacyMonthlyRevenue,
  getPharmacyDailyRevenue
} = require('../controllers/invoice.controller');

const invoiceController = require('../controllers/invoice.controller');

// Procedure module routes
router.post('/procedure', invoiceController.generateProcedureInvoice);
router.get('/procedures', invoiceController.getProcedureInvoices);
router.get('/with-procedures', invoiceController.getInvoicesWithProcedures);
router.put('/:invoiceId/procedures/:procedureIndex/status', invoiceController.updateInvoiceProcedureStatus);

// ✅ Lab Tests module routes
router.post('/labtest', invoiceController.generateLabTestInvoice);
router.get('/labtests', invoiceController.getLabTestInvoices);
router.get('/with-labtests', invoiceController.getInvoicesWithLabTests);
router.put('/:invoiceId/labtests/:labTestIndex/status', invoiceController.updateInvoiceLabTestStatus);

// Existing routes
router.post('/appointment', generateAppointmentInvoice);
router.post('/pharmacy', generatePharmacyInvoice);
router.post('/purchase', generatePurchaseInvoice);

router.get('/', getAllInvoices);
router.get('/pharmacy', getPharmacyInvoices);
router.get('/stats', getInvoiceStatistics);
router.get('/stats/pharmacy-monthly', getPharmacyMonthlyRevenue);
router.get('/stats/pharmacy-daily', getPharmacyDailyRevenue);
router.get('/export', exportInvoices);
router.get('/type/:type', getInvoicesByType);

// IMPORTANT: download must come before /:id
router.get('/:id/download', downloadInvoicePDF);
router.get('/:id', getInvoiceById);

router.put('/:id/payment', updateInvoicePayment);

module.exports = router;
