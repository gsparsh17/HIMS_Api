const mongoose = require('mongoose');

const checklistItemSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true },
  label: { type: String, required: true, trim: true },
  category: { type: String, trim: true },
  required: { type: Boolean, default: true },
  status: { type: String, enum: ['Pending', 'Complete', 'Not Applicable', 'Bypassed'], default: 'Pending' },
  value: mongoose.Schema.Types.Mixed,
  notes: { type: String, trim: true },
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  completedAt: Date,
  bypassReason: { type: String, trim: true },
  bypassApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, unique: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  items: [checklistItemSchema],
  overallStatus: { type: String, enum: ['Pending', 'Ready', 'Ready With Bypass'], default: 'Pending', index: true },
  evaluatedAt: Date,
  evaluatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  version: { type: Number, default: 1 }
}, { timestamps: true });

schema.index({ hospitalId: 1, admissionId: 1 });
module.exports = mongoose.model('OTReadinessChecklist', schema);
