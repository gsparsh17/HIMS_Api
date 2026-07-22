const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const controller = require('../controllers/printIdentity.controller');
const { protect, authorize } = require('../middlewares/auth');

const router = express.Router();
const uploadDir = path.resolve('uploads/print-identities');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${req.user?._id || 'user'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only PNG or JPEG images are allowed'), allowed.includes(file.mimetype));
  }
});

router.use(protect);
router.get('/me', controller.getMyIdentity);
router.put('/me', controller.updateMyIdentity);
router.post('/me/assets', upload.single('asset'), controller.uploadAsset);
router.put('/me/defaults', controller.setDefaults);
router.delete('/me/assets/:assetId', controller.retireAsset);
router.get('/assets/:assetId/content', controller.streamAsset);
router.get('/admin/pending', authorize('admin', 'mediqliq_super_admin'), controller.listPending);
router.put('/admin/assets/:assetId/verify', authorize('admin', 'mediqliq_super_admin'), controller.verifyAsset);

module.exports = router;
