const mongoose = require('mongoose');

const observationSchema = new mongoose.Schema({
  recordedAt: { type: Date, required: true },
  activity: Number,
  respiration: Number,
  circulation: Number,
  consciousness: Number,
  oxygenSaturation: Number,
  aldreteTotal: Number,
  painScore: Number,
  nauseaVomiting: String,
  heartRate: Number,
  bloodPressure: String,
  respiratoryRate: Number,
  spo2: Number,
  temperature: Number,
  urineOutputMl: Number,
  drainOutputMl: Number,
  bleeding: String,
  notes: String,
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: true });

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: 'OTRequest', required: true, unique: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  receivedAt: Date,
  receivedFrom: String,
  airwayStatus: String,
  oxygenSupport: String,
  observations: [observationSchema],
  medications: [{ name: String, dose: String, route: String, givenAt: Date }],
  complications: String,
  dischargeCriteriaMet: Boolean,
  finalAldreteScore: Number,
  disposition: { type: String, enum: ['Ward', 'ICU', 'HDU', 'Day Care', 'Other', ''], default: '' },
  destinationWardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' },
  destinationRoomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  transferAt: Date,
  handoverTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  postOpInstructions: String,
  status: { type: String, enum: ['Draft', 'Monitoring', 'Ready For Transfer', 'Transferred', 'Signed'], default: 'Draft', index: true },
  signedAt: Date,
  version: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.model('OTRecoveryRecord', schema);
