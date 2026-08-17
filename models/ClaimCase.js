const mongoose = require('mongoose');

const claimLineSchema = new mongoose.Schema({
  lineNumber: Number,
  chargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDCharge' },
  billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' },
  billItemId: mongoose.Schema.Types.ObjectId,
  packageEpisodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageEpisode' },
  serviceDate: Date,
  serviceType: String,
  description: String,
  internalServiceModel: String,
  internalServiceId: mongoose.Schema.Types.ObjectId,
  internalCode: String,
  payerCode: String,
  quantity: { type: Number, default: 1 },
  standardAmount: { type: Number, default: 0 },
  contractedAmount: { type: Number, default: 0 },
  eligibleAmount: { type: Number, default: 0 },
  sponsorLiability: { type: Number, default: 0 },
  patientLiability: { type: Number, default: 0 },
  nonAdmissibleAmount: { type: Number, default: 0 },
  contractualAdjustment: { type: Number, default: 0 },
  hospitalConcession: { type: Number, default: 0 },
  submittedAmount: { type: Number, default: 0 },
  approvedAmount: { type: Number, default: 0 },
  deductedAmount: { type: Number, default: 0 },
  paidAmount: { type: Number, default: 0 },
  admissibilityStatus: { type: String, enum: ['admissible', 'partially_admissible', 'non_admissible', 'pending'], default: 'pending' },
  deductionReason: String,
  pricingSnapshot: mongoose.Schema.Types.Mixed
}, { _id: true });

const claimCaseSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  claimNumber: { type: String, required: true },
  encounterType: { type: String, enum: ['OPD', 'IPD'], default: 'IPD', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  coverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage', required: true },
  payerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payer', required: true, index: true },
  type: { type: String, enum: ['cashless', 'reimbursement_support'], default: 'cashless' },
  adjudicationStatus: { type: String, enum: ['pending', 'approved', 'partially_approved', 'rejected'], default: 'pending', index: true },
  status: {
    type: String,
    enum: ['draft', 'documents_pending', 'ready', 'submitted', 'query', 'partially_approved', 'approved', 'rejected', 'settlement_pending', 'partially_settled', 'settled', 'closed', 'cancelled'],
    default: 'draft',
    index: true
  },
  servicePeriod: { from: Date, to: Date },
  schemeType: { type: String, trim: true, lowercase: true, index: true },
  schemeData: {
    pmjay: {
      pmjayCaseId: { type: String, trim: true, index: true },
      abhaId: { type: String, trim: true },
      beneficiaryId: { type: String, trim: true },
      packageCode: { type: String, trim: true, uppercase: true },
      packageName: { type: String, trim: true },
      packageType: { type: String, trim: true },
      packageRate: Number,
      specialty: String,
      caseType: { type: String, trim: true },
      provisionalDiagnosis: String,
      finalDiagnosis: String,
      icd10Codes: [{ type: String, trim: true, uppercase: true }],
      procedureCodes: [{ type: String, trim: true, uppercase: true }],
      portability: { type: Boolean, default: false },
      homeState: String,
      treatingState: String,
      portalStatus: String,
      portalSubmissionReference: String,
      portalSubmittedAt: Date,
      lastPortalSyncAt: Date
    }
  },
  preAuth: { requestNumber: String, approvedAmount: Number, status: String },
  amounts: {
    standardAmount: { type: Number, default: 0 },
    contractedAmount: { type: Number, default: 0 },
    eligibleAmount: { type: Number, default: 0 },
    sponsorLiability: { type: Number, default: 0 },
    patientLiability: { type: Number, default: 0 },
    contractualAdjustment: { type: Number, default: 0 },
    hospitalConcession: { type: Number, default: 0 },
    claimSubmittedAmount: { type: Number, default: 0 },
    approvedSponsorAmount: { type: Number, default: 0 },
    deductedAmount: { type: Number, default: 0 },
    nonAdmissibleAmount: { type: Number, default: 0 },
    sponsorPaidAmount: { type: Number, default: 0 },
    outstandingSponsorAmount: { type: Number, default: 0 }
  },
  lines: [claimLineSchema],
  documents: [{ code: String, name: String, documentId: mongoose.Schema.Types.ObjectId, url: String, status: String, note: String }],
  queries: [{
    queryNumber: String,
    externalQueryId: String,
    category: String,
    reasonCode: String,
    receivedAt: Date,
    dueAt: Date,
    text: String,
    status: { type: String, enum: ['open', 'responded', 'closed'], default: 'open' },
    response: String,
    documentsAdded: [{ documentId: mongoose.Schema.Types.ObjectId, name: String, url: String }],
    respondedAt: Date,
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  readiness: {
    status: { type: String, enum: ['not_evaluated', 'ready', 'warning', 'blocked', 'overridden'], default: 'not_evaluated', index: true },
    score: { type: Number, min: 0, max: 100, default: 0 },
    evaluatedAt: Date,
    rulesVersion: String,
    blockers: [{ code: String, severity: String, message: String, source: String, details: mongoose.Schema.Types.Mixed }],
    warnings: [{ code: String, severity: String, message: String, source: String, details: mongoose.Schema.Types.Mixed }],
    override: {
      active: { type: Boolean, default: false },
      reason: String,
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date
    }
  },
  rejectionHistory: [{
    reasonCode: String,
    reason: String,
    category: String,
    recordedAt: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  }],
  deductions: [{ code: String, lineId: mongoose.Schema.Types.ObjectId, reason: String, amount: Number, accepted: Boolean, appealed: Boolean, note: String }],
  settlements: [{ amount: Number, receivedAt: Date, reference: String, method: String, recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } }],
  submittedAt: Date,
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  closedAt: Date,
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancellationReason: String,
  revision: { type: Number, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

claimCaseSchema.pre('validate', function validateEncounter(next) {
  if (this.encounterType === 'IPD' && !this.admissionId) this.invalidate('admissionId', 'admissionId is required for IPD claim');
  if (this.encounterType === 'OPD' && !this.appointmentId) this.invalidate('appointmentId', 'appointmentId is required for OPD claim');
  next();
});

claimCaseSchema.index({ hospitalId: 1, claimNumber: 1 }, { unique: true });
claimCaseSchema.index({ hospitalId: 1, payerId: 1, status: 1, createdAt: -1 });
claimCaseSchema.index({ hospitalId: 1, 'servicePeriod.from': 1, 'servicePeriod.to': 1 });

module.exports = mongoose.model('ClaimCase', claimCaseSchema);
