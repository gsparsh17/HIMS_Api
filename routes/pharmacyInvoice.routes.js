// const express = require('express');
// const router = express.Router();
// // Updated import to the new controller file name
// const { createInvoiceAndHandleStock } = require('../controllers/pharmacyInvoiceController.js');

// router.post('/from-prescription', createInvoiceAndHandleStock);

// module.exports = router;

const express = require('express');
const router = express.Router();

// ADD THIS: Import the download function along with the create function
const { 
  createInvoiceAndHandleStock,
  downloadInvoicePDF,
  getAllPharmacyInvoices,
  getPharmacyInvoiceById,
  getMonthlyRevenue 
} = require('../controllers/pharmacyInvoiceController.js');

// router.post('/', createInvoice);
router.get('/stats/monthly-revenue', getMonthlyRevenue);
router.get('/', getAllPharmacyInvoices);
router.post('/from-prescription', createInvoiceAndHandleStock);

router.get('/:id', getPharmacyInvoiceById);
// ADD THIS: The route for downloading the PDF
router.get('/:id/download', downloadInvoicePDF);

module.exports = router;