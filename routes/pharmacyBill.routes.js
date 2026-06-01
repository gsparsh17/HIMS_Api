const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');
const {
    getPatientPharmacyBills,
    getPharmacyBillById,
    updatePharmacyBillPayment,
    voidPharmacyBill
} = require('../controllers/pharmacyBill.controller');

// Get all pharmacy bills for a patient
router.get('/patient/:patientId',
    //   protect, 
    // authorize('pharmacy', 'pharmacy_head', 'admin', 'billing', 'patient'),
    getPatientPharmacyBills
);

// Get pharmacy bill by ID with full details
router.get('/:billId',
    //   protect, 
    // authorize('pharmacy', 'pharmacy_head', 'admin', 'billing'),
    getPharmacyBillById
);

// Update payment on a pharmacy bill
router.patch('/:billId/payment',
    //   protect, 
    // authorize('pharmacy', 'pharmacy_head', 'admin', 'billing'),
    updatePharmacyBillPayment
);

// Void/cancel a pharmacy bill
router.post('/:billId/void',
    //   protect, 
    // authorize('pharmacy_head', 'admin'),
    voidPharmacyBill
);

module.exports = router;