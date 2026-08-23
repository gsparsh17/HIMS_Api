const express = require('express');
const { protect } = require('../middlewares/auth');
const { requireDeskView, requireDeskPreview, requireDeskCommit } = require('../middlewares/deskAuthorization');
const controller = require('../controllers/desk.controller');
const { requirePatientAccess } = require('../middlewares/patientAccess');
const router = express.Router();

router.use(protect);
router.get('/patients/search', requireDeskView, controller.searchPatients);
router.get('/services/search', requireDeskView, controller.searchServices);
router.get('/patients/:patientId/admissions', requireDeskView, requirePatientAccess({ patientParam: 'patientId', purpose: 'OPERATIONS', scope: 'demographic_read' }), controller.getPatientAdmissions);
router.post('/checkout/preview', requireDeskPreview, controller.preview);
router.post('/checkout/commit', requireDeskCommit, controller.commit);
module.exports = router;
