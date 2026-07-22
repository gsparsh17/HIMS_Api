const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, unique: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  preOpDiagnosis: String,
  postOpDiagnosis: String,
  procedurePerformed: String,
  procedureSide: String,
  surgeonTeam: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, name: String, role: String }],
  anaesthesiaTeam: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, name: String, role: String }],
  nursingTeam: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, name: String, role: String }],
  surgeryDate: Date,
  incisionAt: Date,
  closureAt: Date,
  findings: String,
  steps: [{ sequence: Number, description: String }],
  specimens: [{ name: String, site: String, container: String, sentToPathology: Boolean, specimenId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTSpecimen' } }],
  counts: { instrumentsCorrect: Boolean, spongesCorrect: Boolean, needlesCorrect: Boolean, notes: String },
  drains: [{ type: String, site: String, size: String }],
  implants: [{ itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreItem' }, name: String, lotNumber: String, serialNumber: String, quantity: Number }],
  estimatedBloodLossMl: Number,
  complications: String,
  closureMethod: String,
  postOpPlan: String,
  status: { type: String, enum: ['Draft', 'Completed', 'Signed', 'Amended'], default: 'Draft', index: true },
  authoredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  signedAt: Date,
  version: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.model('OTOperativeNote', schema);
