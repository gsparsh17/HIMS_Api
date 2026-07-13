const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patient.controller');
const { protect, authorize } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype || '')) {
      return cb(new Error('Only JPEG, PNG and WebP patient images are allowed'));
    }
    return cb(null, true);
  }
});

const canReadPatient = authorize(
  'admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist',
  'pharmacy', 'pathology_staff', 'radiology_staff', 'ot_staff'
);
const canManagePatient = authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist');
const canManagePharmacyPatient = authorize('admin', 'registrar', 'receptionist', 'pharmacy');

router.use(protect);

// Specific routes must stay before /:id.
router.get('/pharmacy/search', canManagePharmacyPatient, patientController.searchPatientsForPharmacy);
router.post('/walkin', canManagePharmacyPatient, patientController.createOrUpdateWalkinPatient);
router.post('/upload', canManagePatient, upload.single('image'), patientController.uploadPatientImage);
router.get('/check-duplicate', canManagePatient, patientController.checkDuplicateByPhone);
router.post('/bulk-add', canManagePatient, patientController.bulkCreatePatients);
router.get('/by-temp-id/:tempId', canReadPatient, patientController.getPatientByTempId);
router.get('/sync/status', authorize('admin', 'registrar'), patientController.getSyncStatus);
router.get('/phone/:phone', canReadPatient, patientController.getPatientByPhone);

router.post('/', canManagePatient, patientController.createPatient);
router.get('/', canReadPatient, patientController.getAllPatients);
router.get('/:id/pharmacy-account', canManagePharmacyPatient, patientController.getPatientPharmacyAccount);
router.patch('/:id/pharmacy-balance', canManagePharmacyPatient, patientController.updatePatientPharmacyBalance);
router.get('/:id', canReadPatient, patientController.getPatientById);
router.put('/:id', canManagePatient, patientController.updatePatient);
router.delete('/:id', authorize('admin'), patientController.deletePatient);

module.exports = router;
