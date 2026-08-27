const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patientTenant.controller');
const { protect, authorize } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');
const { tempDir } = require('../config/upload.config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
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
  'admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist',
  'accountant', 'insurance_desk', 'pharmacy', 'pathology_staff', 'radiology_staff', 'ot_staff'
);
const canManagePatient = authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist');
const canManagePharmacyPatient = authorize('admin', 'registrar', 'receptionist', 'pharmacy');

router.use(protect);

// Specific routes must stay before /:id.
router.get('/pharmacy/search', canManagePharmacyPatient, patientController.searchPatientsForPharmacy);
router.post('/walkin', canManagePharmacyPatient, patientController.createOrUpdateWalkinPatient);
router.post('/upload', canManagePatient, upload.single('image'), patientController.uploadPatientImage);
router.get('/check-duplicate', canManagePatient, patientController.checkDuplicateByPhone);
router.get('/registration-config', canManagePatient, patientController.getRegistrationConfig);
router.get('/registration-payers', canManagePatient, patientController.getRegistrationPayers);
router.post('/mobile-otp/request', canManagePatient, patientController.requestMobileOtp);
router.post('/mobile-otp/verify', canManagePatient, patientController.verifyMobileOtp);
router.post('/bulk-add', canManagePatient, patientController.bulkCreatePatients);
router.get('/by-temp-id/:tempId', canReadPatient, patientController.getPatientByTempId);
router.get('/sync/status', authorize('admin', 'registrar'), patientController.getSyncStatus);
router.get('/phone/:phone', canReadPatient, patientController.getPatientByPhone);
router.get('/search', canReadPatient, patientController.searchPatientsCompact);
router.get('/worklist/export', canReadPatient, patientController.exportPatientWorklist);
router.get('/worklist', canReadPatient, patientController.getPatientWorklist);
router.get('/dashboard-overview', canReadPatient, patientController.getDashboardOverview);
router.get('/staff-dashboard-overview', canReadPatient, patientController.getStaffDashboardOverview);
router.get('/registration-trend', canReadPatient, patientController.getPatientRegistrationTrend);

router.post('/', canManagePatient, patientController.createPatient);
router.get('/', canReadPatient, patientController.getAllPatients);
router.get('/:id/visits', canReadPatient, patientController.getPatientVisitHistory);
router.get('/:id/coverage-preference', canReadPatient, patientController.getCoveragePreference);
router.get('/:id/longitudinal-record', canReadPatient, patientController.getLongitudinalRecord);
router.post('/:id/share', canManagePatient, patientController.sharePatientRecord);
router.get('/:id/pharmacy-account', canManagePharmacyPatient, patientController.getPatientPharmacyAccount);
router.patch('/:id/pharmacy-balance', canManagePharmacyPatient, patientController.updatePatientPharmacyBalance);
router.get('/:id', canReadPatient, patientController.getPatientById);
router.put('/:id', canManagePatient, patientController.updatePatient);
router.delete('/:id', authorize('admin'), patientController.deletePatient);

module.exports = router;
