const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const {
  createAdjustment,
  getAdjustmentsByMedicine,
  getAllAdjustments
} = require('../controllers/stockAdjustment.controller');

router.use(protect);

// Stock Adjustment routes
router.post('/', createAdjustment);
router.get('/', getAllAdjustments);
router.get('/medicine/:medicineId', getAdjustmentsByMedicine);

module.exports = router;