const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const controller = require('../controllers/patientIdentity.controller');
const { requirePatientAccess } = require('../middlewares/patientAccess');
const { protect, authorize } = require('../middlewares/auth');
const { tempDir } = require('../config/upload.config');

const router = express.Router();
const uploadDir = path.join(tempDir, 'patient-identities');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${req.user?._id || 'user'}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^image\/(png|jpeg|jpg|webp)$/i.test(file.mimetype || '');
    cb(allowed ? null : new Error('Only PNG, JPEG and WebP images are allowed'), allowed);
  }
});

const readers = authorize('admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'accountant', 'insurance_desk', 'ot_staff');
const capturers = authorize('admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'ot_staff');

router.use(protect);
router.post('/digilocker/verify', capturers, controller.verifyDigiLocker);
router.get('/patients/:patientId/assets', readers, requirePatientAccess({ patientParam: 'patientId', purpose: 'AUTO', scope: 'demographic_read' }), controller.listPatientAssets);
router.post('/patients/:patientId/assets/upload', capturers, requirePatientAccess({ patientParam: 'patientId', purpose: 'AUTO', scope: 'demographic_write' }), upload.single('asset'), controller.uploadAsset);
router.post('/patients/:patientId/assets/capture', capturers, requirePatientAccess({ patientParam: 'patientId', purpose: 'AUTO', scope: 'demographic_write' }), controller.captureAsset);
router.post('/patients/:patientId/scanned-documents/capture', capturers, requirePatientAccess({ patientParam: 'patientId', purpose: 'AUTO', scope: 'demographic_write' }), controller.captureScannedDocument);
router.get('/patients/:patientId/scanned-documents', capturers, requirePatientAccess({ patientParam: 'patientId', purpose: 'AUTO', scope: 'demographic_read' }), controller.listScannedDocuments);
router.put('/patients/:patientId/assets/:assetId/default', capturers, requirePatientAccess({ patientParam: 'patientId', purpose: 'AUTO', scope: 'demographic_write' }), controller.setDefault);
router.delete('/assets/:assetId', capturers, controller.revokeAsset);
router.get('/assets/:assetId/content', readers, controller.streamAsset);

module.exports = router;
