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

router.post('/login/request', controller.requestAdvancedLogin);
router.post('/login/verify', controller.verifyAdvancedLogin);
router.post('/login/verify-user', controller.completeAdvancedLoginUser);
router.post('/login/password/search', controller.searchPasswordLogin);
router.post('/login/password/verify', controller.verifyPasswordLogin);
router.post('/login/address/search', controller.searchAbhaAddressLogin);
router.post('/login/address/request-otp', controller.requestAbhaAddressLoginOtp);
router.post('/login/address/verify-otp', controller.verifyAbhaAddressLoginOtp);

router.post('/document/request-otp', controller.requestDocumentEnrollmentOtp);
router.post('/document/verify-otp', controller.verifyDocumentEnrollmentOtp);
router.post('/document/enrol', controller.enrolByDocument);
router.post('/biometric/init', controller.initBiometricEnrollment);
router.post('/biometric/capture-pid', controller.captureBiometricPid);
router.post('/biometric/enrol', controller.enrolByBiometric);

router.post('/address/suggestions', controller.getAddressSuggestions);
router.post('/address/validate', controller.validateAddress);
router.post('/address/create', controller.createAddress);
router.post('/email/verification-link', controller.requestEmailVerification);

router.get('/patients/search', controller.searchPatientsByAbha);
router.get('/patients/:patientId', controller.getPatientAbha);
router.get('/patients/:patientId/qr-code', controller.getQrCode);
router.get('/patients/:patientId/card', controller.getAbhaCard);
router.get('/patients/:patientId/profile', controller.getProfile);
router.post('/patients/:patientId/logout', controller.logoutProfile);

router.post('/records/link', controller.linkRecord);
router.post('/records/link-patient-records/:patientId', controller.linkAllPatientRecords);
router.post('/ehr/generate', controller.generateEhr);
router.get('/ehr/patient/:patientId', controller.getPatientEhrBundles);
router.get('/ehr/bundle/:bundleId', controller.getEhrBundle);

module.exports = router;
