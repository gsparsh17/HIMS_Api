const express = require('express');
const router = express.Router();
const {
  createAdjustment,
  getAdjustmentsByMedicine,
  getAllAdjustments
} = require('../controllers/stockAdjustment.controller');

// Stock Adjustment routes
router.post('/', createAdjustment);
router.get('/', getAllAdjustments);
router.get('/medicine/:medicineId', getAdjustmentsByMedicine);

module.exports = router;