const { operationNow } = require('../utils/operationTimeContext');
const mongoose = require('mongoose');
// backend/controllers/ipdDischarge.controller.js
const IPDAdmission = require('../models/IPDAdmission');
const DischargeSummary = require('../models/DischargeSummary');
const Bed = require('../models/Bed');
const IPDCharge = require('../models/IPDCharge');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const Hospital = require('../models/Hospital');
const LabReport = require('../models/LabReport');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const Medicine = require('../models/Medicine');
const IPDRound = require('../models/IPDRound');
const IPDVitals = require('../models/IPDVitals');
const NursingNote = require('../models/NursingNote');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const OTRequest = require('../models/OTRequest');
const Prescription = require('../models/Prescription');
const Sale = require('../models/Sale');
const IPDAccommodationSegment = require('../models/IPDAccommodationSegment');
const { appendDomainEvent } = require('../services/auditEvent.service');
const { loadIPDWorkflowPolicy } = require('../services/ipdWorkflowPolicy.service');
const financial = require('../services/ipdFinancial.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { buildAccommodationPrintData } = require('../services/ipdAccommodationPrint.service');
const { parseHospitalDateTime, hospitalDateKey } = require('../utils/hospitalDateTime');
const { ensureAdmissionDailyCharges } = require('../services/ipdRecurringCharge.service');
const { reopenChargeFreeze } = require('../services/ipdLifecycleGuard.service');
const { resolveClinicalActor } = require('../services/clinicalActor.service');

const CANONICAL_DISCHARGE_TYPES = Object.freeze(['Normal', 'DOR', 'LAMA', 'Referred', 'Death']);
const FINAL_LAB_STATUSES = new Set(['Verified', 'Completed', 'Reported', 'Released', 'Amended']);
const FINAL_RADIOLOGY_STATUSES = new Set(['Verified', 'Completed', 'Reported', 'Amended']);

function canonicalDischargeType(value = 'Normal') {
  const raw = String(value || 'Normal').trim();
  const key = raw.toUpperCase().replace(/[ _-]+/g, ' ');
  if (['NORMAL', 'RECOVERED', 'IMPROVED', 'STABILIZED'].includes(key)) return 'Normal';
  if (['DOR', 'DISCHARGE ON REQUEST', 'ON REQUEST'].includes(key)) return 'DOR';
  if (['LAMA', 'DAMA', 'DISCHARGE AGAINST MEDICAL ADVICE', 'LEAVE AGAINST MEDICAL ADVICE'].includes(key)) return 'LAMA';
  if (['REFERRED', 'REFERRAL', 'TRANSFER', 'TRANSFERRED'].includes(key)) return 'Referred';
  if (['DEATH', 'EXPIRED', 'DECEASED'].includes(key)) return 'Death';
  const error = new Error(`Unsupported discharge type: ${raw}`);
  error.statusCode = 400;
  error.code = 'INVALID_DISCHARGE_TYPE';
  throw error;
}

function normalizeDeathDetails(dischargeType, payload = {}, existing = {}) {
  if (dischargeType !== 'Death') return undefined;
  const source = payload.deathDetails || {};
  const deathDate = source.deathDate || payload.deathDate || existing.deathDate;
  const deathTime = source.deathTime || payload.deathTime || existing.deathTime;
  const chiefComplaints = source.chiefComplaints || payload.deathChiefComplaints || payload.chiefComplaints || existing.chiefComplaints;
  const causeOfDeath = source.causeOfDeath || payload.causeOfDeath || existing.causeOfDeath;
  const summary = source.summary || payload.deathSummary || payload.deathDetailsText || existing.summary;
  if (!chiefComplaints || !causeOfDeath || !summary || !deathDate || !deathTime) {
    const error = new Error('Death discharge requires Chief Complaints, Cause of Death, Death Summary/Details, Death Date and Death Time');
    error.statusCode = 400;
    error.code = 'DEATH_DISCHARGE_FIELDS_REQUIRED';
    throw error;
  }
  const dateKey = hospitalDateKey(deathDate);
  const deathAt = parseHospitalDateTime(deathTime, dateKey);
  return { chiefComplaints, causeOfDeath, summary, deathDate: new Date(`${dateKey}T00:00:00.000Z`), deathTime: String(deathTime), deathAt };
}

function isFinalLabRequest(row) {
  return Boolean(row?.reportFinalisation?.isFinal) || FINAL_LAB_STATUSES.has(String(row?.status || ''));
}
function isFinalRadiologyRequest(row) {
  return Boolean(row?.reportFinalisation?.isFinal) || FINAL_RADIOLOGY_STATUSES.has(String(row?.status || ''));
}
function classifyInvestigation(row, kind) {
  const status = String(row?.status || 'Pending');
  const cancelled = ['Cancelled', 'Rejected'].includes(status);
  const referredOut = status === 'Referred Out';
  const final = kind === 'LAB' ? isFinalLabRequest(row) : isFinalRadiologyRequest(row);
  return { final, cancelled, referredOut, pending: !final && !cancelled && !referredOut };
}

async function loadDischargePolicy(hospitalId) {
  return loadIPDWorkflowPolicy(hospitalId);
}

function immutableSummarySnapshot(summary) {
  const raw = summary?.toObject ? summary.toObject({ depopulate: true }) : JSON.parse(JSON.stringify(summary || {}));
  // Avoid recursively embedding the whole revision chain inside every revision.
  delete raw.revisionHistory;
  return raw;
}

async function snapshotDischargeMedicationDetails(rows, hospitalId) {
  if (!Array.isArray(rows)) return rows;
  const ids = [...new Set(rows
    .map((row) => row?.medicineId?._id || row?.medicineId)
    .filter(Boolean)
    .map((value) => String(value)))];
  const medicines = ids.length
    ? await Medicine.find({ _id: { $in: ids }, hospitalId }).select('name strength dosage_form base_unit compositions').lean()
    : [];
  const byId = new Map(medicines.map((medicine) => [String(medicine._id), medicine]));
  return rows.map((row) => {
    const raw = row?.toObject ? row.toObject({ depopulate: true }) : { ...(row || {}) };
    const medicineId = raw.medicineId?._id || raw.medicineId;
    const master = medicineId ? byId.get(String(medicineId)) : null;
    return {
      ...raw,
      medicineId: medicineId || undefined,
      medicineName: raw.medicineName || master?.name || '',
      dosageForm: raw.dosageForm || raw.dosage_form || master?.dosage_form || master?.base_unit || '',
      strength: raw.strength || master?.strength || '',
    };
  });
}

async function reopenSummaryRevision({ summary, admission, user, reason, session = null }) {
  const reopenReason = String(reason || '').trim();
  if (!reopenReason) {
    const error = new Error('A clinical amendment/reopen reason is required');
    error.statusCode = 400;
    error.code = 'DISCHARGE_REVISION_REASON_REQUIRED';
    throw error;
  }
  if (!['Finalized', 'StaffCompleted'].includes(String(summary.status || ''))) return summary;
  const previousRevision = Number(summary.revisionNumber || 1);
  summary.revisionHistory = Array.isArray(summary.revisionHistory) ? summary.revisionHistory : [];
  summary.revisionHistory.push({
    revisionNumber: previousRevision,
    reopenedAt: operationNow(),
    reopenedBy: user?._id,
    reopenReason,
    previousStatus: summary.status,
    snapshot: immutableSummarySnapshot(summary)
  });
  summary.revisionNumber = previousRevision + 1;
  summary.status = 'Draft';
  summary.finalizedAt = undefined;
  summary.reviewedAt = undefined;
  summary.reviewedBy = undefined;
  summary.updatedBy = user?._id;
  await summary.save(session ? { session, validateBeforeSave: false } : { validateBeforeSave: false });
  if (admission) {
    admission.status = 'Discharge Summary Pending';
    admission.financialClearanceStatus = 'in_progress';
    admission.financialClearedAt = undefined;
    admission.financialClearedBy = undefined;
    admission.finalSettlementReceiptNumber = undefined;
    await admission.save(session ? { session, validateBeforeSave: false } : { validateBeforeSave: false });
  }
  return summary;
}

async function buildDischargeReadiness(admission, hospitalId) {
  const [dischargeSummary, labRows, radiologyRows, procedureRows, otRows, pendingMedications, financeClearance, policy] = await Promise.all([
    DischargeSummary.findOne({ admissionId: admission._id, hospitalId }).lean(),
    LabRequest.find({ admissionId: admission._id, hospitalId, is_active: { $ne: false } }).select('status reportFinalisation requestedDate testName labTestId').lean(),
    RadiologyRequest.find({ admissionId: admission._id, hospitalId, is_active: { $ne: false } }).select('status reportFinalisation requestedDate testName imagingTestId').lean(),
    ProcedureRequest.find({ admissionId: admission._id, hospitalId }).select('status procedureName requestedDate').lean(),
    OTRequest.find({ admissionId: admission._id, hospitalId }).select('status procedureName requestedDate clinicalClosureStatus').lean(),
    // A Requested order, a dispatched-but-unreceived indent, or any Pending MAR
    // dose is still clinically open and must not disappear from discharge checks.
    IPDMedicationChart.countDocuments({
      admissionId: admission._id,
      hospitalId,
      $or: [
        { status: 'Requested' },
        { stockReceiptStatus: 'PENDING_RECEIPT' },
        { status: 'Active', 'timing.status': 'Pending' },
        {
          'pharmacyRequest.requestedToPharmacy': true,
          'pharmacyRequest.pharmacyStatus': { $in: ['Pending', 'PartiallyDispensed', 'Dispatched'] },
          $expr: {
            $gt: [
              { $ifNull: ['$pharmacyRequest.requestedQuantity', 0] },
              { $ifNull: ['$pharmacyRequest.dispensedQuantity', 0] }
            ]
          }
        }
      ]
    }),
    financial.getFinancialClearance(admission._id),
    loadDischargePolicy(hospitalId)
  ]);

  const bucket = (rows, kind) => rows.reduce((acc, row) => {
    const state = classifyInvestigation(row, kind);
    if (state.final) acc.completed.push(row);
    else if (state.cancelled) acc.cancelled.push(row);
    else if (state.referredOut) acc.referredOut.push(row);
    else acc.pending.push(row);
    return acc;
  }, { completed: [], pending: [], cancelled: [], referredOut: [] });
  const lab = bucket(labRows, 'LAB');
  const radiology = bucket(radiologyRows, 'RADIOLOGY');
  const exception = admission.dischargeClinicalException || {};
  const exceptionCategories = new Set((exception.categories || []).map(String));
  const exceptionApproved = Boolean(exception.approvedAt && exception.approvedBy && exception.reason);
  const exceptionAllowed = policy.pendingInvestigations.allowAuthorisedException && exceptionApproved;
  const labException = exceptionAllowed && exceptionCategories.has('LAB_PENDING');
  const radiologyException = exceptionAllowed && exceptionCategories.has('RADIOLOGY_PENDING');
  const medicationException = exceptionAllowed && exceptionCategories.has('MEDICATION_PENDING');
  const procedureException = exceptionAllowed && exceptionCategories.has('PROCEDURE_PENDING');
  const otException = exceptionAllowed && exceptionCategories.has('OT_PENDING');
  const pendingProcedures = procedureRows.filter((row) => !['Completed', 'Cancelled'].includes(String(row.status || 'Pending')));
  const pendingOT = otRows.filter((row) => !['Closed', 'Completed', 'Cancelled'].includes(String(row.status || 'Requested')) || String(row.clinicalClosureStatus || 'Open') !== 'Closed');

  const checks = {
    doctorDischargeAdvice: ['Discharge Initiated', 'Discharge Summary Pending', 'Billing Pending', 'Payment Pending', 'Ready for Discharge', 'Discharged'].includes(admission.status),
    dischargeSummaryFinalized: !policy.requireSummaryFinalized || (policy.requireStaffCompletedSummary ? dischargeSummary?.status === 'StaffCompleted' : ['Finalized', 'StaffCompleted'].includes(dischargeSummary?.status)),
    labReportsCompleted: !policy.pendingInvestigations.blockLab || lab.pending.length === 0 || labException,
    radiologyReportsCompleted: !policy.pendingInvestigations.blockRadiology || radiology.pending.length === 0 || radiologyException,
    proceduresCompleted: pendingProcedures.length === 0 || procedureException,
    otCompleted: pendingOT.length === 0 || otException,
    medicationsAdministered: !policy.requireMedicationCompletion || pendingMedications === 0 || medicationException,
    chargesBilled: financeClearance.checks.unbilledChargesResolved,
    paymentSettled: financeClearance.checks.issuedInvoicesSettled,
    pharmacyClearance: !policy.requirePharmacyClearance || ['cleared', 'exempted'].includes(admission.pharmacyClearanceStatus),
    finalInvoiceAvailable: !policy.requireFinalIPDInvoice || financeClearance.checks.finalInvoiceAvailable,
    advanceReconciled: !policy.requireAdvanceReconciliation || financeClearance.checks.advanceReconciled,
    financialClearance: !policy.requireFinancialClearance || financeClearance.cleared,
    bedReadyForRelease: true
  };
  return {
    dischargeSummary,
    financeClearance,
    policy,
    checks,
    ready: Object.values(checks).every(Boolean),
    investigations: { lab, radiology, procedures: { pending: pendingProcedures }, ot: { pending: pendingOT } },
    pendingMedications,
    pendingProcedures: pendingProcedures.length,
    pendingOT: pendingOT.length,
    clinicalException: exceptionApproved ? exception : null
  };
}

// ========== DISCHARGE SUMMARY ==========

// Create/Update discharge summary - Allow ANY user (doctor/nurse/staff) to save
exports.saveDischargeSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const {
      finalDiagnosis,
      chiefComplaints,
      historyOfPresentIllness,
      pastMedicalHistory,
      examinationFindings,
      investigations,
      treatmentGiven,
      proceduresDone,
      surgeriesDone,
      conditionOnDischarge,
      conditionAtDischargeText,
      operativeNotes,
      dischargeType,
      dischargeMedications,
      followUpAdvice,
      followUpAfterDays,
      followUpDate,
      followUpDetails,
      emergencyInstructions,
      emergencyContactNumber,
      dietAdvice,
      activityAdvice,
      adviceAtDischarge,
      patientAcknowledgement,
      templateId,
      deathDetails,
      deathDate,
      deathTime,
      causeOfDeath,
      deathSummary
    } = req.body;

    const hospitalId = requireHospitalId(req);
    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId });
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const normalizedDischargeMedications = dischargeMedications === undefined
      ? undefined
      : await snapshotDischargeMedicationDetails(dischargeMedications, hospitalId);

    let dischargeSummary = await DischargeSummary.findOne({ admissionId, hospitalId });
    if (dischargeSummary && ['Finalized', 'StaffCompleted'].includes(dischargeSummary.status)) {
      return res.status(409).json({
        error: 'A finalized discharge summary is immutable. Reopen/amend it through an authorised revision workflow before changing clinical content.',
        code: 'DISCHARGE_SUMMARY_FINALIZED'
      });
    }
    
    const normalizedDischargeType = canonicalDischargeType(dischargeType || dischargeSummary?.dischargeType || admission.dischargeType || admission.status);
    const normalizedDeath = normalizedDischargeType === 'Death'
      ? normalizeDeathDetails(normalizedDischargeType, { ...req.body, deathDetails, deathDate, deathTime, causeOfDeath, deathSummary }, dischargeSummary?.deathDetails || admission.deathDetails || {})
      : undefined;

    // Determine preparedBy doctor ID (use admission's primary doctor if available)
    let doctorId = admission.primaryDoctorId;
    
    if (dischargeSummary) {
      // Update existing - allow any user to update
      Object.assign(dischargeSummary, {
        finalDiagnosis,
        chiefComplaints,
        historyOfPresentIllness,
        pastMedicalHistory,
        examinationFindings,
        investigations,
        treatmentGiven,
        proceduresDone,
        surgeriesDone,
        conditionOnDischarge,
        conditionAtDischargeText,
        operativeNotes,
        dischargeType: normalizedDischargeType,
        deathDetails: normalizedDeath,
        dischargeMedications: normalizedDischargeMedications,
        followUpAdvice,
        followUpAfterDays,
        followUpDate,
        followUpDetails,
        emergencyInstructions,
        emergencyContactNumber,
        dietAdvice,
        activityAdvice,
        adviceAtDischarge,
        patientAcknowledgement,
        templateId: templateId || dischargeSummary.templateId,
        updatedBy: req.user?._id
      });
    } else {
      // Create new
      dischargeSummary = new DischargeSummary({
        hospitalId: requireHospitalId(req),
        admissionId,
        patientId: admission.patientId,
        preparedBy: doctorId,
        admissionDate: admission.admissionDate,
        dischargeDate: operationNow(),
        finalDiagnosis,
        chiefComplaints,
        historyOfPresentIllness,
        pastMedicalHistory,
        examinationFindings,
        investigations,
        treatmentGiven,
        proceduresDone,
        surgeriesDone,
        conditionOnDischarge,
        conditionAtDischargeText,
        operativeNotes,
        dischargeType: normalizedDischargeType,
        deathDetails: normalizedDeath,
        dischargeMedications: normalizedDischargeMedications,
        followUpAdvice,
        followUpAfterDays,
        followUpDate,
        followUpDetails,
        emergencyInstructions,
        emergencyContactNumber,
        dietAdvice,
        activityAdvice,
        adviceAtDischarge,
        patientAcknowledgement,
        templateId: templateId || null,
        status: 'Draft',
        createdBy: req.user?._id
      });
    }

    await dischargeSummary.save();
    admission.dischargeType = normalizedDischargeType;
    admission.isLAMA = normalizedDischargeType === 'LAMA';
    if (normalizedDeath) admission.deathDetails = normalizedDeath;
    await admission.save({ validateBeforeSave: false });

    res.json({
      success: true,
      message: 'Discharge summary saved successfully',
      dischargeSummary
    });
  } catch (err) {
    console.error('Error saving discharge summary:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
};

// Get discharge summary
exports.getDischargeSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const dischargeSummary = await DischargeSummary.findOne({ admissionId, hospitalId: requireHospitalId(req) })
      .populate('preparedBy', 'firstName lastName')
      .populate('reviewedBy', 'firstName lastName')
      .populate('dischargeMedications.medicineId', 'name strength dosage_form base_unit compositions');

    if (!dischargeSummary) {
      return res.status(404).json({ error: 'Discharge summary not found' });
    }

    res.json({ success: true, dischargeSummary });
  } catch (err) {
    console.error('Error fetching discharge summary:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get all patient clinical records for discharge summary auto-fill
exports.getDischargeRecords = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const hospitalId = requireHospitalId(req);

    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId })
      .populate('patientId', 'first_name last_name patientId phone dob gender blood_group age address')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('departmentId', 'name')
      .populate('bedId', 'bedNumber bedType')
      .populate('wardId', 'name');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }
    const hospital = await Hospital.findById(hospitalId).select('contact phone email').lean();

    // Fetch all clinical records in parallel
    const [
      rounds,
      vitals,
      nursingNotes,
      medications,
      labRequests,
      radiologyRequests,
      procedureRequests,
      otRequests,
      prescriptions
    ] = await Promise.all([
      IPDRound.find({ admissionId, hospitalId })
        .populate('doctorId', 'firstName lastName specialization')
        .populate({ path: 'prescriptionId', populate: [{ path: 'items.medicine_id', select: 'name' }] })
        .sort({ roundDateTime: 1 }),
      IPDVitals.find({ admissionId, hospitalId }).populate('recordedBy', 'first_name last_name').sort({ recordedAt: 1 }),
      // NursingNote is encounter-scoped through the already tenant-validated admissionId.
      NursingNote.find({ admissionId, $or: [{ hospitalId }, { hospitalId: { $exists: false } }] }).populate('nurseId', 'first_name last_name').sort({ noteDateTime: 1 }),
      IPDMedicationChart.find({ admissionId, hospitalId }).populate('medicineId', 'name strength dosage_form base_unit compositions').sort({ createdAt: 1 }),
      LabRequest.find({ admissionId, hospitalId }).populate('doctorId', 'firstName lastName').populate('labTestId', 'name testName code').sort({ requestedDate: 1 }),
      RadiologyRequest.find({ admissionId, hospitalId }).populate('doctorId', 'firstName lastName').populate('imagingTestId', 'name testName code').sort({ requestedDate: 1 }),
      ProcedureRequest.find({ admissionId, hospitalId }).populate('doctorId', 'firstName lastName').sort({ requestedDate: 1 }),
      OTRequest.find({ admissionId, hospitalId }).populate('doctorId', 'firstName lastName').populate('primarySurgeonId', 'firstName lastName').populate('anesthetistId', 'firstName lastName').sort({ requestedDate: 1 }),
      Prescription.find({ ipd_admission_id: admissionId, hospitalId }).populate('doctor_id', 'firstName lastName').sort({ issue_date: 1 })
    ]);

    // Auto-generate summary text for each section
    const autoFill = {};

    const complaints = [admission.chiefComplaints];
    rounds.forEach(r => { if (r.complaints && !complaints.includes(r.complaints)) complaints.push(r.complaints); });
    autoFill.chiefComplaints = complaints.filter(Boolean).join('\n');

    autoFill.historyOfPresentIllness = admission.historyOfPresentIllness || '';
    autoFill.pastMedicalHistory = admission.pastMedicalHistory || '';

    const diagnoses = [admission.provisionalDiagnosis];
    rounds.forEach(r => { if (r.diagnosis && !diagnoses.includes(r.diagnosis)) diagnoses.push(r.diagnosis); });
    prescriptions.forEach(rx => { if (rx.diagnosis && !diagnoses.includes(rx.diagnosis)) diagnoses.push(rx.diagnosis); });
    autoFill.finalDiagnosis = diagnoses.filter(Boolean).join('\n');

    const examFindings = [];
    rounds.forEach(r => { if (r.examinationFindings) examFindings.push(`[${new Date(r.roundDateTime).toLocaleDateString()}] Dr. ${r.doctorId?.firstName || ''} ${r.doctorId?.lastName || ''}: ${r.examinationFindings}`); });
    autoFill.examinationFindings = examFindings.join('\n');

    const completedInvestigations = [];
    const pendingInvestigations = [];
    const cancelledInvestigations = [];
    const referredOutInvestigations = [];
    const addInvestigation = (row, kind, label, resultText) => {
      const state = classifyInvestigation(row, kind);
      const line = `• [${kind === 'LAB' ? 'Lab' : 'Radiology'}] ${label || 'Investigation'} (${row.status || 'Pending'})${resultText ? ` → ${resultText}` : ''} - ${new Date(row.requestedDate || row.createdAt || operationNow()).toLocaleDateString()}`;
      if (state.final) completedInvestigations.push(line);
      else if (state.cancelled) cancelledInvestigations.push(line);
      else if (state.referredOut) referredOutInvestigations.push(line);
      else pendingInvestigations.push(line);
    };
    labRequests.forEach((lr) => addInvestigation(
      lr,
      'LAB',
      lr.testName || lr.labTestId?.testName || lr.labTestId?.name || lr.labTestId?.code,
      isFinalLabRequest(lr) ? (lr.result_value || lr.manual_report?.summary || lr.manual_report?.interpretation || '') : ''
    ));
    radiologyRequests.forEach((rr) => addInvestigation(
      rr,
      'RADIOLOGY',
      rr.testName || rr.imagingTestId?.testName || rr.imagingTestId?.name || rr.imagingTestId?.code,
      isFinalRadiologyRequest(rr) ? (rr.findings || rr.impression || rr.manual_report?.impression || '') : ''
    ));
    autoFill.investigations = completedInvestigations.join('\n');
    autoFill.pendingInvestigations = pendingInvestigations;
    autoFill.cancelledInvestigations = cancelledInvestigations;
    autoFill.referredOutInvestigations = referredOutInvestigations;
    autoFill.investigationStatus = {
      completed: completedInvestigations.length,
      pending: pendingInvestigations.length,
      cancelled: cancelledInvestigations.length,
      referredOut: referredOutInvestigations.length
    };

    const treatmentLines = [];
    rounds.forEach(r => { if (r.treatmentPlan) treatmentLines.push(`[${new Date(r.roundDateTime).toLocaleDateString()}] ${r.treatmentPlan}`); });
    const administeredMeds = [];
    medications.forEach((med) => {
      const administeredCount = (med.timing || []).filter((slot) => slot.status === 'Administered').length;
      if (!administeredCount) return;
      const medInfo = `${med.medicineName} ${med.dosage || ''} - ${med.frequency} (${med.route || 'Oral'}) × ${administeredCount} administered dose(s)`;
      if (!administeredMeds.includes(medInfo)) administeredMeds.push(medInfo);
    });
    if (administeredMeds.length > 0) { treatmentLines.push('\nMedications actually administered during stay (MAR):'); administeredMeds.forEach(m => treatmentLines.push(`• ${m}`)); }
    autoFill.treatmentGiven = treatmentLines.join('\n');

    const procedureLines = [];
    procedureRequests.filter((pr) => String(pr.status) === 'Completed').forEach(pr => { procedureLines.push(`• ${pr.procedureName} - ${new Date(pr.requestedDate).toLocaleDateString()}${pr.findings ? ` - Findings: ${pr.findings}` : ''}`); });
    autoFill.proceduresDone = procedureLines.join('\n');

    const surgeryLines = [];
    otRequests.filter((ot) => ['Closed', 'Completed'].includes(String(ot.status))).forEach(ot => { const surgeon = ot.primarySurgeonId ? `Dr. ${ot.primarySurgeonId.firstName} ${ot.primarySurgeonId.lastName}` : (ot.doctorId ? `Dr. ${ot.doctorId.firstName} ${ot.doctorId.lastName}` : ''); surgeryLines.push(`• ${ot.procedureName} - ${new Date(ot.requestedDate).toLocaleDateString()}\n  Surgeon: ${surgeon}${ot.findings ? `\n  Findings: ${ot.findings}` : ''}${ot.complications ? `\n  Complications: ${ot.complications}` : ''}`); });
    autoFill.surgeriesDone = surgeryLines.join('\n');

    // Do not silently turn the last inpatient prescription/MAR order into a
    // discharge prescription. Give the doctor explicit reconciliation candidates;
    // only a saved/finalized DischargeSummary is authoritative for medicines to
    // continue after discharge.
    const dischargeMedicationCandidates = medications
      .filter((med) => !['Stopped', 'Completed'].includes(String(med.status || '')))
      .map((med) => ({
        medicineId: med.medicineId?._id || med.medicineId || undefined,
        medicineName: med.medicineName || med.medicineId?.name,
        dosage: med.dosage || '',
        dosageForm: med.dosageForm || med.dosage_form || med.medicineId?.dosage_form || med.medicineId?.base_unit || '',
        strength: med.strength || med.medicineId?.strength || '',
        frequency: med.frequency || '',
        duration: med.duration || '',
        instructions: med.specialInstructions || '',
        currentStatus: med.status,
        source: 'inpatient-medication-order'
      }));
    autoFill.dischargeMedications = [];
    autoFill.dischargeMedicationCandidates = dischargeMedicationCandidates;
    autoFill.requiresMedicationReconciliation = true;
    autoFill.emergencyInstructions = 'BLOOD IN URINE/STOOL/SPUTUM, SWELLING AT SURGICAL SITE, BLEEDING FROM SURGICAL SITE, PUS DISCHARGE FROM SURGICAL SITE';
    autoFill.emergencyContactNumber = hospital?.contact || hospital?.phone || '';

    res.json({ success: true, admission, autoFill, records: { rounds, vitals, nursingNotes, medications, labRequests, radiologyRequests, procedureRequests, otRequests, prescriptions }, investigationFinality: { completed: completedInvestigations, pending: pendingInvestigations, cancelled: cancelledInvestigations, referredOut: referredOutInvestigations } });
  } catch (err) {
    console.error('Error fetching discharge records:', err);
    res.status(500).json({ error: err.message });
  }
};

// Doctor/Nurse finalizes discharge summary (clinical details are ready)
// This sets status to 'Finalized' and admission status to 'Discharge Summary Pending'
exports.finalizeDischargeSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { reviewedBy } = req.body;

    const hospitalId = requireHospitalId(req);
    const [dischargeSummary, admission] = await Promise.all([
      DischargeSummary.findOne({ admissionId, hospitalId }),
      IPDAdmission.findOne({ _id: admissionId, hospitalId })
        .populate('primaryDoctorId', 'firstName lastName')
        .populate('wardId', 'name wardName')
        .populate('roomId', 'roomNumber roomName name')
        .populate('bedId', 'bedNumber bedName name')
        .populate('departmentId', 'name departmentName')
        .lean()
    ]);
    if (!dischargeSummary) {
      return res.status(404).json({ error: 'Discharge summary not found' });
    }
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const normalizedDischargeType = canonicalDischargeType(dischargeSummary.dischargeType || admission.dischargeType || admission.status);
    const normalizedDeath = normalizedDischargeType === 'Death'
      ? normalizeDeathDetails(normalizedDischargeType, dischargeSummary.toObject?.() || dischargeSummary, dischargeSummary.deathDetails || admission.deathDetails || {})
      : undefined;
    dischargeSummary.dischargeType = normalizedDischargeType;
    if (normalizedDeath) dischargeSummary.deathDetails = normalizedDeath;

    if (dischargeSummary.status === 'Finalized') {
      return res.status(409).json({ error: 'Discharge summary already finalized' });
    }
    if (!['Draft', 'Pending Review'].includes(dischargeSummary.status)) {
      return res.status(409).json({ error: `Discharge summary cannot be finalized from ${dischargeSummary.status}`, code: 'INVALID_DISCHARGE_SUMMARY_TRANSITION' });
    }
    const hasMedicationHistory = await IPDMedicationChart.exists({ admissionId, hospitalId, is_active: { $ne: false } });
    if (hasMedicationHistory && !dischargeSummary.medicationReconciliation?.completed) {
      return res.status(409).json({
        error: 'Complete physician discharge medication reconciliation (Continue / Stop / Changed / New / PRN) before finalizing the summary',
        code: 'MEDICATION_RECONCILIATION_REQUIRED'
      });
    }

    dischargeSummary.status = 'Finalized';
    
    const reviewerActor = await resolveClinicalActor(req.user);
    if (reviewerActor.staffModel !== 'Doctor' || !reviewerActor.staffProfileId) {
      return res.status(409).json({
        error: 'The authenticated doctor account is not linked to a valid Doctor profile for this hospital',
        code: 'DOCTOR_PROFILE_LINK_REQUIRED'
      });
    }
    if (reviewedBy && String(reviewedBy) !== String(reviewerActor.staffProfileId)) {
      return res.status(409).json({
        error: 'reviewedBy must match the authenticated doctor profile; another doctor cannot be supplied as the signer',
        code: 'DISCHARGE_SIGNER_MISMATCH'
      });
    }

    dischargeSummary.reviewedBy = reviewerActor.staffProfileId;
    dischargeSummary.reviewedAt = operationNow();
    dischargeSummary.finalizedAt = operationNow();

    const [patientSnapshotSource, hospitalSnapshotSource] = await Promise.all([
      Patient.findById(admission.patientId).lean(),
      Hospital.findById(admission.hospitalId).lean()
    ]);
    if (patientSnapshotSource) {
      dischargeSummary.patientSnapshot = {
        id: patientSnapshotSource._id,
        uhid: patientSnapshotSource.uhid || patientSnapshotSource.patientId,
        name: [patientSnapshotSource.salutation, patientSnapshotSource.first_name, patientSnapshotSource.middle_name, patientSnapshotSource.last_name].filter(Boolean).join(' '),
        dob: patientSnapshotSource.dob,
        age: patientSnapshotSource.age,
        gender: patientSnapshotSource.gender,
        phone: patientSnapshotSource.phone,
        address: patientSnapshotSource.address,
        city: patientSnapshotSource.city,
        state: patientSnapshotSource.state,
        guardianName: patientSnapshotSource.guardianName || patientSnapshotSource.father_name || patientSnapshotSource.husband_name
      };
    }
    const primaryDoctor = admission.primaryDoctorId;
    const displayName = (record, fields) => fields.map((field) => record?.[field]).find(Boolean) || '';
    dischargeSummary.admissionSnapshot = {
      id: admission._id,
      admissionNumber: admission.admissionNumber,
      admissionDate: admission.admissionDate,
      dischargeDate: admission.dischargeDate || dischargeSummary.dischargeDate,
      dischargeType: normalizedDischargeType,
      deathDetails: normalizedDeath || undefined,
      consultantName: primaryDoctor
        ? `Dr. ${[primaryDoctor.firstName, primaryDoctor.lastName].filter(Boolean).join(' ')}`.trim()
        : '',
      ward: displayName(admission.wardId, ['wardName', 'name']),
      room: displayName(admission.roomId, ['roomNumber', 'roomName', 'name']),
      bed: displayName(admission.bedId, ['bedNumber', 'bedName', 'name']),
      department: displayName(admission.departmentId, ['departmentName', 'name'])
    };
    if (hospitalSnapshotSource) {
      dischargeSummary.hospitalSnapshot = {
        id: hospitalSnapshotSource._id,
        hospitalName: hospitalSnapshotSource.hospitalName || hospitalSnapshotSource.name,
        address: hospitalSnapshotSource.address,
        city: hospitalSnapshotSource.city,
        state: hospitalSnapshotSource.state,
        pinCode: hospitalSnapshotSource.pinCode,
        phone: hospitalSnapshotSource.contact || hospitalSnapshotSource.phone,
        email: hospitalSnapshotSource.email,
        website: hospitalSnapshotSource.website,
        logo: hospitalSnapshotSource.logo
      };
    }
    dischargeSummary.printSnapshot = { templateVersion: 'reference-discharge-2026-08', finalizedAt: operationNow() };
    await dischargeSummary.save();

    await IPDAdmission.findOneAndUpdate({ _id: admissionId, hospitalId }, {
      status: 'Discharge Summary Pending',
      finalDiagnosis: dischargeSummary.finalDiagnosis,
      dischargeType: normalizedDischargeType,
      isLAMA: normalizedDischargeType === 'LAMA',
      ...(normalizedDeath ? { deathDetails: normalizedDeath } : {})
    });

    res.json({ success: true, message: 'Discharge summary finalized. Awaiting staff to complete.', dischargeSummary });
  } catch (err) {
    console.error('Error finalizing discharge summary:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
};

// Staff completes the administrative/support portion of the already doctor-finalized summary.
// This sets status to 'StaffCompleted' and admission status to 'Billing Pending'.
exports.staffCompleteDischargeSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const {
      dischargeMedications,
      followUpAdvice,
      followUpAfterDays,
      followUpDate,
      followUpDetails,
      emergencyInstructions,
      emergencyContactNumber,
      dietAdvice,
      activityAdvice,
      adviceAtDischarge,
      patientAcknowledgement,
      conditionAtDischargeText,
      dischargeType
    } = req.body;

    const dischargeSummary = await DischargeSummary.findOne({ admissionId, hospitalId: requireHospitalId(req) });
    if (!dischargeSummary) {
      return res.status(404).json({ error: 'Discharge summary not found' });
    }

    if (dischargeSummary.status === 'StaffCompleted') {
      return res.status(409).json({ error: 'Discharge summary already completed by staff' });
    }
    if (dischargeSummary.status !== 'Finalized') {
      return res.status(409).json({ error: 'Doctor must finalize the discharge summary before staff completion', code: 'DOCTOR_FINALIZATION_REQUIRED' });
    }

    // Update only administrative/support discharge fields. Doctor-owned clinical
    // fields (including discharge type/death certification) stay immutable after
    // finalization.
    if (dischargeMedications !== undefined) {
      return res.status(409).json({
        error: 'Discharge medicines are doctor-owned clinical content and are immutable after finalization. Reopen a versioned amendment if they must change.',
        code: 'FINALIZED_CLINICAL_FIELD_LOCKED'
      });
    }
    if (followUpAdvice !== undefined) dischargeSummary.followUpAdvice = followUpAdvice;
    if (followUpAfterDays !== undefined) dischargeSummary.followUpAfterDays = followUpAfterDays;
    if (followUpDetails !== undefined) dischargeSummary.followUpDetails = followUpDetails;
    if (followUpDate) dischargeSummary.followUpDate = new Date(followUpDate);
    if (emergencyInstructions !== undefined) dischargeSummary.emergencyInstructions = emergencyInstructions;
    if (emergencyContactNumber !== undefined) dischargeSummary.emergencyContactNumber = emergencyContactNumber;
    if (dietAdvice !== undefined) dischargeSummary.dietAdvice = dietAdvice;
    if (activityAdvice !== undefined) dischargeSummary.activityAdvice = activityAdvice;
    if (adviceAtDischarge !== undefined) dischargeSummary.adviceAtDischarge = adviceAtDischarge;
    if (patientAcknowledgement !== undefined) dischargeSummary.patientAcknowledgement = patientAcknowledgement;
    if (conditionAtDischargeText !== undefined) dischargeSummary.conditionAtDischargeText = conditionAtDischargeText;
    if (dischargeType && canonicalDischargeType(dischargeType) !== canonicalDischargeType(dischargeSummary.dischargeType || 'Normal')) {
      return res.status(409).json({ error: 'Staff completion cannot change the doctor-finalized discharge type', code: 'FINALIZED_CLINICAL_FIELD_LOCKED' });
    }
    const normalizedDischargeType = canonicalDischargeType(dischargeSummary.dischargeType || 'Normal');
    const normalizedDeath = dischargeSummary.deathDetails || undefined;
    
    dischargeSummary.status = 'StaffCompleted';
    await dischargeSummary.save();

    await IPDAdmission.findOneAndUpdate({ _id: admissionId, hospitalId: requireHospitalId(req) }, {
      status: 'Billing Pending',
      dischargeType: normalizedDischargeType,
      isLAMA: normalizedDischargeType === 'LAMA',
      ...(normalizedDeath ? { deathDetails: normalizedDeath } : {})
    });

    res.json({ success: true, message: 'Discharge summary completed by staff. Ready for billing.', dischargeSummary });
  } catch (err) {
    console.error('Error completing discharge summary by staff:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
};

// Update doctor-owned discharge medications while the clinical summary is still editable
exports.updateDischargeMedications = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { dischargeMedications } = req.body;

    const dischargeSummary = await DischargeSummary.findOne({ admissionId, hospitalId: requireHospitalId(req) });
    if (!dischargeSummary) {
      return res.status(404).json({ error: 'Discharge summary not found' });
    }
    // Discharge medicines are part of the doctor-signed clinical document.
    // Once finalized, every clinical field is immutable until a versioned
    // amendment explicitly reopens the summary.
    if (!['Draft', 'Pending Review'].includes(dischargeSummary.status)) {
      return res.status(409).json({
        error: 'Discharge medications are locked after doctor finalization; reopen through an authorised revision workflow',
        code: 'DISCHARGE_SUMMARY_FINALIZED'
      });
    }
    if (!Array.isArray(dischargeMedications)) {
      return res.status(400).json({ error: 'dischargeMedications must be an array' });
    }

    dischargeSummary.dischargeMedications = dischargeMedications;
    dischargeSummary.updatedBy = req.user?._id;
    await dischargeSummary.save();

    res.json({ success: true, message: 'Discharge medications updated successfully', dischargeMedications: dischargeSummary.dischargeMedications });
  } catch (err) {
    console.error('Error updating medications:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== DISCHARGE WORKFLOW ==========

// Initiate discharge
exports.initiateDischarge = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId: requireHospitalId(req) });
    if (!admission) return res.status(404).json({ error: 'Admission not found' });
    if (!admission.canProceedToDischarge) return res.status(400).json({ error: 'Cannot initiate discharge from current status' });

    admission.status = 'Discharge Initiated';
    await admission.save();

    res.json({ success: true, message: 'Discharge initiated successfully', admission });
  } catch (err) {
    console.error('Error initiating discharge:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get discharge checklist with deferred payments
exports.getDischargeChecklist = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const hospitalId = requireHospitalId(req);
    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId });
    if (!admission) return res.status(404).json({ error: 'Admission not found' });

    const readiness = await buildDischargeReadiness(admission, hospitalId);
    const labPending = readiness.investigations.lab.pending;
    const radiologyPending = readiness.investigations.radiology.pending;

    res.json({
      success: true,
      checklist: readiness.checks,
      isReadyForDischarge: readiness.ready,
      dischargePolicy: readiness.policy,
      clinicalException: readiness.clinicalException,
      investigations: {
        lab: {
          completed: readiness.investigations.lab.completed,
          pending: labPending,
          cancelled: readiness.investigations.lab.cancelled,
          referredOut: readiness.investigations.lab.referredOut
        },
        radiology: {
          completed: readiness.investigations.radiology.completed,
          pending: radiologyPending,
          cancelled: readiness.investigations.radiology.cancelled,
          referredOut: readiness.investigations.radiology.referredOut
        }
      },
      pendingItems: {
        pendingLabReports: labPending.length,
        pendingRadiologyReports: radiologyPending.length,
        pendingMedications: readiness.pendingMedications,
        pendingProcedures: readiness.pendingProcedures,
        pendingOT: readiness.pendingOT,
        unbilledCharges: readiness.financeClearance.summary.unbilledCharges,
        invoiceOutstanding: readiness.financeClearance.summary.invoiceOutstanding,
        pharmacyDue: readiness.financeClearance.summary.pharmacyDue,
        advanceAvailable: readiness.financeClearance.summary.advanceAvailable
      },
      financialClearance: readiness.financeClearance,
      manualChecklist: admission.dischargeChecklist || { checkpoints: [], delayReasons: [] }
    });
  } catch (err) {
    console.error('Error fetching discharge checklist:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code, details: err.details });
  }
};

exports.approveClinicalDischargeException = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const admission = await IPDAdmission.findOne({ _id: req.params.admissionId, hospitalId });
    if (!admission) return res.status(404).json({ error: 'Admission not found' });
    const policy = await loadDischargePolicy(hospitalId);
    if (!policy.pendingInvestigations.allowAuthorisedException) {
      return res.status(409).json({ error: 'Clinical discharge exceptions are disabled by hospital policy' });
    }
    const reason = String(req.body.reason || '').trim();
    const allowed = new Set(['LAB_PENDING', 'RADIOLOGY_PENDING', 'MEDICATION_PENDING', 'PROCEDURE_PENDING', 'OT_PENDING', 'OTHER']);
    const categories = [...new Set((req.body.categories || []).map((value) => String(value).toUpperCase()).filter((value) => allowed.has(value)))];
    if (!reason) return res.status(400).json({ error: 'Exception reason is required' });
    if (!categories.length) return res.status(400).json({ error: 'At least one exception category is required' });
    admission.dischargeClinicalException = { reason, categories, approvedBy: req.user?._id, approvedAt: operationNow() };
    await admission.save({ validateBeforeSave: false });
    return res.json({ success: true, clinicalException: admission.dischargeClinicalException });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
};


exports.updateDischargeChecklist = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId: requireHospitalId(req) });
    if (!admission) return res.status(404).json({ error: 'Admission not found' });
    const current = admission.dischargeChecklist || { checkpoints: [], delayReasons: [] };
    const checkpointMap = new Map((current.checkpoints || []).map((row) => [String(row.key), row]));
    for (const patch of (req.body.checkpoints || [])) {
      if (!patch?.key) continue;
      const previous = checkpointMap.get(String(patch.key));
      const row = previous?.toObject ? previous.toObject() : (previous || {});
      row.key = String(patch.key);
      if (patch.label !== undefined) row.label = patch.label;
      if (patch.note !== undefined) row.note = patch.note;
      if (patch.completed !== undefined) {
        row.completed = Boolean(patch.completed);
        row.completedAt = row.completed ? operationNow() : undefined;
        row.completedBy = row.completed ? req.user?._id : undefined;
      }
      checkpointMap.set(row.key, row);
    }
    const delayReasons = (current.delayReasons || []).map((x) => x.toObject ? x.toObject() : x);
    if (req.body.delayReason) delayReasons.push({ reason: String(req.body.delayReason), recordedAt: operationNow(), recordedBy: req.user?._id });
    admission.dischargeChecklist = { checkpoints: [...checkpointMap.values()], delayReasons, updatedAt: operationNow() };
    await admission.save({ validateBeforeSave: false });
    return res.json({ success: true, data: admission.dischargeChecklist });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
};

// Complete discharge only after the finance service has validated all bills,
// invoices, receipts, advances and pharmacy clearances. A financial exception
// can be approved only by finance admin/accountant through the finance route.
exports.completeDischarge = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const hospitalId = requireHospitalId(req);
    const { dischargeReason } = req.body;
    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId });
    if (!admission) return res.status(404).json({ error: 'Admission not found' });

    const dischargeSummary = await DischargeSummary.findOne({ admissionId, hospitalId });
    if (!dischargeSummary) return res.status(400).json({ error: 'Discharge summary not found' });

    // Final Discharge is idempotent for retry-safe UI/network behaviour.
    if (admission.status === 'Discharged') {
      return res.json({
        success: true,
        alreadyDischarged: true,
        message: 'Patient is already finally discharged',
        admission,
        dischargeSummary
      });
    }

    const readiness = await buildDischargeReadiness(admission, hospitalId);
    if (!readiness.ready) {
      return res.status(409).json({
        error: 'Discharge clearance is pending. Resolve the listed clinical/financial items or use an authorised policy exception.',
        checklist: readiness.checks,
        investigations: readiness.investigations,
        financialClearance: readiness.financeClearance,
        dischargePolicy: readiness.policy
      });
    }

    const dischargeType = canonicalDischargeType(dischargeSummary.dischargeType || admission.dischargeType || 'Normal');
    if (req.body.dischargeType && canonicalDischargeType(req.body.dischargeType) !== dischargeType) {
      return res.status(409).json({
        error: 'Final discharge cannot override the doctor-finalized discharge type. Reopen and re-finalize the clinical summary first.',
        code: 'FINALIZED_CLINICAL_FIELD_LOCKED'
      });
    }
    if (req.body.deathDetails || req.body.deathDate || req.body.deathTime || req.body.causeOfDeath || req.body.deathSummary) {
      return res.status(409).json({
        error: 'Final discharge cannot modify doctor-finalized death certification details. Reopen and re-finalize the clinical summary first.',
        code: 'FINALIZED_CLINICAL_FIELD_LOCKED'
      });
    }
    const deathDetails = dischargeType === 'Death' ? (dischargeSummary.deathDetails || admission.deathDetails || undefined) : undefined;

    // The discharge state change and all occupancy/patient cleanup must commit
    // together. This prevents a clinically discharged admission from remaining
    // active on the patient/bed/accommodation side (or vice versa).
    const session = await mongoose.startSession();
    let finalAdmission;
    let finalSummary;
    try {
      await session.withTransaction(async () => {
        const txAdmission = await IPDAdmission.findOne({ _id: admissionId, hospitalId }).session(session);
        if (!txAdmission) {
          const error = new Error('Admission not found');
          error.statusCode = 404;
          throw error;
        }
        const txSummary = await DischargeSummary.findOne({ admissionId, hospitalId }).session(session);
        if (!txSummary) {
          const error = new Error('Discharge summary not found');
          error.statusCode = 400;
          throw error;
        }
        if (txAdmission.status === 'Discharged') {
          finalAdmission = txAdmission;
          finalSummary = txSummary;
          return;
        }

        const dischargeDate = operationNow();
        txAdmission.status = 'Discharged';
        txAdmission.dischargeDate = dischargeDate;
        txAdmission.dischargeReason = dischargeReason;
        txAdmission.dischargeType = dischargeType;
        txAdmission.isLAMA = dischargeType === 'LAMA';
        txAdmission.finalDischargedAt = dischargeDate;
        txAdmission.finalDischargedBy = req.user?._id;
        txAdmission.updatedBy = req.user?._id;
        if (deathDetails) txAdmission.deathDetails = deathDetails;
        await txAdmission.save({ session });

        txSummary.dischargeType = dischargeType;
        txSummary.dischargeDate = dischargeDate;
        if (deathDetails) txSummary.deathDetails = deathDetails;
        txSummary.admissionSnapshot = {
          ...(txSummary.admissionSnapshot || {}),
          dischargeType,
          dischargeDate,
          deathDetails: deathDetails || undefined
        };
        await txSummary.save({ session, validateBeforeSave: false });

        await IPDAccommodationSegment.updateMany(
          { hospitalId, admissionId: txAdmission._id, status: 'active' },
          { $set: { status: 'closed', endedAt: dischargeDate } },
          { session }
        );

        if (txAdmission.bedId) {
          await Bed.findOneAndUpdate(
            { _id: txAdmission.bedId, hospitalId, currentAdmissionId: txAdmission._id },
            { $set: { status: 'Cleaning', currentAdmissionId: null, reservedTransferId: null } },
            { session }
          );
        }

        await Patient.updateOne(
          { _id: txAdmission.patientId, hospitalId },
          { $pull: { active_admissions: { admission_id: txAdmission._id } } },
          { session }
        );
        const patientAfterDischarge = await Patient.findOne({ _id: txAdmission.patientId, hospitalId })
          .select('active_admissions')
          .session(session);
        if (patientAfterDischarge) {
          patientAfterDischarge.patient_type = (patientAfterDischarge.active_admissions || []).length ? 'ipd' : 'opd';
          await patientAfterDischarge.save({ session, validateBeforeSave: false });
        }

        await appendDomainEvent({
          req,
          eventType: 'ipd.final_discharge.completed',
          entityType: 'IPDAdmission',
          entityId: txAdmission._id,
          hospitalId,
          patientId: txAdmission.patientId,
          encounterId: txAdmission._id,
          afterSummary: { status: 'Discharged', dischargeDate, dischargeType },
          reasonCode: dischargeReason || dischargeType,
          session
        });

        finalAdmission = txAdmission;
        finalSummary = txSummary;
      });
    } finally {
      await session.endSession();
    }

    return res.json({
      success: true,
      message: 'Patient discharged successfully',
      admission: finalAdmission || admission,
      dischargeSummary: finalSummary || dischargeSummary,
      financialClearance: readiness.financeClearance
    });
  } catch (err) {
    console.error('Error completing discharge:', err);
    return res.status(err.statusCode || 500).json({ error: err.message, code: err.code, details: err.details });
  }
};

// Restored startup/API handler: this route remained registered in ipd.routes.js
// but the handler was accidentally removed by the IPD billing/discharge patch.
exports.getDischargeDocuments = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const hospitalId = requireHospitalId(req);
    const admission = await IPDAdmission.findOne({ _id: admissionId, hospitalId })
      .populate('patientId', 'first_name last_name patientId')
      .populate('primaryDoctorId', 'firstName lastName');
    if (!admission) return res.status(404).json({ error: 'Admission not found' });

    const [dischargeSummary, invoices] = await Promise.all([
      DischargeSummary.findOne({ admissionId, hospitalId })
        .populate('preparedBy', 'firstName lastName')
        .populate('reviewedBy', 'firstName lastName')
        .populate('dischargeMedications.medicineId', 'name strength dosage_form base_unit compositions'),
      Invoice.find({ hospital_id: hospitalId, admission_id: admissionId }).sort({ issue_date: 1, createdAt: 1 })
    ]);

    // Canonical final-document identity is explicit and independent of payment status.
    // Never choose the first Paid invoice because that can be an interim document.
    let finalBill = null;
    if (admission.finalInvoiceId) {
      finalBill = invoices.find((invoice) => String(invoice._id) === String(admission.finalInvoiceId)) || null;
    }
    if (!finalBill) finalBill = invoices.find((invoice) => invoice.is_final_ipd_invoice === true || invoice.invoice_type === 'IPD Final') || null;

    const deferredSales = await Sale.find({
      hospitalId,
      admission_id: admissionId,
      payment_deferred: true,
      status: { $in: ['Pending', 'Partially Paid'] }
    });
    const totalDeferredAmount = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);
    const financeClearance = await financial.getFinancialClearance(admissionId, req.user);
    const isCleared = financeClearance.cleared;

    const accommodationPrint = await buildAccommodationPrintData({ hospitalId, admissionId, financial: false });
    const dischargeType = canonicalDischargeType(dischargeSummary?.dischargeType || admission.dischargeType || admission.status);
    const finalBillDto = finalBill ? {
      ...finalBill.toObject(),
      dischargeType,
      discharge_type: dischargeType,
      dischargeSnapshot: {
        dischargeType,
        dischargeDate: admission.dischargeDate || dischargeSummary?.dischargeDate,
        deathDetails: dischargeType === 'Death' ? (dischargeSummary?.deathDetails || admission.deathDetails) : undefined
      }
    } : null;

    res.json({
      success: true,
      admission,
      dischargeSummary,
      invoices,
      clearanceStatus: {
        isCleared,
        deferredAmount: totalDeferredAmount,
        deferredCount: deferredSales.length,
        regularDue: financeClearance.summary?.dueAmount ?? admission.dueAmount,
        financialClearanceStatus: admission.financialClearanceStatus
      },
      accommodationPrint,
      documents: {
        dischargeSummary: dischargeSummary || null,
        finalBill: finalBillDto,
        admissionSlip: {
          admissionNumber: admission.admissionNumber,
          admissionDate: admission.admissionDate,
          patientName: `${admission.patientId?.first_name || ''} ${admission.patientId?.last_name || ''}`.trim(),
          doctorName: `Dr. ${admission.primaryDoctorId?.firstName || ''} ${admission.primaryDoctorId?.lastName || ''}`.trim(),
          dischargeType
        }
      }
    });
  } catch (err) {
    console.error('Error fetching discharge documents:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
};

// Reopen a doctor-finalized summary as a genuine versioned amendment. The exact
// prior signed document is retained in revisionHistory before any field becomes editable.
exports.reopenDischargeSummary = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const hospitalId = requireHospitalId(req);
    const reason = String(req.body?.reason || '').trim();
    let result;
    await session.withTransaction(async () => {
      const admission = await IPDAdmission.findOne({ _id: req.params.admissionId, hospitalId }).session(session);
      const summary = await DischargeSummary.findOne({ admissionId: req.params.admissionId, hospitalId }).session(session);
      if (!admission || !summary) throw Object.assign(new Error('Admission/discharge summary not found'), { statusCode: 404 });
      if (!['Finalized', 'StaffCompleted'].includes(summary.status)) throw Object.assign(new Error('Only a finalized discharge summary requires a revision reopen'), { statusCode: 409, code: 'DISCHARGE_SUMMARY_NOT_FINALIZED' });
      await reopenSummaryRevision({ summary, admission, user: req.user, reason, session });
      if (admission.chargeFreeze?.status === 'frozen') await reopenChargeFreeze({ admission, user: req.user, reason: `Discharge summary amendment: ${reason}`, session });
      result = summary;
    });
    return res.json({ success: true, message: 'Discharge summary reopened as a new audited revision', dischargeSummary: result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
  } finally {
    await session.endSession();
  }
};

exports.freezeAdmissionCharges = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const admission = await IPDAdmission.findOne({ _id: req.params.admissionId, hospitalId });
    if (!admission) return res.status(404).json({ error: 'Admission not found' });
    if (admission.chargeFreeze?.status === 'frozen') return res.json({ success: true, alreadyFrozen: true, chargeFreeze: admission.chargeFreeze });
    const readiness = await buildDischargeReadiness(admission, hospitalId);
    const requiredClinicalChecks = ['doctorDischargeAdvice', 'dischargeSummaryFinalized', 'labReportsCompleted', 'radiologyReportsCompleted', 'proceduresCompleted', 'otCompleted', 'medicationsAdministered', 'pharmacyClearance'];
    const blockers = Object.fromEntries(requiredClinicalChecks.filter((key) => !readiness.checks[key]).map((key) => [key, readiness.checks[key]]));
    if (Object.keys(blockers).length) {
      return res.status(409).json({
        error: 'Clinical/pharmacy closure is incomplete; charges cannot be frozen yet',
        code: 'IPD_CHARGE_FREEZE_BLOCKED',
        blockers,
        investigations: readiness.investigations,
        pendingMedications: readiness.pendingMedications
      });
    }
    // Catch up all recurring liability through the exact freeze moment before
    // locking mutations, so the frozen ledger is complete rather than understated.
    const freezeAt = operationNow();
    await ensureAdmissionDailyCharges(admission._id, freezeAt, req.user);
    admission.chargeFreeze = {
      ...(admission.chargeFreeze?.toObject?.() || admission.chargeFreeze || {}),
      status: 'frozen',
      frozenAt: freezeAt,
      frozenBy: req.user?._id,
      freezeReason: String(req.body?.reason || 'Clinical/pharmacy closure completed before final billing').trim(),
      reopenedAt: undefined,
      reopenedBy: undefined,
      reopenReason: undefined
    };
    admission.financialClearanceStatus = 'in_progress';
    admission.financialClearedAt = undefined;
    admission.financialClearedBy = undefined;
    await admission.save({ validateBeforeSave: false });
    return res.json({ success: true, message: 'IPD clinical charging frozen; final billing may proceed', chargeFreeze: admission.chargeFreeze });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message, code: error.code, details: error.details });
  }
};

exports.reopenAdmissionCharges = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const hospitalId = requireHospitalId(req);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Reopen reason is required', code: 'IPD_CHARGE_REOPEN_REASON_REQUIRED' });
    let result;
    await session.withTransaction(async () => {
      const admission = await IPDAdmission.findOne({ _id: req.params.admissionId, hospitalId }).session(session);
      if (!admission) throw Object.assign(new Error('Admission not found'), { statusCode: 404 });
      if (admission.chargeFreeze?.status !== 'frozen') { result = admission; return; }
      const summary = await DischargeSummary.findOne({ admissionId: admission._id, hospitalId }).session(session);
      if (summary && ['Finalized', 'StaffCompleted'].includes(summary.status)) {
        await reopenSummaryRevision({ summary, admission, user: req.user, reason: `Charge freeze reopened: ${reason}`, session });
      }
      await reopenChargeFreeze({ admission, user: req.user, reason, session });
      result = admission;
    });
    return res.json({ success: true, message: 'IPD charge freeze reopened; prior financial clearance was invalidated', chargeFreeze: result?.chargeFreeze });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
  } finally {
    await session.endSession();
  }
};

// Restored startup/API handler: the schema and route still support medication
// reconciliation, but this controller export was accidentally removed by the patch.
exports.reconcileDischargeMedications = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const admission = await IPDAdmission.findOne({ _id: req.params.admissionId, hospitalId });
    if (!admission) return res.status(404).json({ error: 'Admission not found' });
    let summary = await DischargeSummary.findOne({ admissionId: admission._id, hospitalId });
    if (!summary) summary = new DischargeSummary({ admissionId: admission._id, patientId: admission.patientId, hospitalId, preparedBy: admission.primaryDoctorId, admissionDate: admission.admissionDate, dischargeDate: operationNow(), createdBy: req.user?._id });
    if (['Finalized', 'StaffCompleted'].includes(summary.status)) {
      return res.status(409).json({ error: 'Medication reconciliation is locked after doctor finalization; reopen the summary through an authorised revision workflow first', code: 'DISCHARGE_SUMMARY_FINALIZED' });
    }
    const allowed = new Set(['continue', 'stop', 'change', 'new', 'prn']);
    const admissionMedicines = Array.isArray(req.body.admissionMedicines) ? req.body.admissionMedicines : [];
    for (const row of admissionMedicines) {
      row.action = String(row.action || '').trim().toLowerCase();
      if (!String(row.name || '').trim() || !allowed.has(row.action)) {
        return res.status(400).json({ error: 'Every reconciled medicine requires a name and one action: Continue, Stop, Changed, New or PRN', code: 'INVALID_MEDICATION_RECONCILIATION' });
      }
    }
    const dischargeMedications = Array.isArray(req.body.dischargeMedications) ? req.body.dischargeMedications : summary.dischargeMedications;
    const normalizedDischargeMedications = Array.isArray(dischargeMedications)
      ? await snapshotDischargeMedicationDetails(dischargeMedications, hospitalId)
      : dischargeMedications;
    if (Array.isArray(normalizedDischargeMedications)) {
      for (const row of normalizedDischargeMedications) {
        const action = String(row.reconciliationAction || '').trim().toLowerCase();
        if (!action || action === 'stop' || !allowed.has(action === 'changed' ? 'change' : action)) {
          return res.status(400).json({ error: 'Every discharge medicine must be explicitly reconciled as Continue, Changed, New or PRN; stopped medicines belong only in the reconciliation record', code: 'INVALID_DISCHARGE_MEDICATION_ACTION' });
        }
      }
      summary.dischargeMedications = normalizedDischargeMedications;
    }
    summary.medicationReconciliation = {
      performedAt: operationNow(),
      performedBy: req.user?._id,
      admissionMedicines,
      discrepancies: Array.isArray(req.body.discrepancies) ? req.body.discrepancies : [],
      completed: true
    };
    summary.updatedBy = req.user?._id;
    await summary.save({ validateBeforeSave: false });
    return res.json({ success: true, data: summary.medicationReconciliation, dischargeMedications: summary.dischargeMedications, summaryId: summary._id });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message, code: error.code });
  }
};