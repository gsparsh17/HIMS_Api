const express = require('express');

const { requirePatientAccess } = require('../middlewares/patientAccess');
const router = express.Router();

const operations = require('../controllers/pharmacyOperations.controller');
const financial = require('../controllers/pharmacyFinancialV2.controller');
const pharmacyLedgerSettlement = require('../controllers/pharmacyLedgerSettlement.controller');

const { protect, requirePharmacyFinancialAccess } = require('../middlewares/auth');

const {
  createPharmacy,
  getAllPharmacies,
  getPharmacyById,
  updatePharmacy,
  deletePharmacy,
} = require('../controllers/pharmacy.controller');

/*
 * Every pharmacy API requires login. Pharmacy-financial endpoints additionally
 * use requirePharmacyFinancialAccess so unrestricted admins and Pharmacy staff
 * keep their workflows while delegated admins require an explicit grant.
 * Controllers/services apply req.user.hospital_id for tenant scoping.
 */
router.use(protect);

const pharmacyFinanceView = requirePharmacyFinancialAccess('view');
const pharmacyFinanceManage = requirePharmacyFinancialAccess('manage');

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
router.get('/ledger/patient/:patientId', requirePatientAccess({ patientParam: 'patientId', purpose: 'PAYMENT', scope: 'demographic_read' }), financial.groupedLedger);
router.get('/ledger/daily', pharmacyFinanceView, operations.getLedgerDaily);
router.get('/inventory/ledger', operations.getInventoryLedger);

// ========== DASHBOARD / REPORTS ==========
router.get('/dashboard', operations.getDashboard);
router.get('/analytics/inventory', operations.getInventoryAnalytics);
router.get('/analytics/purchases', operations.getPurchaseAnalytics);
router.get('/reports/doctor-commission', operations.getDoctorCommissionReport);
router.get('/reports/doctor-bills', operations.getDoctorBillReport);
router.get('/dose-calculation', operations.getDoseCalculation);

// ========== IPD PHARMACY ==========
router.get('/ipd/search-admissions', pharmacyFinanceView, operations.searchIPDAdmissions);
router.get('/ipd/queue', operations.getIPDQueue);

router.post('/ipd/dispense', operations.dispenseIPDMedication);
router.post('/ipd/advance', pharmacyFinanceManage, operations.depositAdvance);

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
  pharmacyFinanceManage,
  pharmacyLedgerSettlement.preview
);

router.post(
  '/ledger-settlements',
  pharmacyFinanceManage,
  pharmacyLedgerSettlement.create
);

router.get(
  '/ledger-settlements',
  pharmacyFinanceView,
  pharmacyLedgerSettlement.list
);

router.get(
  '/ledger-settlements/:settlementId',
  pharmacyFinanceView,
  pharmacyLedgerSettlement.getOne
);

router.post(
  '/ledger-settlements/:settlementId/reverse',
  pharmacyFinanceManage,
  pharmacyLedgerSettlement.reverse
);

// ========== DEFERRED PAYMENTS ==========
router.get('/deferred-payments', pharmacyFinanceView, operations.getAllDeferredPayments);

router.get(
  '/ipd/admissions/:admissionId/deferred-payments',
  pharmacyFinanceView,
  operations.getDeferredPaymentsByAdmission
);

router.post(
  '/deferred-payments/bulk-settle',
  pharmacyFinanceManage,
  operations.bulkSettleDeferredPayments
);

router.get(
  '/ipd/admissions/:admissionId/deferred-summary',
  pharmacyFinanceView,
  operations.getDeferredSettlementSummary
);

// ========== INVENTORY / HOSPITAL ==========
router.get('/inventory/batches', operations.getInventoryBatches);
router.get('/hospital/details', pharmacyFinanceView, operations.getHospitalDetails);
router.get('/medicines/search', operations.searchMedicines);

// ========== PHARMACY MASTER ==========
router.post('/', createPharmacy);
router.get('/', getAllPharmacies);
router.get('/:id', getPharmacyById);
router.put('/:id', updatePharmacy);
router.delete('/:id', deletePharmacy);

module.exports = router;