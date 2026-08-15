const express = require('express');
const router = express.Router();
const prescriptionController = require('../controllers/prescription.controller');
const multer = require('multer');
const path = require('path');
const { tempDir } = require('../config/upload.config');
const { validatePrescriptionMedicationFlow } = require('../middlewares/medicationFlowValidation');
const { protect, authorize } = require('../middlewares/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error('Prescription upload must be a PNG, JPEG, WebP, or PDF file.'));
    }
    cb(null, true);
  }
});


router.use(
  protect,
  authorize('admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'pharmacy', 'pathology_staff')
);

// ============== IMAGE UPLOAD ==============
router.post('/upload', upload.single('image'), prescriptionController.uploadPrescriptionImage);

// ============== IPD PRESCRIPTION CONVERSION ==============
router.post('/:prescriptionId/convert-to-ipd/:admissionId', prescriptionController.convertToIPD);
router.get('/opd/patient/:patientId/for-ipd', prescriptionController.getOPDPrescriptionsForIPD);
router.get('/ipd/admission/:admissionId', prescriptionController.getIPDPrescriptions);

// ============== STANDARD CRUD ROUTES ==============
router.post('/', authorize('admin', 'mediqliq_super_admin', 'doctor'), validatePrescriptionMedicationFlow, prescriptionController.createPrescription);
router.get('/', prescriptionController.getAllPrescriptions);
router.get('/active', prescriptionController.getActivePrescriptions);
router.get('/patient/:patientId', prescriptionController.getPrescriptionsByPatientId);
router.get('/doctor/:doctorId', prescriptionController.getPrescriptionsByDoctorId);
router.get('/appointment/:appointmentId', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'pharmacy', 'pathology_staff'), prescriptionController.getPrescriptionByAppointmentId);
router.get('/appointment/:appointmentId/blank-print', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist'), prescriptionController.downloadBlankPrescriptionPdfByAppointment);
router.get('/:id/opd-slip.pdf', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist'), prescriptionController.downloadOpdSlipPdf);
router.get('/:id/print', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'pharmacy', 'pathology_staff'), prescriptionController.downloadPrescriptionPdf);
router.get('/:id', prescriptionController.getPrescriptionById);
router.put('/:id', protect, authorize('admin', 'doctor'), prescriptionController.updatePrescription);
router.put('/:prescriptionId/dispense/:itemIndex', authorize('admin', 'mediqliq_super_admin', 'pharmacy'), prescriptionController.dispenseMedication);
router.delete('/:id', authorize('admin', 'mediqliq_super_admin', 'doctor'), prescriptionController.deletePrescription);

module.exports = router;