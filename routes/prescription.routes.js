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

// Procedure management routes (must come before /:id routes)
router.get('/with-procedures', prescriptionController.getPrescriptionsWithProcedures);
router.get('/todays-procedures', prescriptionController.getTodaysProcedures);
router.get('/procedures/status/:status', prescriptionController.getProceduresByStatus);

// Procedure update routes
router.put('/:prescription_id/procedures/:procedure_id/status', prescriptionController.updateProcedureStatus);
router.put('/:prescription_id/procedures/:procedure_id/billed', prescriptionController.markProcedureAsBilled);

// Patient pending procedures
router.get('/patient/:patientId/pending-procedures', prescriptionController.getPatientPendingProcedures);

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