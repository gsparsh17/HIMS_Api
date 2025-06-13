const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billing.controller');

// Create bill
router.post('/', billingController.createBill);

// Read bills
router.get('/', billingController.getAllBills);
router.get('/:id', billingController.getBillById);

// Update bill status
router.put('/:id', billingController.updateBillStatus);

// Delete bill
router.delete('/:id', billingController.deleteBill);

module.exports = router;
