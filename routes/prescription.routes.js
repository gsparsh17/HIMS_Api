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

// ============== IMAGE UPLOAD ==============
router.post('/upload', upload.single('image'), prescriptionController.uploadPrescriptionImage);

// ============== IPD PRESCRIPTION CONVERSION ==============
router.post('/:prescriptionId/convert-to-ipd/:admissionId', prescriptionController.convertToIPD);
router.get('/opd/patient/:patientId/for-ipd', prescriptionController.getOPDPrescriptionsForIPD);
router.get('/ipd/admission/:admissionId', prescriptionController.getIPDPrescriptions);

// ============== STANDARD CRUD ROUTES ==============
router.post('/', prescriptionController.createPrescription);
router.get('/', prescriptionController.getAllPrescriptions);
router.get('/active', prescriptionController.getActivePrescriptions);
router.get('/patient/:patientId', prescriptionController.getPrescriptionsByPatientId);
router.get('/doctor/:doctorId', prescriptionController.getPrescriptionsByDoctorId);
router.get('/:id', prescriptionController.getPrescriptionById);
router.put('/:id', prescriptionController.updatePrescription);
router.put('/:prescriptionId/dispense/:itemIndex', prescriptionController.dispenseMedication);
router.delete('/:id', prescriptionController.deletePrescription);

module.exports = router;