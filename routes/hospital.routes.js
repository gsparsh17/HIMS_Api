const express = require('express');
const router = express.Router();
const { 
  getHospitalDetails, 
  getHospitalById,
  updateHospitalDetails,
  getVitalsConfig,
  updateVitalsConfig
} = require('../controllers/hospital.controller.js');

const multer = require('multer');
const path = require('path');

// Configure Multer for disk storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Public routes
router.get('/', getHospitalDetails);
router.get('/:hospitalId', getHospitalById);

// Protected routes - require authentication
router.get('/:hospitalId/vitals-config', getVitalsConfig);

// Admin only routes
router.patch(
  '/:hospitalId/details', 
  upload.single('logo'), 
  updateHospitalDetails
);

router.patch(
  '/:hospitalId/vitals-config', 
  updateVitalsConfig
);

module.exports = router;