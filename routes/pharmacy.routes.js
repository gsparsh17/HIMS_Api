const express = require('express');

const router = express.Router();

const operations = require('../controllers/pharmacyOperations.controller');
const financial = require('../controllers/pharmacyFinancialV2.controller');
const pharmacyLedgerSettlement = require('../controllers/pharmacyLedgerSettlement.controller');

const { protect, requireModuleAccess, requirePharmacyFinancialAccess } = require('../middlewares/auth');

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

const pharmacyView = requireModuleAccess('pharmacy', 'view');
const pharmacyManage = requireModuleAccess('pharmacy', 'manage');
const pharmacyFinanceView = requirePharmacyFinancialAccess('view');
const pharmacyFinanceManage = requirePharmacyFinancialAccess('manage');

// ========== SETTINGS ==========
router.get('/settings', pharmacyView, operations.getSettings);
router.put('/settings', pharmacyManage, operations.updateSettings);

// ========== POS ==========
router.post('/pos/quote', pharmacyFinanceView, financial.quotePos);
router.post('/pos/complete', pharmacyFinanceManage, financial.completePos);
router.get('/sales/:saleId/bill', pharmacyFinanceView, operations.getSaleBill);

// ========== PATIENTS ==========
router.get('/patients/search', pharmacyFinanceView, operations.searchPharmacyPatients);

// ========== RETURNS ==========
router.post('/returns/preview', pharmacyFinanceView, financial.previewReturn);
router.post('/returns/complete', pharmacyFinanceManage, financial.completeReturn);
router.post('/returns/:returnId/approve', pharmacyFinanceManage, financial.approveReturn);
router.post('/returns/:returnId/reject', pharmacyFinanceManage, financial.rejectReturn);
router.get('/returns', pharmacyFinanceView, operations.getReturns);

// ========== CLEARANCE ==========
router.get(
  '/clearance/:admissionId/preview',
  pharmacyFinanceView,
  financial.clearancePreview
);

router.post(
  '/clearance/:admissionId/complete',
  pharmacyFinanceManage,
  financial.clearanceComplete
);

// ========== LEDGER ==========
router.get('/ledger/patient/:patientId', pharmacyFinanceView, financial.groupedLedger);
router.get('/ledger/daily', pharmacyFinanceView, operations.getLedgerDaily);
router.get('/inventory/ledger', pharmacyView, operations.getInventoryLedger);

// ========== DASHBOARD / REPORTS ==========
router.get('/dashboard', pharmacyFinanceView, operations.getDashboard);
router.get('/analytics/inventory', pharmacyView, operations.getInventoryAnalytics);
router.get('/analytics/purchases', pharmacyFinanceView, operations.getPurchaseAnalytics);
router.get('/reports/doctor-commission', pharmacyFinanceView, operations.getDoctorCommissionReport);
router.get('/reports/doctor-bills', pharmacyFinanceView, operations.getDoctorBillReport);
router.get('/dose-calculation', pharmacyView, operations.getDoseCalculation);

// ========== IPD PHARMACY ==========
router.get('/ipd/search-admissions', pharmacyFinanceView, operations.searchIPDAdmissions);
router.get('/ipd/queue', pharmacyFinanceView, operations.getIPDQueue);

router.post('/ipd/dispense', pharmacyFinanceManage, operations.dispenseIPDMedication);
router.post('/ipd/advance', pharmacyFinanceManage, operations.depositAdvance);

router.post(
  '/ipd/admissions/:admissionId/refund-advance',
  pharmacyFinanceManage,
  operations.refundPharmacyAdvance
);

router.get('/ipd/patients', pharmacyFinanceView, operations.getIPDPatients);

router.get(
  '/ipd/patient-ledger/:patientId',
  pharmacyFinanceView,
  operations.getPatientPharmacyLedger
);

router.get(
  '/ipd/admissions/:admissionId/file',
  pharmacyFinanceView,
  operations.getAdmissionPharmacyFile
);

router.get(
  '/ipd/admissions/:admissionId/medicine-stock',
  pharmacyFinanceView,
  operations.getAdmissionMedicineStock
);

router.get(
  '/ipd/admissions/:admissionId/advance-ledger',
  pharmacyFinanceView,
  operations.getAdvanceLedger
);

router.get(
  '/ipd/admissions/:admissionId/final-clearance',
  pharmacyFinanceView,
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
router.get('/inventory/batches', pharmacyView, operations.getInventoryBatches);
router.get('/hospital/details', pharmacyFinanceView, operations.getHospitalDetails);
router.get('/medicines/search', pharmacyView, operations.searchMedicines);

// ========== PHARMACY MASTER ==========
router.post('/', pharmacyManage, createPharmacy);
router.get('/', pharmacyView, getAllPharmacies);
router.get('/:id', pharmacyView, getPharmacyById);
router.put('/:id', pharmacyManage, updatePharmacy);
router.delete('/:id', pharmacyManage, deletePharmacy);

module.exports = router;