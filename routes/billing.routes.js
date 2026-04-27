const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billing.controller');
const { verifyToken, isAdmin } = require('../middlewares/auth');

// Generate bills for procedures, lab tests, and radiology
router.post('/procedure', billingController.generateProcedureBill);
router.post('/labtest', billingController.generateLabTestBill);
router.post('/radiology', billingController.generateRadiologyBill);  // ✅ NEW

// Existing routes
router.post('/', billingController.createBill);
router.get('/', billingController.getAllBills);

// Deletion request routes
router.post('/:id/request-deletion', verifyToken, billingController.requestBillDeletion);
router.get('/deletion-requests/pending', verifyToken, isAdmin, billingController.getPendingDeletionRequests);
router.put('/:id/review-deletion', verifyToken, isAdmin, billingController.reviewDeletionRequest);
router.get('/deleted', verifyToken, isAdmin, billingController.getDeletedBills);

// Admin direct delete (permanent)
router.delete('/:id/admin-delete', verifyToken, isAdmin, billingController.adminDeleteBill);

// IMPORTANT: keep specific routes BEFORE /:id
router.get('/appointment/:appointmentId', billingController.getBillByAppointmentId);
router.get('/admission/:admissionId', billingController.getBillByAdmissionId);  // ✅ NEW

router.get('/:id', billingController.getBillById);
router.put('/:id', billingController.updateBillStatus);
router.delete('/:id', verifyToken, billingController.deleteBill);

module.exports = router;