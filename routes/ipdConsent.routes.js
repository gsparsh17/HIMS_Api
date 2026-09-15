const express = require('express');
const router = express.Router();
const controller = require('../controllers/ipdConsent.controller');
const { protect, authorize } = require('../middlewares/auth');
const { requireOtCapability } = require('../services/otAccess.service');

router.use(protect);
const readers = authorize('admin', 'staff', 'registrar', 'receptionist', 'nurse', 'doctor', 'ot_staff');

const legacyEditors = authorize('admin', 'staff', 'registrar', 'receptionist', 'nurse', 'doctor');
const otAwareEditors = (req, res, next) => {
  const otContext = req.body?.otCaseContextId || req.body?.relatedOTCaseId;
  if (!otContext) return legacyEditors(req, res, next);
  const templateId = String(req.params?.templateId || '').trim().toLowerCase();
  const capability = templateId === 'general-consent'
    ? 'ot.consent.admission'
    : 'ot.consent.clinical';
  return requireOtCapability(capability)(req, res, next);
};


router.get('/templates', readers, controller.listTemplates);
router.get('/admission/:admissionId', readers, controller.listAdmissionConsents);
router.get('/admission/:admissionId/:templateId', readers, controller.getConsent);
router.put('/admission/:admissionId/:templateId', otAwareEditors, controller.saveConsent);
router.get('/admission/:admissionId/:templateId/print.pdf', readers, controller.printConsent);

module.exports = router;
