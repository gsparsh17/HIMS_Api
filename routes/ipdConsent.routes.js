const express = require('express');
const router = express.Router();
const controller = require('../controllers/ipdConsent.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect, authorize('admin', 'staff', 'registrar', 'receptionist', 'nurse', 'doctor'));
router.get('/templates', controller.listTemplates);
router.get('/admission/:admissionId', controller.listAdmissionConsents);
router.get('/admission/:admissionId/:templateId', controller.getConsent);
router.put('/admission/:admissionId/:templateId', controller.saveConsent);
router.get('/admission/:admissionId/:templateId/print.pdf', controller.printConsent);

module.exports = router;
