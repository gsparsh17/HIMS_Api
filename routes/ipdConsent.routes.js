const express = require('express');
const router = express.Router();
const controller = require('../controllers/ipdConsent.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect);
const readers = authorize('admin', 'staff', 'registrar', 'receptionist', 'nurse', 'doctor', 'ot_staff');
const editors = authorize('admin', 'staff', 'registrar', 'receptionist', 'nurse', 'doctor');

router.get('/templates', readers, controller.listTemplates);
router.get('/admission/:admissionId', readers, controller.listAdmissionConsents);
router.get('/admission/:admissionId/:templateId', readers, controller.getConsent);
router.put('/admission/:admissionId/:templateId', editors, controller.saveConsent);
router.get('/admission/:admissionId/:templateId/print.pdf', readers, controller.printConsent);

module.exports = router;
