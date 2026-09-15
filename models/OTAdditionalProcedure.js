const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  procedureId: { type: mongoose.Schema.Types.ObjectId, ref: 'Procedure', required: true },
  procedureCode: { type: String, required: true, trim: true },
  procedureName: { type: String, required: true, trim: true },
  clinicalJustification: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 1, min: 1 },
  sameOtSessionIndex: { type: Number, default: 2, min: 2 },
  billingChargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDCharge' },
  billingStatus: { type: String, enum: ['Pending', 'Posted', 'Package Covered', 'Failed', 'Reversed'], default: 'Pending' },
  pricingSnapshot: { type: mongoose.Schema.Types.Mixed },
  idempotencyKey: { type: String, trim: true },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  addedAt: { type: Date, default: Date.now },
  notes: String
}, { timestamps: true });

schema.index({ hospitalId: 1, caseId: 1, createdAt: 1 });
schema.index(
  { hospitalId: 1, caseId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('OTAdditionalProcedure', schema);
