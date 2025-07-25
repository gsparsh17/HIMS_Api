const express = require('express');
const router = express.Router();
const pharmacyController = require('../controllers/pharmacy.controller');

// Medicine inventory routes
router.post('/medicines', pharmacyController.addMedicine);
router.get('/medicines', pharmacyController.getAllMedicines);
router.put('/medicines/:id', pharmacyController.updateMedicine);
router.delete('/medicines/:id', pharmacyController.deleteMedicine);

// Issuing medicine
router.post('/issue', pharmacyController.issueMedicine);
router.get('/issued', pharmacyController.getIssuedMedicines);

// Pharmacy
router.post('/', pharmacyController.createPharmacy);
router.get('/', pharmacyController.getAllPharmacies);
router.get('/:id', pharmacyController.getPharmacyById);
router.put('/:id', pharmacyController.updatePharmacy);
router.delete('/:id', pharmacyController.deletePharmacy);

module.exports = router;
