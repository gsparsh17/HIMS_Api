const IPDAdmission = require('../models/IPDAdmission');
const DischargeSummary = require('../models/DischargeSummary');
const Bed = require('../models/Bed');
const IPDCharge = require('../models/IPDCharge');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
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

// ========== DISCHARGE SUMMARY ==========

// Create/Update discharge summary
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
      dischargeMedications,
      followUpAdvice,
      followUpDate,
      emergencyInstructions,
      dietAdvice,
      activityAdvice
    } = req.body;

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    let dischargeSummary = await DischargeSummary.findOne({ admissionId });
    
    if (dischargeSummary) {
      // Update existing
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
        dischargeMedications,
        followUpAdvice,
        followUpDate,
        emergencyInstructions,
        dietAdvice,
        activityAdvice,
        updatedBy: req.user?._id
      });
    } else {
      // Create new
      dischargeSummary = new DischargeSummary({
        admissionId,
        patientId: admission.patientId,
        preparedBy: req.user?._id,
        admissionDate: admission.admissionDate,
        dischargeDate: new Date(),
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
        dischargeMedications,
        followUpAdvice,
        followUpDate,
        emergencyInstructions,
        dietAdvice,
        activityAdvice,
        status: 'Draft',
        createdBy: req.user?._id
      });
    }

    await dischargeSummary.save();

    res.json({
      success: true,
      message: 'Discharge summary saved successfully',
      dischargeSummary
    });
  } catch (err) {
    console.error('Error saving discharge summary:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get discharge summary
exports.getDischargeSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const dischargeSummary = await DischargeSummary.findOne({ admissionId })
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

    const admission = await IPDAdmission.findById(admissionId)
      .populate('patientId', 'first_name last_name patientId phone dob gender blood_group age address')
      .populate('primaryDoctorId', 'firstName lastName specialization')
      .populate('departmentId', 'name')
      .populate('bedId', 'bedNumber bedType')
      .populate('wardId', 'name');

    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

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
      // All doctor rounds with prescriptions populated
      IPDRound.find({ admissionId })
        .populate('doctorId', 'firstName lastName specialization')
        .populate({
          path: 'prescriptionId',
          populate: [
            { path: 'items.medicine_id', select: 'name' }
          ]
        })
        .sort({ roundDateTime: 1 }),

      // All vitals
      IPDVitals.find({ admissionId })
        .populate('recordedBy', 'first_name last_name')
        .sort({ recordedAt: 1 }),

      // All nursing notes
      NursingNote.find({ admissionId })
        .populate('nurseId', 'first_name last_name')
        .sort({ noteDateTime: 1 }),

      // All medications
      IPDMedicationChart.find({ admissionId })
        .sort({ createdAt: 1 }),

      // All lab requests for this admission
      LabRequest.find({ admissionId })
        .populate('doctorId', 'firstName lastName')
        .populate('labTestId', 'testName')
        .sort({ requestedDate: 1 }),

      // All radiology requests for this admission
      RadiologyRequest.find({ admissionId })
        .populate('doctorId', 'firstName lastName')
        .sort({ requestedDate: 1 }),

      // All procedure requests for this admission
      ProcedureRequest.find({ admissionId })
        .populate('doctorId', 'firstName lastName')
        .sort({ requestedDate: 1 }),

      // All OT (surgery) requests for this admission
      OTRequest.find({ admissionId })
        .populate('doctorId', 'firstName lastName')
        .populate('primarySurgeonId', 'firstName lastName')
        .populate('anesthetistId', 'firstName lastName')
        .sort({ requestedDate: 1 }),

      // All prescriptions linked to this IPD admission
      Prescription.find({ ipd_admission_id: admissionId })
        .populate('doctor_id', 'firstName lastName')
        .sort({ issue_date: 1 })
    ]);

    // Auto-generate summary text for each section
    const autoFill = {};

    // Chief Complaints from admission + rounds
    const complaints = [admission.chiefComplaints];
    rounds.forEach(r => {
      if (r.complaints && !complaints.includes(r.complaints)) {
        complaints.push(r.complaints);
      }
    });
    autoFill.chiefComplaints = complaints.filter(Boolean).join('\n');

    // History of Present Illness
    autoFill.historyOfPresentIllness = admission.historyOfPresentIllness || '';

    // Past Medical History
    autoFill.pastMedicalHistory = admission.pastMedicalHistory || '';

    // Final Diagnosis - aggregate all diagnoses from rounds
    const diagnoses = [admission.provisionalDiagnosis];
    rounds.forEach(r => {
      if (r.diagnosis && !diagnoses.includes(r.diagnosis)) {
        diagnoses.push(r.diagnosis);
      }
    });
    prescriptions.forEach(rx => {
      if (rx.diagnosis && !diagnoses.includes(rx.diagnosis)) {
        diagnoses.push(rx.diagnosis);
      }
    });
    autoFill.finalDiagnosis = diagnoses.filter(Boolean).join('\n');

    // Examination Findings from rounds
    const examFindings = [];
    rounds.forEach(r => {
      if (r.examinationFindings) {
        examFindings.push(`[${new Date(r.roundDateTime).toLocaleDateString()}] Dr. ${r.doctorId?.firstName || ''} ${r.doctorId?.lastName || ''}: ${r.examinationFindings}`);
      }
    });
    autoFill.examinationFindings = examFindings.join('\n');

    // Investigations - Lab Tests + Radiology
    const investigationLines = [];
    labRequests.forEach(lr => {
      const resultText = lr.result_value ? ` → Result: ${lr.result_value}${lr.is_abnormal ? ' (ABNORMAL)' : ''}` : '';
      investigationLines.push(`• [Lab] ${lr.testName} (${lr.status})${resultText} - ${new Date(lr.requestedDate).toLocaleDateString()}`);
    });
    radiologyRequests.forEach(rr => {
      const findingsText = rr.findings ? ` → ${rr.findings}` : '';
      investigationLines.push(`• [Radiology] ${rr.testName} (${rr.status})${findingsText} - ${new Date(rr.requestedDate).toLocaleDateString()}`);
    });
    autoFill.investigations = investigationLines.join('\n');

    // Treatment Given - from rounds treatment plans + medications prescribed
    const treatmentLines = [];
    rounds.forEach(r => {
      if (r.treatmentPlan) {
        treatmentLines.push(`[${new Date(r.roundDateTime).toLocaleDateString()}] ${r.treatmentPlan}`);
      }
    });
    // Add medication summary
    const allMeds = [];
    prescriptions.forEach(rx => {
      rx.items?.forEach(item => {
        const medInfo = `${item.medicine_name} ${item.dosage || ''} - ${item.frequency} x ${item.duration}`;
        if (!allMeds.includes(medInfo)) {
          allMeds.push(medInfo);
        }
      });
    });
    medications.forEach(med => {
      const medInfo = `${med.medicineName} ${med.dosage || ''} - ${med.frequency} (${med.route || 'Oral'})`;
      if (!allMeds.includes(medInfo)) {
        allMeds.push(medInfo);
      }
    });
    if (allMeds.length > 0) {
      treatmentLines.push('\nMedications administered during stay:');
      allMeds.forEach(m => treatmentLines.push(`• ${m}`));
    }
    autoFill.treatmentGiven = treatmentLines.join('\n');

    // Procedures Done
    const procedureLines = [];
    procedureRequests.forEach(pr => {
      const findingsText = pr.findings ? ` - Findings: ${pr.findings}` : '';
      procedureLines.push(`• ${pr.procedureName} (${pr.status}) - ${new Date(pr.requestedDate).toLocaleDateString()}${findingsText}`);
    });
    autoFill.proceduresDone = procedureLines.join('\n');

    // Surgeries Done (from OT)
    const surgeryLines = [];
    otRequests.forEach(ot => {
      const surgeon = ot.primarySurgeonId ? `Dr. ${ot.primarySurgeonId.firstName} ${ot.primarySurgeonId.lastName}` : (ot.doctorId ? `Dr. ${ot.doctorId.firstName} ${ot.doctorId.lastName}` : '');
      const findingsText = ot.findings ? `\n  Findings: ${ot.findings}` : '';
      const compText = ot.complications ? `\n  Complications: ${ot.complications}` : '';
      surgeryLines.push(`• ${ot.procedureName} (${ot.status}) - ${new Date(ot.requestedDate).toLocaleDateString()}\n  Surgeon: ${surgeon}${findingsText}${compText}`);
    });
    autoFill.surgeriesDone = surgeryLines.join('\n');

    // Discharge medications - collect from last round's prescription or all active meds
    const dischargeMeds = [];
    // Get medications from the last prescription
    if (prescriptions.length > 0) {
      const lastPrescription = prescriptions[prescriptions.length - 1];
      lastPrescription.items?.forEach(item => {
        dischargeMeds.push({
          medicineName: item.medicine_name,
          dosage: item.dosage || '',
          frequency: item.frequency || '',
          duration: item.duration || '',
          instructions: item.instructions || item.timing || ''
        });
      });
    }
    autoFill.dischargeMedications = dischargeMeds;

    // Emergency instructions based on diagnosis
    autoFill.emergencyInstructions = 'If you experience any of the following, visit the emergency department immediately:\n• High fever (>101°F) or chills\n• Severe pain unresponsive to prescribed medications\n• Difficulty breathing or chest pain\n• Excessive bleeding or wound discharge\n• Sudden dizziness, confusion, or loss of consciousness';

    res.json({
      success: true,
      admission,
      autoFill,
      records: {
        rounds,
        vitals,
        nursingNotes,
        medications,
        labRequests,
        radiologyRequests,
        procedureRequests,
        otRequests,
        prescriptions
      }
    });
  } catch (err) {
    console.error('Error fetching discharge records:', err);
    res.status(500).json({ error: err.message });
  }
};

// Finalize discharge summary
exports.finalizeDischargeSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { reviewedBy } = req.body;

    const dischargeSummary = await DischargeSummary.findOne({ admissionId });
    if (!dischargeSummary) {
      return res.status(404).json({ error: 'Discharge summary not found' });
    }

    dischargeSummary.status = 'Finalized';
    dischargeSummary.reviewedBy = reviewedBy || req.user?._id;
    dischargeSummary.reviewedAt = new Date();
    dischargeSummary.finalizedAt = new Date();
    await dischargeSummary.save();

    // Update admission status
    await IPDAdmission.findByIdAndUpdate(admissionId, {
      status: 'Billing Pending'
    });

    res.json({
      success: true,
      message: 'Discharge summary finalized',
      dischargeSummary
    });
  } catch (err) {
    console.error('Error finalizing discharge summary:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== DISCHARGE WORKFLOW ==========

// Initiate discharge
exports.initiateDischarge = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    if (!admission.canProceedToDischarge) {
      return res.status(400).json({ error: 'Cannot initiate discharge from current status' });
    }

    admission.status = 'Discharge Initiated';
    await admission.save();

    res.json({
      success: true,
      message: 'Discharge initiated successfully',
      admission
    });
  } catch (err) {
    console.error('Error initiating discharge:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get discharge checklist
exports.getDischargeChecklist = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    // Check various conditions
    const dischargeSummary = await DischargeSummary.findOne({ admissionId });
    const pendingLabReports = await LabReport.countDocuments({
      patientId: admission.patientId,
      status: { $ne: 'Completed' }
    });
    const pendingMedications = await IPDMedicationChart.countDocuments({
      admissionId,
      status: 'Active',
      'timing.status': 'Pending'
    });
    const pendingCharges = await IPDCharge.countDocuments({
      admissionId,
      isBilled: false
    });
    const hasUnpaidAmount = admission.dueAmount > 0;

    const checklist = {
      doctorDischargeAdvice: admission.status === 'Discharge Initiated',
      dischargeSummaryFinalized: dischargeSummary?.status === 'Finalized',
      labReportsCompleted: pendingLabReports === 0,
      medicationsAdministered: pendingMedications === 0,
      chargesBilled: pendingCharges === 0,
      paymentSettled: !hasUnpaidAmount,
      bedReadyForRelease: true
    };

    const isReadyForDischarge = Object.values(checklist).every(v => v === true);

    res.json({
      success: true,
      checklist,
      isReadyForDischarge,
      pendingItems: {
        pendingLabReports,
        pendingMedications,
        pendingCharges,
        dueAmount: admission.dueAmount
      }
    });
  } catch (err) {
    console.error('Error fetching discharge checklist:', err);
    res.status(500).json({ error: err.message });
  }
};

// Complete discharge
exports.completeDischarge = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { dischargeReason, isLAMA } = req.body;

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    // Verify all discharge requirements
    const dischargeSummary = await DischargeSummary.findOne({ admissionId });
    if (!dischargeSummary || dischargeSummary.status !== 'Finalized') {
      return res.status(400).json({ error: 'Discharge summary not finalized' });
    }

    // Check if payment is settled (unless admin override)
    if (admission.dueAmount > 0) {
      return res.status(400).json({ error: 'Payment pending. Please settle dues before discharge.' });
    }

    // Update admission
    admission.status = 'Discharged';
    admission.dischargeDate = new Date();
    admission.dischargeReason = dischargeReason;
    admission.isLAMA = isLAMA || false;
    await admission.save();

    // Release bed
    if (admission.bedId) {
      await Bed.findByIdAndUpdate(admission.bedId, {
        status: 'Cleaning',
        currentAdmissionId: null
      });
    }

    // Generate final invoice if not already generated
    const existingInvoice = await Invoice.findOne({ admission_id: admissionId });
    if (!existingInvoice) {
      const finalInvoice = new Invoice({
        patient_id: admission.patientId,
        admission_id: admissionId,
        invoice_number: `FINAL-${admission.admissionNumber}`,
        total: admission.totalBillAmount,
        paid: admission.paidAmount,
        due: 0,
        status: 'Paid',
        notes: `Final discharge bill for admission ${admission.admissionNumber}`
      });
      await finalInvoice.save();
    }

    res.json({
      success: true,
      message: 'Patient discharged successfully',
      admission
    });
  } catch (err) {
    console.error('Error completing discharge:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get discharge documents
exports.getDischargeDocuments = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const admission = await IPDAdmission.findById(admissionId)
      .populate('patientId', 'first_name last_name patientId')
      .populate('primaryDoctorId', 'firstName lastName');
    
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const dischargeSummary = await DischargeSummary.findOne({ admissionId })
      .populate('preparedBy', 'firstName lastName')
      .populate('reviewedBy', 'firstName lastName');

    const invoices = await Invoice.find({ admission_id: admissionId });

    res.json({
      success: true,
      admission,
      dischargeSummary,
      invoices,
      documents: {
        dischargeSummary: dischargeSummary || null,
        finalBill: invoices.find(i => i.status === 'Paid') || null,
        admissionSlip: {
          admissionNumber: admission.admissionNumber,
          admissionDate: admission.admissionDate,
          patientName: `${admission.patientId?.first_name} ${admission.patientId?.last_name}`,
          doctorName: `Dr. ${admission.primaryDoctorId?.firstName} ${admission.primaryDoctorId?.lastName}`
        }
      }
    });
  } catch (err) {
    console.error('Error fetching discharge documents:', err);
    res.status(500).json({ error: err.message });
  }
};