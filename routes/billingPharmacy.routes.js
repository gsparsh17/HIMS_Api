const express = require('express');
const router = express.Router();
// Corrected to use your controller file name
const billingController = require('../controllers/billingPharmacy.controller.js');

router.get('/', billingController.getAllInvoices);
router.get('/:id', billingController.getInvoiceById);
router.post('/:id/payments', billingController.recordPayment);
// ... existing routes

// Add this new route for creating invoices
router.post('/', billingController.createInvoice);

module.exports = router;