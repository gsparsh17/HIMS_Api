const express = require('express');
const router = express.Router();
const prescriptionController = require('../controllers/prescription.controller');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); 
  }
});

const upload = multer({ storage: storage });

// Create
router.post('/', prescriptionController.createPrescription);

// Read
router.get('/', prescriptionController.getAllPrescriptions);
router.get('/:id', prescriptionController.getPrescriptionById);

// Update
router.put('/:id', prescriptionController.updatePrescription);

// Delete
router.delete('/:id', prescriptionController.deletePrescription);

router.post('/upload', upload.single('image'), prescriptionController.uploadPrescriptionImage);

module.exports = router;
