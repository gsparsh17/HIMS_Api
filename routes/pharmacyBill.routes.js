const express = require('express');
const { requirePatientAccess } = require('../middlewares/patientAccess');
const router = express.Router();
const { protect, requirePharmacyFinancialAccess } = require('../middlewares/auth');
const {
    getPatientPharmacyBills,
    getPharmacyBillById,
    updatePharmacyBillPayment,
    voidPharmacyBill
} = require('../controllers/pharmacyBill.controller');

// Every pharmacy-bill endpoint is authenticated and tenant-scoped by the
// controller. Restricted/delegated admins additionally need the explicit
// pharmacy_finance_access action via requirePharmacyFinancialAccess.
router.use(protect);

const pharmacyFinanceView = requirePharmacyFinancialAccess('view');
const pharmacyFinanceManage = requirePharmacyFinancialAccess('manage');

// Get all pharmacy bills for a patient
router.get('/patient/:patientId', pharmacyFinanceView, requirePatientAccess({ patientParam: 'patientId', purpose: 'PAYMENT', scope: 'demographic_read' }), getPatientPharmacyBills);

// Get pharmacy bill by ID with full details
router.get('/:billId', pharmacyFinanceView, getPharmacyBillById);

// Update payment on a pharmacy bill
router.patch('/:billId/payment', pharmacyFinanceManage, updatePharmacyBillPayment);

// Void/cancel a pharmacy bill
router.post('/:billId/void', pharmacyFinanceManage, voidPharmacyBill);

module.exports = router;