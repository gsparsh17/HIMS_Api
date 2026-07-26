const express = require('express');
const router = express.Router();
const controller = require('../controllers/abha.controller');
const { protect, authorize } = require('../middlewares/auth');

const canManageAbha = authorize(
  'admin',
  'staff',
  'registrar',
  'receptionist',
  'doctor',
  'nurse'
);

router.use(protect, canManageAbha);

router.post('/aadhaar/request-otp', controller.requestAadhaarOtp);
router.post('/aadhaar/enrol', controller.enrolByAadhaarOtp);
router.post('/capture-existing', controller.captureExistingAbha);
router.post('/existing/search-mobile', controller.searchExistingAbhaByMobile);
router.post('/existing/request-otp', controller.requestExistingAbhaOtp);
router.post('/existing/verify-otp', controller.verifyExistingAbhaOtp);
router.post('/mobile/request-otp', controller.requestMobileOtp);
router.post('/mobile/verify-otp', controller.verifyMobileOtp);

router.post('/address/suggestions', controller.getAddressSuggestions);
router.post('/address/validate', controller.validateAddress);
router.post('/address/create', controller.createAddress);

router.get('/patients/search', controller.searchPatientsByAbha);
router.get('/patients/:patientId', controller.getPatientAbha);
router.get('/patients/:patientId/qr-code', controller.getQrCode);
router.get('/patients/:patientId/card', controller.getAbhaCard);

router.post('/records/link', controller.linkRecord);
router.post('/records/link-patient-records/:patientId', controller.linkAllPatientRecords);
router.post('/ehr/generate', controller.generateEhr);
router.get('/ehr/patient/:patientId', controller.getPatientEhrBundles);
router.get('/ehr/bundle/:bundleId', controller.getEhrBundle);

module.exports = router;
