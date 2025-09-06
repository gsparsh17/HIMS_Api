const express = require('express');
const router = express.Router();
const {
  createPharmacy,
  getAllPharmacies,
  getPharmacyById,
  updatePharmacy,
  deletePharmacy
} = require('../controllers/pharmacy.controller');

// Pharmacy routes
router.post('/', createPharmacy);
router.get('/', getAllPharmacies);
router.get('/:id', getPharmacyById);
router.put('/:id', updatePharmacy);
router.delete('/:id', deletePharmacy);

module.exports = router;