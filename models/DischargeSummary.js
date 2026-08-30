const mongoose = require('mongoose');

const dischargeMedicationSchema = new mongoose.Schema({
  medicineName: { type: String, trim: true },
  saltName: { type: String, trim: true },
  dosage: { type: String, trim: true },
  frequency: { type: String, trim: true },
  duration: { type: String, trim: true },
  instructions: { type: String, trim: true },

  // Reference discharge-summary medicine table fields.
  days: { type: String, trim: true },
  type: { type: String, trim: true },
  meal: { type: String, trim: true },
  morning: { type: String, trim: true },
  noon: { type: String, trim: true },
  evening: { type: String, trim: true },
  extra: { type: String, trim: true },
  unit: { type: String, trim: true },
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine' },
  source: { type: String, enum: ['formulary', 'prescription', 'mar', 'free_text'], default: 'free_text' },
  freeTextReason: { type: String, trim: true },
  reconciliationAction: { type: String, enum: ['Continue', 'Stop', 'Changed', 'New', 'PRN'], default: 'Continue' },
  reconciliationReason: { type: String, trim: true }
}, { _id: true });

const dischargeSummarySchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClinicalTemplate' },
  templateVersion: { type: String, trim: true, default: 'reference-2026.1' },
  preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  admissionDate: { type: Date, required: true },
  dischargeDate: { type: Date, required: true },
  dischargeType: { type: String, enum: ['Normal', 'DOR', 'LAMA', 'Referred', 'Death'], default: 'Normal' },

  deathDetails: {
    chiefComplaints: { type: String, trim: true },
    causeOfDeath: { type: String, trim: true },
    summary: { type: String, trim: true },
    deathDate: Date,
    deathTime: { type: String, trim: true },
    deathAt: Date
  },

  finalDiagnosis: { type: String, trim: true },
  chiefComplaints: { type: String, trim: true },
  historyOfPresentIllness: { type: String, trim: true },
  pastMedicalHistory: { type: String, trim: true },
  examinationFindings: { type: String, trim: true },
  investigations: { type: String, trim: true },
  treatmentGiven: { type: String, trim: true },
  proceduresDone: { type: String, trim: true },
  surgeriesDone: { type: String, trim: true },
  operativeNotes: { type: String, trim: true },

  conditionOnDischarge: {
    type: String,
    enum: ['Recovered', 'Improved', 'Stabilized', 'Referred', 'Expired', 'LAMA', 'Unchanged'],
    default: 'Improved'
  },
  conditionAtDischargeText: { type: String, trim: true },
  medicationReconciliation: {
    performedAt: Date,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    admissionMedicines: [{ name: String, medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine' }, action: { type: String, enum: ['continue','stop','change','new','prn'] }, dischargeInstruction: String, reason: String }],
    discrepancies: [{ medicine: String, discrepancy: String, resolution: String }],
    completed: { type: Boolean, default: false }
  },
  dischargeMedications: [dischargeMedicationSchema],

  followUpAdvice: { type: String, trim: true },
  followUpAfterDays: { type: Number, min: 0 },
  followUpDate: Date,
  followUpDetails: { type: String, trim: true },
  emergencyInstructions: { type: String, trim: true },
  emergencyContactNumber: { type: String, trim: true },
  adviceAtDischarge: { type: String, trim: true },
  dietAdvice: { type: String, trim: true },
  activityAdvice: { type: String, trim: true },
  patientAcknowledgement: { type: String, trim: true },

  // Immutable source snapshots used by finalized print documents. Mixed is
  // intentional: hospitals can retain tenant-specific demographics/labels
  // without silently losing fields under Mongoose strict mode.
  patientSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  admissionSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  hospitalSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  printSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  reviewedAt: Date,
  status: {
    type: String,
    enum: ['Draft', 'Pending Review', 'Finalized', 'StaffCompleted'],
    default: 'Draft'
  },
  finalizedAt: Date,
  revisionNumber: { type: Number, default: 1, min: 1 },
  revisionHistory: [{
    revisionNumber: { type: Number, required: true },
    reopenedAt: { type: Date, required: true },
    reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reopenReason: { type: String, trim: true, required: true },
    previousStatus: { type: String, trim: true },
    // Snapshot of the exact previously finalized clinical document. This is
    // intentionally Mixed so future template fields are retained in history.
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true }
  }],

  abdmRecordLink: {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    abhaNumber: { type: String, index: true },
    abhaAddress: { type: String, index: true },
    status: { type: String, enum: ['pending_abha', 'linked', 'ready_for_consent', 'shared', 'LOCAL_RECORD_READY', 'VERIFICATION_PENDING', 'ABDM_LINK_PENDING', 'ABDM_LINKED', 'ABDM_LINK_FAILED'], default: 'pending_abha' },
    linkedAt: Date,
    source: String,
    ehrBundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'EHRBundle' }
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

dischargeSummarySchema.pre('validate', function normalizeMedicationRows(next) {
  for (const medicine of this.dischargeMedications || []) {
    medicine.days = medicine.days || medicine.duration || '';
    medicine.type = medicine.type || medicine.frequency || '';
    medicine.frequency = medicine.frequency || medicine.type || '';
    medicine.duration = medicine.duration || medicine.days || '';

    // Preserve useful printing for legacy rows which only stored frequency.
    const schedule = String(medicine.frequency || medicine.type || '').trim().toUpperCase();
    const hasStructuredDose = [medicine.morning, medicine.noon, medicine.evening, medicine.extra]
      .some((value) => value !== undefined && value !== null && value !== '');
    if (!hasStructuredDose) {
      if (['OD', 'QD', 'ONCE DAILY'].includes(schedule)) medicine.morning = '1';
      if (['BD', 'BID', 'TWICE DAILY'].includes(schedule)) {
        medicine.morning = '1'; medicine.evening = '1';
      }
      if (['TDS', 'TID', 'THRICE DAILY'].includes(schedule)) {
        medicine.morning = '1'; medicine.noon = '1'; medicine.evening = '1';
      }
      if (['QID', 'FOUR TIMES DAILY'].includes(schedule)) {
        medicine.morning = '1'; medicine.noon = '1'; medicine.evening = '1'; medicine.extra = '1';
      }
      if (['HS', 'BEDTIME', 'NIGHT'].includes(schedule)) medicine.evening = '1';
    }
  }
  if (!this.operativeNotes) this.operativeNotes = this.surgeriesDone || this.proceduresDone || '';
  if (!this.conditionAtDischargeText) this.conditionAtDischargeText = this.conditionOnDischarge || '';
  if (!this.followUpDetails) this.followUpDetails = this.followUpAdvice || '';
  next();
});

dischargeSummarySchema.index({ hospitalId: 1, admissionId: 1 }, { unique: true });
dischargeSummarySchema.index({ patientId: 1, dischargeDate: -1 });
dischargeSummarySchema.index({ status: 1, preparedBy: 1 });
dischargeSummarySchema.index({ 'abdmRecordLink.abhaNumber': 1 });
dischargeSummarySchema.index({ 'abdmRecordLink.abhaAddress': 1 });

module.exports = mongoose.model('DischargeSummary', dischargeSummarySchema);
