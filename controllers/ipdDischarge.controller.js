// backend/controllers/ipdDischarge.controller.js
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
const Sale = require('../models/Sale');

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
        preparedBy: doctorId,
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
      IPDRound.find({ admissionId })
        .populate('doctorId', 'firstName lastName specialization')
        .populate({ path: 'prescriptionId', populate: [{ path: 'items.medicine_id', select: 'name' }] })
        .sort({ roundDateTime: 1 }),
      IPDVitals.find({ admissionId }).populate('recordedBy', 'first_name last_name').sort({ recordedAt: 1 }),
      NursingNote.find({ admissionId }).populate('nurseId', 'first_name last_name').sort({ noteDateTime: 1 }),
      IPDMedicationChart.find({ admissionId }).sort({ createdAt: 1 }),
      LabRequest.find({ admissionId }).populate('doctorId', 'firstName lastName').populate('labTestId', 'testName').sort({ requestedDate: 1 }),
      RadiologyRequest.find({ admissionId }).populate('doctorId', 'firstName lastName').sort({ requestedDate: 1 }),
      ProcedureRequest.find({ admissionId }).populate('doctorId', 'firstName lastName').sort({ requestedDate: 1 }),
      OTRequest.find({ admissionId }).populate('doctorId', 'firstName lastName').populate('primarySurgeonId', 'firstName lastName').populate('anesthetistId', 'firstName lastName').sort({ requestedDate: 1 }),
      Prescription.find({ ipd_admission_id: admissionId }).populate('doctor_id', 'firstName lastName').sort({ issue_date: 1 })
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

    const investigationLines = [];
    labRequests.forEach(lr => { investigationLines.push(`• [Lab] ${lr.testName} (${lr.status})${lr.result_value ? ` → Result: ${lr.result_value}${lr.is_abnormal ? ' (ABNORMAL)' : ''}` : ''} - ${new Date(lr.requestedDate).toLocaleDateString()}`); });
    radiologyRequests.forEach(rr => { investigationLines.push(`• [Radiology] ${rr.testName} (${rr.status})${rr.findings ? ` → ${rr.findings}` : ''} - ${new Date(rr.requestedDate).toLocaleDateString()}`); });
    autoFill.investigations = investigationLines.join('\n');

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
    if (prescriptions.length > 0) {
      const lastPrescription = prescriptions[prescriptions.length - 1];
      lastPrescription.items?.forEach(item => { dischargeMeds.push({ medicineName: item.medicine_name, dosage: item.dosage || '', frequency: item.frequency || '', duration: item.duration || '', instructions: item.instructions || item.timing || '' }); });
    }
    autoFill.dischargeMedications = dischargeMeds;
    autoFill.emergencyInstructions = 'If you experience any of the following, visit the emergency department immediately:\n• High fever (>101°F) or chills\n• Severe pain unresponsive to prescribed medications\n• Difficulty breathing or chest pain\n• Excessive bleeding or wound discharge\n• Sudden dizziness, confusion, or loss of consciousness';

    res.json({ success: true, admission, autoFill, records: { rounds, vitals, nursingNotes, medications, labRequests, radiologyRequests, procedureRequests, otRequests, prescriptions } });
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

    const dischargeSummary = await DischargeSummary.findOne({ admissionId });
    if (!dischargeSummary) {
      return res.status(404).json({ error: 'Discharge summary not found' });
    }

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
    dischargeSummary.reviewedAt = new Date();
    dischargeSummary.finalizedAt = new Date();
    await dischargeSummary.save();

    await IPDAdmission.findByIdAndUpdate(admissionId, {
      status: 'Discharge Summary Pending',
      finalDiagnosis: dischargeSummary.finalDiagnosis
    });

    res.json({ success: true, message: 'Discharge summary finalized. Awaiting staff to complete.', dischargeSummary });
  } catch (err) {
    console.error('Error finalizing discharge summary:', err);
    res.status(500).json({ error: err.message });
  }
};

// Staff completes discharge summary (adds medications, follow-up advice, etc.)
// This sets status to 'StaffCompleted' and admission status to 'Billing Pending'
exports.staffCompleteDischargeSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { dischargeMedications, followUpAdvice, followUpDate, emergencyInstructions, dietAdvice, activityAdvice } = req.body;

    const dischargeSummary = await DischargeSummary.findOne({ admissionId });
    if (!dischargeSummary) {
      return res.status(404).json({ error: 'Discharge summary not found' });
    }

    if (dischargeSummary.status === 'StaffCompleted') {
      return res.status(400).json({ error: 'Discharge summary already completed by staff' });
    }

    // Update with staff-entered data
    if (dischargeMedications !== undefined) dischargeSummary.dischargeMedications = dischargeMedications;
    if (followUpAdvice !== undefined) dischargeSummary.followUpAdvice = followUpAdvice;
    if (followUpDate) dischargeSummary.followUpDate = new Date(followUpDate);
    if (emergencyInstructions !== undefined) dischargeSummary.emergencyInstructions = emergencyInstructions;
    if (dietAdvice !== undefined) dischargeSummary.dietAdvice = dietAdvice;
    if (activityAdvice !== undefined) dischargeSummary.activityAdvice = activityAdvice;
    
    dischargeSummary.status = 'StaffCompleted';
    await dischargeSummary.save();

    await IPDAdmission.findByIdAndUpdate(admissionId, { status: 'Billing Pending' });

    res.json({ success: true, message: 'Discharge summary completed by staff. Ready for billing.', dischargeSummary });
  } catch (err) {
    console.error('Error completing discharge summary by staff:', err);
    res.status(500).json({ error: err.message });
  }
};

// NEW: Update only discharge medications (any role can call this)
exports.updateDischargeMedications = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { dischargeMedications } = req.body;

    const dischargeSummary = await DischargeSummary.findOne({ admissionId });
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
    const admission = await IPDAdmission.findById(admissionId);
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
    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) return res.status(404).json({ error: 'Admission not found' });

    const dischargeSummary = await DischargeSummary.findOne({ admissionId });
    const pendingLabReports = await LabReport.countDocuments({ patientId: admission.patientId, status: { $ne: 'Completed' } });
    const pendingMedications = await IPDMedicationChart.countDocuments({ admissionId, status: 'Active', 'timing.status': 'Pending' });
    const pendingCharges = await IPDCharge.countDocuments({ admissionId, isBilled: false });
    const hasUnpaidAmount = admission.dueAmount > 0;

    // Check deferred payments for this admission
    const deferredSales = await Sale.find({
      admission_id: admissionId,
      payment_deferred: true,
      status: { $in: ['Pending', 'Partially Paid'] },
      include_in_discharge_clearance: true
    });

    const totalDeferredAmount = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);
    const hasDeferredPayments = totalDeferredAmount > 0;

    // Check for pending bills that are not deferred
    const pendingBills = await Sale.find({
      admission_id: admissionId,
      payment_deferred: { $ne: true },
      balance_due: { $gt: 0 },
      status: { $in: ['Pending', 'Partially Paid'] }
    });

    const totalPendingAmount = pendingBills.reduce((sum, bill) => sum + (bill.balance_due || 0), 0);
    const hasPendingBills = totalPendingAmount > 0;

    const totalPendingAmountAll = totalPendingAmount + totalDeferredAmount;

    const checklist = {
      doctorDischargeAdvice: admission.status === 'Discharge Initiated',
      dischargeSummaryFinalized: dischargeSummary?.status === 'Finalized' || dischargeSummary?.status === 'StaffCompleted',
      labReportsCompleted: pendingLabReports === 0,
      medicationsAdministered: pendingMedications === 0,
      chargesBilled: pendingCharges === 0,
      paymentSettled: !hasUnpaidAmount && !hasDeferredPayments && !hasPendingBills,
      deferredPaymentsSettled: !hasDeferredPayments,
      pendingBillsSettled: !hasPendingBills,
      bedReadyForRelease: true
    };

    res.json({
      success: true,
      checklist,
      isReadyForDischarge: Object.values(checklist).every(v => v === true),
      pendingItems: {
        pendingLabReports,
        pendingMedications,
        pendingCharges,
        dueAmount: admission.dueAmount,
        deferredPaymentsCount: deferredSales.length,
        deferredPaymentsAmount: totalDeferredAmount,
        pendingBillsCount: pendingBills.length,
        pendingBillsAmount: totalPendingAmount,
        totalPendingAmount: totalPendingAmountAll
      },
      deferredPayments: deferredSales.map(sale => ({
        _id: sale._id,
        sale_number: sale.sale_number,
        total_amount: sale.total_amount,
        balance_due: sale.balance_due,
        sale_date: sale.sale_date,
        deferral_reason: sale.deferral_reason,
        items_count: sale.items?.length || 0
      }))
    });
  } catch (err) {
    console.error('Error fetching discharge checklist:', err);
    res.status(500).json({ error: err.message });
  }
};

// Complete discharge with deferred payment validation
exports.completeDischarge = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { dischargeReason, isLAMA } = req.body;

    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) return res.status(404).json({ error: 'Admission not found' });

    const dischargeSummary = await DischargeSummary.findOne({ admissionId });
    if (!dischargeSummary || (dischargeSummary.status !== 'Finalized' && dischargeSummary.status !== 'StaffCompleted')) {
      return res.status(400).json({ error: 'Discharge summary not finalized' });
    }

    // Check for deferred payments before discharge
    const deferredSales = await Sale.find({
      admission_id: admissionId,
      payment_deferred: true,
      status: { $in: ['Pending', 'Partially Paid'] },
      include_in_discharge_clearance: true
    });

    const totalDeferredAmount = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);

    // Check for pending bills that are not deferred
    const pendingBills = await Sale.find({
      admission_id: admissionId,
      payment_deferred: { $ne: true },
      balance_due: { $gt: 0 },
      status: { $in: ['Pending', 'Partially Paid'] }
    });

    const totalPendingAmount = pendingBills.reduce((sum, bill) => sum + (bill.balance_due || 0), 0);
    const totalPendingAll = totalPendingAmount + totalDeferredAmount;

    if (totalPendingAll > 0) {
      return res.status(400).json({
        error: 'Payment pending. Please settle all dues including deferred payments before discharge.',
        pendingAmount: totalPendingAll,
        deferredAmount: totalDeferredAmount,
        regularPendingAmount: totalPendingAmount
      });
    }

    if (admission.dueAmount > 0) {
      return res.status(400).json({ error: 'Payment pending. Please settle dues before discharge.' });
    }

    admission.status = 'Discharged';
    admission.dischargeDate = new Date();
    admission.dischargeReason = dischargeReason;
    admission.isLAMA = isLAMA || false;
    await admission.save();

    if (admission.bedId) await Bed.findByIdAndUpdate(admission.bedId, { status: 'Cleaning', currentAdmissionId: null });

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
      admission,
      clearanceSummary: {
        deferredPaymentsCleared: deferredSales.length,
        deferredAmountCleared: totalDeferredAmount
      }
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
    const admission = await IPDAdmission.findById(admissionId).populate('patientId', 'first_name last_name patientId').populate('primaryDoctorId', 'firstName lastName');
    if (!admission) return res.status(404).json({ error: 'Admission not found' });

    const dischargeSummary = await DischargeSummary.findOne({ admissionId }).populate('preparedBy', 'firstName lastName').populate('reviewedBy', 'firstName lastName');
    const invoices = await Invoice.find({ admission_id: admissionId });
    
    // Get clearance status including deferred payments
    const deferredSales = await Sale.find({
      admission_id: admissionId,
      payment_deferred: true,
      status: { $in: ['Pending', 'Partially Paid'] }
    });
    const totalDeferredAmount = deferredSales.reduce((sum, sale) => sum + (sale.balance_due || 0), 0);
    const isCleared = totalDeferredAmount === 0 && admission.dueAmount === 0;

    res.json({
      success: true,
      admission,
      dischargeSummary,
      invoices,
      clearanceStatus: {
        isCleared,
        deferredAmount: totalDeferredAmount,
        deferredCount: deferredSales.length,
        regularDue: admission.dueAmount
      },
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