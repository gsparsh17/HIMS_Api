const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billing.controller');
const {
  protect,
  isAdmin,
  requireModuleAccess,
  requireActionPermission,
  requireAnyActionPermission
} = require('../middlewares/auth');

const viewBilling = requireModuleAccess('billing_finance', 'view');
const manageBilling = requireModuleAccess('billing_finance', 'manage');

router.use(protect);

// Patient-first dashboard routes must be declared before /:id.
router.get('/patients/summary', viewBilling, billingController.getPatientBillingSummaries);
router.get('/patients/:patientId/details', viewBilling, billingController.getPatientBillingDetails);

// Direct financial document creation is restricted to finance managers. Clinical
// modules should create operational requests/charges through their own services.
router.post('/procedure', manageBilling, billingController.generateProcedureBill);
router.post('/labtest', manageBilling, billingController.generateLabTestBill);
router.post('/radiology', manageBilling, billingController.generateRadiologyBill);

router.get('/deletion-requests/pending', viewBilling, isAdmin, billingController.getPendingDeletionRequests);
router.get('/deleted', viewBilling, isAdmin, billingController.getDeletedBills);
router.get('/appointment/:appointmentId', viewBilling, billingController.getBillByAppointmentId);
router.get('/admission/:admissionId', viewBilling, billingController.getBillByAdmissionId);
router.get('/:id/ledger', viewBilling, billingController.getBillLedger);

router.post('/', manageBilling, requireAnyActionPermission(['billing_create', 'billing_edit']), billingController.createBill);
router.get('/', viewBilling, billingController.getAllBills);
router.get('/:id', viewBilling, billingController.getBillById);
router.put('/:id', manageBilling, requireAnyActionPermission(['billing_edit', 'settlement']), billingController.updateBillStatus);
router.post('/:id/generate-invoice', manageBilling, requireAnyActionPermission(['billing_create', 'billing_finalize']), billingController.generateInvoiceFromBill);

router.post('/:id/request-deletion', manageBilling, requireAnyActionPermission(['billing_delete_charge', 'refund']), billingController.requestBillDeletion);
router.put('/:id/review-deletion', manageBilling, requireAnyActionPermission(['billing_delete_charge', 'refund']), billingController.reviewDeletionRequest);
router.delete('/:id/admin-delete', manageBilling, isAdmin, billingController.adminDeleteBill);
router.delete('/:id', manageBilling, requireAnyActionPermission(['billing_delete_charge', 'refund']), billingController.deleteBill);

module.exports = router;
