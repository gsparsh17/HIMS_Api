const mongoose = require('mongoose');

const responseSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  response: { type: String, enum: ['Yes', 'No', 'Not Applicable', ''], default: '' },
  notes: String,
  completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  completedAt: Date
}, { _id: true });

const sectionSchema = new mongoose.Schema({
  status: { type: String, enum: ['Pending', 'Completed', 'Bypassed'], default: 'Pending' },
  items: [responseSchema],
  attestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  attestedAt: Date,
  bypassReason: String,
  bypassApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, unique: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  signIn: sectionSchema,
  timeOut: sectionSchema,
  signOut: sectionSchema,
  version: { type: Number, default: 1 },
  finalizedAt: Date,
  finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('OTSurgicalSafetyChecklist', schema);
