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
  getPharmacyMonthlyRevenue
} = require('../controllers/invoice.controller');
const invoiceController  = require('../controllers/invoice.controller');

router.post('/procedure', invoiceController.generateProcedureInvoice);
router.get('/procedures', invoiceController.getProcedureInvoices);
router.get('/with-procedures', invoiceController.getInvoicesWithProcedures);
router.put('/:invoiceId/procedures/:procedureIndex/status', invoiceController.updateInvoiceProcedureStatus);
router.post('/appointment', generateAppointmentInvoice);
router.post('/pharmacy', generatePharmacyInvoice);
router.post('/purchase', generatePurchaseInvoice);
router.get('/', getAllInvoices);
router.get('/pharmacy', getPharmacyInvoices);
router.get('/stats', getInvoiceStatistics);
router.get('/stats/pharmacy-monthly', getPharmacyMonthlyRevenue);
router.get('/export', exportInvoices);
router.get('/type/:type', getInvoicesByType);
router.get('/:id', getInvoiceById);
router.get('/:id/download', downloadInvoicePDF);
router.put('/:id/payment', updateInvoicePayment);

module.exports = router;