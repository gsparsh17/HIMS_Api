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

// Invoice routes
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