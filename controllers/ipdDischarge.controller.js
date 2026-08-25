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

async function buildDischargeReadiness(admission, hospitalId) {
  const [dischargeSummary, labRows, radiologyRows, pendingMedications, financeClearance, policy] = await Promise.all([
    DischargeSummary.findOne({ admissionId: admission._id, hospitalId }).lean(),
    LabRequest.find({ admissionId: admission._id, hospitalId, is_active: { $ne: false } }).select('status reportFinalisation requestedDate testName labTestId').lean(),
    RadiologyRequest.find({ admissionId: admission._id, hospitalId, is_active: { $ne: false } }).select('status reportFinalisation requestedDate testName imagingTestId').lean(),
    IPDMedicationChart.countDocuments({ admissionId: admission._id, hospitalId, status: 'Active', 'timing.status': 'Pending' }),
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

  const checks = {
    doctorDischargeAdvice: ['Discharge Initiated', 'Discharge Summary Pending', 'Billing Pending', 'Payment Pending', 'Ready for Discharge', 'Discharged'].includes(admission.status),
    dischargeSummaryFinalized: !policy.requireSummaryFinalized || (policy.requireStaffCompletedSummary ? dischargeSummary?.status === 'StaffCompleted' : ['Finalized', 'StaffCompleted'].includes(dischargeSummary?.status)),
    labReportsCompleted: !policy.pendingInvestigations.blockLab || lab.pending.length === 0 || labException,
    radiologyReportsCompleted: !policy.pendingInvestigations.blockRadiology || radiology.pending.length === 0 || radiologyException,
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
    investigations: { lab, radiology },
    pendingMedications,
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

    let dischargeSummary = await DischargeSummary.findOne({ admissionId, hospitalId });
    
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
      .populate('reviewedBy', 'firstName lastName');

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
      NursingNote.find({ admissionId }).populate('nurseId', 'first_name last_name').sort({ noteDateTime: 1 }),
      IPDMedicationChart.find({ admissionId, hospitalId }).sort({ createdAt: 1 }),
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
    const allMeds = [];
    prescriptions.forEach(rx => { rx.items?.forEach(item => { const medInfo = `${item.medicine_name} ${item.dosage || ''} - ${item.frequency} x ${item.duration}`; if (!allMeds.includes(medInfo)) allMeds.push(medInfo); }); });
    medications.forEach(med => { const medInfo = `${med.medicineName} ${med.dosage || ''} - ${med.frequency} (${med.route || 'Oral'})`; if (!allMeds.includes(medInfo)) allMeds.push(medInfo); });
    if (allMeds.length > 0) { treatmentLines.push('\nMedications administered during stay:'); allMeds.forEach(m => treatmentLines.push(`• ${m}`)); }
    autoFill.treatmentGiven = treatmentLines.join('\n');

    const procedureLines = [];
    procedureRequests.forEach(pr => { procedureLines.push(`• ${pr.procedureName} (${pr.status}) - ${new Date(pr.requestedDate).toLocaleDateString()}${pr.findings ? ` - Findings: ${pr.findings}` : ''}`); });
    autoFill.proceduresDone = procedureLines.join('\n');

    const surgeryLines = [];
    otRequests.forEach(ot => { const surgeon = ot.primarySurgeonId ? `Dr. ${ot.primarySurgeonId.firstName} ${ot.primarySurgeonId.lastName}` : (ot.doctorId ? `Dr. ${ot.doctorId.firstName} ${ot.doctorId.lastName}` : ''); surgeryLines.push(`• ${ot.procedureName} (${ot.status}) - ${new Date(ot.requestedDate).toLocaleDateString()}\n  Surgeon: ${surgeon}${ot.findings ? `\n  Findings: ${ot.findings}` : ''}${ot.complications ? `\n  Complications: ${ot.complications}` : ''}`); });
    autoFill.surgeriesDone = surgeryLines.join('\n');

    const dischargeMeds = [];
    const seenMedicines = new Set();
    if (prescriptions.length > 0) {
      const lastPrescription = prescriptions[prescriptions.length - 1];
      lastPrescription.items?.forEach((item) => {
        const name = item.medicine_name || item.medicine_id?.name;
        if (!name) return;
        const key = String(item.medicine_id?._id || item.medicine_id || name).toLowerCase();
        if (seenMedicines.has(key)) return;
        seenMedicines.add(key);
        dischargeMeds.push({
          medicineId: item.medicine_id?._id || item.medicine_id || undefined,
          medicineName: name,
          dosage: item.dosage || '',
          frequency: item.frequency || '',
          duration: item.duration || '',
          instructions: item.instructions || item.timing || '',
          source: 'prescription'
        });
      });
    }
    medications.filter((med) => String(med.status || '').toLowerCase() !== 'stopped').forEach((med) => {
      const name = med.medicineName || med.medicine_id?.name;
      if (!name) return;
      const key = String(med.medicineId || med.medicine_id || name).toLowerCase();
      if (seenMedicines.has(key)) return;
      seenMedicines.add(key);
      dischargeMeds.push({ medicineId: med.medicineId || med.medicine_id || undefined, medicineName: name, dosage: med.dosage || '', frequency: med.frequency || '', duration: med.duration || '', instructions: med.instructions || '', source: 'mar' });
    });
    autoFill.dischargeMedications = dischargeMeds;
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
      return res.status(400).json({ error: 'Discharge summary already finalized' });
    }

    dischargeSummary.status = 'Finalized';
    
    let reviewerDoctorId = reviewedBy;
    if (!reviewerDoctorId && req.user?._id) {
      const Doctor = require('../models/Doctor');
      const doc = await Doctor.findOne({ user_id: req.user._id });
      if (doc) reviewerDoctorId = doc._id;
    }
    if (!reviewerDoctorId) reviewerDoctorId = dischargeSummary.preparedBy;

    dischargeSummary.reviewedBy = reviewerDoctorId;
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

// Staff completes discharge summary (adds medications, follow-up advice, etc.)
// This sets status to 'StaffCompleted' and admission status to 'Billing Pending'
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
      return res.status(400).json({ error: 'Discharge summary already completed by staff' });
    }

    // Update with staff-entered data
    if (dischargeMedications !== undefined) dischargeSummary.dischargeMedications = dischargeMedications;
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
    const normalizedDischargeType = canonicalDischargeType(dischargeType || dischargeSummary.dischargeType || 'Normal');
    dischargeSummary.dischargeType = normalizedDischargeType;
    const normalizedDeath = normalizedDischargeType === 'Death'
      ? normalizeDeathDetails(normalizedDischargeType, req.body, dischargeSummary.deathDetails || {})
      : undefined;
    if (normalizedDeath) dischargeSummary.deathDetails = normalizedDeath;
    
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

// NEW: Update only discharge medications (any role can call this)
exports.updateDischargeMedications = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { dischargeMedications } = req.body;

    const dischargeSummary = await DischargeSummary.findOne({ admissionId, hospitalId: requireHospitalId(req) });
    if (!dischargeSummary) {
      return res.status(404).json({ error: 'Discharge summary not found' });
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
    const allowed = new Set(['LAB_PENDING', 'RADIOLOGY_PENDING', 'MEDICATION_PENDING', 'OTHER']);
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

    const dischargeType = canonicalDischargeType(req.body.dischargeType || dischargeSummary.dischargeType || admission.dischargeType || (req.body.isLAMA ? 'LAMA' : 'Normal'));
    const deathDetails = dischargeType === 'Death'
      ? normalizeDeathDetails(dischargeType, req.body, dischargeSummary.deathDetails || admission.deathDetails || {})
      : undefined;

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
