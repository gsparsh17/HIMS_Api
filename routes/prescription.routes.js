const express = require('express');
const router = express.Router();
const prescriptionController = require('../controllers/prescription.controller');
const multer = require('multer');
const path = require('path');
const { validatePrescriptionMedicationFlow } = require('../middlewares/medicationFlowValidation');
const { protect, authorize } = require('../middlewares/auth');

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
router.post('/', validatePrescriptionMedicationFlow, prescriptionController.createPrescription);
router.get('/', prescriptionController.getAllPrescriptions);
router.get('/active', prescriptionController.getActivePrescriptions);
router.get('/patient/:patientId', prescriptionController.getPrescriptionsByPatientId);
router.get('/doctor/:doctorId', prescriptionController.getPrescriptionsByDoctorId);
router.get('/appointment/:appointmentId', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'pharmacy', 'pathology_staff'), prescriptionController.getPrescriptionByAppointmentId);
router.get('/appointment/:appointmentId/blank-print', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist'), prescriptionController.downloadBlankPrescriptionPdfByAppointment);
router.get('/:id/print', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'pharmacy', 'pathology_staff'), prescriptionController.downloadPrescriptionPdf);
router.get('/:id', prescriptionController.getPrescriptionById);
router.put('/:id', protect, authorize('admin', 'doctor'), prescriptionController.updatePrescription);
router.put('/:prescriptionId/dispense/:itemIndex', prescriptionController.dispenseMedication);
router.delete('/:id', prescriptionController.deletePrescription);

module.exports = router;