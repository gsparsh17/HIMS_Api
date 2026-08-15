const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  certificateNumber: { type: String, required: true, trim: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  certificateType: { type: String, enum: ['medical', 'fitness', 'sick_leave', 'disability', 'treatment', 'hospitalisation', 'other'], required: true, index: true },
  issueDate: { type: Date, default: Date.now, index: true },
  validFrom: Date,
  validTo: Date,
  diagnosisSummary: String,
  purpose: String,
  remarks: String,
  authorizedByDoctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  authorizedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['draft', 'issued', 'revoked'], default: 'draft', index: true },
  revokedAt: Date,
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokeReason: String,
  fileUrl: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ hospitalId: 1, certificateNumber: 1 }, { unique: true });
schema.index({ hospitalId: 1, patientId: 1, issueDate: -1 });

module.exports = mongoose.model('MRDMedicalCertificate', schema);
