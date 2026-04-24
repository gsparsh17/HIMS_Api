const IPDAdmission = require('../models/IPDAdmission');
const DischargeSummary = require('../models/DischargeSummary');
const Bed = require('../models/Bed');
const IPDCharge = require('../models/IPDCharge');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const LabReport = require('../models/LabReport');
const IPDMedicationChart = require('../models/IPDMedicationChart');

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