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

// Existing pharmacy module operational routes. These power the current dashboard/POS/queue/ledger/returns screens.
router.get('/settings', ...authChain, operations.getSettings);
router.put('/settings', ...authChain, operations.updateSettings);

router.get('/dashboard', ...authChain, operations.getDashboard);
router.get('/analytics/inventory', ...authChain, operations.getInventoryAnalytics);
router.get('/analytics/purchases', ...authChain, operations.getPurchaseAnalytics);
router.get('/ledger/daily', ...authChain, operations.getLedgerDaily);
router.get('/inventory/ledger', ...authChain, operations.getInventoryLedger);
router.get('/dose-calculation', ...authChain, operations.getDoseCalculation);

router.post('/sales/quote', ...authChain, operations.quoteSale);
router.post('/sales', ...authChain, operations.createSale);

router.get('/ipd/search-admissions', ...authChain, operations.searchIPDAdmissions);
router.get('/ipd/queue', ...authChain, operations.getIPDQueue);
router.post('/ipd/dispense', ...authChain, operations.dispenseIPDMedication);
router.post('/ipd/advance', ...authChain, operations.depositAdvance);
router.get('/ipd/admissions/:admissionId/file', ...authChain, operations.getAdmissionPharmacyFile);
router.get('/ipd/admissions/:admissionId/medicine-stock', ...authChain, operations.getAdmissionMedicineStock);
router.get('/ipd/admissions/:admissionId/advance-ledger', ...authChain, operations.getAdvanceLedger);

router.post('/returns', ...authChain, operations.createReturn);
router.get('/returns', ...authChain, operations.getReturns);

// Existing pharmacy CRUD routes kept for admin screens.
router.post('/', createPharmacy);
router.get('/', getAllPharmacies);
router.get('/:id', getPharmacyById);
router.put('/:id', updatePharmacy);
router.delete('/:id', deletePharmacy);

module.exports = router;
