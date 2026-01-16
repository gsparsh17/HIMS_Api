// const express = require('express');
// const router = express.Router();
// const { getHospitalDetails } = require('../controllers/hospital.controller.js');

// // This handles the GET request for '/api/hospitals'
// router.get('/', getHospitalDetails);

// module.exports = router;


const express = require('express');
const router = express.Router();
const { getHospitalDetails, updateHospitalDetails } = require('../controllers/hospital.controller.js');

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

// This existing route gets hospital details
router.get('/', getHospitalDetails);

// **FIX: Add this new route to handle updates**
router.patch('/:hospitalId/details', upload.single('logo'), updateHospitalDetails);

module.exports = router;