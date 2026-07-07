const express = require('express');

const router = express.Router();

const operations = require('../controllers/pharmacyOperations.controller');
const financial = require('../controllers/pharmacyFinancialV2.controller');
const pharmacyLedgerSettlement = require('../controllers/pharmacyLedgerSettlement.controller');

const { protect } = require('../middlewares/auth');

const {
  createPharmacy,
  getAllPharmacies,
  getPharmacyById,
  updatePharmacy,
  deletePharmacy,
} = require('../controllers/pharmacy.controller');

/*
 * Every pharmacy API requires login.
 *
 * No requireModuleAccess().
 * No route-level hospital-context middleware.
 *
 * Controllers/services use req.user.hospital_id where required.
 */
router.use(protect);

// ========== SETTINGS ==========
router.get('/settings', operations.getSettings);
router.put('/settings', operations.updateSettings);

// ========== POS ==========
router.post('/pos/quote', financial.quotePos);
router.post('/pos/complete', financial.completePos);
router.get('/sales/:saleId/bill', operations.getSaleBill);

// ========== PATIENTS ==========
router.get('/patients/search', operations.searchPharmacyPatients);

// ========== RETURNS ==========
router.post('/returns/preview', financial.previewReturn);
router.post('/returns/complete', financial.completeReturn);
router.get('/returns', operations.getReturns);

// ========== CLEARANCE ==========
router.get(
  '/clearance/:admissionId/preview',
  financial.clearancePreview
);

router.post(
  '/clearance/:admissionId/complete',
  financial.clearanceComplete
);

// ========== LEDGER ==========
router.get('/ledger/patient/:patientId', financial.groupedLedger);
router.get('/ledger/daily', operations.getLedgerDaily);
router.get('/inventory/ledger', operations.getInventoryLedger);

// ========== DASHBOARD / REPORTS ==========
router.get('/dashboard', operations.getDashboard);
router.get('/analytics/inventory', operations.getInventoryAnalytics);
router.get('/analytics/purchases', operations.getPurchaseAnalytics);
router.get('/reports/doctor-commission', operations.getDoctorCommissionReport);
router.get('/reports/doctor-bills', operations.getDoctorBillReport);
router.get('/dose-calculation', operations.getDoseCalculation);

// ========== IPD PHARMACY ==========
router.get('/ipd/search-admissions', operations.searchIPDAdmissions);
router.get('/ipd/queue', operations.getIPDQueue);

router.post('/ipd/dispense', operations.dispenseIPDMedication);
router.post('/ipd/advance', operations.depositAdvance);

router.post(
  '/ipd/admissions/:admissionId/refund-advance',
  operations.refundPharmacyAdvance
);

router.get('/ipd/patients', operations.getIPDPatients);

router.get(
  '/ipd/patient-ledger/:patientId',
  operations.getPatientPharmacyLedger
);

router.get(
  '/ipd/admissions/:admissionId/file',
  operations.getAdmissionPharmacyFile
);

router.get(
  '/ipd/admissions/:admissionId/medicine-stock',
  operations.getAdmissionMedicineStock
);

router.get(
  '/ipd/admissions/:admissionId/advance-ledger',
  operations.getAdvanceLedger
);

router.get(
  '/ipd/admissions/:admissionId/final-clearance',
  operations.getAdmissionFinalClearance
);

// ========== LEDGER SETTLEMENTS ==========
router.post(
  '/ledger-settlements/preview',
  pharmacyLedgerSettlement.preview
);

router.post(
  '/ledger-settlements',
  pharmacyLedgerSettlement.create
);

router.get(
  '/ledger-settlements',
  pharmacyLedgerSettlement.list
);

router.get(
  '/ledger-settlements/:settlementId',
  pharmacyLedgerSettlement.getOne
);

router.post(
  '/ledger-settlements/:settlementId/reverse',
  pharmacyLedgerSettlement.reverse
);

// ========== DEFERRED PAYMENTS ==========
router.get('/deferred-payments', operations.getAllDeferredPayments);

router.get(
  '/ipd/admissions/:admissionId/deferred-payments',
  operations.getDeferredPaymentsByAdmission
);

router.post(
  '/deferred-payments/bulk-settle',
  operations.bulkSettleDeferredPayments
);

router.get(
  '/ipd/admissions/:admissionId/deferred-summary',
  operations.getDeferredSettlementSummary
);

// ========== INVENTORY / HOSPITAL ==========
router.get('/inventory/batches', operations.getInventoryBatches);
router.get('/hospital/details', operations.getHospitalDetails);
router.get('/medicines/search', operations.searchMedicines);

// ========== PHARMACY MASTER ==========
router.post('/', createPharmacy);
router.get('/', getAllPharmacies);
router.get('/:id', getPharmacyById);
router.put('/:id', updatePharmacy);
router.delete('/:id', deletePharmacy);

module.exports = router;