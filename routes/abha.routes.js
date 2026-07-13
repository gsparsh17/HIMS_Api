const express = require('express');
const router = express.Router();
const abhaController = require('../controllers/abha.controller');
const { protect, authorize } = require('../middlewares/auth');

const canManageAbha = authorize('admin', 'staff', 'registrar', 'receptionist', 'doctor', 'nurse');

router.post('/aadhaar/request-otp', protect, canManageAbha, abhaController.requestAadhaarOtp);
router.post('/aadhaar/enrol', protect, canManageAbha, abhaController.enrolByAadhaarOtp);
router.post('/capture-existing', protect, canManageAbha, abhaController.captureExistingAbha);
router.post('/existing/search-mobile', protect, canManageAbha, abhaController.searchExistingAbhaByMobile);
router.post('/existing/request-otp', protect, canManageAbha, abhaController.requestExistingAbhaOtp);
router.post('/existing/verify-otp', protect, canManageAbha, abhaController.verifyExistingAbhaOtp);

router.post('/mobile/request-otp', protect, canManageAbha, abhaController.requestMobileOtp);
router.post('/mobile/verify-otp', protect, canManageAbha, abhaController.verifyMobileOtp);

router.get('/patients/search', protect, canManageAbha, abhaController.searchPatientsByAbha);
router.get('/patients/:patientId/qr-code', protect, canManageAbha, abhaController.getQrCode);
router.get('/patients/:patientId/card', protect, canManageAbha, abhaController.getAbhaCard);

router.post('/records/link', protect, canManageAbha, abhaController.linkRecord);
router.post('/records/link-patient-records/:patientId', protect, canManageAbha, abhaController.linkAllPatientRecords);

router.post('/ehr/generate', protect, canManageAbha, abhaController.generateEhr);
router.get('/ehr/patient/:patientId', protect, canManageAbha, abhaController.getPatientEhrBundles);
router.get('/ehr/bundle/:bundleId', protect, canManageAbha, abhaController.getEhrBundle);

router.post('/phr/consent/request', protect, canManageAbha, abhaController.requestPhrConsentStub);

module.exports = router;
