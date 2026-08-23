const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assignmentType: { type: String, enum: ['CARE_TEAM', 'COVERING_CLINICIAN', 'DIAGNOSTIC_WORKFLOW', 'OTHER'], default: 'CARE_TEAM' },
  purposes: [{ type: String, enum: ['TREATMENT', 'PAYMENT', 'OPERATIONS', 'ABDM_CONSENTED_EXCHANGE'] }],
  scopes: [{ type: String, enum: ['clinical_read', 'clinical_write', 'demographic_read', 'demographic_write'] }],
  validFrom: { type: Date, default: Date.now },
  validTo: Date,
  reason: { type: String, trim: true, maxlength: 1000 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revokedAt: Date,
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ hospitalId: 1, patientId: 1, userId: 1, revokedAt: 1 });
module.exports = mongoose.model('PatientCareTeamAssignment', schema);
