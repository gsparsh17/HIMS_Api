const mongoose = require('mongoose');

const lineSchema = new mongoose.Schema({
  sourceType: { type: String, enum: ['IPDCharge', 'BillItem'], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceLineId: mongoose.Schema.Types.ObjectId,
  description: String,
  locked: { type: Boolean, default: false },
  lockReason: String,
  before: { type: mongoose.Schema.Types.Mixed, required: true },
  after: { type: mongoose.Schema.Types.Mixed, required: true },
  delta: {
    standardAmount: Number,
    contractedAmount: Number,
    sponsorLiability: Number,
    patientLiability: Number,
    nonAdmissibleAmount: Number,
    hospitalAdjustment: Number
  },
  adjustmentStatus: { type: String, enum: ['not_required', 'pending', 'created', 'failed'], default: 'not_required' },
  generatedDocumentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
  error: String
}, { _id: true });

const repricingBatchSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  batchNumber: { type: String, required: true },
  encounterType: { type: String, enum: ['OPD', 'IPD'], required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  fromCoverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage' },
  toCoverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage', required: true },
  reason: { type: String, required: true, trim: true },
  status: { type: String, enum: ['preview', 'pending_approval', 'approved', 'committing', 'committed', 'failed', 'cancelled'], default: 'preview', index: true },
  lines: [lineSchema],
  totals: {
    beforeStandard: { type: Number, default: 0 },
    beforePatient: { type: Number, default: 0 },
    beforeSponsor: { type: Number, default: 0 },
    afterStandard: { type: Number, default: 0 },
    afterPatient: { type: Number, default: 0 },
    afterSponsor: { type: Number, default: 0 },
    patientRefundOrCredit: { type: Number, default: 0 },
    patientAdditionalDue: { type: Number, default: 0 },
    sponsorReceivableDelta: { type: Number, default: 0 },
    contractualAdjustmentDelta: { type: Number, default: 0 }
  },
  firstApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  firstApprovedAt: Date,
  approvalOverride: {
    used: { type: Boolean, default: false },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: Date,
    role: String,
    reason: String
  },
  committedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  committedAt: Date,
  commitOverride: {
    used: { type: Boolean, default: false },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: Date,
    role: String,
    reason: String
  },
  idempotencyKey: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  error: String
}, { timestamps: true });

repricingBatchSchema.index({ hospitalId: 1, batchNumber: 1 }, { unique: true });
repricingBatchSchema.index({ hospitalId: 1, idempotencyKey: 1 }, { unique: true });

module.exports = mongoose.model('RepricingBatch', repricingBatchSchema);
