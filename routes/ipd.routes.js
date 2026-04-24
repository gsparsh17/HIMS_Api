const express = require('express');
const router = express.Router();

// Import controllers
const ipdAdmissionController = require('../controllers/ipdAdmission.controller');
const ipdBedController = require('../controllers/ipdBed.controller');
const ipdRoundController = require('../controllers/ipdRound.controller');
const ipdNursingController = require('../controllers/ipdNursing.controller');
const ipdMedicationController = require('../controllers/ipdMedication.controller');
const ipdBillingController = require('../controllers/ipdBilling.controller');
const ipdDischargeController = require('../controllers/ipdDischarge.controller');

// ========== ADMISSION ROUTES ==========
router.post('/admissions', ipdAdmissionController.createAdmission);
router.get('/admissions', ipdAdmissionController.getAllAdmissions);
router.get('/admissions/dashboard/stats', ipdAdmissionController.getDashboardStats);
router.get('/admissions/:id', ipdAdmissionController.getAdmissionById);
router.put('/admissions/:id', ipdAdmissionController.updateAdmission);
router.patch('/admissions/:id/status', ipdAdmissionController.updateAdmissionStatus);
router.delete('/admissions/:id', ipdAdmissionController.deleteAdmission);

// ========== BED ROUTES ==========
router.post('/beds', ipdBedController.createBed);
router.get('/beds', ipdBedController.getAllBeds);
router.get('/beds/available', ipdBedController.getAvailableBeds);
router.get('/beds/occupied', ipdBedController.getOccupiedBeds);
router.get('/beds/:id', ipdBedController.getBedById);
router.put('/beds/:id', ipdBedController.updateBed);
router.patch('/beds/:id/status', ipdBedController.updateBedStatus);
router.delete('/beds/:id', ipdBedController.deleteBed);

// ========== ROUND ROUTES ==========
router.post('/rounds', ipdRoundController.createRound);
router.get('/rounds/admission/:admissionId', ipdRoundController.getRoundsByAdmission);
router.get('/rounds/doctor/:doctorId', ipdRoundController.getRoundsByDoctor);
router.get('/rounds/:id', ipdRoundController.getRoundById);
router.put('/rounds/:id', ipdRoundController.updateRound);
router.delete('/rounds/:id', ipdRoundController.deleteRound);

// ========== NURSING ROUTES ==========
router.post('/nursing-notes', ipdNursingController.createNursingNote);
router.get('/nursing-notes/admission/:admissionId', ipdNursingController.getNursingNotesByAdmission);
router.get('/nursing-notes/:id', ipdNursingController.getNursingNoteById);
router.put('/nursing-notes/:id', ipdNursingController.updateNursingNote);
router.delete('/nursing-notes/:id', ipdNursingController.deleteNursingNote);

// ========== VITALS ROUTES ==========
router.post('/vitals', ipdNursingController.createVitals);
router.get('/vitals/admission/:admissionId', ipdNursingController.getVitalsByAdmission);
router.get('/vitals/admission/:admissionId/chart', ipdNursingController.getVitalsChartData);
router.get('/vitals/admission/:admissionId/latest', ipdNursingController.getLatestVitals);

// ========== MEDICATION ROUTES ==========
router.post('/medications', ipdMedicationController.createMedicationOrder);
router.get('/medications/admission/:admissionId', ipdMedicationController.getMedicationsByAdmission);
router.get('/medications/admission/:admissionId/today', ipdMedicationController.getTodaySchedule);
router.get('/medications/:id', ipdMedicationController.getMedicationById);
router.patch('/medications/:id/administer', ipdMedicationController.administerMedication);
router.patch('/medications/:id/skip', ipdMedicationController.skipMedication);
router.patch('/medications/:id/stop', ipdMedicationController.stopMedication);

// ========== BILLING ROUTES ==========
router.post('/billing/charges', ipdBillingController.addManualCharge);
router.get('/billing/admission/:admissionId/charges', ipdBillingController.getChargesByAdmission);
router.get('/billing/admission/:admissionId/running-bill', ipdBillingController.getRunningBill);
router.post('/billing/admission/:admissionId/bed-charges', ipdBillingController.generateBedCharges);
router.post('/billing/admission/:admissionId/discount', ipdBillingController.applyDiscount);
router.post('/billing/admission/:admissionId/payment', ipdBillingController.recordPayment);
router.post('/billing/admission/:admissionId/finalize', ipdBillingController.finalizeBill);

// ========== DISCHARGE ROUTES ==========
router.post('/discharge/:admissionId/initiate', ipdDischargeController.initiateDischarge);
router.post('/discharge/:admissionId/summary', ipdDischargeController.saveDischargeSummary);
router.get('/discharge/:admissionId/summary', ipdDischargeController.getDischargeSummary);
router.post('/discharge/:admissionId/summary/finalize', ipdDischargeController.finalizeDischargeSummary);
router.get('/discharge/:admissionId/checklist', ipdDischargeController.getDischargeChecklist);
router.post('/discharge/:admissionId/complete', ipdDischargeController.completeDischarge);
router.get('/discharge/:admissionId/documents', ipdDischargeController.getDischargeDocuments);

module.exports = router;