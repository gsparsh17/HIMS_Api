const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billing.controller');
const { verifyToken, isAdmin } = require('../middlewares/auth');

// Generate bills
router.post('/procedure', billingController.generateProcedureBill);
router.post('/labtest', billingController.generateLabTestBill);

// Existing routes
router.post('/', billingController.createBill);
router.get('/', billingController.getAllBills);

// Deletion request routes
router.post('/:id/request-deletion', verifyToken, billingController.requestBillDeletion);
router.get('/deletion-requests/pending', verifyToken, isAdmin, billingController.getPendingDeletionRequests);
router.put('/:id/review-deletion', verifyToken, isAdmin, billingController.reviewDeletionRequest);
router.get('/deleted', verifyToken, isAdmin, billingController.getDeletedBills);

// IMPORTANT: keep /appointment/:appointmentId BEFORE /:id
router.get('/appointment/:appointmentId', billingController.getBillByAppointmentId);

router.get('/:id', billingController.getBillById);
router.put('/:id', billingController.updateBillStatus);
router.delete('/:id', verifyToken, billingController.deleteBill); // Now handles both admin and staff

module.exports = router;