const express = require("express");
const router = express.Router();
const operations = require("../controllers/pharmacyOperations.controller");
const financial = require("../controllers/pharmacyFinancialV2.controller");
const pharmacyLedgerSettlement = require("../controllers/pharmacyLedgerSettlement.controller");
const {
  protect,
  authorize,
  requireModuleAccess,
  requireActionPermission,
} = require("../middlewares/auth");

// Pharmacy CRUD controllers
const {
  createPharmacy,
  getAllPharmacies,
  getPharmacyById,
  updatePharmacy,
  deletePharmacy
} = require('../controllers/pharmacy.controller');

const pharmacyRoles = ["admin", "pharmacy", "accountant", "doctor", "nurse", "staff"];
const read = [protect, authorize(...pharmacyRoles)];

// ========== SETTINGS & CONFIGURATION ==========
router.get("/settings", ...read, operations.getSettings);
router.put(
  "/settings",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "edit"),
  operations.updateSettings
);

// ========== PATIENT SEARCH & MANAGEMENT ==========
router.get(
  "/patients/search",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "view"),
  operations.searchPharmacyPatients
);

// ========== OUTSTANDING SETTLEMENTS ==========
router.post(
  "/settlements/outstanding",
  // ...read,
  operations.settleOutstanding
);

// ========== POS (Point of Sale) ==========
router.post(
  "/pos/quote",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "view"),
  financial.quotePos
);
router.post(
  "/pos/complete",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "edit"),
  financial.completePos
);

// ========== SALES ==========
router.post(
  "/sales/quote",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "view"),
  operations.quoteSale
);
router.post(
  "/sales",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "edit"),
  operations.createSale
);
router.get(
  "/sales/:saleId/bill",
  // ...read,
  // requireModuleAccess("pharmacy.ledger", "view"),
  operations.getSaleBill
);

// ========== RETURNS ==========
router.post(
  "/returns/preview",
  // ...read,
  // requireModuleAccess("pharmacy.returns", "view"),
  financial.previewReturn
);
router.post(
  "/returns/complete",
  // ...read,
  // requireModuleAccess("pharmacy.returns", "edit"),
  financial.completeReturn
);
// Compatibility route intentionally uses the same authoritative return engine.
router.post(
  "/returns",
  // ...read,
  // requireModuleAccess("pharmacy.returns", "edit"),
  financial.completeReturn
);
router.get(
  "/returns",
  // ...read,
  // requireModuleAccess("pharmacy.returns", "view"),
  operations.getReturns
);

// ========== CLEARANCE ==========
router.get(
  "/clearance/:admissionId/preview",
  // ...read,
  // requireModuleAccess("pharmacy.clearance", "view"),
  financial.clearancePreview
);
router.post(
  "/clearance/:admissionId/complete",
  // ...read,
  // requireModuleAccess("pharmacy.clearance", "edit"),
  requireActionPermission("final_clearance"),
  financial.clearanceComplete
);

// ========== LEDGER ==========
router.get(
  "/ledger/patient/:patientId",
  // ...read,
  // requireModuleAccess("pharmacy.ledger", "view"),
  financial.groupedLedger
);
router.get(
  "/ledger/daily",
  // ...read,
  // requireModuleAccess("pharmacy.ledger", "view"),
  operations.getLedgerDaily
);
router.get(
  "/inventory/ledger",
  // ...read,
  // requireModuleAccess("pharmacy.ledger", "view"),
  operations.getInventoryLedger
);

// ========== DASHBOARD & ANALYTICS ==========
router.get("/dashboard", ...read, operations.getDashboard);
router.get(
  "/analytics/inventory",
  // ...read,
  operations.getInventoryAnalytics
);
router.get(
  "/analytics/purchases",
  // ...read,
  operations.getPurchaseAnalytics
);
router.get(
  "/reports/doctor-commission",
  // ...read,
  operations.getDoctorCommissionReport
);
router.get(
  "/reports/doctor-bills",
  // ...read,
  operations.getDoctorBillReport
);
router.get(
  "/dose-calculation",
  // ...read,
  operations.getDoseCalculation
);

// ========== IPD (In-Patient Department) ==========
router.get(
  "/ipd/search-admissions",
  // ...read,
  operations.searchIPDAdmissions
);
router.get("/ipd/queue", ...read, operations.getIPDQueue);
router.post(
  "/ipd/dispense",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "edit"),
  operations.dispenseIPDMedication
);
router.post(
  "/ipd/advance",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "edit"),
  operations.depositAdvance
);
router.post(
  "/ipd/admissions/:admissionId/refund-advance",
  // ...read,
  // requireModuleAccess("pharmacy.returns", "edit"),
  requireActionPermission("refund"),
  operations.refundPharmacyAdvance
);
router.get("/ipd/patients", ...read, operations.getIPDPatients);
router.get(
  "/ipd/patient-ledger/:patientId",
  // ...read,
  // requireModuleAccess("pharmacy.ledger", "view"),
  operations.getPatientPharmacyLedger
);
router.get(
  "/ipd/admissions/:admissionId/file",
  // ...read,
  operations.getAdmissionPharmacyFile
);
router.get(
  "/ipd/admissions/:admissionId/medicine-stock",
  // ...read,
  operations.getAdmissionMedicineStock
);
router.get(
  "/ipd/admissions/:admissionId/advance-ledger",
  // ...read,
  operations.getAdvanceLedger
);

// ========== IPD ADMISSION CLEARANCE ==========
router.get(
  "/ipd/admissions/:admissionId/final-clearance",
  // ...read,
  operations.getAdmissionFinalClearance
);

// ========== LEDGER SETTLEMENTS ==========
router.post(
  "/ledger-settlements/preview",
  // ...read,
  // requireModuleAccess("pharmacy.clearance", "view"),
  pharmacyLedgerSettlement.preview
);
router.post(
  "/ledger-settlements",
  // ...read,
  // requireModuleAccess("pharmacy.clearance", "edit"),
  requireActionPermission("settlement"),
  pharmacyLedgerSettlement.create
);
router.get(
  "/ledger-settlements",
  // ...read,
  // requireModuleAccess("pharmacy.ledger", "view"),
  pharmacyLedgerSettlement.list
);
router.get(
  "/ledger-settlements/:settlementId",
  // ...read,
  // requireModuleAccess("pharmacy.ledger", "view"),
  pharmacyLedgerSettlement.getOne
);
router.post(
  "/ledger-settlements/:settlementId/reverse",
  // ...read,
  // requireModuleAccess("pharmacy.clearance", "edit"),
  requireActionPermission("refund"),
  pharmacyLedgerSettlement.reverse
);

// ========== DEFERRED PAYMENTS ==========
router.get(
  "/deferred-payments",
  // ...read,
  operations.getAllDeferredPayments
);
router.get(
  "/ipd/admissions/:admissionId/deferred-payments",
  // ...read,
  operations.getDeferredPaymentsByAdmission
);
router.post(
  "/deferred-payments/:saleId/settle",
  // ...read,
  // requireModuleAccess("pharmacy.clearance", "edit"),
  operations.settleDeferredPayment
);
router.post(
  "/deferred-payments/bulk-settle",
  // ...read,
  // requireModuleAccess("pharmacy.clearance", "edit"),
  requireActionPermission("settlement"),
  operations.bulkSettleDeferredPayments
);
router.get(
  "/ipd/admissions/:admissionId/deferred-summary",
  // ...read,
  operations.getDeferredSettlementSummary
);

// ========== INVENTORY BATCHES ==========
router.get(
  "/inventory/batches",
  // ...read,
  // requireModuleAccess("pharmacy.ledger", "view"),
  operations.getInventoryBatches
);

// ========== HOSPITAL DETAILS ==========
router.get(
  "/hospital/details",
  // ...read,
  operations.getHospitalDetails
);

// ========== MEDICINE SEARCH (enhanced) ==========
router.get(
  "/medicines/search",
  // ...read,
  // requireModuleAccess("pharmacy.pos", "view"),
  operations.searchMedicines
);

// ========== PHARMACY CRUD (ADMIN SCREENS) ==========
// These routes were in the original pharmacy.routes.js
router.post('/', ...read, createPharmacy);
router.get('/', ...read, getAllPharmacies);
router.get('/:id', ...read, getPharmacyById);
router.put('/:id', ...read, updatePharmacy);
router.delete('/:id', ...read, deletePharmacy);

module.exports = router;