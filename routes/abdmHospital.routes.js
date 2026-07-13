const express = require('express');
const router = express.Router();
const controller = require('../controllers/abdmHospital.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);
router.get('/integration/status', controller.integrationStatus);
router.post('/care-contexts/build/:patientId', controller.buildCareContexts);
router.get('/care-contexts/patient/:patientId', controller.listPatientCareContexts);
router.get('/care-contexts/patient/:patientId/grouped', controller.groupedCareContexts);
router.post('/linking/hip/initiate/:patientId', controller.initiateHipLinking);
router.post('/fhir/generate', controller.generateFhir);

module.exports = router;
