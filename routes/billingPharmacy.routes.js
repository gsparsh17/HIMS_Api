const express = require('express');
const router = express.Router();
// Corrected to use your controller file name
const billingController = require('../controllers/billingPharmacy.controller.js');

router.get('/', billingController.getAllInvoices);
router.get('/:id', billingController.getInvoiceById);
router.post('/:id/payments', billingController.recordPayment);

module.exports = router;