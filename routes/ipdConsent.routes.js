const express = require('express');
const router = express.Router();
const controller = require('../controllers/ipdConsent.controller');
const IPDAdmission = require('../models/IPDAdmission');
const { requireResourcePatientAccess } = require('../middlewares/patientAccess');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect, authorize('admin', 'staff', 'registrar', 'receptionist', 'nurse', 'doctor'));
const admissionAccess = requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', hospitalField: 'hospitalId', purpose: 'AUTO', scope: 'patient_document_read' });
router.get('/templates', controller.listTemplates);
router.get('/admission/:admissionId', admissionAccess, controller.listAdmissionConsents);
router.get('/admission/:admissionId/:templateId', admissionAccess, controller.getConsent);
router.put('/admission/:admissionId/:templateId', admissionAccess, controller.saveConsent);
router.get('/admission/:admissionId/:templateId/print.pdf', admissionAccess, controller.printConsent);

module.exports = router;
