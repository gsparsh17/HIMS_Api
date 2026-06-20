const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billing.controller');
const { protect, authorize, isAdmin } = require('../middlewares/auth');

/**
 * Bill creation is used by OPD, lab, radiology, procedure and IPD screens.
 * Keep it broad enough for those counter users, but never expose financial
 * documents anonymously.
 */
const billingUsers = [
  'admin', 'accountant', 'staff', 'registrar', 'receptionist',
  'pharmacy', 'pathology_staff', 'radiology_staff', 'ot_staff', 'demo'
];
const billingApprovers = ['admin', 'accountant', 'demo'];

router.use(protect);

// Specific paths must be declared before /:id.
router.post('/procedure', authorize(...billingUsers), billingController.generateProcedureBill);
router.post('/labtest', authorize(...billingUsers), billingController.generateLabTestBill);
router.post('/radiology', authorize(...billingUsers), billingController.generateRadiologyBill);

router.get('/deletion-requests/pending', isAdmin, billingController.getPendingDeletionRequests);
router.get('/deleted', isAdmin, billingController.getDeletedBills);
router.get('/appointment/:appointmentId', authorize(...billingUsers), billingController.getBillByAppointmentId);
router.get('/admission/:admissionId', authorize(...billingUsers), billingController.getBillByAdmissionId);

router.post('/', authorize(...billingUsers), billingController.createBill);
router.get('/', authorize(...billingUsers), billingController.getAllBills);
router.get('/:id', authorize(...billingUsers), billingController.getBillById);
router.put('/:id', authorize(...billingUsers), billingController.updateBillStatus);

router.post('/:id/request-deletion', authorize(...billingUsers), billingController.requestBillDeletion);
router.put('/:id/review-deletion', authorize(...billingApprovers), billingController.reviewDeletionRequest);
// Existing permanent-delete endpoint is intentionally restricted to actual admins.
router.delete('/:id/admin-delete', isAdmin, billingController.adminDeleteBill);
router.delete('/:id', authorize(...billingUsers), billingController.deleteBill);

module.exports = router;
