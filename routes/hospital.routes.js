// const express = require('express');
// const router = express.Router();
// const { getHospitalDetails } = require('../controllers/hospital.controller.js');

// // This handles the GET request for '/api/hospitals'
// router.get('/', getHospitalDetails);

// module.exports = router;


const express = require('express');
const router = express.Router();
const { getHospitalDetails, updateHospitalDetails } = require('../controllers/hospital.controller.js');

// This existing route gets hospital details
router.get('/', getHospitalDetails);

// **FIX: Add this new route to handle updates**
router.patch('/:hospitalId/details', updateHospitalDetails);

module.exports = router;