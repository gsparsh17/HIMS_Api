const mongoose = require('mongoose');

const observationSchema = new mongoose.Schema({
  recordedAt: { type: Date, required: true },
  heartRate: Number,
  bloodPressure: String,
  respiratoryRate: Number,
  spo2: Number,
  temperature: Number,
  etco2: Number,
  airwayPressure: Number,
  notes: String,
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: true });

const eventSchema = new mongoose.Schema({
  occurredAt: { type: Date, required: true },
  type: { type: String, required: true },
  name: String,
  dose: String,
  route: String,
  volumeMl: Number,
  notes: String,
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, unique: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  anaesthesiaType: String,
  inductionAt: Date,
  intubationAt: Date,
  incisionAt: Date,
  closureAt: Date,
  extubationAt: Date,
  technique: String,
  airway: { type: String, size: String, fixedAtCm: Number, attempts: Number, difficulty: String },
  observations: [observationSchema],
  events: [eventSchema],
  fluids: [{ name: String, volumeMl: Number, startedAt: Date, completedAt: Date }],
  bloodProducts: [{ product: String, units: Number, volumeMl: Number, identifier: String, startedAt: Date, completedAt: Date }],
  urineOutputMl: Number,
  estimatedBloodLossMl: Number,
  complications: String,
  postOpInstructions: String,
  status: { type: String, enum: ['Draft', 'Completed', 'Signed', 'Amended'], default: 'Draft', index: true },
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  signedAt: Date,
  version: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.model('OTAnesthesiaRecord', schema);
