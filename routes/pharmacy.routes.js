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

module.exports = router;
