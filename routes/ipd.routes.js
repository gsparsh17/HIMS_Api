const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middlewares/auth');

// Import controllers
const ipdAdmissionController = require('../controllers/ipdAdmission.controller');
const ipdBedController = require('../controllers/ipdBed.controller');
const ipdRoundController = require('../controllers/ipdRound.controller');
const ipdNursingController = require('../controllers/ipdNursing.controller');
const ipdMedicationController = require('../controllers/ipdMedication.controller');
const ipdBillingController = require('../controllers/ipdBilling.controller');
const ipdDischargeController = require('../controllers/ipdDischarge.controller');

// ========== ADMISSION ROUTES ==========
// Create new admission
router.post('/admissions', 
  // protect, 
  // authorize('admin', 'registrar', 'doctor'),
  ipdAdmissionController.createAdmission
);

// Get all admissions with filters
router.get('/admissions', 
  // protect, 
  // authorize('admin', 'registrar', 'doctor', 'nurse', 'pharmacy', 'pharmacy_head', 'billing'),
  ipdAdmissionController.getAllAdmissions
);

// Get dashboard statistics
router.get('/admissions/dashboard/stats', 
  // protect, 
  // authorize('admin', 'registrar', 'doctor'),
  ipdAdmissionController.getDashboardStats
);

// Get admission by ID
router.get('/admissions/:id', 
  // protect, 
  // authorize('admin', 'registrar', 'doctor', 'nurse', 'pharmacy', 'pharmacy_head', 'billing'),
  ipdAdmissionController.getAdmissionById
);

// Update admission
router.put('/admissions/:id', 
  // protect, 
  // authorize('admin', 'doctor'),
  ipdAdmissionController.updateAdmission
);

// Update admission status
router.patch('/admissions/:id/status', 
  // protect, 
  // authorize('admin', 'doctor', 'registrar'),
  ipdAdmissionController.updateAdmissionStatus
);

// Delete/cancel admission
router.delete('/admissions/:id', 
  // protect, 
  // authorize('admin'),
  ipdAdmissionController.deleteAdmission
);

// ========== PHARMACY INTEGRATION ROUTES (NEW) ==========
// Get admission by SHIP number (for pharmacy POS lookup)
router.get('/ship/:shipNumber', 
  // protect, 
  // authorize('pharmacy', 'pharmacy_head', 'admin', 'billing', 'registrar'),
  ipdAdmissionController.getAdmissionByShipNumber
);

// Update pharmacy clearance status
router.patch('/:id/pharmacy-clearance',
  // protect,
  // authorize('pharmacy_head', 'admin', 'billing'),
  ipdAdmissionController.updatePharmacyClearance
);

// Get admissions pending pharmacy clearance
router.get('/pharmacy-clearance/pending',
  // protect,
  // authorize('pharmacy_head', 'admin', 'billing'),
  ipdAdmissionController.getPendingPharmacyClearance
);

// ========== NURSE SPECIFIC ROUTES ==========
// Complete clinical assessment (nurse workflow)
router.post('/admissions/:id/complete-clinical-assessment', 
  // protect, 
  // authorize('nurse', 'admin', 'doctor'),
  ipdAdmissionController.completeClinicalAssessment
);

// Get nurse dashboard data
router.get('/nurse/dashboard', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdAdmissionController.getNurseDashboardData
);

// ========== BED ROUTES ==========
router.post('/beds', 
  // protect, 
  // authorize('admin', 'registrar'),
  ipdBedController.createBed
);

router.get('/beds', 
  // protect, 
  // authorize('admin', 'registrar', 'nurse', 'doctor'),
  ipdBedController.getAllBeds
);

router.get('/beds/available', 
  // protect, 
  // authorize('admin', 'registrar', 'nurse', 'doctor'),
  ipdBedController.getAvailableBeds
);

router.get('/beds/occupied', 
  // protect, 
  // authorize('admin', 'registrar', 'nurse', 'doctor'),
  ipdBedController.getOccupiedBeds
);

router.get('/beds/:id', 
  // protect, 
  // authorize('admin', 'registrar', 'nurse'),
  ipdBedController.getBedById
);

router.put('/beds/:id', 
  // protect, 
  // authorize('admin'),
  ipdBedController.updateBed
);

router.patch('/beds/:id/status', 
  // protect, 
  // authorize('admin', 'nurse'),
  ipdBedController.updateBedStatus
);

router.delete('/beds/:id', 
  // protect, 
  // authorize('admin'),
  ipdBedController.deleteBed
);

// ========== ROUND ROUTES ==========
router.post('/rounds', 
  // protect, 
  // authorize('doctor', 'admin'),
  ipdRoundController.createRound
);

router.get('/rounds/admission/:admissionId', 
  // protect, 
  // authorize('doctor', 'nurse', 'admin'),
  ipdRoundController.getRoundsByAdmission
);

router.get('/rounds/doctor/:doctorId', 
  // protect, 
  // authorize('doctor', 'admin'),
  ipdRoundController.getRoundsByDoctor
);

router.get('/rounds/:id', 
  // protect, 
  // authorize('doctor', 'nurse', 'admin'),
  ipdRoundController.getRoundById
);

router.put('/rounds/:id', 
  // protect, 
  // authorize('doctor', 'admin'),
  ipdRoundController.updateRound
);

router.delete('/rounds/:id', 
  // protect, 
  // authorize('doctor', 'admin'),
  ipdRoundController.deleteRound
);

// ========== NURSING ROUTES ==========
router.post('/nursing-notes', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdNursingController.createNursingNote
);

router.get('/nursing-notes/admission/:admissionId', 
  // protect, 
  // authorize('nurse', 'doctor', 'admin'),
  ipdNursingController.getNursingNotesByAdmission
);

router.get('/nursing-notes/:id', 
  // protect, 
  // authorize('nurse', 'doctor', 'admin'),
  ipdNursingController.getNursingNoteById
);

router.put('/nursing-notes/:id', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdNursingController.updateNursingNote
);

router.delete('/nursing-notes/:id', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdNursingController.deleteNursingNote
);

// ========== VITALS ROUTES ==========
router.post('/vitals', 
  // protect, 
  // authorize('nurse', 'doctor', 'admin'),
  ipdNursingController.createVitals
);

router.get('/vitals/admission/:admissionId', 
  // protect, 
  // authorize('nurse', 'doctor', 'admin'),
  ipdNursingController.getVitalsByAdmission
);

router.get('/vitals/admission/:admissionId/chart', 
  // protect, 
  // authorize('nurse', 'doctor', 'admin'),
  ipdNursingController.getVitalsChartData
);

router.get('/vitals/admission/:admissionId/latest', 
  // protect, 
  // authorize('nurse', 'doctor', 'admin', 'pharmacy'),
  ipdNursingController.getLatestVitals
);

// ========== MEDICATION ROUTES ==========
// Create medication order
router.post('/medications', 
  // protect, 
  // authorize('doctor', 'admin'),
  ipdMedicationController.createMedicationOrder
);

// Get medications by admission
router.get('/medications/admission/:admissionId', 
  // protect, 
  // authorize('doctor', 'nurse', 'pharmacy', 'pharmacy_head', 'admin'),
  ipdMedicationController.getMedicationsByAdmission
);

// Get today's medication schedule
router.get('/medications/admission/:admissionId/today', 
  // protect, 
  // authorize('nurse', 'doctor', 'admin'),
  ipdMedicationController.getTodaySchedule
);

// Get medication by ID
router.get('/medications/:id', 
  // protect, 
  // authorize('doctor', 'nurse', 'pharmacy', 'admin'),
  ipdMedicationController.getMedicationById
);

// Administer medication (nurse)
router.patch('/medications/:id/administer', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdMedicationController.administerMedication
);

// Skip medication (nurse)
router.patch('/medications/:id/skip', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdMedicationController.skipMedication
);

// Stop medication (doctor)
router.patch('/medications/:id/stop', 
  // protect, 
  // authorize('doctor', 'admin'),
  ipdMedicationController.stopMedication
);

// Hold medication (nurse/doctor)
router.patch('/medications/:id/hold', 
  // protect, 
  // authorize('nurse', 'doctor', 'admin'),
  ipdMedicationController.holdMedication
);

// Request medication from pharmacy (nurse)
router.patch('/medications/:id/request-pharmacy', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdMedicationController.requestPharmacy
);

// Receive medication stock from external pharmacy (nurse)
router.patch('/medications/:id/receive-external', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdMedicationController.receiveExternalPharmacyStock
);

// ========== PHARMACY INTEGRATION FOR MEDICATIONS ==========
// Get pending pharmacy requests (for pharmacy dashboard)
router.get('/medications/pharmacy/requests/:pharmacyId', 
  // protect, 
  // authorize('pharmacy', 'pharmacy_head', 'admin'),
  ipdMedicationController.getPendingPharmacyRequests
);

// Process pharmacy request (pharmacy dispenses medication)
router.patch('/medications/:id/pharmacy-process', 
  // protect, 
  // authorize('pharmacy', 'pharmacy_head', 'admin'),
  ipdMedicationController.processPharmacyRequest
);

// Get nurse's today's medication schedule
router.get('/medications/nurse/today', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdMedicationController.getNurseTodaySchedule
);

// Get medication schedule for specific nurse and admission
router.get('/medications/nurse/admission/:admissionId/schedule', 
  // protect, 
  // authorize('nurse', 'admin'),
  ipdMedicationController.getMedicationScheduleForNurse
);

// Get medication summary for admission
router.get('/medications/admission/:admissionId/summary', 
  // protect, 
  // authorize('doctor', 'nurse', 'pharmacy', 'admin'),
  ipdMedicationController.getMedicationSummary
);

// ========== BILLING ROUTES ==========
// Finance mutations are authenticated and use shared Bill -> Invoice -> Receipt
// lifecycle controls. Existing URLs are retained for older screens.
const financeViewRoles = ['admin', 'accountant', 'registrar', 'staff'];
const financeApproveRoles = ['admin', 'accountant'];

router.post('/billing/charges', protect, authorize(...financeViewRoles), ipdBillingController.addManualCharge);
router.get('/billing/admission/:admissionId/charges', protect, authorize(...financeViewRoles), ipdBillingController.getChargesByAdmission);
router.get('/billing/admission/:admissionId/running-bill', protect, authorize(...financeViewRoles), ipdBillingController.getRunningBill);
router.post('/billing/admission/:admissionId/bed-charges', protect, authorize(...financeViewRoles), ipdBillingController.generateBedCharges);
router.post('/billing/admission/:admissionId/discount', protect, authorize(...financeApproveRoles), ipdBillingController.applyDiscount);
router.post('/billing/admission/:admissionId/payment', protect, authorize(...financeViewRoles), ipdBillingController.recordPayment);
router.post('/billing/admission/:admissionId/finalize', protect, authorize(...financeViewRoles), ipdBillingController.finalizeBill);
router.post('/billing/admission/:admissionId/advance', protect, authorize(...financeViewRoles), ipdBillingController.recordAdvance);
router.post('/billing/admission/:admissionId/advance-refund', protect, authorize(...financeApproveRoles), ipdBillingController.refundAdvance);
router.get('/billing/admission/:admissionId/ledger', protect, authorize(...financeViewRoles), ipdBillingController.getLedger);
router.get('/billing/admission/:admissionId/financial-clearance', protect, authorize(...financeViewRoles), ipdBillingController.getFinancialClearance);
router.post('/billing/admission/:admissionId/financial-clearance', protect, authorize(...financeApproveRoles), ipdBillingController.finaliseFinancialClearance);
router.patch('/billing/admission/:admissionId/charges/:chargeId/void', protect, authorize(...financeApproveRoles), ipdBillingController.voidCharge);

// ========== DISCHARGE ROUTES ==========
// Initiate discharge process
router.post('/discharge/:admissionId/initiate', 
  // protect, 
  // authorize('doctor', 'admin', 'registrar'),
  ipdDischargeController.initiateDischarge
);

// Save discharge summary (doctor)
router.post('/discharge/:admissionId/summary', 
  // protect, 
  // authorize('doctor', 'admin'),
  ipdDischargeController.saveDischargeSummary
);

// Get discharge summary
router.get('/discharge/:admissionId/summary', 
  // protect, 
  // authorize('doctor', 'nurse', 'admin', 'registrar'),
  ipdDischargeController.getDischargeSummary
);

// Get discharge records
router.get('/discharge/:admissionId/records', 
  // protect, 
  // authorize('admin', 'doctor', 'registrar'),
  ipdDischargeController.getDischargeRecords
);

// Finalize discharge summary (doctor)
router.post('/discharge/:admissionId/summary/finalize', 
  // protect, 
  // authorize('doctor', 'admin'),
  ipdDischargeController.finalizeDischargeSummary
);

// Staff completes discharge summary (new)
router.post('/discharge/:admissionId/staff-complete', 
  // protect, 
  // authorize('nurse', 'admin', 'registrar'),
  ipdDischargeController.staffCompleteDischargeSummary
);

// Get discharge checklist
router.get('/discharge/:admissionId/checklist', 
  // protect, 
  // authorize('doctor', 'nurse', 'admin', 'registrar'),
  ipdDischargeController.getDischargeChecklist
);

// Complete discharge (final step)
router.post('/discharge/:admissionId/complete', 
  // protect, 
  // authorize('admin', 'registrar'),
  ipdDischargeController.completeDischarge
);

// Get discharge documents
router.get('/discharge/:admissionId/documents', 
  // protect, 
  // authorize('admin', 'doctor', 'registrar', 'patient'),
  ipdDischargeController.getDischargeDocuments
);

module.exports = router;