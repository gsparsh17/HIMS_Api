const express = require('express');
const router = express.Router();
const {
  addMedicine,
  getAllMedicines,
  getMedicineById,
  updateMedicine,
  deleteMedicine,
  getExpiredMedicines,
  getLowStockMedicines,
  searchMedicines,
  getMedicinesByHSN,
  getGSTSummary,
  bulkUpdateGST,
  exportGSTData,
  getMedicineTaxHistory,
  getGSTCompliantMedicines
} = require('../controllers/medicine.controller');

// ============== BASIC CRUD ROUTES ==============
router.post('/', addMedicine);
router.get('/', getAllMedicines);
router.get('/search', searchMedicines);
router.get('/expired', getExpiredMedicines);
router.get('/low-stock', getLowStockMedicines);
router.get('/:id', getMedicineById);
router.put('/:id', updateMedicine);
router.delete('/:id', deleteMedicine);

// ============== GST / TAX REPORTING ROUTES ==============
// Get GST summary report
router.get('/gst/summary', getGSTSummary);

// Export GST data to CSV
router.get('/gst/export', exportGSTData);

// Bulk update GST rates for multiple medicines
router.post('/gst/bulk-update', bulkUpdateGST);

// Get GST compliance statistics
router.get('/gst/compliance', getGSTCompliantMedicines);

// Get tax history for a specific medicine (audit)
router.get('/:id/tax-history', getMedicineTaxHistory);

// Get medicines by HSN code (must come after specific routes)
router.get('/hsn/:hsnCode', getMedicinesByHSN);

module.exports = router;