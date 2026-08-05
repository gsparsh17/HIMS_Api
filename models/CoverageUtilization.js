const mongoose = require('mongoose');

const coverageUtilizationSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true, index: true },
  coverageId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionCoverage', required: true, index: true },
  encounterType: { type: String, enum: ['OPD', 'IPD'], required: true, index: true },
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  sourceType: { type: String, required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceLineId: mongoose.Schema.Types.ObjectId,
  sourceKey: { type: String, required: true },
  serviceCode: String,
  rateCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCard' },
  rateCardItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'RateCardItem' },
  amounts: {
    eligibleAmount: { type: Number, default: 0 },
    sponsorLiability: { type: Number, default: 0 },
    patientLiability: { type: Number, default: 0 },
    coPayAmount: { type: Number, default: 0 },
    deductibleAmount: { type: Number, default: 0 },
    fixedPatientShare: { type: Number, default: 0 },
    uncoveredAmount: { type: Number, default: 0 }
  },
  status: { type: String, enum: ['active', 'reversed'], default: 'active', index: true },
  pricingSnapshot: mongoose.Schema.Types.Mixed,
  recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reversedAt: Date,
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reversalReason: String
}, { timestamps: true, versionKey: false });

coverageUtilizationSchema.pre('validate', function validateEncounter(next) {
  if (this.encounterType === 'IPD' && !this.admissionId) this.invalidate('admissionId', 'admissionId is required for IPD utilization');
  if (this.encounterType === 'OPD' && !this.appointmentId) this.invalidate('appointmentId', 'appointmentId is required for OPD utilization');
  next();
});

coverageUtilizationSchema.index({ hospitalId: 1, sourceKey: 1 }, { unique: true });
coverageUtilizationSchema.index({ hospitalId: 1, coverageId: 1, status: 1, createdAt: 1 });

module.exports = mongoose.model('CoverageUtilization', coverageUtilizationSchema);
