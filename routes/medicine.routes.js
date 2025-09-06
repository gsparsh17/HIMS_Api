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
  searchMedicines
} = require('../controllers/medicine.controller');

// Medicine routes
router.post('/', addMedicine);
router.get('/', getAllMedicines);
router.get('/search', searchMedicines);
router.get('/expired', getExpiredMedicines);
router.get('/low-stock', getLowStockMedicines);
router.get('/:id', getMedicineById);
router.put('/:id', updateMedicine);
router.delete('/:id', deleteMedicine);

module.exports = router;