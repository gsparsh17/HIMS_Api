const express = require('express');
const router = express.Router();
const patientController = require('../controllers/patient.controller');

// --- Specific routes first ---

// Image Upload
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); 
  }
});

const upload = multer({ storage: storage });

router.post('/upload', upload.single('image'), patientController.uploadPatientImage);

router.post('/', patientController.createPatient);

// Make sure this line exists and is in the correct place
router.post('/bulk-add', patientController.bulkCreatePatients); 

router.get('/', patientController.getAllPatients);


// --- General, parameterized routes last ---

router.get('/:id', patientController.getPatientById);
router.put('/:id', patientController.updatePatient);
router.delete('/:id', patientController.deletePatient);

module.exports = router;