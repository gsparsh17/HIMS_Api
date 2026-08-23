const express = require('express');
const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');
const IPDAdmission = require('../models/IPDAdmission');
const { requirePatientAccess, requireResourcePatientAccess } = require('../middlewares/patientAccess');
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
router.post('/:prescriptionId/convert-to-ipd/:admissionId', requireResourcePatientAccess(Prescription, { idParam: 'prescriptionId', patientField: 'patient_id', purpose: 'TREATMENT', scope: 'clinical_write' }), requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }), prescriptionController.convertToIPD);
router.get('/opd/patient/:patientId/for-ipd', requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), prescriptionController.getOPDPrescriptionsForIPD);
router.get('/ipd/admission/:admissionId', requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), prescriptionController.getIPDPrescriptions);

// ============== STANDARD CRUD ROUTES ==============
router.post('/', authorize('admin', 'mediqliq_super_admin', 'doctor'), validatePrescriptionMedicationFlow, prescriptionController.createPrescription);
router.get('/', prescriptionController.getAllPrescriptions);
router.get('/active', prescriptionController.getActivePrescriptions);
router.get('/patient/:patientId', requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), prescriptionController.getPrescriptionsByPatientId);
router.get('/doctor/:doctorId', prescriptionController.getPrescriptionsByDoctorId);
router.get('/appointment/:appointmentId', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'pharmacy', 'pathology_staff'), requireResourcePatientAccess(Appointment, { idParam: 'appointmentId', patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_read' }), prescriptionController.getPrescriptionByAppointmentId);
router.get('/appointment/:appointmentId/blank-print', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist'), requireResourcePatientAccess(Appointment, { idParam: 'appointmentId', patientField: 'patient_id', hospitalField: 'hospital_id', purpose: 'AUTO', scope: 'clinical_read' }), prescriptionController.downloadBlankPrescriptionPdfByAppointment);
router.get('/:id/opd-slip.pdf', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist'), requireResourcePatientAccess(Prescription, { patientField: 'patient_id', purpose: 'AUTO', scope: 'clinical_read' }), prescriptionController.downloadOpdSlipPdf);
router.get('/:id/print', protect, authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'pharmacy', 'pathology_staff'), requireResourcePatientAccess(Prescription, { patientField: 'patient_id', purpose: 'AUTO', scope: 'clinical_read' }), prescriptionController.downloadPrescriptionPdf);
router.get('/:id', requireResourcePatientAccess(Prescription, { patientField: 'patient_id', purpose: 'AUTO', scope: 'clinical_read' }), prescriptionController.getPrescriptionById);
router.put('/:id', protect, authorize('admin', 'doctor'), requireResourcePatientAccess(Prescription, { patientField: 'patient_id', purpose: 'TREATMENT', scope: 'clinical_write' }), prescriptionController.updatePrescription);
router.put('/:prescriptionId/dispense/:itemIndex', authorize('admin', 'mediqliq_super_admin', 'pharmacy'), requireResourcePatientAccess(Prescription, { idParam: 'prescriptionId', patientField: 'patient_id', purpose: 'PAYMENT', scope: 'clinical_write' }), prescriptionController.dispenseMedication);
router.delete('/:id', authorize('admin', 'mediqliq_super_admin', 'doctor'), requireResourcePatientAccess(Prescription, { patientField: 'patient_id', purpose: 'TREATMENT', scope: 'clinical_write' }), prescriptionController.deletePrescription);

module.exports = router;