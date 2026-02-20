const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billing.controller');

// Generate bills
router.post('/procedure', billingController.generateProcedureBill);
router.post('/labtest', billingController.generateLabTestBill);

// Existing routes
router.post('/', billingController.createBill);
router.get('/', billingController.getAllBills);

// IMPORTANT: keep /appointment/:appointmentId BEFORE /:id
router.get('/appointment/:appointmentId', billingController.getBillByAppointmentId);

router.get('/:id', billingController.getBillById);
router.put('/:id', billingController.updateBillStatus);
router.delete('/:id', billingController.deleteBill);

module.exports = router;
