const mongoose = require('mongoose');

const claimCaseSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true,
    index: true
  },
  claimNumber: {
    type: String,
    required: true
  },
  admissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission',
    required: true,
    index: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient',
    required: true
  },
  coverageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AdmissionCoverage',
    required: true
  },
  payerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payer',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['cashless', 'reimbursement_support'],
    default: 'cashless'
  },
  status: {
    type: String,
    enum: [
      'draft',
      'documents_pending',
      'ready',
      'submitted',
      'query',
      'partially_approved',
      'approved',
      'rejected',
      'settlement_pending',
      'partially_settled',
      'settled',
      'closed',
      'cancelled'
    ],
    default: 'draft',
    index: true
  },
  preAuth: {
    requestNumber: String,
    approvedAmount: Number,
    status: String
  },
  amounts: {
    contractedAmount: { type: Number, default: 0 },
    sponsorLiability: { type: Number, default: 0 },
    patientLiability: { type: Number, default: 0 },
    claimSubmittedAmount: { type: Number, default: 0 },
    approvedSponsorAmount: { type: Number, default: 0 },
    deductedAmount: { type: Number, default: 0 },
    nonAdmissibleAmount: { type: Number, default: 0 },
    sponsorPaidAmount: { type: Number, default: 0 },
    outstandingSponsorAmount: { type: Number, default: 0 }
  },
  documents: [{
    code: String,
    name: String,
    documentId: mongoose.Schema.Types.ObjectId,
    url: String,
    status: String,
    note: String
  }],
  queries: [{
    queryNumber: String,
    receivedAt: Date,
    dueAt: Date,
    text: String,
    status: {
      type: String,
      enum: ['open', 'responded', 'closed'],
      default: 'open'
    },
    response: String,
    respondedAt: Date,
    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  deductions: [{
    code: String,
    reason: String,
    amount: Number,
    accepted: Boolean,
    appealed: Boolean,
    note: String
  }],
  settlements: [{
    amount: Number,
    receivedAt: Date,
    reference: String,
    method: String,
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  submittedAt: Date,
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  closedAt: Date,
  closedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  revision: {
    type: Number,
    default: 1
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

claimCaseSchema.index({ hospitalId: 1, claimNumber: 1 }, { unique: true });
claimCaseSchema.index({ hospitalId: 1, payerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ClaimCase', claimCaseSchema);