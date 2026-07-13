const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmHospital.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
router.get('/integration/status', authorize('admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist'), controller.integrationStatus);
router.post('/care-contexts/build/:patientId', authorize('admin', 'doctor', 'nurse', 'registrar'), controller.buildCareContexts);
router.get('/care-contexts/patient/:patientId', authorize('admin', 'doctor', 'nurse', 'staff', 'registrar'), controller.listPatientCareContexts);
router.get('/care-contexts/patient/:patientId/grouped', authorize('admin', 'doctor', 'nurse', 'staff', 'registrar'), controller.groupedCareContexts);
router.post('/linking/hip/initiate/:patientId', authorize('admin', 'doctor', 'registrar'), controller.initiateHipLinking);
router.post('/fhir/generate', authorize('admin', 'doctor'), controller.generateFhir);

module.exports = router;
