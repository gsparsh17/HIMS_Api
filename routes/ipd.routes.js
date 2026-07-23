const express = require('express');
const router = express.Router();
const {
  protect,
  authorize,
  requireModuleAccess,
} = require('../middlewares/auth');
const {
  validateIndent,
  validatePharmacyProcess,
  validateAdministration
} = require('../middlewares/medicationFlowValidation');
const admissions = require('../controllers/ipdAdmission.controller');
const beds = require('../controllers/ipdBed.controller');
const rounds = require('../controllers/ipdRound.controller');
const nursing = require('../controllers/ipdNursing.controller');
const meds = require('../controllers/ipdMedication.controller');
const billing = require('../controllers/ipdBilling.controller');
const discharge = require('../controllers/ipdDischarge.controller');
const clinical = require('../controllers/ipdClinicalDocuments.controller');
const clinicalTemplates = require('../controllers/clinicalTemplate.controller');

const clinicalRoles = ['admin', 'doctor', 'nurse', 'staff', 'registrar', 'pharmacy', 'accountant'];
const read = [protect, authorize(...clinicalRoles)];
const doctors = [protect, authorize('admin', 'doctor')];
const nurses = [protect, authorize('admin', 'nurse', 'staff')];

// Enforce authentication and hospital feature access across the complete IPD route tree.
router.use(protect, requireModuleAccess('ipd', 'view'));
router.use((req, res, next) => req.method === 'GET' ? next() : requireModuleAccess('ipd', 'manage')(req, res, next));

// ============== CLINICAL DOCUMENTS ==============
router.get(
  '/admissions/:admissionId/clinical-documents/status',
  protect,  // ✅ Added for getStatus()
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  clinical.getClinicalDocumentStatus
);

router.get(
  '/admissions/:admissionId/initial-assessment',
  protect,  // ✅ Added for getDoctorAssessment()
  // ...read,
  // requireModuleAccess('ipd.initial_assessment.doctor', 'view'),
  clinical.getDoctorInitialAssessment
);

router.post(
  '/admissions/:admissionId/initial-assessment',
  protect,  // ✅ Added for saveDoctorAssessment()
  // ...doctors,
  // requireModuleAccess('ipd.initial_assessment.doctor', 'edit'),
  clinical.saveDoctorInitialAssessment
);

router.put(
  '/admissions/:admissionId/initial-assessment',
  protect,  // ✅ Added for saveDoctorAssessment()
  // ...doctors,
  // requireModuleAccess('ipd.initial_assessment.doctor', 'edit'),
  clinical.saveDoctorInitialAssessment
);

router.get(
  '/admissions/:admissionId/initial-assessment/print',
  protect,  // ✅ Added for printDoctorAssessment()
  // ...read,
  // requireModuleAccess('ipd.initial_assessment.doctor', 'view'),
  clinical.printDoctorInitialAssessment
);

router.get(
  '/admissions/:admissionId/nursing-admission-assessment',
  protect,  // ✅ Added for getNursingAssessment()
  // ...read,
  // requireModuleAccess('ipd.initial_assessment.nursing', 'view'),
  clinical.getNursingAdmissionAssessment
);

router.post(
  '/admissions/:admissionId/nursing-admission-assessment',
  protect,  // ✅ Added for saveNursingAssessment()
  // ...nurses,
  // requireModuleAccess('ipd.initial_assessment.nursing', 'edit'),
  clinical.saveNursingAdmissionAssessment
);

router.put(
  '/admissions/:admissionId/nursing-admission-assessment',
  protect,  // ✅ Added for saveNursingAssessment()
  // ...nurses,
  // requireModuleAccess('ipd.initial_assessment.nursing', 'edit'),
  clinical.saveNursingAdmissionAssessment
);

router.get(
  '/admissions/:admissionId/nursing-admission-assessment/print',
  protect,  // ✅ Added for printNursingAssessment()
  // ...read,
  // requireModuleAccess('ipd.initial_assessment.nursing', 'view'),
  clinical.printNursingAdmissionAssessment
);

// ============== VITALS ==============
router.post(
  '/vitals',
  protect,  // ✅ Added for saveVitals()
  // ...nurses,
  // requireModuleAccess('ipd.vitals', 'edit'),
  clinical.createVitals
);

router.put(
  '/vitals/:id',
  protect,  // ✅ Added for saveVitals() (update)
  // ...nurses,
  // requireModuleAccess('ipd.vitals', 'edit'),
  clinical.updateVitals
);

router.get(
  '/vitals/admission/:admissionId',
  protect,  // ✅ Added for listVitals()
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  clinical.getVitals
);

router.get(
  '/vitals/admission/:admissionId/print/ews',
  protect,  // ✅ Added for printVitalsEws()
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  clinical.printVitalsEws
);

router.get(
  '/vitals/admission/:admissionId/print/patient-care-flow',
  protect,  // ✅ Added for printPatientCareFlow()
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  clinical.printPatientCareFlow
);

router.get(
  '/medications/admission/:admissionId/print',
  protect,  // ✅ Added for printMedicationChart()
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  clinical.printMedicationChart
);

router.get(
  '/rounds/admission/:admissionId/print',
  protect,  // ✅ Added for printRounds()
  // ...read,
  // requireModuleAccess('ipd.rounds', 'view'),
  clinical.printRounds
);

// ============== ADMISSIONS ==============
router.post(
  '/admissions',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  admissions.createAdmission
);

router.get(
  '/admissions',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  admissions.getAllAdmissions
);

router.get(
  '/admissions/dashboard/stats',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  admissions.getDashboardStats
);

router.get(
  '/admissions/:id',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  admissions.getAdmissionById
);

router.put(
  '/admissions/:id',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  admissions.updateAdmission
);

router.patch(
  '/admissions/:id/status',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  admissions.updateAdmissionStatus
);

router.delete(
  '/admissions/:id',
  protect,
  authorize('admin'),
  requireModuleAccess('ipd.patient_file', 'edit'),
  admissions.deleteAdmission
);

router.get(
  '/ship/:shipNumber',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  admissions.getAdmissionByShipNumber
);

router.patch(
  '/:id/pharmacy-clearance',
  // ...read,
  // requireModuleAccess('pharmacy.clearance', 'edit'),
  // requireActionPermission('final_clearance'),
  admissions.updatePharmacyClearance
);

router.get(
  '/pharmacy-clearance/pending',
  // ...read,
  // requireModuleAccess('pharmacy.clearance', 'view'),
  admissions.getPendingPharmacyClearance
);

router.post(
  '/admissions/:id/complete-clinical-assessment',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  admissions.completeClinicalAssessment
);

router.get(
  '/nurse/dashboard',
  // ...nurses,
  // requireModuleAccess('ipd.patient_file', 'view'),
  admissions.getNurseDashboardData
);

// ============== BEDS ==============
router.post(
  '/beds',
  protect,
  authorize('admin', 'registrar'),
  requireModuleAccess('ipd.patient_file', 'edit'),
  beds.createBed
);

router.get(
  '/beds',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  beds.getAllBeds
);

router.get(
  '/beds/available',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  beds.getAvailableBeds
);

router.get(
  '/beds/occupied',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  beds.getOccupiedBeds
);

router.get(
  '/beds/:id',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  beds.getBedById
);

router.put(
  '/beds/:id',
  protect,
  authorize('admin'),
  requireModuleAccess('ipd.patient_file', 'edit'),
  beds.updateBed
);

router.patch(
  '/beds/:id/status',
  // ...nurses,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  beds.updateBedStatus
);

router.delete(
  '/beds/:id',
  protect,
  authorize('admin'),
  requireModuleAccess('ipd.patient_file', 'edit'),
  beds.deleteBed
);

router.post(
  '/beds/sync',
  protect,
  authorize('admin', 'registrar'),
  requireModuleAccess('ipd.patient_file', 'edit'),
  beds.syncBedStatus
);

// ============== CLINICAL TEMPLATES ==============
router.get('/clinical-templates', clinicalTemplates.listTemplates);
router.post('/clinical-templates', clinicalTemplates.createTemplate);
router.put('/clinical-templates/:id', clinicalTemplates.updateTemplate);
router.delete('/clinical-templates/:id', clinicalTemplates.deactivateTemplate);
router.post('/clinical-templates/:id/use', clinicalTemplates.recordTemplateUse);

// ============== ROUNDS ==============
router.post(
  '/rounds',
  // ...doctors,
  // requireModuleAccess('ipd.rounds', 'edit'),
  rounds.createRound
);

router.get(
  '/rounds/admission/:admissionId',
  // ...read,
  // requireModuleAccess('ipd.rounds', 'view'),
  rounds.getRoundsByAdmission
);

router.get(
  '/rounds/doctor/:doctorId',
  // ...doctors,
  // requireModuleAccess('ipd.rounds', 'view'),
  rounds.getRoundsByDoctor
);

router.get(
  '/rounds/:id',
  // ...read,
  // requireModuleAccess('ipd.rounds', 'view'),
  rounds.getRoundById
);

router.put(
  '/rounds/:id',
  // ...doctors,
  // requireModuleAccess('ipd.rounds', 'edit'),
  rounds.updateRound
);

router.delete(
  '/rounds/:id',
  // ...doctors,
  // requireModuleAccess('ipd.rounds', 'edit'),
  rounds.deleteRound
);

// ============== NURSING NOTES ==============
router.post(
  '/nursing-notes',
  // ...nurses,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  nursing.createNursingNote
);

router.get(
  '/nursing-notes/admission/:admissionId',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  nursing.getNursingNotesByAdmission
);

router.get(
  '/nursing-notes/:id',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  nursing.getNursingNoteById
);

router.put(
  '/nursing-notes/:id',
  // ...nurses,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  nursing.updateNursingNote
);

router.delete(
  '/nursing-notes/:id',
  // ...nurses,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  nursing.deleteNursingNote
);

// Legacy vitals chart endpoints
router.get(
  '/vitals/admission/:admissionId/chart',
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  nursing.getVitalsChartData
);

router.get(
  '/vitals/admission/:admissionId/latest',
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  nursing.getLatestVitals
);

// ============== MEDICATION CHART / MAR ==============
router.post(
  '/medications',
  // ...doctors,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  meds.createMedicationOrder
);

router.get(
  '/medications/admission/:admissionId',
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getMedicationsByAdmission
);

router.get(
  '/medications/admission/:admissionId/today',
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getTodaySchedule
);

router.get(
  '/medications/:id',
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getMedicationById
);

router.patch(
  '/medications/:id/doctor-change',
  meds.changeMedicationOrder
);

router.patch(
  '/medications/:id/administer',
  // ...nurses,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  validateAdministration,
  meds.administerMedication
);

router.patch(
  '/medications/:id/skip',
  // ...nurses,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  meds.skipMedication
);

router.patch(
  '/medications/:id/stop',
  // ...doctors,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  meds.stopMedication
);

router.patch(
  '/medications/:id/hold',
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  meds.holdMedication
);

router.patch(
  '/medications/:id/request-pharmacy',
  // ...nurses,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  validateIndent,
  meds.requestPharmacy
);

router.patch(
  '/medications/:id/receive-external',
  // ...nurses,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  validateIndent,
  meds.receiveExternalPharmacyStock
);

router.patch(
  '/medications/:id/acknowledge-receipt',
  // ...nurses,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  meds.acknowledgeStockReceipt
);

router.get(
  '/medications/admission/:admissionId/pending-receipts',
  // ...nurses,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getPendingStockReceipts
);

router.get(
  '/medications/pharmacy/requests/:pharmacyId',
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getPendingPharmacyRequests
);

router.patch(
  '/medications/:id/pharmacy-process',
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'edit'),
  validatePharmacyProcess,
  meds.processPharmacyRequest
);

router.get(
  '/medications/nurse/today',
  // ...nurses,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getNurseTodaySchedule
);

router.get(
  '/medications/nurse/admission/:admissionId/schedule',
  // ...nurses,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getMedicationScheduleForNurse
);

router.get(
  '/medications/admission/:admissionId/summary',
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getMedicationSummary
);

// ============== BILLING ==============
router.post(
  '/billing/charges',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  billing.addManualCharge
);

router.get(
  '/billing/admission/:admissionId/charges',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  billing.getChargesByAdmission
);

router.get(
  '/billing/admission/:admissionId/running-bill',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  billing.getRunningBill
);

router.post(
  '/billing/admission/:admissionId/bed-charges',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  billing.generateBedCharges
);

router.post(
  '/billing/admission/:admissionId/discount',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  // requireActionPermission('discount_override'),
  billing.applyDiscount
);

router.post(
  '/billing/admission/:admissionId/payment',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  billing.recordPayment
);

router.post(
  '/billing/admission/:admissionId/finalize',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  billing.finalizeBill
);

router.post(
  '/billing/admission/:admissionId/advance',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  billing.recordAdvance
);

router.post(
  '/billing/admission/:admissionId/advance-refund',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  // requireActionPermission('refund'),
  billing.refundAdvance
);

router.get(
  '/billing/admission/:admissionId/ledger',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  billing.getLedger
);

router.get(
  '/billing/admission/:admissionId/financial-clearance',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  billing.getFinancialClearance
);

router.post(
  '/billing/admission/:admissionId/financial-clearance',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  // requireActionPermission('final_clearance'),
  billing.finaliseFinancialClearance
);

router.patch(
  '/billing/admission/:admissionId/charges/:chargeId/void',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  billing.voidCharge
);

// ============== DISCHARGE ==============
router.post(
  '/discharge/:admissionId/initiate',
  // ...doctors,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  discharge.initiateDischarge
);

router.post(
  '/discharge/:admissionId/summary',
  // ...doctors,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  discharge.saveDischargeSummary
);

router.get(
  '/discharge/:admissionId/summary',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  discharge.getDischargeSummary
);

router.get(
  '/discharge/:admissionId/records',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  discharge.getDischargeRecords
);

router.post(
  '/discharge/:admissionId/summary/finalize',
  // ...doctors,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  discharge.finalizeDischargeSummary
);

router.post(
  '/discharge/:admissionId/staff-complete',
  // ...nurses,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  discharge.staffCompleteDischargeSummary
);

router.get(
  '/discharge/:admissionId/checklist',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  discharge.getDischargeChecklist
);

router.post(
  '/discharge/:admissionId/complete',
  protect,
  authorize('admin', 'registrar'),
  requireModuleAccess('ipd.patient_file', 'edit'),
  discharge.completeDischarge
);

router.get(
  '/discharge/:admissionId/documents',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  discharge.getDischargeDocuments
);

module.exports = router;