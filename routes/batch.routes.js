const express = require('express');
const router = express.Router();
const {
  addBatch,
  getBatchesByMedicine,
  updateBatch,
  getExpiringBatches,
  getAllBatches
} = require('../controllers/batch.controller');

// Batch routes
router.post('/', addBatch);
router.get('/', getAllBatches);
router.get('/medicine/:medicineId', getBatchesByMedicine);
router.get('/expiring-soon', getExpiringBatches);
router.put('/:id', updateBatch);

module.exports = router;