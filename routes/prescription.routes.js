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

// ============== SPECIFIC ROUTES (MUST COME FIRST) ==============

// Image Upload
router.post('/upload', upload.single('image'), prescriptionController.uploadPrescriptionImage);

// ===================== PROCEDURE MANAGEMENT (EXISTING) =====================
router.get('/with-procedures', prescriptionController.getPrescriptionsWithProcedures);
router.get('/todays-procedures', prescriptionController.getTodaysProcedures);
router.get('/procedures/status/:status', prescriptionController.getProceduresByStatus);
router.put('/:prescription_id/procedures/:procedure_id/status', prescriptionController.updateProcedureStatus);
router.put('/:prescription_id/procedures/:procedure_id/billed', prescriptionController.markProcedureAsBilled);
router.get('/patient/:patientId/pending-procedures', prescriptionController.getPatientPendingProcedures);

// ===================== ✅ LAB TEST MANAGEMENT (NEW) =====================
router.get('/with-lab-tests', prescriptionController.getPrescriptionsWithLabTests);
router.get('/todays-lab-tests', prescriptionController.getTodaysLabTests);
router.get('/lab-tests/status/:status', prescriptionController.getLabTestsByStatus);

// Lab test update routes
router.put('/:prescription_id/lab-tests/:lab_test_id/status', prescriptionController.updateLabTestStatus);
router.put('/:prescription_id/lab-tests/:lab_test_id/billed', prescriptionController.markLabTestAsBilled);

// Patient pending lab tests
router.get('/patient/:patientId/pending-lab-tests', prescriptionController.getPatientPendingLabTests);

// ============== STANDARD CRUD ROUTES ==============

// Create
router.post('/', prescriptionController.createPrescription);

// Read (except specific ID routes)
router.get('/', prescriptionController.getAllPrescriptions);
router.get('/active', prescriptionController.getActivePrescriptions);
router.get('/patient/:patientId', prescriptionController.getPrescriptionsByPatientId);
router.get('/doctor/:doctorId', prescriptionController.getPrescriptionsByDoctorId);

// ============== INDIVIDUAL PRESCRIPTION ROUTES (MUST COME LAST) ==============

// Get single prescription by ID
router.get('/:id', prescriptionController.getPrescriptionById);

// Update
router.put('/:id', prescriptionController.updatePrescription);
router.put('/:prescriptionId/dispense/:itemIndex', prescriptionController.dispenseMedication);

// Delete
router.delete('/:id', prescriptionController.deletePrescription);

module.exports = router;
