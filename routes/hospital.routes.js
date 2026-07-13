const express = require('express');
const router = express.Router();
const {
  getHospitalDetails,
  getHospitalById,
  updateHospitalDetails,
  getVitalsConfig,
  updateVitalsConfig
} = require('../controllers/hospital.controller');
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
    if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype || '')) return cb(new Error('Only image files are allowed'));
    return cb(null, true);
  }
});

router.use(protect);
router.get('/', getHospitalDetails);
router.get('/:hospitalId', getHospitalById);
router.get('/:hospitalId/vitals-config', getVitalsConfig);
router.patch('/:hospitalId/details', authorize('admin'), upload.single('logo'), updateHospitalDetails);
router.patch('/:hospitalId/vitals-config', authorize('admin'), updateVitalsConfig);

module.exports = router;
