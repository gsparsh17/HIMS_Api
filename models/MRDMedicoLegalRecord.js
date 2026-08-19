const mongoose = require('mongoose');
const { operationNow } = require('../utils/operationTimeContext');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  emergencyEncounterId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyEncounter', index: true },
  caseNumber: { type: String, required: true, trim: true },
  caseType: { type: String, enum: ['MLC', 'Police', 'Accident', 'Assault', 'Poisoning', 'Burn', 'Unknown', 'Other'], default: 'MLC', index: true },
  incidentAt: Date,
  registeredAt: { type: Date, default: operationNow, index: true },
  policeStation: String,
  policeInformedAt: Date,
  investigatingOfficer: String,
  firNumber: String,
  status: { type: String, enum: ['open', 'under_review', 'closed'], default: 'open', index: true },
  notes: String,
  closureNote: String,
  closedAt: Date,
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ hospitalId: 1, caseNumber: 1 }, { unique: true });
schema.index({ hospitalId: 1, registeredAt: -1, status: 1 });

module.exports = mongoose.model('MRDMedicoLegalRecord', schema);
