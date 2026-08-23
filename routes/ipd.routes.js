const express = require('express');
const IPDAdmission = require('../models/IPDAdmission');
const { requireResourcePatientAccess } = require('../middlewares/patientAccess');
const router = express.Router();
const {
  protect,
  authorize,
  requireModuleAccess,
  requireActionPermission,
  requireAnyActionPermission,
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
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for getStatus()
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  clinical.getClinicalDocumentStatus
);

router.get(
  '/admissions/:admissionId/initial-assessment',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for getDoctorAssessment()
  // ...read,
  // requireModuleAccess('ipd.initial_assessment.doctor', 'view'),
  clinical.getDoctorInitialAssessment
);

router.post(
  '/admissions/:admissionId/initial-assessment',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }),
  requireActionPermission('ipd_clinical_write'),
  clinical.saveDoctorInitialAssessment
);

router.put(
  '/admissions/:admissionId/initial-assessment',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }),
  requireActionPermission('ipd_clinical_write'),
  clinical.saveDoctorInitialAssessment
);

router.get(
  '/admissions/:admissionId/initial-assessment/print',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for printDoctorAssessment()
  // ...read,
  // requireModuleAccess('ipd.initial_assessment.doctor', 'view'),
  clinical.printDoctorInitialAssessment
);

router.get(
  '/admissions/:admissionId/nursing-admission-assessment',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for getNursingAssessment()
  // ...read,
  // requireModuleAccess('ipd.initial_assessment.nursing', 'view'),
  clinical.getNursingAdmissionAssessment
);

router.post(
  '/admissions/:admissionId/nursing-admission-assessment',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }),
  requireActionPermission('ipd_nursing_write'),
  clinical.saveNursingAdmissionAssessment
);

router.put(
  '/admissions/:admissionId/nursing-admission-assessment',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }),
  requireActionPermission('ipd_nursing_write'),
  clinical.saveNursingAdmissionAssessment
);

router.get(
  '/admissions/:admissionId/nursing-admission-assessment/print',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for printNursingAssessment()
  // ...read,
  // requireModuleAccess('ipd.initial_assessment.nursing', 'view'),
  clinical.printNursingAdmissionAssessment
);


// ============== VITALS ==============
router.post(
  '/vitals',
  requireAnyActionPermission(['ipd_nursing_write', 'ipd_clinical_write']),
  clinical.createVitals
);

router.put(
  '/vitals/:id',
  requireAnyActionPermission(['ipd_nursing_write', 'ipd_clinical_write']),
  clinical.updateVitals
);

router.get(
  '/vitals/admission/:admissionId',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for listVitals()
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  clinical.getVitals
);

router.get(
  '/vitals/admission/:admissionId/print/ews',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for printVitalsEws()
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  clinical.printVitalsEws
);

router.get(
  '/vitals/admission/:admissionId/print/patient-care-flow',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for printPatientCareFlow()
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  clinical.printPatientCareFlow
);

router.get(
  '/medications/admission/:admissionId/print',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for printMedicationChart()
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  clinical.printMedicationChart
);

router.get(
  '/rounds/admission/:admissionId/print',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  protect,  // ✅ Added for printRounds()
  // ...read,
  // requireModuleAccess('ipd.rounds', 'view'),
  clinical.printRounds
);

// ============== ADMISSIONS ==============
router.post(
  '/admissions',
  requireActionPermission('ipd_admission_manage'),
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

// Keep concrete analytics routes above /admissions/:id so they can never be
// interpreted as an admission identifier and so the dashboard has stable APIs.
router.get('/admissions/stats/by-doctor', admissions.getAdmissionStatsByDoctor);
router.get('/admissions/stats/by-ward', admissions.getAdmissionStatsByWard);
router.get('/admissions/today-schedule', admissions.getAdmissionTodaySchedule);

router.get('/reports/bed-occupancy', admissions.getBedOccupancyReport);

router.get(
  '/admissions/:id',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'id', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  admissions.getAdmissionById
);

router.put(
  '/admissions/:id',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'id', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }),
  requireActionPermission('ipd_admission_manage'),
  admissions.updateAdmission
);

router.patch(
  '/admissions/:id/status',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'id', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }),
  requireActionPermission('ipd_admission_manage'),
  admissions.updateAdmissionStatus
);

router.delete(
  '/admissions/:id',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'id', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_write' }),
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
  requireActionPermission('ipd_clinical_write'),
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
  requireAnyActionPermission(['ipd_admission_manage', 'ipd_nursing_write']),
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
router.post('/clinical-templates', requireActionPermission('ipd_clinical_write'), clinicalTemplates.createTemplate);
router.put('/clinical-templates/:id', requireActionPermission('ipd_clinical_write'), clinicalTemplates.updateTemplate);
router.delete('/clinical-templates/:id', requireActionPermission('ipd_clinical_write'), clinicalTemplates.deactivateTemplate);
router.post('/clinical-templates/:id/use', requireAnyActionPermission(['ipd_clinical_write', 'ipd_nursing_write']), clinicalTemplates.recordTemplateUse);

// ============== ROUNDS ==============
router.get('/rounds/tariff', rounds.getDoctorTariff);

router.post(
  '/rounds',
  requireActionPermission('ipd_round_write'),
  rounds.createRound
);

router.get(
  '/rounds/admission/:admissionId',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
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
  requireActionPermission('ipd_round_write'),
  rounds.updateRound
);

router.delete(
  '/rounds/:id',
  requireActionPermission('ipd_round_write'),
  rounds.deleteRound
);

// ============== NURSING NOTES ==============
router.post(
  '/nursing-notes',
  requireActionPermission('ipd_nursing_write'),
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
  requireActionPermission('ipd_nursing_write'),
  nursing.updateNursingNote
);

router.delete(
  '/nursing-notes/:id',
  requireActionPermission('ipd_nursing_write'),
  nursing.deleteNursingNote
);

// Legacy vitals chart endpoints
router.get(
  '/vitals/admission/:admissionId/chart',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  nursing.getVitalsChartData
);

router.get(
  '/vitals/admission/:admissionId/latest',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  // ...read,
  // requireModuleAccess('ipd.vitals', 'view'),
  nursing.getLatestVitals
);

// ============== MEDICATION CHART / MAR ==============
router.post(
  '/medications',
  requireAnyActionPermission(['ipd_clinical_write', 'ipd_medication_write']),
  meds.createMedicationOrder
);

router.get(
  '/medications/admission/:admissionId',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getMedicationsByAdmission
);

router.get(
  '/medications/admission/:admissionId/today',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
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
  requireActionPermission('ipd_clinical_write'),
  meds.changeMedicationOrder
);

router.patch(
  '/medications/:id/administer',
  requireActionPermission('ipd_medication_write'),
  validateAdministration,
  meds.administerMedication
);

router.patch(
  '/medications/:id/skip',
  requireActionPermission('ipd_medication_write'),
  meds.skipMedication
);

router.patch(
  '/medications/:id/stop',
  requireAnyActionPermission(['ipd_clinical_write', 'ipd_medication_write']),
  meds.stopMedication
);

router.patch(
  '/medications/:id/hold',
  requireAnyActionPermission(['ipd_clinical_write', 'ipd_medication_write']),
  meds.holdMedication
);

router.patch(
  '/medications/:id/request-pharmacy',
  requireActionPermission('ipd_medication_write'),
  validateIndent,
  meds.requestPharmacy
);

router.patch(
  '/medications/:id/receive-external',
  requireActionPermission('ipd_medication_write'),
  validateIndent,
  meds.receiveExternalPharmacyStock
);

router.patch(
  '/medications/:id/acknowledge-receipt',
  requireActionPermission('ipd_medication_write'),
  meds.acknowledgeStockReceipt
);

router.get(
  '/medications/admission/:admissionId/pending-receipts',
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
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
  requireResourcePatientAccess(IPDAdmission, { idParam: 'admissionId', patientField: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }),
  // ...read,
  // requireModuleAccess('ipd.medication_chart', 'view'),
  meds.getMedicationSummary
);

router.post('/clinical-templates/:id/validate', clinicalTemplates.validateTemplateData);

// ============== BILLING ==============
router.post(
  '/billing/charges',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_create', 'billing_edit']),
  billing.addManualCharge
);

router.get(
  '/billing/admission/:admissionId/charges',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  requireModuleAccess('billing_finance', 'view'),
  billing.getChargesByAdmission
);

router.get(
  '/billing/admission/:admissionId/running-bill',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  requireModuleAccess('billing_finance', 'view'),
  billing.getRunningBill
);

router.post(
  '/billing/admission/:admissionId/daily-charges/catch-up',
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_create', 'billing_edit']),
  billing.catchUpDailyCharges
);

router.post(
  '/billing/daily-charges/catch-up',
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_create', 'billing_edit']),
  billing.catchUpHospitalDailyCharges
);

router.post(
  '/billing/admission/:admissionId/bed-charges',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_create', 'billing_edit']),
  billing.generateBedCharges
);

router.post(
  '/billing/admission/:admissionId/discount',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  // requireActionPermission('discount_override'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_apply_discount', 'discount_override', 'pricing_override']),
  billing.applyDiscount
);

router.post(
  '/billing/admission/:admissionId/payment',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_edit', 'settlement']),
  billing.recordPayment
);

router.post(
  '/billing/admission/:admissionId/finalize',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_finalize', 'final_clearance']),
  billing.finalizeBill
);

router.post(
  '/billing/admission/:admissionId/advance',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_edit', 'settlement']),
  billing.recordAdvance
);

router.post(
  '/billing/admission/:admissionId/advance-refund',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  // requireActionPermission('refund'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_delete_charge', 'refund']),
  billing.refundAdvance
);

router.get(
  '/billing/admission/:admissionId/ledger',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  requireModuleAccess('billing_finance', 'view'),
  billing.getLedger
);

router.get(
  '/billing/admission/:admissionId/financial-clearance',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  requireModuleAccess('billing_finance', 'view'),
  billing.getFinancialClearance
);

router.post(
  '/billing/admission/:admissionId/financial-clearance',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  // requireActionPermission('final_clearance'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_finalize', 'final_clearance']),
  billing.finaliseFinancialClearance
);

router.patch(
  '/billing/admission/:admissionId/charges/:chargeId/void',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'edit'),
  requireModuleAccess('billing_finance', 'manage'),
  requireAnyActionPermission(['billing_delete_charge', 'pricing_override', 'refund']),
  billing.voidCharge
);

// ============== DISCHARGE ==============
router.post(
  '/discharge/:admissionId/initiate',
  requireAnyActionPermission(['ipd_discharge_write', 'ipd_discharge_support']),
  discharge.initiateDischarge
);

router.post(
  '/discharge/:admissionId/summary',
  requireAnyActionPermission(['ipd_discharge_write', 'ipd_discharge_support']),
  discharge.saveDischargeSummary
);

router.post('/discharge/:admissionId/medication-reconciliation', requireAnyActionPermission(['ipd_discharge_write', 'ipd_discharge_support']), discharge.reconcileDischargeMedications);

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
  requireActionPermission('ipd_discharge_write'),
  discharge.finalizeDischargeSummary
);

router.post(
  '/discharge/:admissionId/staff-complete',
  requireActionPermission('ipd_discharge_support'),
  discharge.staffCompleteDischargeSummary
);

router.get(
  '/discharge/:admissionId/checklist',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  discharge.getDischargeChecklist
);

router.patch(
  '/discharge/:admissionId/checklist',
  requireActionPermission('ipd_discharge_support'),
  discharge.updateDischargeChecklist
);

router.post(
  '/discharge/:admissionId/complete',
  requireActionPermission('ipd_discharge_write'),
  discharge.completeDischarge
);

router.post(
  '/discharge/:admissionId/clinical-exception',
  requireActionPermission('ipd_discharge_override'),
  discharge.approveClinicalDischargeException
);

router.get(
  '/discharge/:admissionId/documents',
  // ...read,
  // requireModuleAccess('ipd.patient_file', 'view'),
  discharge.getDischargeDocuments
);

module.exports = router;
