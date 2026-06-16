const mongoose = require('mongoose');

const approvalRequestSchema = new mongoose.Schema({
  hospitalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hospital',
    required: true,
    index: true
  },
  requestType: {
    type: String,
    enum: ['DISCOUNT_APPROVAL', 'OTHER'],
    default: 'DISCOUNT_APPROVAL',
    required: true
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Pending',
    index: true
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Patient'
  },
  admissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'IPDAdmission'
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    description: 'JSON object holding specific details like discountAmount, saleIds, etc.'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedAt: {
    type: Date
  },
  rejectionReason: {
    type: String
  }
}, { timestamps: true });

approvalRequestSchema.index({ hospitalId: 1, status: 1 });
approvalRequestSchema.index({ admissionId: 1, requestType: 1 });

module.exports = mongoose.model('ApprovalRequest', approvalRequestSchema);
