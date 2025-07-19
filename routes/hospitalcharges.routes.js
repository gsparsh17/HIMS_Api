const express = require('express');
const router = express.Router();
const {
  createOrUpdateCharges,
  getChargesByHospital,
  getAllCharges,
  deleteCharges
} = require('../controllers/hospitalcharges.controller');

// ✅ Create or Update charges for a hospital
router.post('/', createOrUpdateCharges);

// ✅ Get charges for a specific hospital
router.get('/:hospitalId', getChargesByHospital);

// ✅ Get all charges (for admin)
router.get('/', getAllCharges);

// ✅ Delete charges for a hospital
router.delete('/:hospitalId', deleteCharges);

module.exports = router;
