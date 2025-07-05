const express = require('express');
const router = express.Router();
const { getHospitalDetails } = require('../controllers/hospital.controller.js');

// This handles the GET request for '/api/hospitals'
router.get('/', getHospitalDetails);

module.exports = router;