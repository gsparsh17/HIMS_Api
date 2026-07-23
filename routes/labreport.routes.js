const express = require('express');
const router = express.Router();
const controller = require('../controllers/labreport.controller');
const multer = require('multer');
const path = require('path');
const { protect, authorize, requireModuleAccess } = require('../middlewares/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(
    null,
    `${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(file.originalname)}`
  )
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    const isValid = allowedMimeTypes.includes(file.mimetype);
    cb(isValid ? null : new Error('Invalid file type. Only PDF, JPG and PNG are allowed.'), isValid);
  }
});

router.use(protect, requireModuleAccess('laboratory', 'view'));

router.get('/patient/:patientId', controller.getReportsByPatient);
router.get('/prescription/:prescriptionId', controller.getReportsByPrescription);

router.post(
  '/upload',
  authorize('admin', 'mediqliq_super_admin', 'pathology_staff'),
  requireModuleAccess('laboratory', 'manage'),
  upload.single('report'),
  controller.uploadReport
);

router.get('/download/:report_id', controller.downloadReport);
router.get('/download-stream/:report_id', controller.downloadReportStream);
router.get('/external/:prescription_id/:lab_test_id/download', controller.downloadExternalReport);
router.get('/external/:prescription_id/:lab_test_id/stream', controller.downloadExternalReportStream);

router.post(
  '/',
  authorize('admin', 'mediqliq_super_admin', 'pathology_staff'),
  requireModuleAccess('laboratory', 'manage'),
  controller.createLabReport
);

router.get('/', controller.getAllLabReports);
router.get('/:id', controller.getReportById);

router.delete(
  '/:id',
  authorize('admin', 'mediqliq_super_admin'),
  requireModuleAccess('laboratory', 'manage'),
  controller.deleteReport
);

module.exports = router;