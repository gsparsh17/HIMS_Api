const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billing.controller');

// Create bill
router.post('/procedure', billingController.generateProcedureBill);

// Existing routes
router.post('/', billingController.createBill);
router.get('/', billingController.getAllBills);
router.get('/:id', billingController.getBillById);
router.put('/:id', billingController.updateBillStatus);
router.delete('/:id', billingController.deleteBill);
router.get('/appointment/:appointmentId', billingController.getBillByAppointmentId);


module.exports = router;
