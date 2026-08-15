const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  recordType: { type: String, enum: ['birth', 'death'], required: true, index: true },
  recordNumber: { type: String, required: true, trim: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  motherPatientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  babyPatientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
  eventDateTime: { type: Date, required: true, index: true },
  place: { type: String, trim: true },
  gender: { type: String, enum: ['male', 'female', 'other', 'unknown'] },
  birthWeightGrams: { type: Number, min: 0 },
  modeOfDelivery: { type: String, trim: true },
  gestationalAgeWeeks: { type: Number, min: 0, max: 50 },
  attendingDoctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  wardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' },
  bedId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bed' },
  causeOfDeath: { type: String, trim: true },
  underlyingCause: { type: String, trim: true },
  deathType: { type: String, enum: ['natural', 'accidental', 'surgical', 'unknown', 'other'] },
  isMlc: { type: Boolean, default: false },
  mlcNumber: { type: String, trim: true },
  certificateNumber: { type: String, trim: true },
  registrationStatus: { type: String, enum: ['draft', 'registered', 'certificate_issued', 'cancelled'], default: 'draft', index: true },
  details: mongoose.Schema.Types.Mixed,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ hospitalId: 1, recordNumber: 1 }, { unique: true });
schema.index({ hospitalId: 1, recordType: 1, eventDateTime: -1 });

module.exports = mongoose.model('MRDBirthDeathRecord', schema);
