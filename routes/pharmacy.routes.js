const express = require('express');
const router = express.Router();
const {
  createPharmacy,
  getAllPharmacies,
  getPharmacyById,
  updatePharmacy,
  deletePharmacy
} = require('../controllers/pharmacy.controller');
const operations = require('../controllers/pharmacyOperations.controller');
const { verifyToken, authorize } = require('../middlewares/auth');

// Auth can be enforced without changing local/demo behavior by setting PHARMACY_AUTH_REQUIRED=true.
const authChain = process.env.PHARMACY_AUTH_REQUIRED === 'true'
  ? [verifyToken, authorize('admin', 'pharmacy', 'nurse', 'doctor', 'staff', 'accountant')]
  : [];

// ========== SETTINGS & CONFIGURATION ==========
router.get('/settings', ...authChain, operations.getSettings);
router.put('/settings', ...authChain, operations.updateSettings);

// ========== PATIENT SEARCH & MANAGEMENT ==========
router.get('/patients/search', ...authChain, operations.searchPharmacyPatients);

// ========== OUTSTANDING SETTLEMENTS ==========
router.post('/settlements/outstanding', ...authChain, operations.settleOutstanding);
router.get('/sales/:saleId/bill', ...authChain, operations.getSaleBill);

// ========== IPD ADMISSION CLEARANCE ==========
router.get('/ipd/admissions/:admissionId/final-clearance', ...authChain, operations.getAdmissionFinalClearance);

// ========== REPORTS ==========
router.get('/reports/doctor-commission', ...authChain, operations.getDoctorCommissionReport);
router.get('/reports/doctor-bills', ...authChain, operations.getDoctorBillReport);

// ========== DASHBOARD & ANALYTICS ==========
router.get('/dashboard', ...authChain, operations.getDashboard);
router.get('/analytics/inventory', ...authChain, operations.getInventoryAnalytics);
router.get('/analytics/purchases', ...authChain, operations.getPurchaseAnalytics);
router.get('/ledger/daily', ...authChain, operations.getLedgerDaily);
router.get('/inventory/ledger', ...authChain, operations.getInventoryLedger);
router.get('/dose-calculation', ...authChain, operations.getDoseCalculation);

// ========== SALES OPERATIONS ==========
router.post('/sales/quote', ...authChain, operations.quoteSale);
router.post('/sales', ...authChain, operations.createSale);

// ========== IPD MEDICATION & DISPENSING ==========
router.get('/ipd/search-admissions', ...authChain, operations.searchIPDAdmissions);
router.get('/ipd/queue', ...authChain, operations.getIPDQueue);
router.post('/ipd/dispense', ...authChain, operations.dispenseIPDMedication);
router.post('/ipd/advance', ...authChain, operations.depositAdvance);
router.post(
  '/ipd/admissions/:admissionId/refund-advance',
  ...authChain,
  operations.refundPharmacyAdvance
);

// ========== IPD PATIENT MANAGEMENT ==========
router.get('/ipd/patients', ...authChain, operations.getIPDPatients);
router.get('/ipd/patient-ledger/:patientId', ...authChain, operations.getPatientPharmacyLedger);
router.get('/ipd/admissions/:admissionId/file', ...authChain, operations.getAdmissionPharmacyFile);
router.get('/ipd/admissions/:admissionId/medicine-stock', ...authChain, operations.getAdmissionMedicineStock);
router.get('/ipd/admissions/:admissionId/advance-ledger', ...authChain, operations.getAdvanceLedger);


// ========== FINAL LEDGER SETTLEMENTS ==========
const pharmacyLedgerSettlement = require('../controllers/pharmacyLedgerSettlement.controller');
router.post('/ledger-settlements/preview', ...authChain, pharmacyLedgerSettlement.preview);
router.post('/ledger-settlements', ...authChain, pharmacyLedgerSettlement.create);
router.get('/ledger-settlements', ...authChain, pharmacyLedgerSettlement.list);
router.get('/ledger-settlements/:settlementId', ...authChain, pharmacyLedgerSettlement.getOne);
router.post('/ledger-settlements/:settlementId/reverse', ...authChain, pharmacyLedgerSettlement.reverse);

// ========== DEFERRED PAYMENTS ENDPOINTS ==========
// Get deferred payments for a specific admission
router.get('/ipd/admissions/:admissionId/deferred-payments', ...authChain, operations.getDeferredPaymentsByAdmission);

// Get all deferred payments across admissions (with filters)
router.get('/deferred-payments', ...authChain, operations.getAllDeferredPayments);

// Settle a single deferred payment (mark as paid) - UPDATED with discount support
router.post('/deferred-payments/:saleId/settle', ...authChain, operations.settleDeferredPayment);

// Bulk settle multiple deferred payments (POS-like interface) - NEW
router.post('/deferred-payments/bulk-settle', ...authChain, operations.bulkSettleDeferredPayments);

// Get deferred payment settlement summary for an admission - NEW
router.get('/ipd/admissions/:admissionId/deferred-summary', ...authChain, operations.getDeferredSettlementSummary);

// ========== RETURNS ==========
router.post('/returns', ...authChain, operations.createReturn);
router.get('/returns', ...authChain, operations.getReturns);

// ========== PHARMACY CRUD (ADMIN SCREENS) ==========
router.post('/', createPharmacy);
router.get('/', getAllPharmacies);
router.get('/:id', getPharmacyById);
router.put('/:id', updatePharmacy);
router.delete('/:id', deletePharmacy);

module.exports = router;